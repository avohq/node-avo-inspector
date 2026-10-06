import { AvoInspector } from "../AvoInspector";
import { InspectorBody } from "../AvoNetworkCallsHandler";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// The schema a track call resolves with is the caller's: changing it must not change the
// event still waiting in the batch.

afterEach(() => {
  jest.restoreAllMocks();
});

const spec = (eventName: string) => ({
  eventSpec: { eventName, properties: [{ propertyName: "a", propertyType: "int" }, { propertyName: "b", propertyType: "list" }] },
  metadata: { schemaId: "s", branchId: "b", latestActionId: "l", sourceId: "src" },
});

test.each([
  ["prod", "prod", false],
  ["staging, sent unvalidated", "staging", false],
  ["staging, validated", "staging", true],
] as const)("%s: mutating the returned schema leaves the queued event unchanged", async (_label, env, validated) => {
  jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((eventName, _s, callback) =>
    setImmediate(() => callback(validated ? spec(eventName) : null)));
  const inspector = new AvoInspector({ apiKey: "k", env, version: "1.0.0", disableBatchTimer: true });
  inspector.enableLogging(false);
  const sent: InspectorBody[] = [];
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
    .mockImplementation((batch) => { sent.push(...batch); return Promise.resolve(200); });

  const schema: any[] = await inspector.trackSchemaFromEvent("E", { a: 1, b: [{ x: 1 }] }, "s");
  schema[0].propertyType = "MUTATED";
  schema[1].children[0] = "MUTATED";
  schema.pop();
  await inspector.flush();

  expect(sent).toHaveLength(1);
  expect(sent[0].eventSpecMetadata !== undefined).toBe(validated);
  expect(sent[0].eventProperties.map(({ propertyName, propertyType, children }: any) => ({ propertyName, propertyType, children })))
    .toEqual([
      { propertyName: "a", propertyType: "int", children: undefined },
      { propertyName: "b", propertyType: "list(object)", children: [[{ propertyName: "x", propertyType: "int" }]] },
    ]);
  inspector.destroy();
});
