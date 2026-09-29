import * as https from "https";
import * as http from "http";
import { AddressInfo } from "net";
import { EventEmitter } from "events";

import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// Event spec fetch deadlines, against endpoints that never answer.

let hung: http.Server;
let port: number;

beforeAll(async () => {
  hung = http.createServer(() => {
    // Never answers.
  });
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  port = (hung.address() as AddressInfo).port;
});

afterAll(async () => {
  hung.closeAllConnections();
  await new Promise((resolve) => hung.close(resolve));
});

afterEach(() => {
  jest.restoreAllMocks();
  (AvoEventSpecFetcher as any).fetchTimeoutMs = 10_000;
});

describe("event spec fetch deadline", () => {
  test("fetches queued behind the agent's 8 sockets still settle within one deadline", async () => {
    (AvoEventSpecFetcher as any).fetchTimeoutMs = 200;
    // Route the fetcher's https requests to the hung local server over http, through an
    // agent with the same 8-socket limit, so requests beyond 8 wait for a socket.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    jest.spyOn(https, "request").mockImplementation(((options: any, callback: any) =>
      http.request({ host: "127.0.0.1", port, path: options.path, method: "GET", agent }, callback)) as any);
    const fetcher = new AvoEventSpecFetcher("key");

    const started = Date.now();
    const settledAfter = await Promise.all(
      Array.from({ length: 20 }, (_, i) => new Promise<number>((resolve) => {
        fetcher.fetch("E" + i, "s", (result) => {
          expect(result).toBeNull();
          resolve(Date.now() - started);
        });
      }))
    );
    fetcher.destroy();
    agent.destroy();

    expect(Math.max(...settledAfter)).toBeLessThan(400);
  }, 15_000);
});

describe("settling a fetch", () => {
  // A request that never answers; destroy() errors it on the next tick, like a real one.
  function fakeRequests() {
    const created: any[] = [];
    jest.spyOn(https, "request").mockImplementation(((_options: any, callback: any) => {
      const req: any = new EventEmitter();
      req.callback = callback;
      req.end = () => {};
      req.setTimeout = () => {};
      req.destroy = () => process.nextTick(() => req.emit("error", new Error("destroyed")));
      created.push(req);
      return req;
    }) as any);
    return created;
  }

  test("a timed-out request's late error does not settle a newer fetch of the same key", async () => {
    // Long enough that only the stale error, not the second fetch's own deadline, could
    // settle the second fetch within the check below.
    (AvoEventSpecFetcher as any).fetchTimeoutMs = 1000;
    const created = fakeRequests();
    const fetcher = new AvoEventSpecFetcher("key");

    // Wrapped in an object: awaiting a promise that resolves to a promise would wait for it.
    const { second } = await new Promise<{ second: Promise<any> }>((resolveOuter) => {
      fetcher.fetch("E", "s", (first) => {
        expect(first).toBeNull();
        // Fetch the same key again from inside the timeout's settlement, before the old
        // request's destroy() error arrives.
        resolveOuter({ second: new Promise((resolve) => fetcher.fetch("E", "s", resolve)) });
      });
      // Times out the first request through its socket-idle "timeout" event.
      created[0].emit("timeout");
    });

    // The first request's late error fires on the next tick; the second fetch must not see it.
    let secondResult: any = "pending";
    second.then((value: any) => { secondResult = value; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondResult).toBe("pending");
    expect(created).toHaveLength(2);
    fetcher.destroy();
  });
});
