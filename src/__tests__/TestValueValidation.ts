import * as crypto from "crypto";
import { AvoInspector } from "../AvoInspector";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// Value validation end to end: a spec in the endpoint's wire format, the event tracked, and
// the failed event IDs as they go out on the wire.

const wire = {
  events: [
    {
      b: "main",
      id: "evt",
      vids: ["evt.v1"],
      p: {
        plan: { t: "string", r: true, v: { '["free","pro"]': ["evt"], '["free"]': ["evt.v1"] } },
        amount: { t: "float", r: false, minmax: { "0,100": ["evt", "evt.v1"] } },
        cart: {
          t: "object",
          r: false,
          children: { currency: { t: "string", r: true, v: { '["EUR","USD"]': ["evt", "evt.v1"] } } },
        },
        items: {
          t: "object",
          r: false,
          l: true,
          children: { sku: { t: "string", r: true, rx: { "^SKU-\\d+$": ["evt", "evt.v1"] } } },
        },
      },
    },
  ],
  metadata: { schemaId: "s", branchId: "main", latestActionId: "a", sourceId: "src" },
};

let sent: any[];

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((eventName, _s, callback) =>
    callback(AvoEventSpecFetcher.parseWireResponse(wire, eventName))
  );
  sent = [];
});

afterEach(() => {
  jest.restoreAllMocks();
});

function staging(options: { publicEncryptionKey?: string } = {}): AvoInspector {
  const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", disableBatchTimer: true, ...options });
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockImplementation((batch) => {
    sent.push(...batch);
    return Promise.resolve(200);
  });
  return inspector;
}

async function track(inspector: AvoInspector, eventProperties: { [name: string]: any }): Promise<any> {
  await inspector.trackSchemaFromEvent({ eventName: "Checkout", eventProperties });
  await inspector.flush();
  inspector.destroy();
  expect(sent).toHaveLength(1);
  return sent[0];
}

const property = (event: any, name: string) => event.eventProperties.find((p: any) => p.propertyName === name);

test("a value outside the allowed values fails the event IDs whose list lacks it", async () => {
  const event = await track(staging(), { plan: "pro", amount: 10 });

  expect(event.eventSpecMetadata).toEqual(wire.metadata);
  expect(property(event, "plan").failedEventIds).toEqual(["evt.v1"]);
  expect(property(event, "amount").failedEventIds).toBeUndefined();
});

test("a value breaking a min/max range fails every event ID with that range", async () => {
  const event = await track(staging(), { plan: "free", amount: 250 });

  expect(property(event, "plan").failedEventIds).toBeUndefined();
  expect(property(event, "amount").failedEventIds).toEqual(["evt", "evt.v1"]);
});

test("an object property's failure is reported on that property in children", async () => {
  const event = await track(staging(), { plan: "free", cart: { currency: "GBP" } });

  const cart = property(event, "cart");
  expect(cart.failedEventIds).toBeUndefined();
  expect(cart.children).toEqual([{ propertyName: "currency", propertyType: "string", failedEventIds: ["evt", "evt.v1"] }]);
});

test("a list of objects reports a failing property on each element schema that has it", async () => {
  const event = await track(staging(), { plan: "free", items: [{ sku: "SKU-1", qty: 1 }, { sku: "bad" }] });

  expect(property(event, "items").children).toEqual([
    [
      { propertyName: "sku", propertyType: "string", failedEventIds: ["evt", "evt.v1"] },
      { propertyName: "qty", propertyType: "int" },
    ],
    [{ propertyName: "sku", propertyType: "string", failedEventIds: ["evt", "evt.v1"] }],
  ]);
});

test("only failed event IDs go on the wire, never passed ones", async () => {
  const event = await track(staging(), { plan: "pro", amount: 10, cart: { currency: "EUR" } });

  expect(JSON.stringify(event)).not.toContain("passedEventIds");
});

test("a Codegen event is validated against the spec's event IDs, not its own id", async () => {
  const inspector = staging();
  // @ts-ignore
  await inspector._avoFunctionTrackSchemaFromEvent("Checkout", { plan: "enterprise" }, "codegen-id", "hash");
  await inspector.flush();
  inspector.destroy();

  expect(property(sent[0], "plan").failedEventIds).toEqual(["evt", "evt.v1"]);
});

test("with an encryption key, the failed event IDs go next to the encrypted value", async () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const event = await track(staging({ publicEncryptionKey: ecdh.getPublicKey("hex", "compressed") }), { plan: "pro" });

  const plan = property(event, "plan");
  expect(plan.encryptedPropertyValue).toEqual(expect.any(String));
  expect(plan.failedEventIds).toEqual(["evt.v1"]);
});
