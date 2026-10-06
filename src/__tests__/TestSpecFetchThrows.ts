import { AvoInspector } from "../AvoInspector";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// A synchronous throw inside a spec fetch must not leave the key, the track call or the
// process-wide waiting-validation slot behind.

// Ends in a lone surrogate: encodeURIComponent throws URIError for it.
const BROKEN_NAME = "Bad " + "\u{1F600}".slice(0, 1);

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

test("an event name with a lone surrogate, logging on: every track settles, on a miss and on a hit", async () => {
  // dev turns logging on, which builds the debug line with the encoded name.
  const inspector = new AvoInspector({ apiKey: "k", env: "dev", version: "1.0.0" });
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

  // Two concurrent cache misses of the same key, then a cache hit.
  const misses = [
    inspector.trackSchemaFromEvent(BROKEN_NAME, { a: 1 }, "s"),
    inspector.trackSchemaFromEvent(BROKEN_NAME, { a: 1 }, "s"),
  ];
  await expect(settledWithin(Promise.all(misses), 3000)).resolves.toBe(true);
  await expect(settledWithin(inspector.trackSchemaFromEvent(BROKEN_NAME, { a: 1 }, "s"), 3000)).resolves.toBe(true);

  expect((AvoInspector as any).waitingValidations).toBe(0);
  await expect(inspector.flush(1000)).resolves.toBe(true);
  expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(3);
  inspector.destroy();
});

test("a fetch() that throws frees the waiting slot and the event is sent unvalidated", async () => {
  jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation(() => { throw new TypeError("sync"); });
  const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", disableBatchTimer: true });
  const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

  await expect(inspector.trackSchemaFromEvent("E", { a: 1 }, "s")).resolves.toHaveLength(1);
  expect((AvoInspector as any).waitingValidations).toBe(0);
  await expect(inspector.flush()).resolves.toBe(true);
  expect(send.mock.calls[0][0][0].eventSpecMetadata).toBeUndefined();
  inspector.destroy();
});

test("in the fetcher, a synchronous throw after the key is registered settles the key", async () => {
  const fetcher = new AvoEventSpecFetcher("k");
  // Logging on: the debug line encodes the name.
  jest.spyOn(AvoInspector, "shouldLog", "get").mockReturnValue(true);
  jest.spyOn(fetcher as any, "send").mockImplementation(() => { throw new Error("unexpected"); });

  const first = new Promise((resolve) => fetcher.fetch(BROKEN_NAME, "s", resolve));
  await expect(settledWithin(first, 1000)).resolves.toBe(true);
  expect((fetcher as any).inFlight.size).toBe(0);
});
