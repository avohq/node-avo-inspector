import { format } from "util";
import * as crypto from "crypto";

import { AvoInspector } from "../AvoInspector";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";

// With logging on, log lines show schema types, never raw property values. The flag is
// process-wide (a dev instance turns it on for a prod one), so values would otherwise leak.

const MARKER = "PII-MARKER-123@example.com";
const API_KEY = "api-key-SECRET-456";

let output: string[] = [];

beforeEach(() => {
  output = [];
  for (const method of ["log", "info", "warn", "error"] as const) {
    jest.spyOn(console, method).mockImplementation((...args: any[]) => {
      output.push(format(...args));
    });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

const props = () => ({
  email: MARKER,
  profile: { contact: MARKER, age: 30 },
  tags: [MARKER],
});

const logged = () => output.join("\n");

test("log lines show schema types and never property values or the API key", async () => {
  // Track and Codegen track; sends fail against the default closed local port, which logs.
  const dev = new AvoInspector({ apiKey: API_KEY, env: "dev", version: "1.0.0" });
  dev.enableLogging(true);
  await dev.trackSchemaFromEvent("Signed Up", props(), "stream-1");
  // @ts-ignore
  await dev._avoFunctionTrackSchemaFromEvent("Signed Up Codegen", props(), "event-id", "hash");
  // The Codegen/manual duplicate warning from extractSchema.
  dev.extractSchema(props());

  // Encryption with a value that cannot be serialized (a cycle).
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const encrypting = new AvoInspector({
    apiKey: API_KEY, env: "dev", version: "1.0.0", publicEncryptionKey: ecdh.getPublicKey("hex"),
  });
  const cyclic: any = { email: MARKER };
  cyclic.self = cyclic;
  await encrypting.trackSchemaFromEvent("Encrypted", { cyclic, email: MARKER });

  // Event spec validation, with a regex the value fails.
  jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((eventName, _s, callback) =>
    callback({
      eventSpec: { eventName, properties: [{ propertyName: "email", propertyType: "string", regex: "^nope$" }] },
      metadata: { schemaId: "s", branchId: "b", latestActionId: "a", sourceId: "src" },
    })
  );
  const validating = new AvoInspector({ apiKey: API_KEY, env: "staging", version: "1.0.0" });
  validating.enableLogging(true);
  jest.spyOn(validating.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockRejectedValue("Request failed");
  await validating.trackSchemaFromEvent("Validated", props());
  await validating.flush();
  [dev, encrypting, validating].forEach((inspector) => inspector.destroy());

  const text = logged();
  // Every scenario above did log, so the checks below cover each path.
  expect(text).toContain("Supplied event Signed Up Codegen");
  expect(text).toContain("You are trying to extract schema shape that was just reported by your Codegen");
  expect(text).toContain("could not serialize property");
  expect(text).toContain("Sending validated event Validated");
  expect(text).toContain("schema sending failed");
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain(API_KEY);
  // The schema is still there: names and types.
  expect(text).toContain("Signed Up");
  expect(text).toMatch(/"email"[^\n]*string/);
  expect(text).toMatch(/"profile"[^\n]*object/);
  expect(text).toMatch(/"tags"[^\n]*list\(string\)/);
});

describe("caught errors never print their message", () => {
  test("a value whose toJSON throws with a property value is omitted, and the value is not logged", async () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const inspector = new AvoInspector({
      apiKey: API_KEY, env: "dev", version: "1.0.0", publicEncryptionKey: ecdh.getPublicKey("hex"),
    });
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);
    const secret = { toJSON() { throw new Error("cannot serialize " + MARKER); } };

    await inspector.trackSchemaFromEvent("Encrypted", { secret, ok: "fine" });

    const sent = send.mock.calls[0][0][0];
    expect(sent.eventProperties.map((p: any) => p.propertyName)).toEqual(["ok"]);
    expect(logged()).toContain('could not serialize property "secret" for encryption, omitting it. (Error)');
    expect(logged()).not.toContain(MARKER);
    inspector.destroy();
  });

  test("an event spec validation that throws with a property value logs only the error's type", async () => {
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((_e, _s, callback) =>
      callback({ eventSpec: { eventName: "E", properties: [] }, metadata: {} } as any)
    );
    const inspector = new AvoInspector({ apiKey: API_KEY, env: "staging", version: "1.0.0", disableBatchTimer: true });
    inspector.enableLogging(true);
    jest.spyOn(inspector as any, "fetchAndValidate").mockRejectedValue(new TypeError("bad value " + MARKER));

    await inspector.trackSchemaFromEvent("E", { email: "x" });

    expect(logged()).toContain("Event spec validation failed for event: E. Sending without validation. (TypeError)");
    expect(logged()).not.toContain(MARKER);
    inspector.destroy();
  });
});
