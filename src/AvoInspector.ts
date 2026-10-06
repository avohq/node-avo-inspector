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
import { AvoLog, INTERNAL_ERROR_MESSAGE, MISSING_EVENT_NAME } from "./AvoLog";
import { formatSchema, hasHeaderControlChar, hasNonLatin1Char, isValueEmpty, monotonicNowMs, normalizeOption } from "./utils";

const libVersion = VERSION;

const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_BATCH_FLUSH_SECONDS = 30;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
// Events waiting for a spec fetch at once, across every instance. The fetches share one
// 8-socket pool, so past this an event is sent without validation rather than queued.
const MAX_WAITING_VALIDATIONS = 1_000;
// An exit deadline that passed more than this long ago is from an earlier exit.
const EXIT_DEADLINE_STALE_MS = 1_000;

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
  send: Promise<SendOutcome | null> | null;
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
  // One drain for every flush-marked validation that settles in the same event-loop turn.
  private drainScheduled = false;

  private drainThisTurn(): void {
    if (!this.drainScheduled) {
      this.drainScheduled = true;
      setImmediate(() => {
        this.drainScheduled = false;
        if (!this.destroyed) {
          this.batchQueue.drain();
        }
      });
    }
  }

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
  // One deadline for the whole exit, however often "beforeExit" fires during it. Cleared
  // once every instance has drained, in case the process carries on.
  private static exitDeadline: number | null = null;
  // Events waiting for a spec fetch, across every instance (at most MAX_WAITING_VALIDATIONS).
  private static waitingValidations = 0;
  // Frees this instance's places among them; destroy() runs whatever is left.
  private releaseWaiting: Set<() => void> = new Set();
  // Deadlines of explicit flush() calls still running, by call.
  private static explicitFlushDeadlines: Map<object, number> = new Map();

  private static drainOnExit = (): void => {
    AvoInspector.exitDrainArmed = false;
    const instances = Array.from(AvoInspector.instancesWithWork);
    if (instances.length === 0) {
      return;
    }
    const now = monotonicNowMs();
    // One deadline per exit: "beforeExit" re-fires within moments of the deadline while the
    // same exit continues, so a hung endpoint cannot stretch it. A deadline that passed
    // longer ago belongs to an earlier exit the process carried on from; start a new one.
    if (AvoInspector.exitDeadline === null || now - AvoInspector.exitDeadline > EXIT_DEADLINE_STALE_MS) {
      AvoInspector.exitDeadline = now + DEFAULT_FLUSH_TIMEOUT_MS;
    }
    // An explicit flush() still running gets its full deadline, even past the drain's own.
    let deadline = AvoInspector.exitDeadline;
    AvoInspector.explicitFlushDeadlines.forEach((flushDeadline) => {
      deadline = Math.max(deadline, flushDeadline);
    });
    const remaining = deadline - now;
    if (remaining <= 0) {
      // Out of time: let the process exit; what is still unsent is dropped.
      return;
    }
    // Request sockets are unref'd, so this timer is what keeps the process alive while
    // everything left is sent at once (within the in-flight cap).
    const keepAlive = setTimeout(() => {}, remaining);
    Promise.allSettled(instances.map((inspector) => inspector.flushWithin(remaining))).then(() => {
      clearTimeout(keepAlive);
      // Finished in time: the next "beforeExit" starts a new exit with a fresh deadline.
      if (monotonicNowMs() < deadline) {
        AvoInspector.exitDeadline = null;
      }
    });
    // Re-arm so work added during the drain is sent at the next "beforeExit".
    AvoInspector.armExitDrain();
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
        AvoInspector.exitDeadline = null;
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
      throw new Error("[Avo Inspector] apiKey must not contain control characters");
    } else if (hasNonLatin1Char(options.apiKey)) {
      throw new Error(
        "[Avo Inspector] apiKey must only contain characters that can be sent in an HTTP header"
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
      (batch) => this.sendBatch(batch),
      "failed",
      // A batch is in flight from the moment it is swapped out, even while it waits for a
      // send slot, so flush() waits for it.
      (outcome) => this.trackPending(outcome)
    );

    // Initialize event spec validation for dev/staging only
    if (this.environment !== AvoInspectorEnv.Prod) {
      // Spec fetches follow the track endpoint to a mock server, so validation runs there too.
      this.eventSpecFetcher = new AvoEventSpecFetcher(this.apiKey, this.avoNetworkCallsHandler.mockEndpoint);
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
        // valueToString: concatenation throws for a symbol or a null-prototype object.
        "[Avo Inspector] Invalid " + name + " " + valueToString(value) + ". Using default " + fallback + "."
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
      // A missing event name (null, undefined, non-string, empty or whitespace-only) is
      // still reported to Inspector, under a placeholder name. A valid name is kept as is.
      if (typeof eventName !== "string" || eventName.trim().length === 0) {
        AvoLog.missingEventName();
        eventName = MISSING_EVENT_NAME;
      }
      const avoStreamId = new AvoStreamId(streamId);
      const anonymousId = avoStreamId.streamId || this.generatedAnonymousId;
      const trackOptions = this.resolveTrackOptions(options);

      if (
        this.shouldRegisterEvent(eventName, eventProperties, fromAvoFunction, anonymousId, trackOptions)
      ) {
        let eventSchema = this.extractSchema(eventProperties, false);
        if (AvoInspector.shouldLog) {
          // The schema (names and types), never the values: the logging flag is shared by
          // every instance, so a prod instance can log once any dev instance turns it on.
          console.log(
            "Avo Inspector: Supplied event " + eventName + " with schema " + JSON.stringify(eventSchema)
          );
        }

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
      AvoLog.internal(e);
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

    // The rate that governed this event's sampling decision, not the one at send time.
    const stamp = { createdAt, samplingRate };
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
          trackOptions,
          stamp
        );
      } else {
        body = this.avoNetworkCallsHandler.bodyForEventSchemaCall(
          anonymousId,
          eventName,
          eventSchema,
          eventId,
          eventHash,
          rawEventProperties,
          trackOptions,
          stamp
        );
      }
      return body;
    };

    if (!this.isValidationActive()) {
      return this.enqueue(buildBody(null), eventSchema).result!;
    }

    // A flush() that starts while this validation is in progress sets flushRequested:
    // the event then goes out once it is queued, in the drain shared by every validation
    // that settles in the same event-loop turn, and flush() waits for that send.
    const validation = { flushRequested: false };
    const outcome = this.untilDestroyed<ValidationResult | null>(
      this.fetchAndValidate(eventName, eventSchema, anonymousId, rawEventProperties, eventId),
      null
    )
      .catch((err): ValidationResult | null => {
        if (AvoInspector.shouldLog) {
          // Only the error's type: validation reads property values, which can end up in it.
          console.warn("Avo Inspector: Event spec validation failed for event: " + eventName + ". Sending without validation. (" + AvoLog.errorType(err) + ")");
        }
        return null;
      })
      .then((validationResult): Enqueued => {
        if (this.destroyed) {
          return { result: Promise.resolve([]), send: null };
        }
        try {
          const enqueued = this.enqueue(buildBody(validationResult), eventSchema);
          let send = enqueued.send;
          if (send === null && validation.flushRequested) {
            // flush() waits for the batch that carries this event. Another drain (a size
            // trigger or the timer) may swap it out before the scheduled one runs, so the
            // wait follows the buffered batch, not this particular drain.
            send = this.batchQueue.bufferedBatchOutcome();
            this.drainThisTurn();
          }
          return { result: enqueued.result, send };
        } catch (err) {
          // Same outcome as a synchronous internal error on the unvalidated path (SPEC §4.2
          // step 5): logged, and the call rejects with the internal error message.
          AvoLog.internal(err);
          return { result: null, send: null };
        }
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
          // Not logged for a send abandoned by destroy().
          if (!this.destroyed) {
            AvoLog.rejected(status);
          }
          return "non200";
        }
        if (AvoInspector.shouldLog) {
          batch.forEach((event) => {
            console.log("Avo Inspector: Saved event " + event.eventName + " with schema " + formatSchema(event.eventProperties));
          });
        }
        return "ok";
      },
      (err): SendOutcome => {
        // At-most-once: a failed batch is dropped, never re-queued or retried.
        if (!this.destroyed) {
          AvoLog.failed(err);
        }
        return "failed";
      }
    );
    return send;
  }

  private isValidationActive(): boolean {
    return this.eventSpecFetcher !== null;
  }

  /**
   * Sends every buffered event, then waits until all in-flight sends (and spec fetches
   * that will enqueue) have completed or `timeoutMs` (default 10000) has elapsed.
   * Resolves `true` if, when it resolves, this instance has nothing buffered, waiting or in
   * flight (always after destroy()), and `false` if the timeout won. Never rejects. Call it
   * before process exit or before a serverless handler returns.
   */
  async flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
    const budget =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.min(timeoutMs, MAX_TIMER_MS)
        : DEFAULT_FLUSH_TIMEOUT_MS;
    // While an explicit flush runs, the exit drain holds the process until its deadline too.
    const token = {};
    AvoInspector.explicitFlushDeadlines.set(token, monotonicNowMs() + budget);
    try {
      await this.flushWithin(budget);
    } finally {
      AvoInspector.explicitFlushDeadlines.delete(token);
    }
    return this.hasDrained();
  }

  // Nothing buffered, waiting for a send slot, or in flight (spec validations included).
  private hasDrained(): boolean {
    return (
      this.destroyed ||
      (this.pending.size === 0 && this.batchQueue.length === 0 && this.batchQueue.waitingLength === 0)
    );
  }

  // The body of flush(): also used by the exit drain, whose own deadline is not an explicit one.
  private async flushWithin(budget: number): Promise<void> {
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
    } finally {
      // Counts whose window has expired are printed now; a count still inside its window
      // stays pending, so an app that flushes after every event keeps the 10 s limit.
      AvoLog.flushPending(true);
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
      // The scan compares against every recent Codegen entry, so it runs only when its
      // warning can print (never on the tracking path, which passes false).
      if (
        shouldLogIfEnabled &&
        AvoInspector.shouldLog &&
        this.avoDeduplicator.hasSeenEventParams(eventProperties, true)
      ) {
        console.warn(
          "Avo Inspector: WARNING! You are trying to extract schema shape that was just reported by your Codegen. " +
          "This is an indicator of duplicate inspector reporting. " +
          "Please reach out to support@avo.app for advice if you are not sure how to handle this."
        );
      }

      if (AvoInspector.shouldLog) {
        // No property values in logs; the parsed schema is logged below.
        console.log("Avo Inspector: extracting schema");
      }

      const schema = AvoSchemaParser.extractSchema(eventProperties);

      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: Parsed schema " + formatSchema(schema));
      }

      return schema;
    } catch (e) {
      AvoLog.internal(e);
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

    if (AvoInspector.waitingValidations >= MAX_WAITING_VALIDATIONS) {
      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: " + MAX_WAITING_VALIDATIONS + " events are already waiting for an event spec. Sending " + eventName + " without validation.");
      }
      return null;
    }
    AvoInspector.waitingValidations++;
    let waiting = true;
    const release = () => {
      if (waiting) {
        waiting = false;
        AvoInspector.waitingValidations--;
        this.releaseWaiting.delete(release);
      }
    };
    this.releaseWaiting.add(release);

    const fetcher = this.eventSpecFetcher;
    return new Promise((resolve, reject) => {
      const onSpec = (result: EventSpecResponse | null) => {
        release();
        if (result !== null) {
          cache.set(cacheKey, result);
          // A throw here would be swallowed by the fetcher and leave this promise pending;
          // reject instead, so a miss falls back to an unvalidated send like a hit does.
          try {
            resolve(doValidate(result));
          } catch (err) {
            reject(err);
          }
        } else {
          if (AvoInspector.shouldLog) {
            console.log("Avo Inspector: Event spec fetch returned null for event: " + eventName + ". Cached empty response. Sending without validation.");
          }
          resolve(null);
        }
      };
      try {
        fetcher.fetch(eventName, anonymousId, onSpec);
      } catch (err) {
        // No callback will come: free the slot and fall back to an unvalidated send.
        release();
        reject(err);
      }
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
    Array.from(this.releaseWaiting).forEach((release) => release());
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
    // Destroy is final: report every pending count now.
    AvoLog.flushPending();
  }
}
