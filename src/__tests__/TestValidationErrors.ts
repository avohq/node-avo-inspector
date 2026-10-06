import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler, InspectorBody } from "../AvoNetworkCallsHandler";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// An error thrown while validating against a fetched spec must not leave the track call,
// flush() or exit waiting: the event is sent without validation, on a cache hit or miss.

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  // Validation on (no endpoint override), with the spec delivered asynchronously.
  jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
  jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((eventName, _s, callback) => {
    setImmediate(() => callback({
      eventSpec: { eventName, properties: [{ propertyName: "a", propertyType: "string", regex: ".*" }] },
      metadata: { schemaId: "s", branchId: "b", latestActionId: "a", sourceId: "src" },
    }));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Reads fine once (schema extraction), then throws (the validator reading the value).
function throwsOnSecondRead() {
  let reads = 0;
  return new Proxy({ a: "x" }, {
    get(target, key, receiver) {
      if (key === "a" && ++reads > 1) {
        throw new Error("second read");
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

function staging() {
  const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", disableBatchTimer: true });
  const sent: InspectorBody[] = [];
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
    .mockImplementation((batch) => { sent.push(...batch); return Promise.resolve(200); });
  return { inspector, sent };
}

async function expectSentUnvalidated(inspector: AvoInspector, sent: InspectorBody[], track: Promise<unknown>) {
  await expect(track).resolves.toEqual([{ propertyName: "a", propertyType: "string" }]);
  const started = Date.now();
  await inspector.flush(5000);
  expect(Date.now() - started).toBeLessThan(1000);

  const event = sent.find((e) => e.eventName === "Throws")!;
  expect(event).toBeDefined();
  expect(event.eventSpecMetadata).toBeUndefined();
  expect((inspector as any).pending.size).toBe(0);
  expect((AvoInspector as any).instancesWithWork.has(inspector)).toBe(false);
}

test("a cache miss whose validation throws sends the event unvalidated", async () => {
  const { inspector, sent } = staging();

  const track = inspector.trackSchemaFromEvent("Throws", throwsOnSecondRead(), "s1");

  await expectSentUnvalidated(inspector, sent, track);
  inspector.destroy();
}, 10_000);

test("a cache hit whose validation throws behaves the same", async () => {
  const { inspector, sent } = staging();
  // Caches the spec for ("Throws", "s1").
  await inspector.trackSchemaFromEvent("Throws", { a: "x" }, "s1");
  await inspector.flush();
  sent.length = 0;

  const track = inspector.trackSchemaFromEvent("Throws", throwsOnSecondRead(), "s1");

  await expectSentUnvalidated(inspector, sent, track);
  inspector.destroy();
}, 10_000);
