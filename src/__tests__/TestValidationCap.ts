import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler, InspectorBody } from "../AvoNetworkCallsHandler";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// At most 1,000 events wait for a spec fetch at once, process-wide; past that an event is
// sent without validation instead of waiting behind the others.

const CAP = 1000;

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

function staging() {
  const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", disableBatchTimer: true });
  const sent: InspectorBody[] = [];
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
    .mockImplementation((batch) => { sent.push(...batch); return Promise.resolve(200); });
  return { inspector, sent };
}

const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

test("past 1,000 events waiting for a spec, the next is sent without validation", async () => {
  // Spec fetches that never answer.
  const fetch = jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation(() => {});
  const a = staging();
  const b = staging();

  // The cap is shared by every instance: 600 + 400 fill it.
  for (let i = 0; i < 600; i++) {
    a.inspector.trackSchemaFromEvent("E" + i, { p: "x" }, "s");
  }
  for (let i = 0; i < 400; i++) {
    b.inspector.trackSchemaFromEvent("F" + i, { p: "x" }, "s");
  }
  expect(fetch).toHaveBeenCalledTimes(CAP);

  const over = b.inspector.trackSchemaFromEvent("Over", { p: "x" }, "s");
  await expect(settledWithin(over, 500)).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(CAP);
  await b.inspector.flush(1);
  expect(b.sent.map((e) => e.eventName)).toEqual(["Over"]);
  expect(b.sent[0].eventSpecMetadata).toBeUndefined();

  // Destroying an instance frees its places.
  a.inspector.destroy();
  b.inspector.trackSchemaFromEvent("AfterDestroy", { p: "x" }, "s");
  expect(fetch).toHaveBeenCalledTimes(CAP + 1);
  b.inspector.destroy();
  expect((AvoInspector as any).waitingValidations).toBe(0);
});

test("a settled fetch frees its place", async () => {
  let deliver: Array<() => void> = [];
  const fetch = jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((_e, _s, callback) => {
    deliver.push(() => callback(null));
  });
  const { inspector } = staging();
  const tracks = Array.from({ length: CAP }, (_, i) => inspector.trackSchemaFromEvent("E" + i, { p: "x" }, "s"));
  deliver.forEach((d) => d());
  deliver = [];
  await Promise.all(tracks);

  inspector.trackSchemaFromEvent("Next", { p: "x" }, "s");
  expect(fetch).toHaveBeenCalledTimes(CAP + 1);
  inspector.destroy();
  expect((AvoInspector as any).waitingValidations).toBe(0);
});
