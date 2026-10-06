import { request, Agent, RequestOptions } from "https";
import { request as httpRequest, Agent as HttpAgent, ClientRequest } from "http";
import { EventSpecResponse, EventSpec, EventSpecMetadata, PropertyConstraint } from "./AvoEventSpecFetchTypes";
import { AvoInspector } from "../AvoInspector";
import { AvoLog } from "../AvoLog";

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
// The same, for an http: mock endpoint.
const sharedHttpAgent = new HttpAgent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });

export class AvoEventSpecFetcher {
  private apiKey: string;
  // Where spec requests go: api.avo.app, or the origin of the mock-endpoint override.
  private protocol: "http:" | "https:" = "https:";
  private hostname = "api.avo.app";
  private port: number = 443;
  private inFlight: Map<string, PendingFetch> = new Map();
  private agent: Agent = sharedAgent;
  private requests: Set<ClientRequest> = new Set();

  private static specEndpoint = "/trackingPlan/eventSpec";
  // Budget per fetch, from the moment the shared agent assigns it a socket. Counting from
  // the request instead would expire fetches queued behind 8 slow ones before they were
  // ever sent.
  private static fetchTimeoutMs = 10_000;
  // Budget for the wait before a socket is assigned. Without it, fetches queued behind 8
  // hung ones would wait for every earlier deadline in turn.
  private static socketWaitTimeoutMs = 10_000;
  /** @internal Fetches given up at a deadline, process-wide: the exit drain reads it. */
  static timeouts = 0;

  /** `mockEndpoint`: a valid override URL (AvoNetworkCallsHandler.mockEndpoint), or null. */
  constructor(apiKey: string, mockEndpoint: string | null = null) {
    this.apiKey = apiKey;
    if (mockEndpoint !== null) {
      const url = new URL(mockEndpoint);
      this.protocol = url.protocol === "http:" ? "http:" : "https:";
      // URL keeps the brackets of an IPv6 host; request() takes the bare address.
      this.hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
      this.port = url.port ? Number(url.port) : this.protocol === "http:" ? 80 : 443;
    }
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
    // `deferCallbacks` is for settling inside fetch() itself: the key is freed and the
    // deadline cleared at once, but callbacks still run asynchronously.
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: EventSpecResponse | null, deferCallbacks = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      this.resolveCallbacks(dedupeKey, owner, result, deferCallbacks);
    };

    // Anything that throws from here on would leave the key registered with no request
    // behind it, and every later fetch of the key would wait on it forever.
    let req: ClientRequest | undefined;
    try {
      const queryParams = new URLSearchParams({
        apiKey: this.apiKey,
        eventName,
        streamId,
      });

      const options = {
        hostname: this.hostname,
        port: this.port,
        path: `${AvoEventSpecFetcher.specEndpoint}?${queryParams.toString()}`,
        method: "GET",
        agent: this.protocol === "http:" ? sharedHttpAgent : this.agent,
        headers: {
          Accept: "application/json",
        },
      };

      if (AvoInspector.shouldLog) {
        console.log("Avo Inspector: [network] GET " + this.protocol + "//" + options.hostname + AvoEventSpecFetcher.specEndpoint + "?eventName=" + eventName);
      }

      const sent = this.send(options, eventName, settle);
      req = sent;
      this.requests.add(sent);
      // `deadline` is first the wait for a socket, then the fetch's own budget; settling
      // clears whichever is armed.
      deadline = setTimeout(() => {
        if (AvoInspector.shouldLog) {
          console.error("Avo Inspector: [network] Spec fetch got no connection within " + AvoEventSpecFetcher.socketWaitTimeoutMs + "ms");
        }
        AvoEventSpecFetcher.timeouts++;
        sent.destroy();
        settle(null);
      }, AvoEventSpecFetcher.socketWaitTimeoutMs);
      deadline.unref();
      // Unref'd like track sockets, so a fetch never holds the process open by itself: at
      // exit, a pending validation is awaited by the exit drain, within its deadline. On
      // every assignment, since the keep-alive agent re-refs a socket when it reuses it.
      sent.on("socket", (socket) => socket.unref());
      sent.once("socket", () => {
        if (settled) {
          return;
        }
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          if (AvoInspector.shouldLog) {
            console.error("Avo Inspector: [network] Spec fetch timed out after " + AvoEventSpecFetcher.fetchTimeoutMs + "ms");
          }
          AvoEventSpecFetcher.timeouts++;
          sent.destroy();
          settle(null);
        }, AvoEventSpecFetcher.fetchTimeoutMs);
        deadline.unref();
      });
      sent.on("close", () => {
        clearTimeout(deadline);
        this.requests.delete(sent);
        // A request destroyed before it got a socket can close with no response and no
        // error. settle is idempotent and owner-checked, so this is a no-op otherwise.
        settle(null);
      });
      sent.end();
    } catch (e) {
      if (AvoInspector.shouldLog) {
        console.error("Avo Inspector: [network] Spec fetch error (" + AvoLog.errorType(e) + ")");
      }
      if (req) {
        req.destroy();
      }
      settle(null, true);
    }
  }

  // Starts the GET; every outcome (response, parse failure, transport error) goes to settle.
  private send(
    options: RequestOptions,
    eventName: string,
    settle: (result: EventSpecResponse | null) => void
  ): ClientRequest {
    const send = this.protocol === "http:" ? httpRequest : request;
    const req = send(options, (res) => {
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
    result: EventSpecResponse | null,
    deferCallbacks = false
  ): void {
    const pending = this.inFlight.get(key);
    if (!pending || pending.owner !== owner) {
      return;
    }
    this.inFlight.delete(key);

    const invoke = () => {
      for (const cb of pending.callbacks) {
        try {
          cb(result);
        } catch (e) {
          // Don't let one callback failure affect others
        }
      }
    };
    if (deferCallbacks) {
      process.nextTick(invoke);
    } else {
      invoke();
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
