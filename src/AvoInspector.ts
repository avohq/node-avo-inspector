import { AvoInspectorEnv, AvoInspectorEnvValueType } from "./AvoInspectorEnv";
import { AvoSchemaParser } from "./AvoSchemaParser";
import {
  AvoNetworkCallsHandler,
  EventSchemaBody,
  InspectorBody,
  ResolvedTrackOptions,
} from "./AvoNetworkCallsHandler";
import { AvoBatchQueue, MAX_TIMER_MS } from "./AvoBatchQueue";
import { AvoDeduplicator } from "./AvoDeduplicator";
import { AvoStreamId } from "./AvoStreamId";
import { AvoEventSpecFetcher } from "./eventSpec/AvoEventSpecFetcher";
import { AvoEventSpecCache } from "./eventSpec/AvoEventSpecCache";
import { EventValidator } from "./eventSpec/EventValidator";
import {
  EventSpecMetadata,
  EventSpecResponse,
  PropertyValidationResult,
} from "./eventSpec/AvoEventSpecFetchTypes";
import { VERSION } from "./AvoInspectorVersion";

import { hasHeaderControlChar, hasNonLatin1Char, isValueEmpty, normalizeOption, safeStringify } from "./utils";

const libVersion = VERSION;

const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_BATCH_FLUSH_SECONDS = 30;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

// String() for regex validation; a value with no string conversion (a null-prototype object)
// falls back to its tag, e.g. "[object Object]", which String() gives a plain object.
const valueToString = (value: unknown): string => {
  try {
    return String(value);
  } catch (e) {
    return Object.prototype.toString.call(value);
  }
};

const NO_API_KEY_MESSAGE =
  "[Avo Inspector] No API key provided. Inspector can't operate without API key.";

const INTERNAL_ERROR_MESSAGE =
  "Avo Inspector: something went wrong. Please report to support@avo.app.";

/**
 * Gateway coordinates for a gateway-scoped Inspector API key. All optional; blank
 * values are treated as absent.
 */
export interface TrackOptions {
  /** Reference of the gateway output this observation was bound for. Absent = gateway checkpoint. */
  outputReference?: string;
  /** Low-cardinality label of the source the event came from (e.g. "web"). Never a user id. */
  originHint?: string;
  /** App version of the source that produced this event; overrides the instance version. */
  originAppVersion?: string;
}

type SchemaEntry = {
  propertyName: string;
  propertyType: string;
  children?: any;
};

type SendOutcome = "ok" | "non200" | "failed";

// The promise a track call resolves with (null: reject with the internal error), and the
// send its enqueue triggered, if any.
type Enqueued = {
  result: Promise<Array<SchemaEntry>> | null;
  send: Promise<SendOutcome> | null;
};

type ValidationResult = {
  metadata: EventSpecMetadata;
  propertyResults: PropertyValidationResult[];
};

export class AvoInspector {
  environment: AvoInspectorEnvValueType;
  avoNetworkCallsHandler: AvoNetworkCallsHandler;
  avoDeduplicator: AvoDeduplicator;
  apiKey: string;
  version: string;
  private publicEncryptionKey?: string;

  private eventSpecFetcher: AvoEventSpecFetcher | null = null;
  private eventSpecCache: AvoEventSpecCache | null = null;
  private eventValidator: EventValidator | null = null;
  private generatedAnonymousId: string = "";

  private batchSize: number;
  private batchQueue: AvoBatchQueue<SendOutcome>;
  private destroyed = false;
  // Settles each track still waiting on a spec fetch or an immediate send when destroy()
  // runs. Entries remove themselves once their wait settles, so none outlive their call.
  private destroyWaiters: Set<() => void> = new Set();

  // In-flight work (spec fetches before enqueue, and batch sends) that flush() awaits.
  // Nothing here keeps the process alive: callers flush() or await before exit.
  private pending: Set<Promise<unknown>> = new Set();
  // Pending entries that are event spec validations, keyed by their pending promise.
  private validations: Map<Promise<unknown>, { flushRequested: boolean }> = new Map();

