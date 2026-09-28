import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { gunzipSync } from "zlib";

import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { VERSION } from "../AvoInspectorVersion";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

type Captured = { headers: IncomingMessage["headers"]; body: any[] };
type Responder = (req: IncomingMessage, res: ServerResponse) => void;

const ok: Responder = (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ samplingRate: 1.0, success: true }));
};

// A local stand-in for the Inspector endpoint, reached through AVO_INSPECTOR_MOCK_ENDPOINT.
let server: Server;
let captured: Captured[] = [];
let responders: Responder[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const json = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
      captured.push({ headers: req.headers, body: JSON.parse(json.toString("utf8")) });
      (responders.shift() || ok)(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.AVO_INSPECTOR_MOCK_ENDPOINT;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  captured = [];
  responders = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const staging = (extra: object = {}) =>
  new AvoInspector({ apiKey: "test-key", env: "staging", version: "1.0.0", appName: "App", ...extra });

const dev = (extra: object = {}) =>
  new AvoInspector({ apiKey: "test-key", env: "dev", version: "1.0.0", appName: "App", ...extra });

describe("wire protocol", () => {
  test("sends the five required headers and a v2-shaped body without trackingId/sessionId", async () => {
    const inspector = dev();
    await inspector.trackSchemaFromEvent("Signed Up", { plan: "pro" }, "stream-1");

    expect(captured).toHaveLength(1);
    const { headers, body } = captured[0];
    expect(headers["api-key"]).toBe("test-key");
    expect(headers["env"]).toBe("dev");
    expect(headers["x-avo-client"]).toBe("node");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-length"]).toMatch(/^\d+$/);
    expect(headers["content-encoding"]).toBeUndefined();

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      apiKey: "test-key",
      env: "dev",
      libPlatform: "node",
      libVersion: VERSION,
      appVersion: "1.0.0",
      streamId: "stream-1",
      type: "event",
      eventName: "Signed Up",
    });
    expect(body[0]).not.toHaveProperty("trackingId");
    expect(body[0]).not.toHaveProperty("sessionId");
  });

  test("gzips a body of 1024 bytes or more and reports the compressed length", async () => {
    const inspector = dev();
    const props: { [key: string]: string } = {};
    for (let i = 0; i < 40; i++) props["attribute_" + i] = "value";
    await inspector.trackSchemaFromEvent("Large", props);

    const { headers, body } = captured[0];
    expect(headers["content-encoding"]).toBe("gzip");
    expect(Number(headers["content-length"])).toBeLessThan(
      Buffer.byteLength(JSON.stringify(body))
    );
  });

  test("non-string gateway option values are treated as absent", async () => {
    const inspector = dev();
    await inspector.trackSchemaFromEvent("purchase", { a: 1 }, "s", {
      outputReference: 7 as any,
      originHint: false as any,
      originAppVersion: { v: 1 } as any,
    });

    const event = captured[0].body[0];
    expect(event).not.toHaveProperty("outputReference");
    expect(event).not.toHaveProperty("originHint");
    expect(event.appVersion).toBe("1.0.0");
  });

  test("an API key with a control character fails the send without contacting the server", async () => {
    const handler = new AvoNetworkCallsHandler("test-key\r\nX-Injected: 1", "dev", "", "1.0.0", VERSION);
    const body = handler.bodyForEventSchemaCall("", "E", [], null, null);

    await expect(handler.callInspectorWithBatchBody([body])).rejects.toBe("Request failed");
    expect(captured).toHaveLength(0);
  });

  test.each(["\r", "\n", "\0"])("constructor rejects an API key containing %j", (ch) => {
    expect(() => dev({ apiKey: "test" + ch + "key" })).toThrow(
      "[Avo Inspector] API key contains a control character. The API key is sent as a request header and cannot contain CR, LF, or NUL."
    );
  });

  test("the mock endpoint override is never honored by a prod instance", () => {
    expect(AvoNetworkCallsHandler.mockEndpointFor("prod")).toBeNull();
    expect(AvoNetworkCallsHandler.mockEndpointFor("staging")).toBe(
      process.env.AVO_INSPECTOR_MOCK_ENDPOINT
    );
  });

  test("a request that exceeds the timeout rejects with 'Request timed out'", async () => {
    (AvoNetworkCallsHandler as any).requestTimeoutMs = 50;
    responders.push(() => {}); // never answers
    try {
      const handler = new AvoNetworkCallsHandler("test-key", "dev", "", "1.0.0", VERSION);
      const body = handler.bodyForEventSchemaCall("", "E", [], null, null);
      await expect(handler.callInspectorWithBatchBody([body])).rejects.toBe("Request timed out");
    } finally {
      (AvoNetworkCallsHandler as any).requestTimeoutMs = 10_000;
    }
  });

  test("VERSION matches the package version", () => {
    expect(VERSION).toBe(require("../../package.json").version);
  });
});

