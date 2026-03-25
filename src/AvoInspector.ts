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
      if (!hexPattern.test(this.publicEncryptionKey) || this.publicEncryptionKey.length !== 130) {
        console.warn(
          "[Avo Inspector] Warning: publicEncryptionKey does not look like a valid uncompressed P-256 public key (expected 130 hex characters). Encryption may fail."
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

        // Fire-and-forget: validate against event spec (dev/staging only)
        this.fetchAndValidateAsync(eventName, eventSchema, anonymousId, eventProperties);

        return this.trackSchemaInternal(
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
        const avoStreamId = new AvoStreamId(streamId);

        // Fire-and-forget: validate against event spec (dev/staging only)
        this.fetchAndValidateAsync(eventName, eventSchema, avoStreamId.streamId, eventProperties);

        return this.trackSchemaInternal(
          eventName,
          eventSchema,
          eventId,
          eventHash,
          avoStreamId.streamId,
          eventProperties
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
    anonymousId: string,
    rawEventProperties?: { [propName: string]: any }
  ): Promise<void> {
    try {
      await this.avoNetworkCallsHandler.callInspectorWithBatchBody([
        this.avoNetworkCallsHandler.bodyForEventSchemaCall(
          anonymousId,
          eventName,
          eventSchema,
          eventId,
          eventHash,
          rawEventProperties
        )]);
      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: schema sent successfully.");
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

      return AvoSchemaParser.extractSchema(eventProperties);
    } catch (e) {
      console.error(
        "Avo Inspector: something went wrong. Please report to support@avo.app.",
        e
      );
      return [];
    }
  }

  private fetchAndValidateAsync(
    eventName: string,
    eventSchema: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    anonymousId: string,
    rawEventProperties?: { [propName: string]: any }
  ): void {
    if (!this.eventSpecFetcher || !this.eventSpecCache || !this.eventValidator) {
      return;
    }

    const cacheKey = AvoEventSpecCache.makeKey(this.apiKey, anonymousId, eventName);
    const fetcher = this.eventSpecFetcher;
    const cache = this.eventSpecCache;
    const validator = this.eventValidator;
    const networkHandler = this.avoNetworkCallsHandler;

    const validateAndSend = (specResponse: EventSpecResponse) => {
      if (specResponse.eventSpec === null) {
        return;
      }

      const eventProperties = eventSchema.map((prop) => ({
        propertyName: prop.propertyName,
        propertyType: prop.propertyType,
        ...(rawEventProperties && rawEventProperties[prop.propertyName] !== undefined
          ? { propertyValue: String(rawEventProperties[prop.propertyName]) }
          : {}),
      }));

      const results = validator.validate(
        specResponse.eventSpec,
        eventProperties,
        eventName
      );

      networkHandler.callInspectorWithBatchBody([
        networkHandler.bodyForValidatedEventSchemaCall(
          anonymousId,
          eventName,
          specResponse.metadata,
          results
        ),
      ]).catch(() => {
        // Fire-and-forget: validation send failures are non-critical
      });
    };

    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      validateAndSend(cached);
      return;
    }

    fetcher.fetch(eventName, anonymousId, (result) => {
      if (result !== null) {
        cache.set(cacheKey, result);
        validateAndSend(result);
      }
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
  }
}
