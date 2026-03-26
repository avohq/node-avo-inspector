import { request, Agent } from "https";
import { EventSpecResponse, EventSpec, EventSpecMetadata, PropertyConstraint } from "./AvoEventSpecFetchTypes";
import { AvoInspector } from "../AvoInspector";

type FetchCallback = (result: EventSpecResponse | null) => void;

export class AvoEventSpecFetcher {
  private apiKey: string;
  private inFlight: Map<string, FetchCallback[]> = new Map();
  private agent: Agent;

  private static specEndpoint = "/trackingPlan/eventSpec";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.agent = new Agent({ keepAlive: true });
  }

  fetch(
    eventName: string,
    streamId: string,
    callback: FetchCallback
  ): void {
    const dedupeKey = `${this.apiKey}:${streamId}:${eventName}`;

    // In-flight dedup: if there's already a request in flight for this key,
    // queue the callback
    const existingCallbacks = this.inFlight.get(dedupeKey);
    if (existingCallbacks) {
      existingCallbacks.push(callback);
      return;
    }

    // Register the callback and start the request
    this.inFlight.set(dedupeKey, [callback]);

    const queryParams = new URLSearchParams({
      apiKey: this.apiKey,
      eventName,
      streamId,
    });

    const options = {
      hostname: "api.avo.app",
      port: 443,
      path: `${AvoEventSpecFetcher.specEndpoint}?${queryParams.toString()}`,
      method: "GET",
      agent: this.agent,
      headers: {
        Accept: "application/json",
      },
    };

    if (AvoInspector.shouldLog) {
      console.log("Avo Inspector: [network] GET https://" + options.hostname + options.path);
    }

    const req = request(options, (res) => {
      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: [network] Spec response status: " + res.statusCode + " " + res.statusMessage);
      }
      const chunks: Buffer[] = [];
      res.on("data", (data: Buffer) => chunks.push(data));
      res.on("end", () => {
        let result: EventSpecResponse | null = null;
        if (res.statusCode !== 200) {
          if (AvoInspector.shouldLog) {
            const body = Buffer.concat(chunks).toString();
            console.warn("Avo Inspector: [network] Spec fetch failed with status " + res.statusCode + ": " + body);
          }
          this.resolveCallbacks(dedupeKey, null);
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString();
          if (AvoInspector.shouldLog) {
            console.log("Avo Inspector: [network] Spec response body: " + body);
          }
          const wire = JSON.parse(body);
          result = AvoEventSpecFetcher.parseWireResponse(wire, eventName);
          if (AvoInspector.shouldLog) {
            console.log("Avo Inspector: [network] Parsed spec: " + JSON.stringify(result));
          }
        } catch (e) {
          if (AvoInspector.shouldLog) {
            console.warn("Avo Inspector: [network] Failed to parse spec response: " + e);
          }
        }
        this.resolveCallbacks(dedupeKey, result);
      });
    });

    req.on("error", (err) => {
      if (AvoInspector.shouldLog) {
        console.error("Avo Inspector: [network] Spec fetch error: " + err);
      }
      this.resolveCallbacks(dedupeKey, null);
    });

    req.setTimeout(10_000);
    req.on("timeout", () => {
      if (AvoInspector.shouldLog) {
        console.error("Avo Inspector: [network] Spec fetch timed out after 10s");
      }
      req.destroy();
      this.resolveCallbacks(dedupeKey, null);
    });

    req.end();
  }

  private resolveCallbacks(
    key: string,
    result: EventSpecResponse | null
  ): void {
    const callbacks = this.inFlight.get(key);
    this.inFlight.delete(key);

    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(result);
        } catch (e) {
          // Don't let one callback failure affect others
        }
      }
    }
  }

  /**
   * Parse the wire format from /trackingPlan/eventSpec into our internal types.
   *
   * Wire format:
   *   { events: [{ b, id, vids, p: { "PropName": { t: "string", r: true, v: {...}, rx: {...} } } }],
   *     metadata: { schemaId, branchId, latestActionId, sourceId } }
   *
   * Internal format:
   *   { eventSpec: { eventName, properties: [{ propertyName, propertyType, regex? }] } | null,
   *     metadata: { schemaId, branchId, latestActionId, sourceId } }
   */
  static parseWireResponse(wire: any, eventName: string): EventSpecResponse {
    const metadata: EventSpecMetadata = {
      schemaId: wire.metadata?.schemaId ?? "",
      branchId: wire.metadata?.branchId ?? "",
      latestActionId: wire.metadata?.latestActionId ?? "",
      sourceId: wire.metadata?.sourceId ?? "",
    };

    if (!wire.events || !Array.isArray(wire.events) || wire.events.length === 0) {
      return { eventSpec: null, metadata };
    }

    // Use the first event entry (the endpoint returns specs for the requested event)
    const entry = wire.events[0];
    const properties: PropertyConstraint[] = [];

    if (entry.p && typeof entry.p === "object") {
      for (const propName of Object.keys(entry.p)) {
        const constraint = entry.p[propName];
        const prop: PropertyConstraint = {
          propertyName: propName,
          propertyType: constraint?.t ?? "unknown",
        };
        // Extract regex pattern if present (rx field maps regex patterns to event IDs)
        if (constraint?.rx && typeof constraint.rx === "object") {
          const patterns = Object.keys(constraint.rx);
          if (patterns.length > 0) {
            prop.regex = patterns[0];
          }
        }
        properties.push(prop);
      }
    }

    const eventSpec: EventSpec = {
      eventName,
      properties,
    };

    return { eventSpec, metadata };
  }

  destroy(): void {
    this.agent.destroy();
  }
}