describe("sampling", () => {
  const respondWith = (status: number, body: object): Responder => (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  test("the rate is updated only by a 200 carrying a numeric samplingRate in [0, 1]", async () => {
    const inspector = dev();
    const handler = inspector.avoNetworkCallsHandler;
    responders.push(
      respondWith(200, { samplingRate: 0.9 }),
      respondWith(200, { success: false }),
      respondWith(500, { samplingRate: 0.2 }),
      respondWith(200, { samplingRate: 7 })
    );

    await inspector.trackSchemaFromEvent("E1", {});
    expect(handler.getSamplingRate()).toBe(0.9);

    jest.spyOn(Math, "random").mockReturnValue(0);
    await inspector.trackSchemaFromEvent("E2", {});
    expect(handler.getSamplingRate()).toBe(0.9);
    await inspector.trackSchemaFromEvent("E3", {});
    expect(handler.getSamplingRate()).toBe(0.9);
    await inspector.trackSchemaFromEvent("E4", {});
    expect(handler.getSamplingRate()).toBe(0.9);
  });

  test("sampling is decided per event at enqueue and the body carries that event's rate", async () => {
    const inspector = staging({ batchSize: 30 });
    inspector._setSamplingRateForTesting(0.5);
    const random = jest.spyOn(Math, "random");

    random.mockReturnValueOnce(0.7); // dropped
    await inspector.trackSchemaFromEvent("Dropped", {});
    random.mockReturnValueOnce(0.2); // kept
    await inspector.trackSchemaFromEvent("Kept", {});
    inspector._setSamplingRateForTesting(1.0);
    random.mockReturnValueOnce(0.2);
    await inspector.trackSchemaFromEvent("Kept later", {});
    await inspector.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0].body.map((e: any) => [e.eventName, e.samplingRate])).toEqual([
      ["Kept", 0.5],
      ["Kept later", 1],
    ]);
  });
});

