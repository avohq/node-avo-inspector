import { AvoGuid } from "./AvoGuid";
import { AvoInspector } from "./AvoInspector";
import { AvoEncryption } from "./AvoEncryption";
import { AvoLog } from "./AvoLog";
import { LIB_PLATFORM } from "./AvoInspectorVersion";
import { formatSchema, hasHeaderControlChar, hasNonLatin1Char } from "./utils";
import { request as httpsRequest } from "https";
import { request as httpRequest, ClientRequest } from "http";
import { gzip } from "zlib";
import { EventSpecMetadata, PropertyValidationResult } from "./eventSpec/AvoEventSpecFetchTypes";

export interface BaseBody {
  apiKey: string;
  appName: string;
  appVersion: string | null;
  libVersion: string;
  env: string;
  libPlatform: "node";
  messageId: string;
  streamId: string;
  anonymousId: string;
  createdAt: string;
  samplingRate: number;
  publicEncryptionKey?: string;
}

// Per-event gateway fields, already normalized (see AvoInspector.resolveTrackOptions).
export interface ResolvedTrackOptions {
  appVersion: string | null;
  outputReference?: string;
  originHint?: string;
  /** True when the caller supplied at least one non-blank gateway option. */
  gatewayScoped: boolean;
}

// When an event was tracked, and the sampling rate that decided it was kept.
export interface CallStamp {
  createdAt: string;
  samplingRate: number;
}

export interface EventPropertyEncrypted {
  propertyName: string;
  propertyType: string;
  encryptedPropertyValue: string;
  children?: any;
}

export interface EventPropertyPlain {
  propertyName: string;
  propertyType: string;
  children?: any;
}

export interface EventPropertyValidation {
  failedEventIds?: string[];
  passedEventIds?: string[];
}

export type EventProperty = (EventPropertyEncrypted | EventPropertyPlain) & EventPropertyValidation;

export interface EventSchemaBody extends BaseBody {
  type: "event";
  eventName: string;
  eventProperties: Array<EventProperty>;
  avoFunction: boolean;
  eventId: string | null;
  eventHash: string | null;
  outputReference?: string;
  originHint?: string;
  eventSpecMetadata?: EventSpecMetadata;
}

export type InspectorBody = EventSchemaBody;

export class AvoNetworkCallsHandler {
  private apiKey: string;
  private envName: string;
  private appName: string;
  private appVersion: string;
  private libVersion: string;
  private samplingRate: number = 1.0;
  private publicEncryptionKey?: string;
  private inFlightRequests: Set<ClientRequest> = new Set();
  private aborted = false;
  /** The valid mock-endpoint override in effect for this instance, read once, or null. */
  readonly mockEndpoint: string | null;

  private static trackingEndpoint = "https://api.avo.app/inspector/v2/track";
  private static mockEndpointEnvVar = "AVO_INSPECTOR_MOCK_ENDPOINT";
  private static requestTimeoutMs = 10_000;
  private static gzipThresholdBytes = 1024;

  constructor(
    apiKey: string,
    envName: string,
    appName: string,
    appVersion: string,
    libVersion: string,
    publicEncryptionKey?: string
  ) {
    this.apiKey = apiKey;
    this.envName = envName;
    this.appName = appName;
    this.appVersion = appVersion;
    this.libVersion = libVersion;
    this.publicEncryptionKey = publicEncryptionKey;
    this.mockEndpoint = AvoNetworkCallsHandler.mockEndpointFor(envName);
  }

  /**
   * The test-only endpoint override. Fail-closed: a prod instance never honors it,
   * whatever the surrounding process environment says. A value that is not an http(s)
   * URL is ignored (with a one-time warning), so callers only ever see a valid URL.
   */
  static mockEndpointFor(envName: string): string | null {
    if (envName === "prod") {
      return null;
    }
    const override = process.env[AvoNetworkCallsHandler.mockEndpointEnvVar];
    if (!override) {
      return null;
    }
    // The warnings name the reason only, never the value: it may carry credentials or tokens.
    // The value is used solely as the key that keeps each warning to one per value.
    let url: URL;
    try {
      url = new URL(override);
    } catch (e) {
      AvoNetworkCallsHandler.warnOnce(
        "invalid:" + override,
        "[Avo Inspector] Ignoring invalid AVO_INSPECTOR_MOCK_ENDPOINT: not a valid URL"
      );
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      AvoNetworkCallsHandler.warnOnce(
        "invalid:" + override,
        "[Avo Inspector] Ignoring invalid AVO_INSPECTOR_MOCK_ENDPOINT: unsupported protocol " + url.protocol
      );
      return null;
    }
    return override;
  }

