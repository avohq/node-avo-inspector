import { createHash } from "crypto";

import { AvoSchemaParser } from "../AvoSchemaParser";

// Cross-SDK extraction bound: Node, Java and Go must produce the same schema, digest for
// digest. Canonical form: an entry is {name|type} or {name|type|children}, a list is
// [a,b,...], and type strings inside children are JSON-quoted. MAX_PROPERTIES counts one
// entry per property at every depth (also properties of objects inside lists, never list
// elements), pre-order, and omits every entry after the 10,000th, in iteration order.

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
  ["flat key0..key999999", () => keys(1_000_000), 138_891, "9652d270cd6568d00b73032b56b73782771f634703c89f7fa81df852ae50c835"],
  ["nested a..e, each key0..key4999", () => ({ a: keys(5000), b: keys(5000), c: keys(5000), d: keys(5000), e: keys(5000) }), 137_779, "73549e68066367f3e976a97b299df3bb972e80fe65b487f89b7d7f251397984d"],
  ["items = 3 maps of 4,000 keys, then after", () => ({ items: [keys(4000), keys(4000), keys(4000)], after: 1 }), 136_686, "1f5e38d0b71cdb231568521f0f1ceffc768cd7fcae5e08ab555fc64b8227601f"],
  ["mapsDag(4,12)", () => {
    let level: any = { leaf: 1 };
    for (let i = 0; i < 12; i++) level = { k0: level, k1: level, k2: level, k3: level };
    return level;
  }, 147_496, "5012bc5b9543195e969f2b10956402ef0306e92a009f409194dffd8bd46083ed"],
])("%s: 10,000 entries, digest matches Java and Go", (_name, build, length, digest) => {
  const props = build();
  const started = Date.now();
  const schema = AvoSchemaParser.extractSchema(props);
  // Listing a million keys is linear (about 150 ms unloaded); the bound only rules out the
  // old per-key expansion. Generous for a loaded machine.
  expect(Date.now() - started).toBeLessThan(10_000);

  const canonical = canon(schema);
  expect(entries(schema)).toBe(10_000);
  expect(canonical.length).toBe(length);
  expect(sha256(canonical)).toBe(digest);
});

test("listDag(6,12), below the budget, is unchanged: 8,570 entries", () => {
  let level: any = { v: 1 };
  for (let i = 0; i < 12; i++) level = { l: Array.from({ length: 6 }, () => level) };
  expect(entries(AvoSchemaParser.extractSchema(level))).toBe(8_570);
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
  }), 30_064, "730800e36cee008cc29c5d8a8f75474453ff2c6a561becdb968db7d14cdac3c6"],
])("binary data, %s: digest matches Java and Go", (_name, build, length, digest) => {
  const canonical = canon(AvoSchemaParser.extractSchema(build()));
  expect(canonical.length).toBe(length);
  expect(sha256(canonical)).toBe(digest);
});
