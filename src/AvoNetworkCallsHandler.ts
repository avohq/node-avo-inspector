import { AvoGuid } from "./AvoGuid";
import { AvoInspector } from "./AvoInspector";
import { AvoEncryption } from "./AvoEncryption";
import { request } from "https";

export interface BaseBody {
  apiKey: string;
  appName: string;
  appVersion: string;
  libVersion: string;
  env: string;
  libPlatform: "node";
  messageId: string;
  anonymousId: string;
  createdAt: string;
  samplingRate: number;
  publicEncryptionKey?: string;
}

export interface EventPropertyEncrypted {
  propertyName: string;
  encryptedPropertyValue: string;
  children?: any;
}

export interface EventPropertyPlain {
  propertyName: string;
  propertyType: string;
  children?: any;
}

export type EventProperty = EventPropertyEncrypted | EventPropertyPlain;

export interface EventSchemaBody extends BaseBody {
  type: "event";
  eventName: string;
  eventProperties: Array<EventProperty>;
  avoFunction: boolean;
  eventId: string | null;
  eventHash: string | null;
}

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
    inEvents: Array<EventSchemaBody>
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
        if (event.type === "event") {
          let schemaEvent: EventSchemaBody = event;
          console.log(
            "Avo Inspector: sending event " +
              schemaEvent.eventName +
              " with schema " +
              JSON.stringify(schemaEvent.eventProperties)
          );
        }
      });
    }

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(events);
      var options = {
        hostname: "api.avo.app",
        port: 443,
        path: AvoNetworkCallsHandler.trackingEndpoint,
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(data),
        },
      };
      var req = request(options, (res: any) => {
        const chunks: any = [];
        res.on("data", (data: any) => chunks.push(data));
        res.on("end", () => {
          try {
            // @ts-ignore
            const data = JSON.parse(Buffer.concat(chunks).toString());
            // @ts-ignore
            this.samplingRate = data.samplingRate;
          } catch (e) {}
          resolve();
        });
      });
      req.write(data);
      req.on("error", () => {
        reject("Request failed");
      });
      req.on("timeout", () => {
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
    eventHash: string | null
  ): EventSchemaBody {
    let eventSchemaBody = this.createBaseCallBody(anonymousId) as EventSchemaBody;
    eventSchemaBody.type = "event";
    eventSchemaBody.eventName = eventName;

    if (AvoEncryption.shouldEncrypt(this.envName, this.publicEncryptionKey)) {
      eventSchemaBody.eventProperties = this.encryptProperties(eventProperties);
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

  private encryptProperties(
    properties: Array<{
      propertyName: string;
      propertyType: string;
      children?: any;
    }>
  ): Array<EventProperty> {
    const result: Array<EventProperty> = [];

    for (const prop of properties) {
      // List-type properties: omit entirely
      if (AvoEncryption.isListType(prop.propertyType)) {
        continue;
      }

      const encrypted = AvoEncryption.encryptValue(
        prop.propertyType,
        this.publicEncryptionKey!
      );

      if (encrypted === null) {
        // Encryption failure: omit the property (warning already logged by encryptValue)
        continue;
      }

      result.push({
        propertyName: prop.propertyName,
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
