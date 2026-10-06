import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";

// Pins the debug-log schema format and the Avo function fields of both body builders.

const schema = [
  { propertyName: "a", propertyType: "int" },
  { propertyName: "b", propertyType: "string" },
];
const printed = '{\n\t"a": "int";\n\t"b": "string"\n}';
const metadata = { schemaId: "s", branchId: "b", latestActionId: "l", sourceId: "src" };

let log: jest.SpyInstance;

beforeEach(() => {
  log = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const lines = () => log.mock.calls.map((call) => call.join(" "));

test("the parsed and saved debug lines print the schema", async () => {
  const inspector = new AvoInspector({ apiKey: "k", env: "prod", version: "1.0.0", batchSize: 1 });
  inspector.enableLogging(true);
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

  await inspector.trackSchemaFromEvent("E", { a: 1, b: "x" });
  inspector.destroy();

  expect(lines()).toContain("Avo Inspector: Parsed schema " + printed);
  expect(lines()).toContain("Avo Inspector: Saved event E with schema " + printed);
});

test("the sending debug line prints the schema, marking validated events", async () => {
  jest.spyOn(AvoInspector, "shouldLog", "get").mockReturnValue(true);
  const handler = new AvoNetworkCallsHandler("k", "dev", "", "1.0.0", "2.0.0");
  // Aborted: the batch is logged, then rejected without a request.
  handler.abortInFlight();
  const plain = handler.bodyForEventSchemaCall("", "Plain", schema, null, null);
  const validated = handler.bodyForValidatedEventSchemaCall("", "Checked", schema, null, null, metadata, []);

  await expect(handler.callInspectorWithBatchBody([plain, validated])).rejects.toBe("Request failed");

  expect(lines()).toContain("Avo Inspector: Sending event Plain with schema " + printed);
  expect(lines()).toContain("Avo Inspector: Sending event Checked (validated) with schema " + printed);
});

test.each([
  ["bodyForEventSchemaCall", (h: AvoNetworkCallsHandler, id: string | null, hash: string | null) =>
    h.bodyForEventSchemaCall("", "E", schema, id, hash)],
  ["bodyForValidatedEventSchemaCall", (h: AvoNetworkCallsHandler, id: string | null, hash: string | null) =>
    h.bodyForValidatedEventSchemaCall("", "E", schema, id, hash, metadata, [])],
])("%s sets the Avo function fields from eventId", (_name, build) => {
  const handler = new AvoNetworkCallsHandler("k", "dev", "", "1.0.0", "2.0.0");

  const codegen = build(handler, "id", "hash");
  expect([codegen.avoFunction, codegen.eventId, codegen.eventHash]).toEqual([true, "id", "hash"]);
  const manual = build(handler, null, "ignored");
  expect([manual.avoFunction, manual.eventId, manual.eventHash]).toEqual([false, null, null]);
});
