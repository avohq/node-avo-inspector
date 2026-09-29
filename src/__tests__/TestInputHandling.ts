import { createServer, Server } from "http";
import { AddressInfo } from "net";
import * as querystring from "querystring";
import * as crypto from "crypto";

import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";
import { deepEquals } from "../utils";

// Inputs that real callers pass and that the SDK must handle without throwing internally.

let server: Server;
let captured: any[][] = [];
const defaultEndpoint = process.env.AVO_INSPECTOR_MOCK_ENDPOINT;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ samplingRate: 1.0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

afterAll(async () => {
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT = defaultEndpoint;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  captured = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const dev = (extra: object = {}) =>
  new AvoInspector({ apiKey: "test-key", env: "dev", version: "1.0.0", ...extra });

const nullProto = (props: object) => Object.assign(Object.create(null), props);

describe("null-prototype objects and objects with an own hasOwnProperty key", () => {
  test("a null-prototype object (querystring.parse output) extracts like a plain object", () => {
    const query = querystring.parse("utm_source=google&page=2");

    expect(dev().extractSchema({ path: "/home", query })).toEqual([
      { propertyName: "path", propertyType: "string" },
      {
        propertyName: "query",
        propertyType: "object",
        children: [
          { propertyName: "utm_source", propertyType: "string" },
          { propertyName: "page", propertyType: "string" },
        ],
      },
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("a null-prototype object at the top level or in a list extracts like a plain object", () => {
    const inspector = dev();

    expect(inspector.extractSchema(nullProto({ a: 1 }))).toEqual(inspector.extractSchema({ a: 1 }));
    expect(inspector.extractSchema({ items: [nullProto({ b: "x" })] })).toEqual(
      inspector.extractSchema({ items: [{ b: "x" }] })
    );
  });

  test("an object with its own hasOwnProperty key extracts every key", () => {
    expect(dev().extractSchema({ nested: { hasOwnProperty: 1, a: "x" } })).toEqual([
      {
        propertyName: "nested",
        propertyType: "object",
        children: [
          { propertyName: "hasOwnProperty", propertyType: "int" },
          { propertyName: "a", propertyType: "string" },
        ],
      },
    ]);
  });

  test("tracking such an event sends its full schema", async () => {
    const query = querystring.parse("utm_source=google");
    const schema = await dev().trackSchemaFromEvent("Page Viewed", { path: "/home", query });

    expect(schema).toHaveLength(2);
    expect(captured[0][0].eventProperties).toEqual(schema);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("deepEquals compares null-prototype objects and own hasOwnProperty keys structurally", () => {
    expect(deepEquals(nullProto({ a: 1 }), nullProto({ a: 1 }))).toBe(true);
    expect(deepEquals(nullProto({ a: 1 }), nullProto({ a: 2 }))).toBe(false);
    expect(deepEquals({ hasOwnProperty: 1, a: 1 }, { hasOwnProperty: 1, a: 1 })).toBe(true);
    expect(deepEquals({ hasOwnProperty: 1 }, { hasOwnProperty: 2 })).toBe(false);
  });

  test("Codegen/manual deduplication still matches null-prototype properties", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("E", nullProto({ a: 1 }), "id", "hash");

    await expect(inspector.trackSchemaFromEvent("E", nullProto({ a: 1 }))).resolves.toEqual([]);
    expect(captured).toHaveLength(1);
  });

  test("event spec validation handles a null-prototype property value", async () => {
    jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((eventName, _s, callback) =>
      callback({
        eventSpec: { eventName, properties: [{ propertyName: "query", propertyType: "object", regex: ".*" }] },
        metadata: { schemaId: "s", branchId: "b", latestActionId: "a", sourceId: "src" },
      })
    );
    const inspector = new AvoInspector({ apiKey: "test-key", env: "staging", version: "1.0.0" });
    const send = jest
      .spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockResolvedValue(200);

    await inspector.trackSchemaFromEvent("E", { query: nullProto({ a: "1" }) });
    await inspector.flush();

    expect(send.mock.calls[0][0][0].eventSpecMetadata).toBeDefined();
  });

  test("encryption handles a null-prototype property value", async () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const inspector = dev({ publicEncryptionKey: ecdh.getPublicKey("hex") });

    await inspector.trackSchemaFromEvent("E", { query: nullProto({ a: "1" }) });

    expect(captured[0][0].eventProperties).toEqual([
      expect.objectContaining({ propertyName: "query", encryptedPropertyValue: expect.any(String) }),
    ]);
  });
});

describe("non-string streamId", () => {
  test.each([
    [12345, "12345"],
    [BigInt(10), "10"],
    [true, "true"],
  ])("%p is sent as the string %p and the call resolves", async (streamId, expected) => {
    const schema = await dev().trackSchemaFromEvent("Login", { a: 1 }, streamId as any);

    expect(schema).toEqual([{ propertyName: "a", propertyType: "int" }]);
    expect(captured[0][0].streamId).toBe(expected);
  });

  test.each([
    ["an object", { id: 1 }],
    ["a symbol", Symbol("s")],
    ["a function", () => 1],
  ])("%s is treated as absent, with a warning when logging is on", async (_label, streamId) => {
    const schema = await dev().trackSchemaFromEvent("Login", { a: 1 }, streamId as any);

    expect(schema).toHaveLength(1);
    expect(captured[0][0].streamId).toBe("");
    expect(console.warn).toHaveBeenCalledWith(
      "[Avo Inspector] Warning: streamId must be a string; ignoring a value of type " + typeof streamId
    );
  });

  test("no warning for an ignored streamId when logging is off", async () => {
    const inspector = new AvoInspector({ apiKey: "test-key", env: "staging", version: "1.0.0" });
    await inspector.trackSchemaFromEvent("Login", {}, { id: 1 } as any);

    expect(console.warn).not.toHaveBeenCalled();
    inspector.destroy();
  });

  test("the Codegen entry applies the same rule", async () => {
    const inspector = dev();
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Login", { a: 1 }, "id", "hash", 42);
    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent("Logout", { a: 1 }, "id", "hash", { id: 1 });

    expect(captured.map((batch) => batch[0].streamId)).toEqual(["42", ""]);
  });
});

describe("non-string env", () => {
  test.each([[5], [true], [{}], [["dev"]]])("%p falls back to dev with a warning and never throws", (env) => {
    const inspector = new AvoInspector({ apiKey: "test-key", env: env as any, version: "1.0.0" });

    expect(inspector.environment).toBe("dev");
    expect(console.warn).toHaveBeenCalledWith(
      "[Avo Inspector] Unsupported environment provided. Defaulting to dev. Supported environments - Dev, Staging, Prod."
    );
    inspector.destroy();
  });

  test("null still counts as no environment", () => {
    const inspector = new AvoInspector({ apiKey: "test-key", env: null as any, version: "1.0.0" });

    expect(inspector.environment).toBe("dev");
    expect(console.warn).toHaveBeenCalledWith("[Avo Inspector] No environment provided. Defaulting to dev.");
    inspector.destroy();
  });
});

describe("number classification", () => {
  const typeOf = (v: unknown) => dev().extractSchema({ v })[0].propertyType;

  test.each([[1e-7], [5e-324], [1.5e-10], [0.5], [3.14], [-2.5]])("non-whole %p is float", (v) => {
    expect(typeOf(v)).toBe("float");
  });

  test.each([[0], [-3], [42], [1e21], [Number.MAX_SAFE_INTEGER]])("whole %p is int", (v) => {
    expect(typeOf(v)).toBe("int");
  });

  test("a bigint is int", () => {
    expect(typeOf(BigInt(10))).toBe("int");
  });

  test.each([[NaN], [Infinity], [-Infinity]])("%p is float (not a whole number)", (v) => {
    expect(typeOf(v)).toBe("float");
  });

  test("the list element type follows the same rule", () => {
    expect(dev().extractSchema({ v: [1e-7, 2] })).toEqual([
      { propertyName: "v", propertyType: "list(float)", children: ["float", "int"] },
    ]);
  });
});