  // Printed on the first send redirected to the override.
  private static warnRedirect(url: URL): void {
    // Scheme, host and port only: the path or query may carry sensitive values.
    AvoNetworkCallsHandler.warnOnce(
      "redirect",
      "[Avo Inspector] AVO_INSPECTOR_MOCK_ENDPOINT is set: sending to " + url.protocol + "//" +
        url.host + " instead of api.avo.app (ignored in prod)."
    );
  }

  // Warnings about the override print once per process, whatever the logging flag, on
  // stderr (console.warn).
  private static warnedMockEndpoint: Set<string> | null = null;

  private static warnOnce(key: string, message: string): void {
    if (AvoNetworkCallsHandler.warnedMockEndpoint === null) {
      AvoNetworkCallsHandler.warnedMockEndpoint = new Set();
    }
    if (!AvoNetworkCallsHandler.warnedMockEndpoint.has(key)) {
      AvoNetworkCallsHandler.warnedMockEndpoint.add(key);
      console.warn(message);
    }
  }

  /** The sampling rate last returned by the Inspector API (1 until a response sets it). */
  getSamplingRate(): number {
    return this.samplingRate;
  }

  /** @internal Test-only hook used by the conformance harness. */
  _setSamplingRateForTesting(samplingRate: number): void {
    this.samplingRate = samplingRate;
  }

  /** Aborts every request still in flight (used by AvoInspector.destroy). */
  abortInFlight(): void {
    // Also stops sends still being compressed from starting a request afterwards.
    this.aborted = true;
    const requests = Array.from(this.inFlightRequests);
    this.inFlightRequests.clear();
    requests.forEach((req) => req.destroy());
  }

  /**
   * POSTs one batch. Resolves with the HTTP status code (the batch is never retried);
   * rejects with "Request failed" / "Request timed out" on transport failures, or when
   * a header value cannot be transmitted safely.
   */
  callInspectorWithBatchBody(
    inEvents: Array<InspectorBody>
  ): Promise<number | void> {
    const events = inEvents.filter((x) => x != null);

    if (events.length === 0) {
      return Promise.resolve();
    }

    if (AvoInspector.shouldLog) {
      events.forEach(function (event) {
        const validated = event.eventSpecMetadata ? " (validated)" : "";
        console.log(
          "Avo Inspector: Sending event " +
            event.eventName + validated +
            " with schema " + formatSchema(event.eventProperties)
        );
      });
    }

    const json = Buffer.from(JSON.stringify(events), "utf8");
    // Compressed off the event loop; on a compression error the body is sent as-is.
    const body: Promise<{ data: Buffer; compressed: boolean }> =
      json.length >= AvoNetworkCallsHandler.gzipThresholdBytes
        ? AvoNetworkCallsHandler.gzipAsync(json).then(
            (data) => ({ data, compressed: true }),
            () => ({ data: json, compressed: false })
          )
        : Promise.resolve({ data: json, compressed: false });

    return body.then(({ data, compressed }) => this.post(data, compressed));
  }

