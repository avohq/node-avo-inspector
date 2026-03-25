import { AvoInspectorEnv, AvoInspectorEnvValueType } from "./AvoInspectorEnv";
import { AvoSchemaParser } from "./AvoSchemaParser";
import { AvoNetworkCallsHandler } from "./AvoNetworkCallsHandler";
import { AvoDeduplicator } from "./AvoDeduplicator";
import { AvoStreamId } from "./AvoStreamId";
import { AvoEventSpecFetcher } from "./eventSpec/AvoEventSpecFetcher";
import { AvoEventSpecCache } from "./eventSpec/AvoEventSpecCache";
import { EventValidator } from "./eventSpec/EventValidator";
import { EventSpecResponse, ValidatedEventPayload } from "./eventSpec/AvoEventSpecFetchTypes";

import { isValueEmpty } from "./utils";

const libVersion = require("../package.json").version;

export class AvoInspector {
  environment: AvoInspectorEnvValueType;
  avoNetworkCallsHandler: AvoNetworkCallsHandler;
  avoDeduplicator: AvoDeduplicator;
  apiKey: string;
  version: string;
  publicEncryptionKey?: string;

  private eventSpecFetcher?: AvoEventSpecFetcher;
  private eventSpecCache?: AvoEventSpecCache;
  private eventValidator?: EventValidator;

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

    // Event spec validation is only active in dev/staging, NOT in prod
    if (
      this.environment === AvoInspectorEnv.Dev ||
      this.environment === AvoInspectorEnv.Staging
    ) {
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
      const anonymousId = avoStreamId.streamId;

      if (
        this.avoDeduplicator.shouldRegisterEvent(
          eventName,
          eventProperties,
          false
        )
      ) {
        if (AvoInspector.shouldLog) {
          console.log(
            "Avo Inspector: supplied event " +
            eventName +
            " with params " +
            JSON.stringify(eventProperties)
          );
        }
        let eventSchema = this.extractSchema(eventProperties, false);
        return this.trackSchemaInternal(
          eventName,
          eventSchema,
          null,
          null,
          anonymousId
        ).then(() => {
          return eventSchema;
        });
      } else {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: Deduplicated event: " + eventName);
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

  private _avoFunctionTrackSchemaFromEvent(
    eventName: string,
    eventProperties: { [propName: string]: any },
    eventId: string,
    eventHash: string
  ): Promise<
    Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>
  > {
    try {
      if (
        this.avoDeduplicator.shouldRegisterEvent(
          eventName,
          eventProperties,
          true
        )
      ) {
        if (AvoInspector.shouldLog) {
          console.log(
            "Avo Inspector: supplied event " +
            eventName +
            " with params " +
            JSON.stringify(eventProperties)
          );
        }
        let eventSchema = this.extractSchema(eventProperties, false);
        return this.trackSchemaInternal(
          eventName,
          eventSchema,
          eventId,
          eventHash,
          ""
        ).then(() => {
          return eventSchema;
        });
      } else {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: Deduplicated event: " + eventName);
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

  private async trackSchemaInternal(
    eventName: string,
    eventSchema: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    eventId: string | null,
    eventHash: string | null,
    anonymousId: string
  ): Promise<void> {
    try {
      await this.avoNetworkCallsHandler.callInspectorWithBatchBody([
        this.avoNetworkCallsHandler.bodyForEventSchemaCall(
          anonymousId,
          eventName,
          eventSchema,
          eventId,
          eventHash
        )]);
      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: schema sent successfully.");
      }
    } catch (err) {
      console.error("Avo Inspector: schema sending failed: " + err + ".");
    }
  }

  isSpecValidationEnabled(): boolean {
    return (
      this.environment === AvoInspectorEnv.Dev ||
      this.environment === AvoInspectorEnv.Staging
    );
  }

  /**
   * Opt-in async validation API — does NOT run automatically from trackSchemaFromEvent.
   * Fetches backend event specs via eventSpecFetcher and validates locally extracted
   * schemas against them. Only performs work when isSpecValidationEnabled() is true
   * (Dev/Staging environments).
   *
   * On cache hit, validation runs synchronously. On cache miss, an async fetch is
   * performed and the result is cached for subsequent calls.
   *
   * Call this after trackSchemaFromEvent when you want to validate the extracted
   * schema against backend specs.
   *
   * @returns A Promise that resolves when validation/fetch completes.
   */
  async fetchAndValidateAsync(
    eventName: string,
    eventSchema: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    streamId: string
  ): Promise<void> {
    if (!this.isSpecValidationEnabled()) {
      return;
    }

    const cache = this.eventSpecCache!;
    const fetcher = this.eventSpecFetcher!;
    const validator = this.eventValidator!;
    const cacheKey = AvoEventSpecCache.makeKey(this.apiKey, streamId, eventName);

    const cached = cache.get(cacheKey);

    if (cached !== undefined) {
      // Cache hit: synchronous validation (null means spec was intentionally stored as null)
      if (cached !== null) {
        this.validateAndReport(cached, eventName, eventSchema, streamId, validator);
      }
      return;
    }

    // Cache miss: async fetch
    return new Promise<void>((resolve) => {
      fetcher.fetch(eventName, streamId, (result) => {
        if (result !== null) {
          cache.set(cacheKey, result);
          this.validateAndReport(result, eventName, eventSchema, streamId, validator);
        } else {
          // Cache null with a short TTL to avoid hammering the endpoint on persistent failures
          cache.set(cacheKey, null);
        }
        resolve();
      });
    });
  }

  private validateAndReport(
    specResponse: EventSpecResponse,
    eventName: string,
    eventSchema: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    streamId: string,
    validator: EventValidator
  ): void {
    if (specResponse.eventSpec === null) {
      return;
    }

    const eventId = `${eventName}-${Date.now()}`;
    const propertyResults = validator.validate(
      specResponse.eventSpec,
      eventSchema,
      eventId
    );

    const payload: ValidatedEventPayload = {
      streamId,
      eventName,
      eventSpecMetadata: specResponse.metadata,
      propertyResults,
    };

    if (AvoInspector.shouldLog) {
      console.log(
        "Avo Inspector: validated event " +
          eventName +
          " with results " +
          JSON.stringify(payload)
      );
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

      return AvoSchemaParser.extractSchema(eventProperties);
    } catch (e) {
      console.error(
        "Avo Inspector: something went wrong. Please report to support@avo.app.",
        e
      );
      return [];
    }
  }
}
