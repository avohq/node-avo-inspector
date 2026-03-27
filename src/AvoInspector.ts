import { AvoInspectorEnv, AvoInspectorEnvValueType } from "./AvoInspectorEnv";
import { AvoSchemaParser } from "./AvoSchemaParser";
import { AvoNetworkCallsHandler } from "./AvoNetworkCallsHandler";
import { AvoDeduplicator } from "./AvoDeduplicator";
import { AvoStreamId } from "./AvoStreamId";
import { AvoEventSpecFetcher } from "./eventSpec/AvoEventSpecFetcher";
import { AvoEventSpecCache } from "./eventSpec/AvoEventSpecCache";
import { EventValidator } from "./eventSpec/EventValidator";
import { EventSpecResponse } from "./eventSpec/AvoEventSpecFetchTypes";

import { isValueEmpty } from "./utils";

const libVersion = require("../package.json").version;

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

  // Keep the Node process alive while there are pending inspector operations.
  // Without this, short-lived processes (e.g. CLIs) can exit before async
  // sends complete, since the caller typically doesn't await the inspector promise.
  private pendingCount = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  private trackPending(promise: Promise<any>): void {
    this.pendingCount++;
    if (this.keepAliveTimer === null) {
      this.keepAliveTimer = setInterval(() => {}, 60_000);
    }
    const done = () => {
      this.pendingCount--;
      if (this.pendingCount === 0 && this.keepAliveTimer !== null) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
    };
    promise.then(done, done);
  }

  private static _shouldLog = false;
  static get shouldLog() {
    return this._shouldLog;
  }
  static set shouldLog(enable) {
    this._shouldLog = enable;
  }

  constructor(options: {
    apiKey: string;
    env: AvoInspectorEnvValueType;
    version: string;
    appName?: string;
    publicEncryptionKey?: string;
  }) {
    // the constructor does aggressive null/undefined checking because same code paths will be accessible from JS
    if (isValueEmpty(options.env)) {
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

    if (isValueEmpty(options.apiKey)) {
      throw new Error(
        "[Avo Inspector] No API key provided. Inspector can't operate without API key."
      );
    } else {
      this.apiKey = options.apiKey;
    }

    if (isValueEmpty(options.version)) {
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

    // Initialize event spec validation for dev/staging only
    if (this.environment !== AvoInspectorEnv.Prod) {
      this.eventSpecFetcher = new AvoEventSpecFetcher(this.apiKey);
      this.eventSpecCache = new AvoEventSpecCache();
      this.eventValidator = new EventValidator();
    }
  }

  trackSchemaFromEvent(
    eventName: string,
    eventProperties: { [propName: string]: any },
    streamId?: string
  ): Promise<
    Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>
  > {
    try {
      const avoStreamId = new AvoStreamId(streamId);
      const anonymousId = avoStreamId.streamId || this.generatedAnonymousId;

      if (
        this.avoDeduplicator.shouldRegisterEvent(
          eventName,
          eventProperties,
          false,
          anonymousId
        )
      ) {
        if (AvoInspector.shouldLog) {
          console.log(
            "Avo Inspector: Supplied event " +
            eventName +
            " with params \n" +
            JSON.stringify(eventProperties)
          );
        }
        let eventSchema = this.extractSchema(eventProperties, false);

        return this.sendEventWithOptionalValidation(
          eventName,
          eventSchema,
          null,
          null,
          anonymousId,
          eventProperties
        ).then(() => {
          return eventSchema;
        });
      } else {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: Deduplicated event " + eventName);
        }
        return Promise.resolve([]);
      }
    } catch (e) {
      console.error(
        "Avo Inspector: something went wrong. Please report to support@avo.app.",
        e
      );
      return Promise.reject(
        "Avo Inspector: something went wrong. Please report to support@avo.app."
      );
    }
  }

  _avoFunctionTrackSchemaFromEvent(
    eventName: string,
    eventProperties: { [propName: string]: any },
    eventId: string,
    eventHash: string,
    streamId?: string
  ): Promise<
    Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>
  > {
    try {
      const anonymousId = (streamId && streamId.length > 0) ? streamId : this.generatedAnonymousId;

      if (
        this.avoDeduplicator.shouldRegisterEvent(
          eventName,
          eventProperties,
          true,
          anonymousId
        )
      ) {
        if (AvoInspector.shouldLog) {
          console.log(
            "Avo Inspector: Supplied event " +
            eventName +
            " with params \n" +
            JSON.stringify(eventProperties)
          );
        }
        let eventSchema = this.extractSchema(eventProperties, false);

        return this.sendEventWithOptionalValidation(
          eventName,
          eventSchema,
          eventId,
          eventHash,
          anonymousId,
          eventProperties
        ).then(() => {
          return eventSchema;
        });
      } else {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: Deduplicated event " + eventName);
        }
        return Promise.resolve([]);
      }
    } catch (e) {
      console.error(
        "Avo Inspector: something went wrong. Please report to support@avo.app.",
        e
      );
      return Promise.reject(
        "Avo Inspector: something went wrong. Please report to support@avo.app."
      );
    }
  }

  /**
   * Try to fetch event spec and validate, then send a single event call.
   * If validation succeeds, sends a validated event (with results merged in).
   * If unavailable, sends a plain event.
   *
   * Uses trackPending() to keep the Node process alive until the work completes,
   * so short-lived processes (CLIs) don't exit before the send finishes — even
   * when the caller doesn't await the returned promise.
   */
  private sendEventWithOptionalValidation(
    eventName: string,
    eventSchema: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    eventId: string | null,
    eventHash: string | null,
    anonymousId: string,
    rawEventProperties?: { [propName: string]: any }
  ): Promise<void> {
    const work = this.doSendEventWithOptionalValidation(
      eventName, eventSchema, eventId, eventHash, anonymousId, rawEventProperties
    );
    this.trackPending(work);
    return work;
  }

  private async doSendEventWithOptionalValidation(
    eventName: string,
    eventSchema: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    eventId: string | null,
    eventHash: string | null,
    anonymousId: string,
    rawEventProperties?: { [propName: string]: any }
  ): Promise<void> {
    const validationResult = await this.fetchAndValidate(eventName, eventSchema, anonymousId, rawEventProperties, eventId);

    try {
      let body;
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
          validationResult.propertyResults
        );
      } else {
        body = this.avoNetworkCallsHandler.bodyForEventSchemaCall(
          anonymousId,
          eventName,
          eventSchema,
          eventId,
          eventHash,
          rawEventProperties
        );
      }

      await this.avoNetworkCallsHandler.callInspectorWithBatchBody([body]);

      if (AvoInspector.shouldLog) {
        const schemaString = eventSchema.map(p => '\t"' + p.propertyName + '": "' + p.propertyType + '"').join(";\n");
        console.log("Avo Inspector: Saved event " + eventName + " with schema {\n" + schemaString + "\n}");
      }
    } catch (err) {
      console.error("Avo Inspector: schema sending failed: " + err + ".");
    }
  }

  enableLogging(enable: boolean) {
    AvoInspector._shouldLog = enable;
  }

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
          JSON.stringify(eventProperties)
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
  ): Promise<{ metadata: import("./eventSpec/AvoEventSpecFetchTypes").EventSpecMetadata; propertyResults: import("./eventSpec/AvoEventSpecFetchTypes").PropertyValidationResult[] } | null> {
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
          ? { propertyValue: String(rawEventProperties[prop.propertyName]) }
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

    // Cache miss — fetch spec (process stays alive via trackPending)
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

  destroy(): void {
    if (this.eventSpecFetcher) {
      this.eventSpecFetcher.destroy();
      this.eventSpecFetcher = null;
    }
    if (this.eventSpecCache) {
      this.eventSpecCache.flush();
      this.eventSpecCache = null;
    }
    this.eventValidator = null;
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.pendingCount = 0;
  }
}
