import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import * as zlib from "zlib";
import { gunzipSync } from "zlib";

import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { VERSION } from "../AvoInspectorVersion";
import { deepEquals } from "../utils";
import * as crypto from "crypto";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";
import { answerSpecFetch, restoreEnv } from "./constants";

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
const defaultEndpoint = process.env.AVO_INSPECTOR_MOCK_ENDPOINT;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (answerSpecFetch(req, res)) {
      return;
    }
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
  restoreEnv("AVO_INSPECTOR_MOCK_ENDPOINT", defaultEndpoint);
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

  test("compression is asynchronous and never uses gzipSync", async () => {
    const gzipSync = jest.spyOn(zlib, "gzipSync");
    const inspector = dev();
    const props: { [key: string]: string } = {};
    for (let i = 0; i < 40; i++) props["attribute_" + i] = "value";
    await inspector.trackSchemaFromEvent("Large", props);

    expect(gzipSync).not.toHaveBeenCalled();
    expect(captured[0].headers["content-encoding"]).toBe("gzip");
  });

  test("a compression error falls back to the uncompressed body without Content-Encoding", async () => {
    jest.spyOn(zlib, "gzip").mockImplementation(((_buf: any, callback: any) =>
      callback(new Error("zlib unavailable"))) as any);
    const inspector = dev();
    const props: { [key: string]: string } = {};
    for (let i = 0; i < 40; i++) props["attribute_" + i] = "value";
    await inspector.trackSchemaFromEvent("Large", props);

    const { headers, body } = captured[0];
    expect(headers["content-encoding"]).toBeUndefined();
    expect(Number(headers["content-length"])).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(body[0].eventName).toBe("Large");
  });

  test("destroy() while a batch is being compressed sends nothing", async () => {
    const inspector = staging({ batchSize: 1 });
    const props: { [key: string]: string } = {};
    for (let i = 0; i < 40; i++) props["attribute_" + i] = "value";

    const tracked = inspector.trackSchemaFromEvent("Large", props);
    inspector.destroy();
    await tracked;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(captured).toHaveLength(0);
  });

  test("a track whose properties root is an array sends eventProperties [] and resolves []", async () => {
    const inspector = dev();

    await expect(inspector.trackSchemaFromEvent("E", [1, 2] as any)).resolves.toEqual([]);

    expect(captured).toHaveLength(1);
    expect(captured[0].body[0].eventProperties).toEqual([]);
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

  test.each(["\r", "\n", "\0"])("constructor rejects an API key containing %j with the spec's message", (ch) => {
    expect(() => dev({ apiKey: "test" + ch + "key" })).toThrow(
      "[Avo Inspector] API key contains a control character. The API key is sent as a request header and cannot contain CR, LF, or NUL."
    );
  });

  test.each(["\u0001", "\u001b", "\u007f", "\u0085"])(
    "constructor rejects an API key containing another control character such as %j",
    (ch) => {
      expect(() => dev({ apiKey: "test" + ch + "key" })).toThrow(
        new Error("[Avo Inspector] apiKey must not contain control characters")
      );
    }
  );

  test("the send guard refuses any control character, without contacting the server", async () => {
    const handler = new AvoNetworkCallsHandler("test\u0001key", "dev", "", "1.0.0", VERSION);
    const body = handler.bodyForEventSchemaCall("", "E", [], null, null);

    await expect(handler.callInspectorWithBatchBody([body])).rejects.toBe("Request failed");
    expect(captured).toHaveLength(0);
  });

  test("the send guard refuses a character Node cannot put in a header, without contacting the server", async () => {
    const handler = new AvoNetworkCallsHandler("test\u2014key", "dev", "", "1.0.0", VERSION);
    const body = handler.bodyForEventSchemaCall("", "E", [], null, null);

    await expect(handler.callInspectorWithBatchBody([body])).rejects.toBe("Request failed");
    expect(captured).toHaveLength(0);
  });

  test.each(["\u2014", "\u{1F600}"])("constructor rejects an API key containing %j, which a header cannot carry", (ch) => {
    expect(() => dev({ apiKey: "test" + ch + "key" })).toThrow(
      new Error("[Avo Inspector] apiKey must only contain characters that can be sent in an HTTP header")
    );
  });

  test("a tab in the API key is allowed and sent verbatim", async () => {
    const inspector = dev({ apiKey: "test\tkey" });
    await inspector.trackSchemaFromEvent("E", {});

    expect(captured[0].headers["api-key"]).toBe("test\tkey");
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

  test("a 200 response cut off after its headers fails the send promptly", async () => {
    responders.push((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
      res.write('{"samplingRate":1');
      setTimeout(() => res.socket!.destroy(), 20);
    });
    const handler = new AvoNetworkCallsHandler("test-key", "dev", "", "1.0.0", VERSION);
    // Not the default of 1, so a truncated body that changed or reset it would show.
    handler._setSamplingRateForTesting(0.5);
    const body = handler.bodyForEventSchemaCall("", "E", [], null, null);

    const started = Date.now();
    await expect(handler.callInspectorWithBatchBody([body])).rejects.toBe("Request failed");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(handler.getSamplingRate()).toBe(0.5);
  }, 15_000);

  test("a 3xx is a non-200 response and is never followed", async () => {
    responders.push((_req, res) => {
      res.writeHead(302, { Location: process.env.AVO_INSPECTOR_MOCK_ENDPOINT + "/" });
      res.end();
    });

    await expect(dev().trackSchemaFromEvent("E", { a: 1 })).resolves.toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(captured).toHaveLength(1);
  });

  test("VERSION matches the package version", () => {
    expect(VERSION).toBe(require("../../package.json").version);
  });
});

describe("cyclic event properties with logging on", () => {
  const cyclicProps = () => {
    const props: any = { plan: "pro" };
    props.self = props;
    return props;
  };

  test("extractSchema returns the truncated schema instead of []", () => {
    const inspector = dev();
    inspector.enableLogging(true);

    const schema = inspector.extractSchema(cyclicProps());

    expect(schema[0]).toEqual({ propertyName: "plan", propertyType: "string" });
    expect(schema[1]).toMatchObject({ propertyName: "self", propertyType: "object" });
  });

  test("trackSchemaFromEvent resolves the schema and sends the event", async () => {
    const inspector = dev();
    inspector.enableLogging(true);

    const schema = await inspector.trackSchemaFromEvent("Cyclic", cyclicProps());

    expect(schema[0]).toEqual({ propertyName: "plan", propertyType: "string" });
    expect(captured).toHaveLength(1);
  });

  test("a codegen call and a manual call with distinct cyclic properties dedup without overflowing", async () => {
    const inspector = dev();
    inspector.enableLogging(true);

    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Cyclic", cyclicProps(), "id", "hash");
    await expect(inspector.trackSchemaFromEvent("Cyclic", cyclicProps())).resolves.toEqual([]);
    expect(captured).toHaveLength(1);
  });

  test("deepEquals terminates on distinct cyclic objects", () => {
    const a: any = { x: 1 };
    a.self = a;
    const b: any = { x: 1 };
    b.self = b;
    const c: any = { x: 2 };
    c.self = c;

    expect(deepEquals(a, b)).toBe(true);
    expect(deepEquals(a, c)).toBe(false);
  });

  test("with encryption on, a cyclic property value is omitted instead of failing the event", async () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const inspector = dev({ publicEncryptionKey: ecdh.getPublicKey("hex") });

    const schema = await inspector.trackSchemaFromEvent("Cyclic", cyclicProps());

    expect(schema).toHaveLength(2);
    expect(captured[0].body[0].eventProperties.map((p: any) => p.propertyName)).toEqual(["plan"]);
  });
});

describe("an internal error while building the body", () => {
  const internalError = "Avo Inspector: something went wrong. Please report to support@avo.app.";

  test("rejects with the internal-error string without validation", async () => {
    const inspector = staging({ batchSize: 30 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "bodyForEventSchemaCall").mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(inspector.trackSchemaFromEvent("E", { a: 1 })).rejects.toBe(internalError);
  });

  test("rejects with the same string when validation is active", async () => {
    jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((_e, _s, callback) => callback(null));
    const inspector = staging({ batchSize: 30 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "bodyForEventSchemaCall").mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(inspector.trackSchemaFromEvent("E", { a: 1 })).rejects.toBe(internalError);
    expect(console.error).toHaveBeenCalledWith(internalError + " (Error)");
    expect((inspector as any).batchQueue.length).toBe(0);
  });
});

describe("deduplication", () => {
  test("a manual call carrying gateway options is not deduplicated against a codegen call", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Purchase", { a: 1 }, "eventId", "hash", "s1");
    const schema = await inspector.trackSchemaFromEvent("Purchase", { a: 1 }, "s1", {
      outputReference: "meta-x7k2q",
    });

    expect(schema).toEqual([{ propertyName: "a", propertyType: "int" }]);
    expect(captured).toHaveLength(2);
    expect(captured[1].body[0].outputReference).toBe("meta-x7k2q");
  });

  test("a manual call whose only option is originAppVersion equal to the instance version is not deduplicated", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Purchase", { a: 1 }, "eventId", "hash", "s1");
    const schema = await inspector.trackSchemaFromEvent("Purchase", { a: 1 }, "s1", {
      originAppVersion: " 1.0.0 ",
    });

    expect(schema).toEqual([{ propertyName: "a", propertyType: "int" }]);
    expect(captured).toHaveLength(2);
  });

  test("blank gateway options do not exempt a call from deduplication", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Purchase", { a: 1 }, "eventId", "hash", "s1");
    await expect(
      inspector.trackSchemaFromEvent("Purchase", { a: 1 }, "s1", { outputReference: "  ", originHint: "" })
    ).resolves.toEqual([]);
    expect(captured).toHaveLength(1);
  });

  test("a manual call without options is still deduplicated against a codegen call", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Purchase", { a: 1 }, "eventId", "hash", "s1");
    await expect(inspector.trackSchemaFromEvent("Purchase", { a: 1 }, "s1")).resolves.toEqual([]);
    expect(captured).toHaveLength(1);
  });

  test("the codegen entry warns about a streamId containing ':' and still sends it verbatim", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Purchase", { a: 1 }, "eventId", "hash", "user:42");

    expect(console.warn).toHaveBeenCalledWith(
      "[Avo Inspector] Warning: streamId contains ':' which is not supported"
    );
    expect(captured[0].body[0].streamId).toBe("user:42");
  });

  test("the codegen entry accepts gateway options", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Purchase", { a: 1 }, "eventId", "hash", "s1", {
      originHint: " web ",
    });

    const event = captured[0].body[0];
    expect(event).toMatchObject({ avoFunction: true, eventId: "eventId", originHint: "web", appVersion: null });
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

  // Node needs no fix for the Go/Java flush race: drain() swaps the buffer and registers the
  // send in flight in one synchronous step (drain -> dispatch -> sendBatch -> trackPending),
  // so flush() cannot run in between. These tests pin that invariant.
  describe("a swapped-out batch is in flight before any other code runs", () => {
    // prod: no event spec validation, so each track enqueues its event synchronously.
    const prod = (extra: object = {}) =>
      new AvoInspector({ apiKey: "test-key", env: "prod", version: "1.0.0", appName: "App", ...extra });
    const deferredSend = (inspector: AvoInspector) => {
      let release: (status: number) => void = () => {};
      const send = jest
        .spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
        .mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      return { send, release: (status: number) => release(status) };
    };

    test("size trigger: registered synchronously, and flush() waits for it", async () => {
      const inspector = prod({ batchSize: 2 });
      const { release } = deferredSend(inspector);

      inspector.trackSchemaFromEvent("E1", {});
      inspector.trackSchemaFromEvent("E2", {});
      expect((inspector as any).pending.size).toBe(1);

      let flushed = false;
      const flushing = inspector.flush().then(() => { flushed = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(flushed).toBe(false);

      release(200);
      await flushing;
      expect(flushed).toBe(true);
    });

    test("scheduled flush: registered synchronously when the timer fires", () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const inspector = prod({ batchSize: 30, batchFlushSeconds: 1 });
      deferredSend(inspector);

      inspector.trackSchemaFromEvent("E1", {});
      jest.advanceTimersByTime(1000);

      expect((inspector as any).batchQueue.length).toBe(0);
      expect((inspector as any).pending.size).toBe(1);
      inspector.destroy();
    });
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

  test("a flush timeout beyond the timer limit still waits for in-flight sends", async () => {
    const inspector = staging({ batchSize: 30 });
    let release: (status: number) => void = () => {};
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await inspector.trackSchemaFromEvent("E1", {});

    let flushed = false;
    const flushing = inspector.flush(3e9).then(() => { flushed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flushed).toBe(false);

    release(200);
    await flushing;
    expect(flushed).toBe(true);
  });

  test("flush waits only for sends started before or by it", async () => {
    const inspector = staging({ batchSize: 2 });
    const releases: Array<(status: number) => void> = [];
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));

    await inspector.trackSchemaFromEvent("E1", {});
    let flushed = false;
    const flushing = inspector.flush().then(() => { flushed = true; });
    expect(send).toHaveBeenCalledTimes(1);

    // A size-triggered send that starts after flush() was called, and never completes.
    await inspector.trackSchemaFromEvent("E2", {});
    await inspector.trackSchemaFromEvent("E3", {});
    expect(send).toHaveBeenCalledTimes(2);

    releases[0](200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(true);
    await flushing;
    inspector.destroy();
  });

  test("flush resolves after its timeout even when a send never completes", async () => {
    responders.push(() => {}); // never answers
    const inspector = staging({ batchSize: 30 });
    await inspector.trackSchemaFromEvent("E1", {});

    const started = Date.now();
    await expect(inspector.flush(100)).resolves.toBeUndefined();
    const elapsed = Date.now() - started;
    // It really waited for the send, up to its timeout, and no longer.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(5000);
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

  // Resolves with the promise's value, or "pending" if it has not settled within `ms`.
  const settledWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([
      promise.then((value) => ({ value }), (reason) => ({ reason })),
      new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
    ]);

  test("destroy() resolves a dev track whose send is in flight with [], not the schema", async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => (received = resolve));
    responders.push(() => received()); // never answers
    const inspector = dev();

    const tracked = inspector.trackSchemaFromEvent("E", { a: 1 });
    await arrived;
    inspector.destroy();

    expect(await settledWithin(tracked, 1000)).toEqual({ value: [] });
  });

  test("settled tracks leave no destroy waiters behind", async () => {
    const inspector = dev();
    for (let i = 0; i < 5; i++) {
      await inspector.trackSchemaFromEvent("E" + i, { a: i });
    }

    expect((inspector as any).destroyWaiters.size).toBe(0);
    inspector.destroy();
  });

  test("destroy() resolves a track waiting on an event spec fetch with [], even if the fetch never calls back", async () => {
    jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
    const fetch = jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation(() => {});
    const inspector = staging({ batchSize: 30 });

    const tracked = inspector.trackSchemaFromEvent("E", { a: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    inspector.destroy();

    expect(await settledWithin(tracked, 1000)).toEqual({ value: [] });
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

  test("batchSize above maxQueueSize warns even with logging off, and keeps FIFO overflow", async () => {
    const inspector = staging({ batchSize: 30, maxQueueSize: 2 });
    expect(AvoInspector.shouldLog).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      "[Avo Inspector] batchSize 30 is larger than maxQueueSize 2, so a batch never fills: " +
        "events are sent only by the scheduled flush or flush(), and the oldest are dropped " +
        "once 2 are buffered. Set batchSize to at most maxQueueSize."
    );

    await inspector.trackSchemaFromEvent("E1", {});
    await inspector.trackSchemaFromEvent("E2", {});
    await inspector.trackSchemaFromEvent("E3", {});
    await inspector.flush();
    expect(captured.map((c) => c.body.map((e: any) => e.eventName))).toEqual([["E2", "E3"]]);
  });

  test("no batch-size warning when batchSize fits in maxQueueSize, or in dev", () => {
    staging({ batchSize: 2, maxQueueSize: 2 });
    dev({ batchSize: 30, maxQueueSize: 2 });
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("is larger than maxQueueSize"));
  });

  test("createdAt is stamped when track is called, not when validation lets the event join the queue", async () => {
    jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((eventName, _streamId, callback) => {
      setTimeout(() => callback(null), eventName === "Slow" ? 60 : 0);
    });
    const inspector = staging({ batchSize: 30 });
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockResolvedValue(200);

    const calledAt = Date.now();
    const slow = inspector.trackSchemaFromEvent("Slow", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    await inspector.trackSchemaFromEvent("Fast", {});
    await slow;
    await inspector.flush();

    const events = send.mock.calls[0][0];
    const createdAt = (name: string) => Date.parse(events.find((e) => e.eventName === name)!.createdAt);
    expect(createdAt("Slow")).toBeLessThan(createdAt("Fast"));
    // The Slow fetch is delayed 60 ms; an enqueue-time stamp would be at least that late.
    expect(createdAt("Slow") - calledAt).toBeLessThan(50);
  });

  test("invalid batch options fall back to the defaults with a warning", () => {
    const inspector = staging({ batchSize: 0, batchFlushSeconds: -1, maxQueueSize: 1.5 });
    expect((inspector as any).batchSize).toBe(30);
    expect(console.warn).toHaveBeenCalledWith("[Avo Inspector] Invalid batchSize 0. Using default 30.");
    expect(console.warn).toHaveBeenCalledWith("[Avo Inspector] Invalid batchFlushSeconds -1. Using default 30.");
    expect(console.warn).toHaveBeenCalledWith("[Avo Inspector] Invalid maxQueueSize 1.5. Using default 1000.");
  });
});