  // Mirrors `promise`, but resolves `onDestroy` instead if destroy() runs first.
  private untilDestroyed<T>(promise: Promise<T>, onDestroy: T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => resolve(onDestroy);
      this.destroyWaiters.add(cancel);
      promise.then(
        (value) => {
          this.destroyWaiters.delete(cancel);
          resolve(value);
        },
        (reason) => {
          this.destroyWaiters.delete(cancel);
          reject(reason);
        }
      );
    });
  }

  private get pendingCount(): number {
    return this.pending.size;
  }

  private trackPending<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    this.updateExitDrain();
    const done = () => {
      this.pending.delete(promise);
      this.updateExitDrain();
    };
    promise.then(done, done);
    return promise;
  }

  // Best-effort delivery at exit: when the event loop empties ("beforeExit"), every
  // instance with buffered or in-flight events is flushed. One listener serves all
  // instances, and only instances with work are registered, so idle instances are not
  // retained. The listener schedules nothing when there is nothing to send, so it never
  // keeps the process alive on its own. "beforeExit" does not fire on process.exit() or
  // on signals; callers flush() there.
  private static instancesWithWork: Set<AvoInspector> = new Set();
  private static exitDrainArmed = false;

  private static drainOnExit = (): void => {
    AvoInspector.exitDrainArmed = false;
    const instances = Array.from(AvoInspector.instancesWithWork);
    instances.forEach((inspector) => {
      inspector.flush();
    });
    // The sends just started keep the loop alive; re-arm so anything they leave behind
    // is drained at the next "beforeExit".
    if (AvoInspector.instancesWithWork.size > 0) {
      AvoInspector.armExitDrain();
    }
  };

  private static armExitDrain(): void {
    if (!AvoInspector.exitDrainArmed) {
      process.once("beforeExit", AvoInspector.drainOnExit);
      AvoInspector.exitDrainArmed = true;
    }
  }

  private static disarmExitDrain(): void {
    if (AvoInspector.exitDrainArmed) {
      process.removeListener("beforeExit", AvoInspector.drainOnExit);
      AvoInspector.exitDrainArmed = false;
    }
  }

  private updateExitDrain(): void {
    const hasWork =
      !this.destroyed && (this.batchQueue.length > 0 || this.pending.size > 0);
    if (hasWork) {
      AvoInspector.instancesWithWork.add(this);
      AvoInspector.armExitDrain();
    } else {
      AvoInspector.instancesWithWork.delete(this);
      if (AvoInspector.instancesWithWork.size === 0) {
        AvoInspector.disarmExitDrain();
      }
    }
  }

  private static _shouldLog = false;
  /** Whether the SDK writes its diagnostic log lines (shared by every instance). */
  static get shouldLog() {
    return this._shouldLog;
  }
  static set shouldLog(enable) {
    this._shouldLog = enable;
  }

  /**
   * Creates an Inspector instance. A missing or unsupported `env` falls back to dev.
   *
   * @throws if `apiKey` or `version` is blank, or `apiKey` contains a character that
   * cannot be sent in an HTTP header.
   */
  constructor(options: {
    apiKey: string;
    env: AvoInspectorEnvValueType;
    version: string;
    appName?: string;
    publicEncryptionKey?: string;
    /** Flush when this many events are buffered. Default 30; always 1 in dev. */
    batchSize?: number;
    /** Flush once the oldest buffered event is this many seconds old. Default 30. */
    batchFlushSeconds?: number;
    /** Maximum buffered events; the oldest are dropped first. Default 1000. */
    maxQueueSize?: number;
    /** Start no background flush timer (recommended for serverless). Default false. */
    disableBatchTimer?: boolean;
  }) {
    // the constructor does aggressive null/undefined checking because same code paths will be accessible from JS
    if (options === null || typeof options !== "object") {
      throw new Error(NO_API_KEY_MESSAGE);
    }

    // A non-string env is not "empty": it falls through to the unsupported-value check.
    const env: unknown = options.env;
    if (env === undefined || env === null || (typeof env === "string" && isValueEmpty(env))) {
      this.environment = AvoInspectorEnv.Dev;
      console.warn(
        "[Avo Inspector] No environment provided. Defaulting to dev."
      );
    } else if (Object.values(AvoInspectorEnv).indexOf(options.env) === -1) {
      this.environment = AvoInspectorEnv.Dev;
      console.warn(
        "[Avo Inspector] Unsupported environment provided. Defaulting to dev. Supported environments - Dev, Staging, Prod."
      );
    } else {
      this.environment = options.env;
    }

    if (typeof options.apiKey !== "string" || isValueEmpty(options.apiKey)) {
      throw new Error(NO_API_KEY_MESSAGE);
    } else if (/[\r\n\0]/.test(options.apiKey)) {
      // The spec's exact message covers CR, LF and NUL.
      throw new Error(
        "[Avo Inspector] API key contains a control character. The API key is sent as a request header and cannot contain CR, LF, or NUL."
      );
    } else if (hasHeaderControlChar(options.apiKey)) {
      throw new Error("Avo Inspector: apiKey must not contain control characters");
    } else if (hasNonLatin1Char(options.apiKey)) {
      throw new Error(
        "Avo Inspector: apiKey must only contain characters that can be sent in an HTTP header"
      );
    } else {
      this.apiKey = options.apiKey;
    }

    if (typeof options.version !== "string" || isValueEmpty(options.version)) {
      throw new Error(
        "[Avo Inspector] No version provided. Many features of Inspector rely on versioning. Please provide comparable string version, i.e. integer or semantic."
      );
    } else {
      this.version = options.version;
    }

    this.publicEncryptionKey = options.publicEncryptionKey;

    if (
      this.publicEncryptionKey &&
      this.environment !== AvoInspectorEnv.Prod
    ) {
      const hexPattern = /^[0-9a-fA-F]+$/;
      const len = this.publicEncryptionKey.length;
      // Accept both compressed (66 hex chars, prefix 02/03) and uncompressed (130 hex chars, prefix 04) P-256 keys
      const isValidLength = len === 66 || len === 130;
      if (!hexPattern.test(this.publicEncryptionKey) || !isValidLength) {
        console.warn(
          "[Avo Inspector] Warning: publicEncryptionKey does not look like a valid P-256 public key (expected 66 or 130 hex characters). Encryption may fail."
        );
      }
    }

    if (this.environment === AvoInspectorEnv.Dev) {
      AvoInspector._shouldLog = true;
    } else {
      AvoInspector._shouldLog = false;
    }

    this.avoNetworkCallsHandler = new AvoNetworkCallsHandler(
      this.apiKey,
      this.environment.toString(),
      options.appName || "",
      this.version,
      libVersion,
      this.publicEncryptionKey
    );
    this.avoDeduplicator = new AvoDeduplicator();

    const batchOptions = AvoInspector.resolveBatchOptions(options);
    // dev sends every event immediately, whatever was configured.
    this.batchSize =
      this.environment === AvoInspectorEnv.Dev ? 1 : batchOptions.batchSize;
    // Not clamped: the conformance suite (batch-4) requires FIFO overflow in this case.
    if (this.batchSize > batchOptions.maxQueueSize) {
      console.warn(
        "[Avo Inspector] batchSize " + this.batchSize + " is larger than maxQueueSize " +
          batchOptions.maxQueueSize + ", so a batch never fills: events are sent only by the " +
          "scheduled flush or flush(), and the oldest are dropped once " +
          batchOptions.maxQueueSize + " are buffered. Set batchSize to at most maxQueueSize."
      );
    }
    this.batchQueue = new AvoBatchQueue<SendOutcome>(
      { ...batchOptions, batchSize: this.batchSize },
      (batch) => this.sendBatch(batch)
    );

    // Initialize event spec validation for dev/staging only
    if (this.environment !== AvoInspectorEnv.Prod) {
      this.eventSpecFetcher = new AvoEventSpecFetcher(this.apiKey);
      this.eventSpecCache = new AvoEventSpecCache();
      this.eventValidator = new EventValidator();
    }
  }

  private static resolveBatchOptions(options: {
    batchSize?: number;
    batchFlushSeconds?: number;
    maxQueueSize?: number;
    disableBatchTimer?: boolean;
  }) {
    const pick = (
      name: string,
      value: number | undefined,
      fallback: number,
      isValid: (v: number) => boolean
    ): number => {
      if (value === undefined || value === null) {
        return fallback;
      }
      if (typeof value === "number" && isValid(value)) {
        return value;
      }
      console.warn(
        "[Avo Inspector] Invalid " + name + " " + value + ". Using default " + fallback + "."
      );
      return fallback;
    };
    const isPositiveInteger = (v: number) => Number.isInteger(v) && v >= 1;

    return {
      batchSize: pick("batchSize", options.batchSize, DEFAULT_BATCH_SIZE, isPositiveInteger),
      batchFlushSeconds: pick(
        "batchFlushSeconds",
        options.batchFlushSeconds,
        DEFAULT_BATCH_FLUSH_SECONDS,
        (v) => Number.isFinite(v) && v > 0
      ),
      maxQueueSize: pick("maxQueueSize", options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, isPositiveInteger),
      disableBatchTimer: options.disableBatchTimer === true,
    };
  }

  /**
   * Resolves the gateway options for one event. outputReference / originHint are
   * omitted when blank; appVersion is the per-event override, null for a
   * source-scoped event without one, else the instance version.
   */
  private resolveTrackOptions(options?: TrackOptions): ResolvedTrackOptions {
    const opts: any = options !== null && typeof options === "object" ? options : {};
    const outputReference = normalizeOption(opts.outputReference);
    const originHint = normalizeOption(opts.originHint);
    const originAppVersion = normalizeOption(opts.originAppVersion);

    const resolved: ResolvedTrackOptions = {
      gatewayScoped:
        outputReference !== undefined ||
        originHint !== undefined ||
        originAppVersion !== undefined,
      appVersion:
        originAppVersion !== undefined
          ? originAppVersion
          : originHint !== undefined
          ? null
          : this.version,
    };
    if (outputReference !== undefined) {
      resolved.outputReference = outputReference;
    }
    if (originHint !== undefined) {
      resolved.originHint = originHint;
    }
    return resolved;
  }

  /**
   * Extracts the event schema and queues it for the Inspector API.
   *
   * Resolves with the schema once the event is queued. In dev (batch size 1) the send
   * happens within the call and a non-200 response resolves `[]`; with batching the
   * batch's HTTP outcome is not observable here. Buffered events are only delivered
   * by a later size or time trigger, or by `flush()` — call `flush()` before exit.
   */
  trackSchemaFromEvent(
    eventName: string,
    eventProperties: { [propName: string]: any },
    streamId?: string,
    options?: TrackOptions
  ): Promise<Array<SchemaEntry>> {
    return this.track(eventName, eventProperties, false, null, null, streamId, options);
  }

  /**
   * Codegen entry point: like `trackSchemaFromEvent`, and additionally records the
   * Avo function's `eventId` / `eventHash` so the event is sent with `avoFunction: true`.
   */
  _avoFunctionTrackSchemaFromEvent(
    eventName: string,
    eventProperties: { [propName: string]: any },
    eventId: string,
    eventHash: string,
    streamId?: string,
    options?: TrackOptions
  ): Promise<Array<SchemaEntry>> {
    return this.track(eventName, eventProperties, true, eventId, eventHash, streamId, options);
  }

  // Shared by the manual and Codegen entry points.
  private track(
    eventName: string,
    eventProperties: { [propName: string]: any },
    fromAvoFunction: boolean,
    eventId: string | null,
    eventHash: string | null,
    streamId: string | undefined,
    options: TrackOptions | undefined
  ): Promise<Array<SchemaEntry>> {
    try {
      if (this.destroyed) {
        return Promise.resolve([]);
      }
      const avoStreamId = new AvoStreamId(streamId);
      const anonymousId = avoStreamId.streamId || this.generatedAnonymousId;
      const trackOptions = this.resolveTrackOptions(options);

      if (
        this.shouldRegisterEvent(eventName, eventProperties, fromAvoFunction, anonymousId, trackOptions)
      ) {
        if (AvoInspector.shouldLog) {
          console.log(
            "Avo Inspector: Supplied event " +
            eventName +
            " with params \n" +
            safeStringify(eventProperties)
          );
        }
        let eventSchema = this.extractSchema(eventProperties, false);

        return this.sampleAndEnqueue(
          eventName,
          eventSchema,
          eventId,
          eventHash,
          anonymousId,
          eventProperties,
          trackOptions
        );
      } else {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: Deduplicated event " + eventName);
        }
        return Promise.resolve([]);
      }
    } catch (e) {
      console.error(INTERNAL_ERROR_MESSAGE, e);
      return Promise.reject(INTERNAL_ERROR_MESSAGE);
    }
  }

  /**
   * Codegen/manual deduplication applies only to plain calls. A call carrying gateway
   * options is a distinct observation per gateway output and is always sent.
   */
  private shouldRegisterEvent(
    eventName: string,
    eventProperties: { [propName: string]: any },
    fromAvoFunction: boolean,
    anonymousId: string,
    trackOptions: ResolvedTrackOptions
  ): boolean {
    if (trackOptions.gatewayScoped) {
      return true;
    }
    return this.avoDeduplicator.shouldRegisterEvent(
      eventName,
      eventProperties,
      fromAvoFunction,
      anonymousId
    );
  }

  /**
   * Samples the event, then queues it. When event spec validation is active the spec
   * is fetched (or read from cache) first, so the event joins the queue once its
   * validation results are merged in; flush() awaits that fetch before draining.
   */
  private sampleAndEnqueue(
    eventName: string,
    eventSchema: Array<SchemaEntry>,
    eventId: string | null,
    eventHash: string | null,
    anonymousId: string,
    rawEventProperties: { [propName: string]: any } | undefined,
    trackOptions: ResolvedTrackOptions
  ): Promise<Array<SchemaEntry>> {
    const samplingRate = this.avoNetworkCallsHandler.getSamplingRate();
    // Stamped at the call: with validation active the event may join the queue later.
    const createdAt = new Date().toISOString();
    if (Math.random() > samplingRate) {
      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: event " + eventName + " dropped due to sampling rate.");
      }
      return Promise.resolve(eventSchema);
    }

    const buildBody = (validationResult: ValidationResult | null): EventSchemaBody => {
      let body: EventSchemaBody;
      if (validationResult) {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: Sending validated event " + eventName);
        }
        const eventProps = this.avoNetworkCallsHandler.buildEventProperties(eventSchema, rawEventProperties);
        body = this.avoNetworkCallsHandler.bodyForValidatedEventSchemaCall(
          anonymousId,
          eventName,
          eventProps,
          eventId,
          eventHash,
          validationResult.metadata,
          validationResult.propertyResults,
          trackOptions
        );
      } else {
        body = this.avoNetworkCallsHandler.bodyForEventSchemaCall(
          anonymousId,
          eventName,
          eventSchema,
          eventId,
          eventHash,
          rawEventProperties,
          trackOptions
        );
      }
      // The rate that governed this event's sampling decision, not the one at send time.
      body.samplingRate = samplingRate;
      body.createdAt = createdAt;
      return body;
    };

    if (!this.isValidationActive()) {
      return this.enqueue(buildBody(null), eventSchema).result!;
    }

    // A flush() that starts while this validation is in progress sets flushRequested:
    // the event then goes out as soon as it is queued, and flush() waits for that send.
    const validation = { flushRequested: false };
    const outcome = this.untilDestroyed<ValidationResult | null>(
      this.fetchAndValidate(eventName, eventSchema, anonymousId, rawEventProperties, eventId),
      null
    )
      .catch((err): ValidationResult | null => {
        if (AvoInspector.shouldLog) {
          console.warn("Avo Inspector: Event spec validation failed for event: " + eventName + ". Sending without validation. " + err);
        }
        return null;
      })
      .then((validationResult): Enqueued => {
        if (this.destroyed) {
          return { result: Promise.resolve([]), send: null };
        }
        let body: EventSchemaBody;
        try {
          body = buildBody(validationResult);
        } catch (err) {
          // Same outcome as a synchronous internal error before enqueue (SPEC §4.2 step 5).
          console.error(INTERNAL_ERROR_MESSAGE, err);
          return { result: null, send: null };
        }
        const enqueued = this.enqueue(body, eventSchema);
        return {
          result: enqueued.result,
          send: enqueued.send || (validation.flushRequested ? this.batchQueue.drain() : null),
        };
      });

    // In flight until the event is queued and, if that triggered a send, until it settles.
    const inFlight = outcome.then(({ send }) => (send ? send.then(() => undefined) : undefined));
    this.validations.set(inFlight, validation);
    const forget = () => {
      this.validations.delete(inFlight);
    };
    inFlight.then(forget, forget);
    this.trackPending(inFlight);

    return outcome.then(({ result }) => result || Promise.reject(INTERNAL_ERROR_MESSAGE));
  }

  private enqueue(body: EventSchemaBody, eventSchema: Array<SchemaEntry>): Enqueued {
    const send = this.batchQueue.enqueue(body);
    this.updateExitDrain();
    if (this.batchSize === 1 && send !== null) {
      // Immediate send: the HTTP outcome is observable per call. An event whose send is
      // abandoned by destroy() is not delivered, so it resolves [] like a non-200.
      return {
        result: this.untilDestroyed(
          send.then((outcome) => (outcome === "non200" || this.destroyed ? [] : eventSchema)),
          []
        ),
        send,
      };
    }
    return { result: Promise.resolve(eventSchema), send };
  }

  private sendBatch(batch: Array<InspectorBody>): Promise<SendOutcome> {
    if (this.destroyed) {
      return Promise.resolve("failed");
    }
    const send = this.avoNetworkCallsHandler.callInspectorWithBatchBody(batch).then(
      (status): SendOutcome => {
        if (typeof status === "number" && status !== 200) {
          return "non200";
        }
        if (AvoInspector.shouldLog) {
          batch.forEach((event) => {
            const schemaString = event.eventProperties
              .map((p) => '\t"' + p.propertyName + '": "' + p.propertyType + '"')
              .join(";\n");
            console.log("Avo Inspector: Saved event " + event.eventName + " with schema {\n" + schemaString + "\n}");
          });
        }
        return "ok";
      },
      (err): SendOutcome => {
        // At-most-once: a failed batch is dropped, never re-queued or retried.
        if (!this.destroyed) {
          console.error("Avo Inspector: schema sending failed: " + err + ".");
        }
        return "failed";
      }
    );
    return this.trackPending(send);
  }

  private isValidationActive(): boolean {
    // The conformance mock endpoint serves only the track call, so validation (which
    // would reach the real spec endpoint) is skipped while the override is in effect.
    return (
      this.eventSpecFetcher !== null &&
      AvoNetworkCallsHandler.mockEndpointFor(this.environment) === null
    );
  }

  /**
   * Sends every buffered event, then waits until all in-flight sends (and spec fetches
   * that will enqueue) have completed or `timeoutMs` (default 10000) has elapsed.
   * Always resolves. Call it before process exit or before a serverless handler returns.
   */
  async flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    const budget =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.min(timeoutMs, MAX_TIMER_MS)
        : DEFAULT_FLUSH_TIMEOUT_MS;
    try {
      if (this.destroyed) {
        return;
      }
      // Only work started before this call, plus the batch it drains, is awaited.
      const waitFor: Array<Promise<unknown>> = Array.from(this.pending);
      waitFor.forEach((promise) => {
        const validation = this.validations.get(promise);
        if (validation) {
          validation.flushRequested = true;
        }
      });
      const drained = this.batchQueue.drain();
      if (drained !== null) {
        waitFor.push(drained);
      }
      if (waitFor.length === 0) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(waitFor),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budget);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    } catch (e) {
      // flush() is a completion guarantee and never rejects.
    }
  }

  /** @internal Test-only hook for the conformance harness; not part of the public API. */
  _setSamplingRateForTesting(samplingRate: number): void {
    this.avoNetworkCallsHandler._setSamplingRateForTesting(samplingRate);
  }

  /** Turns the SDK's diagnostic logging on or off for every instance. */
  enableLogging(enable: boolean) {
    AvoInspector._shouldLog = enable;
  }

  /** Returns the schema of `eventProperties` without tracking or sending anything. */
  extractSchema(
    eventProperties: {
      [propName: string]: any;
    },
    shouldLogIfEnabled = true
  ): Array<{
    propertyName: string;
    propertyType: string;
    children?: any;
  }> {
    try {
      if (this.avoDeduplicator.hasSeenEventParams(eventProperties, true)) {
        if (shouldLogIfEnabled && AvoInspector.shouldLog) {
          console.warn(
            "Avo Inspector: WARNING! You are trying to extract schema shape that was just reported by your Codegen. " +
            "This is an indicator of duplicate inspector reporting. " +
            "Please reach out to support@avo.app for advice if you are not sure how to handle this."
          );
        }
      }

      if (AvoInspector.shouldLog) {
        console.log(
          "Avo Inspector: extracting schema from " +
          safeStringify(eventProperties)
        );
      }

      const schema = AvoSchemaParser.extractSchema(eventProperties);

      if (AvoInspector.shouldLog) {
        const schemaString = schema.map(p => '\t"' + p.propertyName + '": "' + p.propertyType + '"').join(";\n");
        console.log("Avo Inspector: Parsed schema {\n" + schemaString + "\n}");
      }

      return schema;
    } catch (e) {
      console.error(
        "Avo Inspector: something went wrong. Please report to support@avo.app.",
        e
      );
      return [];
    }
  }

  /**
   * Fetch event spec and validate. Returns validation results + metadata if
   * validation succeeds, or null if unavailable (prod, no spec, fetch error).
   */
  private async fetchAndValidate(
    eventName: string,
    eventSchema: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    anonymousId: string,
    rawEventProperties?: { [propName: string]: any },
    eventId?: string | null
  ): Promise<ValidationResult | null> {
    if (!this.eventSpecFetcher || !this.eventSpecCache || !this.eventValidator) {
      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: Skipping event spec validation for event: " + eventName
          + " (fetcher=" + (this.eventSpecFetcher != null)
          + ", cache=" + (this.eventSpecCache != null)
          + ", env=" + this.environment + ")");
      }
      return null;
    }

    const cacheKey = AvoEventSpecCache.makeKey(this.apiKey, anonymousId, eventName);
    const cache = this.eventSpecCache;
    const validator = this.eventValidator;

    const doValidate = (specResponse: EventSpecResponse) => {
      if (specResponse.eventSpec === null) {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: Event spec fetch returned null for event: " + eventName + ". Sending without validation.");
        }
        return null;
      }

      const eventProperties = eventSchema.map((prop) => ({
        propertyName: prop.propertyName,
        propertyType: prop.propertyType,
        ...(rawEventProperties && rawEventProperties[prop.propertyName] !== undefined
          ? { propertyValue: valueToString(rawEventProperties[prop.propertyName]) }
          : {}),
      }));

      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: Validating event: " + eventName
          + " with " + eventProperties.length + " properties"
          + " against " + specResponse.eventSpec.properties.length + " spec properties");
      }

      const validationId = eventId || eventName;
      const results = validator.validate(
        specResponse.eventSpec,
        eventProperties,
        validationId
      );

      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: Validation complete for event: " + eventName
          + " with " + results.length + " property results");
      }

      return { metadata: specResponse.metadata, propertyResults: results };
    };

    // Check cache first
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: Event spec cache hit for event: " + eventName);
      }
      return doValidate(cached);
    }

    // Cache miss — fetch spec (flush() awaits it via trackPending)
    if (AvoInspector.shouldLog) {
      console.log("Avo Inspector: Event spec cache miss for event: " + eventName + ". Fetching before sending.");
    }

    const fetcher = this.eventSpecFetcher;
    return new Promise((resolve) => {
      fetcher.fetch(eventName, anonymousId, (result) => {
        if (result !== null) {
          cache.set(cacheKey, result);
          resolve(doValidate(result));
        } else {
          if (AvoInspector.shouldLog) {
            console.log("Avo Inspector: Event spec fetch returned null for event: " + eventName + ". Cached empty response. Sending without validation.");
          }
          resolve(null);
        }
      });
    });
  }

  /**
   * Cancels and cleans up: discards the pending batch unsent, abandons in-flight
   * requests and stops the flush timer. Does not flush. After destroy() the instance
   * is terminated and trackSchemaFromEvent resolves [] without sending; a call still
   * waiting on a spec fetch or on its immediate send also resolves [].
   */
  destroy(): void {
    this.destroyed = true;
    const waiters = Array.from(this.destroyWaiters);
    this.destroyWaiters.clear();
    waiters.forEach((settle) => settle());
    this.batchQueue.clear();
    this.pending.clear();
    this.validations.clear();
    this.updateExitDrain();
    this.avoNetworkCallsHandler.abortInFlight();
    if (this.eventSpecFetcher) {
      this.eventSpecFetcher.destroy();
      this.eventSpecFetcher = null;
    }
    if (this.eventSpecCache) {
      this.eventSpecCache.flush();
      this.eventSpecCache = null;
    }
    this.eventValidator = null;
  }
}
