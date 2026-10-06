import { deepEquals } from "../utils";
import { AvoInspector } from "../AvoInspector";
import { InspectorBody } from "../AvoNetworkCallsHandler";

// deepEquals stops at the schema extraction limits (10 levels, 10,000 expanded objects and
// lists) and treats payloads past them as not equal, so a huge payload cannot overflow the
// stack or block the thread inside the deduplicator.

// { a: { a: ... { a: "leaf" } } } with `levels` objects.
function nested(levels: number): any {
  let value: any = "leaf";
  for (let i = 0; i < levels; i++) {
    value = { a: value };
  }
  return value;
}

// { k0: {}, k1: {}, ... } with `count` objects inside the outer one.
function wide(count: number): any {
  const value: any = {};
  for (let i = 0; i < count; i++) {
    value["k" + i] = {};
  }
  return value;
}

describe("deepEquals limits", () => {
  test("equal payloads within 10 levels compare equal", () => {
    expect(deepEquals(nested(10), nested(10))).toBe(true);
  });

  test("equal payloads more than 10 levels deep compare not equal", () => {
    expect(deepEquals(nested(11), nested(11))).toBe(false);
  });

  test("a very deep payload returns false instead of overflowing the stack", () => {
    expect(deepEquals(nested(100_000), nested(100_000))).toBe(false);
  });

  test("up to 10,000 expanded objects compare equal; past that, not equal", () => {
    // The outer object counts as one.
    expect(deepEquals(wide(9_999), wide(9_999))).toBe(true);
    expect(deepEquals(wide(10_000), wide(10_000))).toBe(false);
  });

  test("the same reference is still equal at any depth", () => {
    const deep = nested(100_000);
    expect(deepEquals(deep, deep)).toBe(true);
    expect(deepEquals({ x: deep }, { x: deep })).toBe(true);
  });
});

describe("deduplicating a deeply nested payload", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("sent by Codegen and by hand within 500 ms: no stack overflow, both are sent", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const inspector = new AvoInspector({ apiKey: "k", env: "prod", version: "1.0.0", disableBatchTimer: true });
    const sent: InspectorBody[] = [];
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation((batch) => { sent.push(...batch); return Promise.resolve(200); });

    // @ts-ignore
    await expect(inspector._avoFunctionTrackSchemaFromEvent("Deep", { p: nested(100_000) }, "id", "hash"))
      .resolves.toHaveLength(1);
    await expect(inspector.trackSchemaFromEvent("Deep", { p: nested(100_000) })).resolves.toHaveLength(1);
    await inspector.flush();

    expect(sent.map((e) => e.eventName)).toEqual(["Deep", "Deep"]);
    expect(console.error).not.toHaveBeenCalled();
    inspector.destroy();
  });
});
