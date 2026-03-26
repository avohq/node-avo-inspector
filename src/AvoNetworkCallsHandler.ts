import { AvoGuid } from "./AvoGuid";
import { AvoInspector } from "./AvoInspector";
import { AvoEncryption } from "./AvoEncryption";
import { request } from "https";
import { EventSpecMetadata, PropertyValidationResult } from "./eventSpec/AvoEventSpecFetchTypes";

export interface BaseBody {
  apiKey: string;
  appName: string;
  appVersion: string;
  libVersion: string;
  env: string;
  libPlatform: "node";
  messageId: string;
  trackingId: string;
  sessionId: string;
  anonymousId: string;
  createdAt: string;
  samplingRate: number;
  publicEncryptionKey?: string;
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
  streamId?: string;
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

  private static trackingEndpoint = "/inspector/v1/track";

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
  }

  callInspectorWithBatchBody(
    inEvents: Array<InspectorBody>
  ): Promise<void> {
    const events = inEvents.filter((x) => x != null);

    if (events.length === 0) {
      return Promise.resolve();
    }

    if (Math.random() > this.samplingRate) {
      if (AvoInspector.shouldLog) {
        console.log(
          "Avo Inspector: last event schema dropped due to sampling rate."
        );
      }
      return Promise.resolve();
    }

    if (AvoInspector.shouldLog) {
      events.forEach(function (event) {
        const eventProps = event.eventProperties
          .map(p => '\t"' + p.propertyName + '": "' + p.propertyType + '"')
          .join(";\n");
        const validated = event.eventSpecMetadata ? " (validated)" : "";
        console.log(
          "Avo Inspector: Sending event " +
            event.eventName + validated +
            " with schema {\n" + eventProps + "\n}"
        );
      });
    }

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(events);
      const options = {
        hostname: "api.avo.app",
        port: 443,
        path: AvoNetworkCallsHandler.trackingEndpoint,
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };

      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: [network] POST https://" + options.hostname + options.path);
        console.log("Avo Inspector: [network] Request headers: " + JSON.stringify(options.headers));
        console.log("Avo Inspector: [network] Request body (" + Buffer.byteLength(data) + " bytes): " + data);
      }

      const req = request(options, (res: any) => {
        if (AvoInspector.shouldLog) {
          console.log("Avo Inspector: [network] Response status: " + res.statusCode + " " + res.statusMessage);
          console.log("Avo Inspector: [network] Response headers: " + JSON.stringify(res.headers));
        }
        const chunks: any = [];
        res.on("data", (data: any) => chunks.push(data));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString();
          if (AvoInspector.shouldLog) {
            console.log("Avo Inspector: [network] Response body: " + responseBody);
          }
          try {
            const data = JSON.parse(responseBody);
            this.samplingRate = data.samplingRate;
          } catch (e) {
            if (AvoInspector.shouldLog) {
              console.warn("Avo Inspector: [network] Failed to parse response JSON: " + e);
            }
          }
          resolve();
        });
      });
      req.write(data);
      req.setTimeout(10_000);
      req.on("error", (err: any) => {
        if (AvoInspector.shouldLog) {
          console.error("Avo Inspector: [network] Request error: " + err);
        }
        reject("Request failed");
      });
      req.on("timeout", () => {
        if (AvoInspector.shouldLog) {
          console.error("Avo Inspector: [network] Request timed out after 10s");
        }
        req.destroy();
        reject("Request timed out");
      });
      req.end();
    });
  }

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
    rawEventProperties?: { [propName: string]: any }
  ): EventSchemaBody {
    let eventSchemaBody = this.createBaseCallBody(anonymousId) as EventSchemaBody;
    eventSchemaBody.type = "event";
    eventSchemaBody.eventName = eventName;

    if (AvoEncryption.shouldEncrypt(this.envName, this.publicEncryptionKey) && rawEventProperties) {
      eventSchemaBody.eventProperties = this.encryptProperties(eventProperties, rawEventProperties);
    } else {
      eventSchemaBody.eventProperties = eventProperties;
    }

    if (eventId != null) {
      eventSchemaBody.avoFunction = true;
      eventSchemaBody.eventId = eventId;
      eventSchemaBody.eventHash = eventHash;
    } else {
      eventSchemaBody.avoFunction = false;
      eventSchemaBody.eventId = null;
      eventSchemaBody.eventHash = null;
    }

    return eventSchemaBody;
  }

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

  bodyForValidatedEventSchemaCall(
    anonymousId: string,
    eventName: string,
    eventProperties: Array<EventProperty>,
    eventId: string | null,
    eventHash: string | null,
    eventSpecMetadata: EventSpecMetadata,
    propertyResults: PropertyValidationResult[]
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

    let body = this.createBaseCallBody(anonymousId) as EventSchemaBody;
    body.type = "event";
    body.eventName = eventName;
    body.eventProperties = mergedProperties;
    body.streamId = anonymousId;
    body.eventSpecMetadata = eventSpecMetadata;

    if (eventId != null) {
      body.avoFunction = true;
      body.eventId = eventId;
      body.eventHash = eventHash;
    } else {
      body.avoFunction = false;
      body.eventId = null;
      body.eventHash = null;
    }

    return body;
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
      const jsonValue = JSON.stringify(rawValue) ?? "null";

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

  private createBaseCallBody(anonymousId: string): BaseBody {
    const body: BaseBody = {
      apiKey: this.apiKey,
      appName: this.appName,
      appVersion: this.appVersion,
      libVersion: this.libVersion,
      env: this.envName,
      libPlatform: "node",
      messageId: AvoGuid.newGuid(),
      trackingId: "",
      sessionId: "",
      anonymousId: anonymousId,
      createdAt: new Date().toISOString(),
      samplingRate: this.samplingRate,
    };

    if (this.publicEncryptionKey && this.publicEncryptionKey.length > 0) {
      body.publicEncryptionKey = this.publicEncryptionKey;
    }

    return body;
  }
}
