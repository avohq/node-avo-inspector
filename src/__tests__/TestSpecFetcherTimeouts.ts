import * as https from "https";
import * as http from "http";
import { AddressInfo } from "net";

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

