import { request, Agent, RequestOptions } from "https";
import { ClientRequest } from "http";
import { EventSpecResponse, EventSpec, EventSpecMetadata, PropertyConstraint } from "./AvoEventSpecFetchTypes";
import { AvoInspector } from "../AvoInspector";

type FetchCallback = (result: EventSpecResponse | null) => void;

// The callbacks waiting on one key, and the request that owns the key.
interface PendingFetch {
  callbacks: FetchCallback[];
  owner: object;
}

// One keep-alive agent for every instance, so creating many instances (for example one per
// request) cannot pile up idle TLS sockets. Idle sockets are capped and do not hold the
// process open.
const sharedAgent = new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });

export class AvoEventSpecFetcher {
  private apiKey: string;
  private inFlight: Map<string, PendingFetch> = new Map();
  private agent: Agent = sharedAgent;
  private requests: Set<ClientRequest> = new Set();

  private static specEndpoint = "/trackingPlan/eventSpec";
  // Wall-clock budget per fetch, from the moment it is requested, and the only timeout: a
  // socket-idle timeout would start only once the shared agent assigns a socket, so a fetch
  // queued behind 8 hung ones would wait for theirs first.
  private static fetchTimeoutMs = 10_000;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  fetch(
    eventName: string,
    streamId: string,
    callback: FetchCallback
  ): void {
    const dedupeKey = `${this.apiKey}:${streamId}:${eventName}`;

    // In-flight dedup: if there's already a request in flight for this key,
    // queue the callback
    const existing = this.inFlight.get(dedupeKey);
    if (existing) {
      existing.callbacks.push(callback);
      return;
    }

    // Register the callback and start the request
    const owner = {};
    this.inFlight.set(dedupeKey, { callbacks: [callback], owner });
    // A request settles its key once. A late event (for example the error from a request
    // destroyed on timeout) must not settle a newer fetch that has taken the key since.
    let settled = false;
    const settle = (result: EventSpecResponse | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      this.resolveCallbacks(dedupeKey, owner, result);
    };

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
      console.log("Avo Inspector: [network] GET https://" + options.hostname + AvoEventSpecFetcher.specEndpoint + "?eventName=" + encodeURIComponent(eventName));
    }

    // Created before the request: a response can settle synchronously inside request().
    // `req` stays undefined if request() throws, so the callback must not assume it.
    let req: ClientRequest | undefined;
    const deadline = setTimeout(() => {
      if (AvoInspector.shouldLog) {
        console.error("Avo Inspector: [network] Spec fetch timed out after " + AvoEventSpecFetcher.fetchTimeoutMs + "ms");
      }
      if (req) {
        req.destroy();
      }
      settle(null);
    }, AvoEventSpecFetcher.fetchTimeoutMs);
    deadline.unref();

    try {
      req = this.send(options, eventName, settle);
    } catch (e) {
      if (AvoInspector.shouldLog) {
        console.error("Avo Inspector: [network] Spec fetch error: " + e);
      }
      settle(null);
      return;
    }
    const sent = req;
    this.requests.add(sent);
    sent.on("close", () => {
      clearTimeout(deadline);
      this.requests.delete(sent);
    });
    sent.end();
  }

  // Starts the GET; every outcome (response, parse failure, transport error) goes to settle.
  private send(
    options: RequestOptions,
    eventName: string,
    settle: (result: EventSpecResponse | null) => void
  ): ClientRequest {
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
          settle(null);
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
        settle(result);
      });
      // A response cut off mid-body emits neither "end" nor a request "error"; without this
      // the fetch would wait for its deadline, holding the key for every same-key fetch.
      const truncated = () => {
        if (!res.complete) {
          if (AvoInspector.shouldLog) {
            console.error("Avo Inspector: [network] Spec response ended before its body was complete");
          }
          settle(null);
        }
      };
      res.on("aborted", truncated);
      res.on("error", truncated);
      res.on("close", truncated);
    });

    req.on("error", (err) => {
      if (AvoInspector.shouldLog) {
        console.error("Avo Inspector: [network] Spec fetch error: " + err);
      }
      settle(null);
    });
    return req;
  }

  private resolveCallbacks(
    key: string,
    owner: object,
    result: EventSpecResponse | null
  ): void {
    const pending = this.inFlight.get(key);
    if (!pending || pending.owner !== owner) {
      return;
    }
    this.inFlight.delete(key);

    if (pending) {
      for (const cb of pending.callbacks) {
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

  /** Aborts this instance's in-flight requests; the shared agent stays usable. */
  destroy(): void {
    const requests = Array.from(this.requests);
    this.requests.clear();
    requests.forEach((req) => req.destroy());
  }
}
