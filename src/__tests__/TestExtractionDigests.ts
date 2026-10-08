import { createHash } from "crypto";

import { AvoSchemaParser } from "../AvoSchemaParser";

// Cross-SDK extraction bound: Node, Java and Go must produce the same schema, digest for
// digest. Canonical form: an entry is {name|type} or {name|type|children}, a list is
// [a,b,...], and type strings inside children are JSON-quoted. MAX_PROPERTIES counts one
// entry per property at every depth (also properties of objects inside lists, never list
// elements), pre-order, and omits every entry after the 10,000th, in iteration order. A list's
// children are deduplicated by value afterwards, which changes neither count: equal maps in a
// list leave one child, though each was counted.

const canonElement = (x: any): string =>
  typeof x === "string"
    ? JSON.stringify(x)
    : Array.isArray(x)
    ? canon(x)
    : "{" + x.propertyName + "|" + x.propertyType + (x.children !== undefined ? "|" + canon(x.children) : "") + "}";
const canon = (list: any[]): string => "[" + list.map(canonElement).join(",") + "]";
const entries = (list: any[]): number =>
  list.reduce((n, x) => n + (typeof x === "string" ? 0 : Array.isArray(x) ? entries(x) : 1 + (x.children ? entries(x.children) : 0)), 0);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const keys = (n: number) => {
  const object: any = {};
  for (let i = 0; i < n; i++) object["key" + i] = i;
  return object;
};

test.each([
  ["flat key0..key999999", () => keys(1_000_000), 10_000, 138_891, "9652d270cd6568d00b73032b56b73782771f634703c89f7fa81df852ae50c835"],
  ["nested a..e, each key0..key4999", () => ({ a: keys(5000), b: keys(5000), c: keys(5000), d: keys(5000), e: keys(5000) }), 10_000, 137_779, "73549e68066367f3e976a97b299df3bb972e80fe65b487f89b7d7f251397984d"],
  // 4,000 + 4,000 + 2,000 entries counted; the second map equals the first, so 6,000 are left.
  ["items = 3 maps of 4,000 keys, then after", () => ({ items: [keys(4000), keys(4000), keys(4000)], after: 1 }), 6_000, 81_794, "a36b0433669c560d85d2f289e194ab6cc4eaa6f32ab13c5acdcac56703bf5b3c"],
  ["mapsDag(4,12)", () => {
    let level: any = { leaf: 1 };
    for (let i = 0; i < 12; i++) level = { k0: level, k1: level, k2: level, k3: level };
    return level;
  }, 10_000, 147_496, "5012bc5b9543195e969f2b10956402ef0306e92a009f409194dffd8bd46083ed"],
])("%s: 10,000 entries counted, digest matches Java and Go", (_name, build, emitted, length, digest) => {
  const props = build();
  const started = Date.now();
  const schema = AvoSchemaParser.extractSchema(props);
  // Listing a million keys is linear (about 150 ms unloaded); the bound only rules out the
  // old per-key expansion. Generous for a loaded machine.
  expect(Date.now() - started).toBeLessThan(10_000);

  const canonical = canon(schema);
  expect(entries(schema)).toBe(emitted);
  expect(canonical.length).toBe(length);
  expect(sha256(canonical)).toBe(digest);
});

test("listDag(6,12): its 6 equal elements per list collapse to one child, digest matches Java and Go", () => {
  let level: any = { v: 1.5 };
  for (let i = 0; i < 12; i++) level = { items: Array.from({ length: 6 }, () => level) };
  const schema = AvoSchemaParser.extractSchema(level);

  const canonical = canon(schema);
  expect(entries(schema)).toBe(15);
  expect(canonical.length).toBe(386);
  expect(sha256(canonical)).toBe("fa36cee2d9450d07e0b374330e796ce55b03dc8e37b44af34c902d60b0c787e5");
});

// Binary data (a Buffer here, byte[] in Java, []byte in Go) is one complex value: the depth cap
// and the expansion budget apply to it first, and otherwise it is list(int) with ["int"], using
// one expansion, its bytes never walked. B is the bytes [1, 2, 3].
const B = () => Buffer.from([1, 2, 3]);
const binaryLevel = (inner?: any) => ({ o: { k: 1 }, bin: B(), list: [B()], ...(inner ? { a: inner } : {}) });

