import * as https from "https";
import * as http from "http";
import { AddressInfo } from "net";
import { gunzipSync } from "zlib";

import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { trackConnections } from "./constants";

// Backpressure: once 1,000 events wait for a send slot, an awaited track resolves only when
// fewer than 1,000 wait, so an awaited loop runs at the speed of the sends instead of
// overflowing the 10,000-event backlog (as 1.x, whose track waited for its own send).

let server: http.Server;
let port: number;
let closeConnections: () => void;
let respond: (res: http.ServerResponse) => void;
let delivered: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"));
      delivered.push(...body.map((e: any) => e.messageId));
      respond(res);
    });
  });
  closeConnections = trackConnections(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  closeConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  delivered = [];
  // Answers on the next I/O turn.
  respond = (res) => setImmediate(() => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ samplingRate: 1 }));
  });
  // prod sends to api.avo.app; route those requests to the local server over http.
  jest.spyOn(https, "request").mockImplementation(((url: any, options: any, callback: any) =>
    http.request({ host: "127.0.0.1", port, path: new URL(url).pathname, method: "POST", headers: options.headers }, callback)) as any);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  (AvoNetworkCallsHandler as any).requestTimeoutMs = 10_000;
});

const prod = () => new AvoInspector({ apiKey: "k", env: "prod", version: "1.0.0" });
const dropLines = () => (console.warn as jest.Mock).mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("dropped"));

test("an awaited 20,000-event loop delivers every event", async () => {
  const inspector = prod();

  for (let i = 0; i < 20_000; i++) await inspector.trackSchemaFromEvent("E", { i });
  await expect(inspector.flush()).resolves.toBe(true);

  expect(new Set(delivered).size).toBe(20_000);
  expect(dropLines()).toEqual([]);
  inspector.destroy();
}, 60_000);

test("tracks that are not awaited are unaffected: the backlog cap still applies", async () => {
  // Sends that never complete.
  respond = () => {};
  const inspector = prod();

  const started = Date.now();
  for (let i = 0; i < 20_000; i++) inspector.trackSchemaFromEvent("E", { i });
  expect(Date.now() - started).toBeLessThan(5_000);

  expect((inspector as any).batchQueue.waitingLength).toBeLessThanOrEqual(10_000);
  // The overflow is dropped and logged, as without backpressure (one line per window).
  expect(dropLines()).toHaveLength(1);
  expect(dropLines()[0]).toMatch(/^Avo Inspector: dropped \d+ event\(s\) \(send backlog full\) in the last 1s\.$/);
  inspector.destroy();
}, 30_000);

test("against a hung endpoint, each awaited track waits about one request timeout at most", async () => {
  respond = () => {};
  (AvoNetworkCallsHandler as any).requestTimeoutMs = 300;
  jest.spyOn(console, "error").mockImplementation(() => {});
  const inspector = prod();

  let longest = 0;
  for (let i = 0; i < 1_500; i++) {
    const started = Date.now();
    await inspector.trackSchemaFromEvent("E", { i });
    longest = Math.max(longest, Date.now() - started);
  }

  // It did wait for a slot (the 4 hung sends time out after 300 ms) ...
  expect(longest).toBeGreaterThanOrEqual(250);
  // ... but never much longer than one request timeout.
  expect(longest).toBeLessThan(1_500);
  expect((inspector as any).batchQueue.waitingLength).toBeLessThan(1_000 + 30);
  expect(dropLines()).toEqual([]);
  inspector.destroy();
}, 60_000);

test("destroy() releases a track waiting for a slot: it resolves []", async () => {
  respond = () => {};
  const inspector = prod();
  // 4 batches in flight and 1,000 events waiting.
  for (let i = 0; i < (4 + 1_000 / 30 + 1) * 30; i++) inspector.trackSchemaFromEvent("E", { i });
  expect((inspector as any).batchQueue.waitingLength).toBeGreaterThanOrEqual(1_000);

  let result: any = "pending";
  inspector.trackSchemaFromEvent("Waiting", { a: 1 }).then((r) => { result = r; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(result).toBe("pending");

  inspector.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  expect(result).toEqual([]);
});
