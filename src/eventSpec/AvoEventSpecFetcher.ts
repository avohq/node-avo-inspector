import { request, Agent } from "https";
import { EventSpecResponse } from "./AvoEventSpecFetchTypes";

type FetchCallback = (result: EventSpecResponse | null) => void;

export class AvoEventSpecFetcher {
  private apiKey: string;
  private inFlight: Map<string, FetchCallback[]> = new Map();
  private agent: Agent;

  private static specEndpoint = "/inspector/v1/spec";

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

    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (data: Buffer) => chunks.push(data));
      res.on("end", () => {
        let result: EventSpecResponse | null = null;
        try {
          const body = Buffer.concat(chunks).toString();
          result = JSON.parse(body) as EventSpecResponse;
        } catch (e) {
          // Parse error - result stays null
        }
        this.resolveCallbacks(dedupeKey, result);
      });
    });

    req.on("error", () => {
      this.resolveCallbacks(dedupeKey, null);
    });

    req.on("timeout", () => {
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

  destroy(): void {
    this.agent.destroy();
  }
}