test.each([
  ["12 levels of { o: { k: 1 }, bin: B, list: [B], a }: below and at the depth cap", () => {
    let level: any = binaryLevel();
    for (let i = 0; i < 11; i++) level = binaryLevel(level);
    return level;
  }, 943, "6df178dc9f783988959d054123ab6abedb56292f034c2e35f5b46ddd8da3de04"],
  ["{ fill: [9,997 {}, B, B, {}], bin: B, list: [B] }: B takes the last expansion", () => ({
    fill: [...Array.from({ length: 9_997 }, () => ({})), B(), B(), {}],
    bin: B(),
    list: [B()],
  }), 76, "708abe1e2c28146b4c3cd44e960c2d3345b6a968d195440f7282700cac027601"],
])("binary data, %s: digest matches Java and Go", (_name, build, length, digest) => {
  const canonical = canon(AvoSchemaParser.extractSchema(build()));
  expect(canonical.length).toBe(length);
  expect(sha256(canonical)).toBe(digest);
});

// Parity fixture F1: numeric typed arrays are typed by element type (float32/float64 arrays in
// Java and Go), never walked, so an empty one has the same type.
test("F1, typed arrays by element type: structure and digest match Java and Go", () => {
  const schema = AvoSchemaParser.extractSchema({
    d: new Float64Array([0.5, 1.5]),
    f: new Float32Array([0.5]),
    e: new Float64Array([]),
    b: Buffer.from([1, 2]),
    i: new Int32Array([1, 2]),
  });
  expect(schema).toEqual([
    { propertyName: "d", propertyType: "list(float)", children: ["float"] },
    { propertyName: "f", propertyType: "list(float)", children: ["float"] },
    { propertyName: "e", propertyType: "list(float)", children: ["float"] },
    { propertyName: "b", propertyType: "list(int)", children: ["int"] },
    { propertyName: "i", propertyType: "list(int)", children: ["int"] },
  ]);

  const canonical = canon(schema);
  expect(canonical.length).toBe(123);
  expect(sha256(canonical)).toBe("bd4dcad1a3f78a8bf7d1ad8a88c878beb77c6c59b6c40abfb7f2706df3433985");
});

// Parity fixture F2: a list's children hold each distinct child schema once, in first-occurrence
// order. Maps are equal whatever their property order (the first one's order is kept); nested
// lists compare their children in order.
test("F2, list children deduplicated by value: structure and digest match Java and Go", () => {
  const schema = AvoSchemaParser.extractSchema({
    maps: [{ a: 1, b: "x" }, { b: "y", a: 2 }, { a: 3 }],
    lists: [[1], [2], ["x"], [3]],
    bins: [Buffer.from([1]), Buffer.from([2, 3]), Buffer.from([])],
    mixed: [1, "x", 2, "y"],
  });
  expect(schema).toEqual([
    {
      propertyName: "maps",
      propertyType: "list(object)",
      children: [
        [{ propertyName: "a", propertyType: "int" }, { propertyName: "b", propertyType: "string" }],
        [{ propertyName: "a", propertyType: "int" }],
      ],
    },
    { propertyName: "lists", propertyType: "list(object)", children: [["int"], ["string"]] },
    { propertyName: "bins", propertyType: "list(object)", children: [["int"]] },
    { propertyName: "mixed", propertyType: "list(int)", children: ["int", "string"] },
  ]);

  const canonical = canon(schema);
  expect(canonical.length).toBe(161);
  expect(sha256(canonical)).toBe("ea480ff92fa33427780e2b46510d84e80589d90fd4bf57baac2f8efa3c866422");
});

test("dedup compares by value, not by structure alone: maps that differ in a type or a nested list's order stay apart", () => {
  const [{ children }] = AvoSchemaParser.extractSchema({
    v: [{ a: 1 }, { a: "x" }, { a: [1, "x"] }, { a: ["x", 1] }, { a: [1, "x"] }],
  });
  expect(children).toEqual([
    [{ propertyName: "a", propertyType: "int" }],
    [{ propertyName: "a", propertyType: "string" }],
    [{ propertyName: "a", propertyType: "list(int)", children: ["int", "string"] }],
    [{ propertyName: "a", propertyType: "list(string)", children: ["string", "int"] }],
  ]);
});

test("one Buffer repeated 200,000 times leaves one child, quickly", () => {
  const buffer = Buffer.from([1, 2, 3]);
  const started = Date.now();
  const schema = AvoSchemaParser.extractSchema({ files: Array.from({ length: 200_000 }, () => buffer) });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(schema).toEqual([{ propertyName: "files", propertyType: "list(object)", children: [["int"], "object"] }]);
});
