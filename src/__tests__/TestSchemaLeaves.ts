import { AvoSchemaParser } from "../AvoSchemaParser";
import { AvoInspector } from "../AvoInspector";
import { InspectorBody } from "../AvoNetworkCallsHandler";
import { deepEquals } from "../utils";

// Binary values are leaves: an ArrayBuffer view is list(int) with children ["int"] (as Java
// and Go type byte arrays), never visited; an ArrayBuffer is an empty object. And at most 10,000 properties
// are emitted per extraction, at every depth.

const MiB = 1024 * 1024;
const extract = (props: any) => AvoSchemaParser.extractSchema(props);
const countProperties = (schema: any[]): number =>
  schema.reduce((n, p) => n + 1 + (Array.isArray(p.children) && p.children.length > 0 && typeof p.children[0] === "object" && !Array.isArray(p.children[0]) ? countProperties(p.children) : 0), 0);

describe("binary values", () => {
  test("a 16 MiB Buffer is a list of ints, typed without visiting its bytes", () => {
    const file = Buffer.alloc(16 * MiB, 7);
    const started = Date.now();
    expect(extract({ file })).toEqual([
      { propertyName: "file", propertyType: "list(int)", children: ["int"] },
    ]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test.each([
    ["Uint8Array", new Uint8Array(4), "list(int)", ["int"]],
    ["Int32Array", new Int32Array(4), "list(int)", ["int"]],
    ["BigInt64Array", new BigInt64Array(4), "list(int)", ["int"]],
    ["Float64Array", new Float64Array(4), "list(int)", ["int"]],
    ["Float32Array", new Float32Array(4), "list(int)", ["int"]],
    ["DataView", new DataView(new ArrayBuffer(4)), "list(int)", ["int"]],
    ["an empty Uint8Array", new Uint8Array(0), "list(int)", ["int"]],
    ["ArrayBuffer", new ArrayBuffer(4 * MiB), "object", []],
    ["SharedArrayBuffer", new SharedArrayBuffer(16), "object", []],
  ])("%s", (_name, value, propertyType, children) => {
    expect(extract({ v: value })).toEqual([{ propertyName: "v", propertyType, children }]);
  });

  test("a Buffer inside a list is a list of ints too", () => {
    expect(extract({ files: [Buffer.alloc(MiB)] })).toEqual([
      { propertyName: "files", propertyType: "list(object)", children: [["int"]] },
    ]);
  });

  test("binary list elements past the depth cap are still typed; an object beside them is not", () => {
    // The list is mapped at depth 10, so its complex elements are at the cap.
    let props: any = { files: [Buffer.alloc(4), new ArrayBuffer(4), { a: 1 }] };
    for (let i = 0; i < 9; i++) props = { a: props };
    let schema: any = extract(props);
    for (let i = 0; i < 9; i++) schema = schema[0].children;
    expect(schema).toEqual([
      { propertyName: "files", propertyType: "list(object)", children: [["int"], [], "object"] },
    ]);
  });

  test("binary list elements use none of the expansion budget", () => {
    const files = Array.from({ length: 10_000 }, () => new Uint8Array(1));
    const schema = extract({ files, meta: { a: 1 } });
    expect(schema[1]).toEqual({
      propertyName: "meta",
      propertyType: "object",
      children: [{ propertyName: "a", propertyType: "int" }],
    });
  });

  test("deepEquals compares binary values by content, without enumerating them", () => {
    const started = Date.now();
    expect(deepEquals({ f: Buffer.alloc(16 * MiB, 1) }, { f: Buffer.alloc(16 * MiB, 1) })).toBe(true);
    expect(deepEquals({ f: Buffer.alloc(16 * MiB, 1) }, { f: Buffer.alloc(16 * MiB, 2) })).toBe(false);
    expect(deepEquals({ f: new Uint8Array([1]) }, { f: new Int8Array([1]) })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("the 10,000-property budget", () => {
  const wide = (n: number) => {
    const object: any = {};
    for (let i = 0; i < n; i++) object["k" + i] = i;
    return object;
  };

  test("an object with a million keys is cut off at 10,000 emitted properties, in insertion order", () => {
    const schema = extract({ first: 1, big: wide(1_000_000) });
    expect(countProperties(schema)).toBe(10_000);
    const big = schema[1].children;
    expect(big).toHaveLength(9_998);
    expect(big[0]).toEqual({ propertyName: "k0", propertyType: "int" });
    expect(big[big.length - 1].propertyName).toBe("k9997");
  });

  test("properties past the budget are omitted, also at the top level", () => {
    const schema = extract(wide(10_005));
    expect(schema).toHaveLength(10_000);
  });

  test("deepEquals treats objects past 10,000 compared properties as not equal", () => {
    const a = wide(20_000);
    expect(deepEquals({ a }, { a: wide(20_000) })).toBe(false);
    expect(deepEquals({ a: wide(9_000) }, { a: wide(9_000) })).toBe(true);
  });
});

describe("tracking a large binary value", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([1, 16])("an un-awaited track with a %i MiB Buffer is fast, its body small, and nothing rejects", async (mib) => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    const inspector = new AvoInspector({ apiKey: "k", env: "prod", version: "1.0.0" });
    inspector.enableLogging(false);
    const sent: InspectorBody[] = [];
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation((batch) => { sent.push(...batch); return Promise.resolve(200); });

    const file = Buffer.alloc(mib * MiB, 7);
    const started = Date.now();
    inspector.trackSchemaFromEvent("Upload", { file, name: "x" });
    expect(Date.now() - started).toBeLessThan(200);
    await expect(inspector.flush()).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]).length).toBeLessThan(2_000);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandled);
    inspector.destroy();
  });
});

describe("binary data or an array as the whole properties argument", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const roots: Array<[string, any]> = [
    ["Buffer", Buffer.from("abc")],
    ["Uint8Array", new Uint8Array(3)],
    ["DataView", new DataView(new ArrayBuffer(8))],
    ["ArrayBuffer", new ArrayBuffer(8)],
    ["array", [1, 2]],
  ];

  test.each(roots)("%s has no properties: extractSchema returns []", (_name, root) => {
    expect(AvoSchemaParser.extractSchema(root)).toEqual([]);
  });

  test.each(roots)("%s is tracked with no properties: the call resolves [] and the body's eventProperties is []", async (_name, root) => {
    const inspector = new AvoInspector({ apiKey: "k", env: "prod", version: "1.0.0", disableBatchTimer: true });
    inspector.enableLogging(false);
    const sent: InspectorBody[] = [];
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation((batch) => { sent.push(...batch); return Promise.resolve(200); });

    await expect(inspector.trackSchemaFromEvent("Root", root)).resolves.toEqual([]);
    await inspector.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].eventProperties).toEqual([]);
    inspector.destroy();
  });
});
