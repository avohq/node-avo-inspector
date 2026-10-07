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
    const started = Date.now();
    expect(extract({ file: Buffer.alloc(16 * MiB, 7) })).toEqual([
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

    const started = Date.now();
    inspector.trackSchemaFromEvent("Upload", { file: Buffer.alloc(mib * MiB, 7), name: "x" });
    expect(Date.now() - started).toBeLessThan(200);
    await expect(inspector.flush()).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]).length).toBeLessThan(2_000);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandled);
    inspector.destroy();
  });
});