describe("batching", () => {
  test("dev forces batch size 1 whatever was configured", async () => {
    const inspector = dev({ batchSize: 30 });
    await inspector.trackSchemaFromEvent("E1", {});
    expect(captured).toHaveLength(1);
  });

  test("a non-200 in immediate mode resolves [] while batched mode resolves the schema", async () => {
    const fail: Responder = (_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "bad key" }));
    };
    responders.push(fail, fail);

    await expect(dev().trackSchemaFromEvent("E", { a: 1 })).resolves.toEqual([]);

    const batched = staging({ batchSize: 1 + 1 });
    await expect(batched.trackSchemaFromEvent("E", { a: 1 })).resolves.toEqual([
      { propertyName: "a", propertyType: "int" },
    ]);
    await batched.trackSchemaFromEvent("E", { a: 1 });
    await batched.flush();
    expect(captured).toHaveLength(2);
  });

  test("the scheduled flush sends a partial batch once the oldest event is batchFlushSeconds old", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const inspector = staging({ batchSize: 30, batchFlushSeconds: 5 });
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockResolvedValue(200);

    await inspector.trackSchemaFromEvent("E1", {});
    jest.advanceTimersByTime(3000);
    await inspector.trackSchemaFromEvent("E2", {});
    jest.advanceTimersByTime(1999);
    expect(send).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((e) => e.eventName)).toEqual(["E1", "E2"]);
  });

  test("disableBatchTimer starts no scheduled flush", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const inspector = staging({ batchSize: 30, batchFlushSeconds: 5, disableBatchTimer: true });
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockResolvedValue(200);

    await inspector.trackSchemaFromEvent("E1", {});
    jest.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
  });

  test("a transient network failure drops the batch; it is never re-queued", async () => {
    responders.push((req) => req.socket.destroy()); // connection dropped mid-request
    const inspector = staging({ batchSize: 2 });

    await expect(inspector.trackSchemaFromEvent("E1", { a: 1 })).resolves.toHaveLength(1);
    await inspector.trackSchemaFromEvent("E2", {});
    await inspector.flush();
    expect(console.error).toHaveBeenCalledWith("Avo Inspector: schema sending failed: Request failed.");

    await inspector.trackSchemaFromEvent("E3", {});
    await inspector.flush();

    const eventNames = captured.map((c) => c.body.map((e: any) => e.eventName));
    expect(eventNames).toEqual([["E1", "E2"], ["E3"]]);
  });

  test("flush resolves after its timeout even when a send never completes", async () => {
    responders.push(() => {}); // never answers
    const inspector = staging({ batchSize: 30 });
    await inspector.trackSchemaFromEvent("E1", {});

    const started = Date.now();
    await expect(inspector.flush(100)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
    inspector.destroy();
  });

  test("destroy discards the buffer, clears the timer and turns track into a no-op", async () => {
    const inspector = staging({ batchSize: 30 });
    inspector._setSamplingRateForTesting(0.9);
    jest.spyOn(Math, "random").mockReturnValue(0);
    await inspector.trackSchemaFromEvent("E1", {});
    expect((inspector as any).batchQueue.hasScheduledFlush).toBe(true);

    inspector.destroy();

    expect((inspector as any).pendingCount).toBe(0);
    expect((inspector as any).batchQueue.length).toBe(0);
    expect((inspector as any).batchQueue.hasScheduledFlush).toBe(false);
    await expect(inspector.trackSchemaFromEvent("E2", { a: 1 })).resolves.toEqual([]);
    await inspector.flush();
    expect(captured).toHaveLength(0);
    expect(inspector.avoNetworkCallsHandler.getSamplingRate()).toBe(0.9);
    expect(inspector.apiKey).toBe("test-key");
  });

  test("flush waits for an in-progress event spec fetch, then sends the validated event", async () => {
    // Validation is skipped under the mock endpoint, so take the real-endpoint path with
    // the network stubbed out.
    jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((eventName, _streamId, callback) => {
      setTimeout(() => callback({
        eventSpec: { eventName, properties: [{ propertyName: "plan", propertyType: "int" }] },
        metadata: { schemaId: "s", branchId: "b", latestActionId: "a", sourceId: "src" },
      }), 20);
    });
    const inspector = staging({ batchSize: 30 });
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockResolvedValue(200);

    const tracked = inspector.trackSchemaFromEvent("Signed Up", { plan: "pro" }, "s1", { originHint: "web" });
    await inspector.flush();

    expect(send).toHaveBeenCalledTimes(1);
    const [event] = send.mock.calls[0][0];
    expect(event.eventSpecMetadata).toEqual({ schemaId: "s", branchId: "b", latestActionId: "a", sourceId: "src" });
    expect(event.eventProperties[0].failedEventIds).toEqual(["Signed Up"]);
    expect(event.originHint).toBe("web");
    expect(event.appVersion).toBeNull();
    await expect(tracked).resolves.toEqual([{ propertyName: "plan", propertyType: "string" }]);
  });

  test("invalid batch options fall back to the defaults with a warning", () => {
    const inspector = staging({ batchSize: 0, batchFlushSeconds: -1, maxQueueSize: 1.5 });
    expect((inspector as any).batchSize).toBe(30);
    expect(console.warn).toHaveBeenCalledWith("[Avo Inspector] Invalid batchSize 0. Using default 30.");
    expect(console.warn).toHaveBeenCalledWith("[Avo Inspector] Invalid batchFlushSeconds -1. Using default 30.");
    expect(console.warn).toHaveBeenCalledWith("[Avo Inspector] Invalid maxQueueSize 1.5. Using default 1000.");
  });
});
