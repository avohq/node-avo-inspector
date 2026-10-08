import { AvoInspector } from "../AvoInspector";
import { AvoEventSpecCache } from "../eventSpec/AvoEventSpecCache";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// Tracks that share one spec fetch store its response once: storing the same response
// again must not count toward the cache's rotation and evict unrelated entries.

afterEach(() => {
  jest.restoreAllMocks();
});

test("re-setting a key to the same response is not a cache operation", () => {
  const cache = new AvoEventSpecCache();
  const response = { eventSpec: null, metadata: { schemaId: "", branchId: "", latestActionId: "", sourceId: "" } };
  for (let i = 0; i < 10; i++) cache.set("warm" + i, { ...response });
  for (let i = 0; i < 200; i++) cache.set("hot", response);

  for (let i = 0; i < 10; i++) expect(cache.contains("warm" + i)).toBe(true);
});

test("200 tracks sharing one fetch evict none of the warm keys", async () => {
  // The spec is fetched from the test mock, which answers "no spec".
  const fetch = jest.spyOn(AvoEventSpecFetcher.prototype, "fetch");
  const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", disableBatchTimer: true });
  inspector.enableLogging(false);
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

  for (let i = 0; i < 10; i++) await inspector.trackSchemaFromEvent({ eventName: "Warm" + i, eventProperties: { a: 1 } });
  await Promise.all(Array.from({ length: 200 }, () => inspector.trackSchemaFromEvent({ eventName: "Hot", eventProperties: { a: 1 } })));
  const before = fetch.mock.calls.length;
  for (let i = 0; i < 10; i++) await inspector.trackSchemaFromEvent({ eventName: "Warm" + i, eventProperties: { a: 1 } });

  expect(fetch.mock.calls.length - before).toBe(0);
  inspector.destroy();
});