  private static gzipAsync(input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      gzip(input, (err, output) => (err ? reject(err) : resolve(output)));
    });
  }

  private post(data: Buffer, compressed: boolean): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      if (this.aborted) {
        reject("Request failed");
        return;
      }

      const headers: { [name: string]: string | number } = {
        "api-key": this.apiKey,
        "env": this.envName,
        "X-Avo-Client": LIB_PLATFORM,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Content-Length": data.length,
      };
      if (compressed) {
        headers["Content-Encoding"] = "gzip";
      }

      for (const name of Object.keys(headers)) {
        const value = headers[name];
        if (typeof value === "string" && (hasHeaderControlChar(value) || hasNonLatin1Char(value))) {
          if (AvoInspector.shouldLog) {
            console.error(
              "Avo Inspector: [network] Header " + name +
                " contains a character that cannot be sent in a header. Batch dropped."
            );
          }
          reject("Request failed");
          return;
        }
      }

      const url = new URL(this.mockEndpoint || AvoNetworkCallsHandler.trackingEndpoint);
      if (this.mockEndpoint) {
        AvoNetworkCallsHandler.warnRedirect(url);
      }
      const send = url.protocol === "http:" ? httpRequest : httpsRequest;

      if (AvoInspector.shouldLog) {
        // An override's path may carry a token, so only its origin is printed.
        console.log("Avo Inspector: [network] POST " + url.origin + (this.mockEndpoint ? "" : url.pathname));
        console.log(
          "Avo Inspector: [network] Request body (" + data.length + " bytes" +
            (compressed ? ", gzip" : "") + ")"
        );
      }

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.inFlightRequests.delete(req);
        fn();
      };

      let req: ClientRequest;
      try {
        req = send(url, { method: "POST", headers }, (res) => {
          if (AvoInspector.shouldLog) {
            console.log("Avo Inspector: [network] Response status: " + res.statusCode + " " + res.statusMessage);
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                const responseBody = Buffer.concat(chunks).toString();
                const body = JSON.parse(responseBody);
                if (body && typeof body.samplingRate === "number" && body.samplingRate >= 0 && body.samplingRate <= 1) {
                  this.samplingRate = body.samplingRate;
                }
              } catch (e) {
                if (AvoInspector.shouldLog) {
                  console.warn("Avo Inspector: [network] Failed to parse response JSON: " + e);
                }
              }
            } else if (AvoInspector.shouldLog) {
              console.warn("Avo Inspector: [network] Non-200 response: " + res.statusCode);
            }
            finish(() => resolve(res.statusCode));
          });
          // A response cut off mid-body emits neither "end" nor a request "error". Its status
          // already arrived and decides, as for an unparseable body: a 200 is delivered (the
          // sampling rate is unchanged), anything else a non-200.
          const truncated = () => {
            if (!res.complete) {
              if (AvoInspector.shouldLog && !settled) {
                console.warn("Avo Inspector: [network] Response ended before its body was complete");
              }
              finish(() => resolve(res.statusCode));
            }
          };
          res.on("aborted", truncated);
          res.on("error", truncated);
          res.on("close", truncated);
        });
      } catch (e) {
        // A synchronous throw (for example invalid request options) is a failed send, with
        // the documented reason; nothing was started, so there is nothing to clean up.
        if (AvoInspector.shouldLog) {
          console.error("Avo Inspector: [network] Request could not be started");
        }
        reject("Request failed");
        return;
      }
      this.inFlightRequests.add(req);
      // An in-flight send must not hold the process open: at exit the beforeExit drain
      // keeps it alive, under one deadline, while it sends what is left.
      req.on("socket", (socket) => socket.unref());

      // A wall-clock budget for the whole request, not just socket idleness.
      const timer = setTimeout(() => {
        if (AvoInspector.shouldLog) {
          console.error("Avo Inspector: [network] Request timed out after 10s");
        }
        finish(() => reject("Request timed out"));
        req.destroy();
      }, AvoNetworkCallsHandler.requestTimeoutMs);
      timer.unref();

      req.on("error", (err: any) => {
        if (AvoInspector.shouldLog && !settled) {
          console.error("Avo Inspector: [network] Request error: " + err);
        }
        finish(() => reject("Request failed"));
      });
      req.end(data);
    });
  }

  /** Builds the wire body for one event, encrypting property values when configured. */
  bodyForEventSchemaCall(
    anonymousId: string,
    eventName: string,
    eventProperties: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    eventId: string | null,
    eventHash: string | null,
    rawEventProperties?: { [propName: string]: any },
    trackOptions?: ResolvedTrackOptions,
    stamp?: CallStamp
  ): EventSchemaBody {
    let eventSchemaBody = this.createBaseCallBody(anonymousId, trackOptions, stamp) as EventSchemaBody;
    eventSchemaBody.type = "event";
    eventSchemaBody.eventName = eventName;

    if (AvoEncryption.shouldEncrypt(this.envName, this.publicEncryptionKey) && rawEventProperties) {
      eventSchemaBody.eventProperties = this.encryptProperties(eventProperties, rawEventProperties);
    } else {
      eventSchemaBody.eventProperties = eventProperties;
    }

    AvoNetworkCallsHandler.applyAvoFunctionFields(eventSchemaBody, eventId, eventHash);

    return eventSchemaBody;
  }

  /** Returns the event properties, with values encrypted when encryption applies. */
  buildEventProperties(
    eventProperties: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    rawEventProperties?: { [propName: string]: any }
  ): Array<EventProperty> {
    if (AvoEncryption.shouldEncrypt(this.envName, this.publicEncryptionKey) && rawEventProperties) {
      return this.encryptProperties(eventProperties, rawEventProperties);
    }
    return eventProperties;
  }

  /** Builds the wire body for one event, including its event-spec validation results. */
  bodyForValidatedEventSchemaCall(
    anonymousId: string,
    eventName: string,
    eventProperties: Array<EventProperty>,
    eventId: string | null,
    eventHash: string | null,
    eventSpecMetadata: EventSpecMetadata,
    propertyResults: PropertyValidationResult[],
    trackOptions?: ResolvedTrackOptions,
    stamp?: CallStamp
  ): EventSchemaBody {
    // Build a map of validation results by property name
    const validationMap = new Map<string, PropertyValidationResult>();
    for (const result of propertyResults) {
      validationMap.set(result.propertyName, result);
    }

    // Merge validation results into eventProperties (matching Android)
    const mergedProperties: Array<EventProperty> = eventProperties.map((prop) => {
      const validation = validationMap.get(prop.propertyName);
      if (validation) {
        const merged: EventProperty = { ...prop };
        if (validation.failedEventIds.length > 0) {
          merged.failedEventIds = validation.failedEventIds;
        }
        if (validation.passedEventIds.length > 0) {
          merged.passedEventIds = validation.passedEventIds;
        }
        return merged;
      }
      return prop;
    });

    let body = this.createBaseCallBody(anonymousId, trackOptions, stamp) as EventSchemaBody;
    body.type = "event";
    body.eventName = eventName;
    body.eventProperties = mergedProperties;
    body.eventSpecMetadata = eventSpecMetadata;

    AvoNetworkCallsHandler.applyAvoFunctionFields(body, eventId, eventHash);

    return body;
  }

  // An event with an eventId came from an Avo function (Codegen): it carries the id and hash.
  private static applyAvoFunctionFields(body: EventSchemaBody, eventId: string | null, eventHash: string | null): void {
    if (eventId != null) {
      body.avoFunction = true;
      body.eventId = eventId;
      body.eventHash = eventHash;
    } else {
      body.avoFunction = false;
      body.eventId = null;
      body.eventHash = null;
    }
  }

  private encryptProperties(
    properties: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>,
    rawEventProperties: { [propName: string]: any }
  ): Array<EventProperty> {
    const result: Array<EventProperty> = [];

    for (const prop of properties) {
      // List-type properties: omit entirely
      if (AvoEncryption.isListType(prop.propertyType)) {
        continue;
      }

      const rawValue = rawEventProperties[prop.propertyName];
      let jsonValue: string;
      try {
        jsonValue = JSON.stringify(rawValue) ?? "null";
      } catch (e) {
        // A value that cannot be serialized (e.g. cyclic) is omitted, like an encryption failure.
        // Only the error's type is printed: toJSON, getters and proxies can put the value in it.
        console.warn(
          `[Avo Inspector] Warning: could not serialize property "${prop.propertyName}" for encryption, omitting it. (${AvoLog.errorType(e)})`
        );
        continue;
      }

      const encrypted = AvoEncryption.encryptValue(
        jsonValue,
        this.publicEncryptionKey!
      );

      if (encrypted === null) {
        // Encryption failure: omit the property (warning already logged by encryptValue)
        continue;
      }

      result.push({
        propertyName: prop.propertyName,
        propertyType: prop.propertyType,
        encryptedPropertyValue: encrypted,
        ...(prop.children !== undefined ? { children: prop.children } : {}),
      });
    }

    return result;
  }

  // `stamp` defaults to now and the current sampling rate.
  private createBaseCallBody(
    anonymousId: string,
    trackOptions?: ResolvedTrackOptions,
    stamp?: CallStamp
  ): BaseBody {
    const body: BaseBody = {
      apiKey: this.apiKey,
      appName: this.appName,
      appVersion: trackOptions ? trackOptions.appVersion : this.appVersion,
      libVersion: this.libVersion,
      env: this.envName,
      libPlatform: LIB_PLATFORM,
      messageId: AvoGuid.newGuid(),
      streamId: anonymousId,
      anonymousId: anonymousId,
      createdAt: stamp ? stamp.createdAt : new Date().toISOString(),
      samplingRate: stamp ? stamp.samplingRate : this.samplingRate,
    };

    // Gateway coordinates are sent only when present; never as null or "".
    if (trackOptions && trackOptions.outputReference !== undefined) {
      (body as EventSchemaBody).outputReference = trackOptions.outputReference;
    }
    if (trackOptions && trackOptions.originHint !== undefined) {
      (body as EventSchemaBody).originHint = trackOptions.originHint;
    }

    if (this.publicEncryptionKey && this.publicEncryptionKey.length > 0) {
      body.publicEncryptionKey = this.publicEncryptionKey;
    }

    return body;
  }
}
