import { format } from "util";

import { AvoInspector } from "../AvoInspector";
import { InspectorBody } from "../AvoNetworkCallsHandler";
import { AvoLog } from "../AvoLog";

// Data loss and send failures are logged whatever the logging flag, at most one line per
// kind (per reason or status) per 10 s; sampling drops and debug lines stay behind the flag.

const API_KEY = "api-key-SECRET-789";
const MARKER = "PII-MARKER-789@example.com";

let lines: string[] = [];
let now = 1_000_000;

beforeEach(() => {
  lines = [];
  now = 1_000_000;
  (AvoLog as any).now = () => now;
  for (const method of ["log", "info", "warn", "error"] as const) {
    jest.spyOn(console, method).mockImplementation((...args: any[]) => {
      lines.push(format(...args));
    });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

const staging = (extra: object = {}) => {
  const inspector = new AvoInspector({
    apiKey: API_KEY, env: "staging", version: "1.0.0", disableBatchTimer: true, ...extra,
  });
  inspector.enableLogging(false);
  return inspector;
};

const matching = (pattern: RegExp) => lines.filter((line) => pattern.test(line));

function holdSends(inspector: AvoInspector) {
  const releases: Array<(status: number) => void> = [];
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
    .mockImplementation((_batch: Array<InspectorBody>) => new Promise((resolve) => { releases.push(resolve); }));
  return releases;
}

describe("always-on data-loss lines, logging off", () => {
  test("a buffer overflow burst logs one line per window, then the suppressed total", async () => {
    const inspector = staging({ batchSize: 30, maxQueueSize: 2 });

    for (let i = 0; i < 10; i++) await inspector.trackSchemaFromEvent("E" + i, { email: MARKER });
    // (The constructor's batchSize > maxQueueSize warning is a separate line.)
    expect(matching(/^Avo Inspector: dropped/)).toEqual(["Avo Inspector: dropped 1 event(s) (queue full) in the last 1s."]);

    now += 10_000;
    await inspector.trackSchemaFromEvent("E10", { email: MARKER });
    // 7 counted in the first window, plus this one.
    expect(matching(/^Avo Inspector: dropped/)).toEqual([
      "Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.",
      "Avo Inspector: dropped 8 event(s) (queue full) in the last 10s.",
    ]);
    inspector.destroy();
  });

  test("a send backlog overflow logs one line per window with its count", async () => {
    const inspector = staging({ batchSize: 30 });
    holdSends(inspector);

    // 4 batches (120 events) in flight, then 10,000 events may wait; the drain that first
    // exceeds it drops 20.
    for (let i = 0; i < 12_000; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    expect(matching(/send backlog full/)).toEqual([
      "Avo Inspector: dropped 20 event(s) (send backlog full) in the last 1s.",
    ]);

    now += 10_000;
    for (let i = 0; i < 30; i++) await inspector.trackSchemaFromEvent("F" + i, {});
    const queue = (inspector as any).batchQueue;
    const totalDropped = 12_030 - 120 - queue.waitingLength - queue.length;
    expect(matching(/send backlog full/)[1]).toBe(
      `Avo Inspector: dropped ${totalDropped - 20} event(s) (send backlog full) in the last 10s.`
    );
    inspector.destroy();
  });

  test("repeated non-200 responses log one line per status per window", async () => {
    const inspector = staging({ batchSize: 1 });
    const statuses = [500, 500, 400, 500, 400, 500];
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation(() => Promise.resolve(statuses.shift() ?? 500));

    for (let i = 0; i < 6; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    expect(matching(/rejected/)).toEqual([
      "Avo Inspector: 1 batch(es) rejected with HTTP 500 in the last 1s.",
      "Avo Inspector: 1 batch(es) rejected with HTTP 400 in the last 1s.",
    ]);

    now += 10_000;
    await inspector.trackSchemaFromEvent("E6", {});
    expect(matching(/HTTP 500/)[1]).toBe("Avo Inspector: 4 batch(es) rejected with HTTP 500 in the last 10s.");
    inspector.destroy();
  });

  test("a failure storm logs one line per window and reports the suppressed count", async () => {
    const inspector = staging({ batchSize: 1 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockRejectedValue("Request failed");

    for (let i = 0; i < 50; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    expect(matching(/schema sending failed/)).toEqual(["Avo Inspector: schema sending failed: Request failed."]);

    now += 10_000;
    await inspector.trackSchemaFromEvent("E50", {});
    expect(matching(/schema sending failed/)[1]).toBe(
      "Avo Inspector: schema sending failed: Request failed. (49 more in the last 10s)"
    );
    inspector.destroy();
  });

  test("sampling drops print nothing with logging off", async () => {
    const inspector = staging({ batchSize: 1 });
    inspector._setSamplingRateForTesting(0);
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

    for (let i = 0; i < 20; i++) await inspector.trackSchemaFromEvent("E" + i, { email: MARKER });

    expect(lines).toEqual([]);
    inspector.destroy();
  });

  test("sends abandoned by destroy() are not logged", async () => {
    const inspector = staging({ batchSize: 1 });
    const releases = holdSends(inspector);
    const tracks = Array.from({ length: 8 }, (_, i) => inspector.trackSchemaFromEvent("E" + i, {}));

    inspector.destroy();
    releases.forEach((release) => release(500));
    await Promise.all(tracks);
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines).toEqual([]);
  });

  test("always-on lines never contain the API key or property values", async () => {
    const inspector = staging({ batchSize: 1, maxQueueSize: 1 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockResolvedValueOnce(503)
      .mockRejectedValue("Request timed out");

    for (let i = 0; i < 5; i++) await inspector.trackSchemaFromEvent("E" + i, { email: MARKER });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(API_KEY);
    expect(lines.join("\n")).not.toContain(MARKER);
    inspector.destroy();
  });
});

describe("the streamId ':' warning", () => {
  test("prints at most once per 10 s, then reports how many it suppressed", async () => {
    const inspector = staging({ batchSize: 30 });
    const warning = "[Avo Inspector] Warning: streamId contains ':' which is not supported";

    for (let i = 0; i < 20; i++) await inspector.trackSchemaFromEvent("E" + i, {}, "user:" + i);
    expect(matching(/streamId contains ':'/)).toEqual([warning]);

    now += 10_000;
    // @ts-ignore The Codegen entry goes through the same path.
    await inspector._avoFunctionTrackSchemaFromEvent("E20", {}, "id", "hash", "user:20");
    expect(matching(/streamId contains ':'/)).toEqual([warning, warning + " (19 more in the last 10s)"]);
    inspector.destroy();
  });
});

describe("internal errors never print the caught error's text", () => {
  test("a property getter that throws with a value in its message: the value is not logged", async () => {
    const inspector = staging();
    const props = {
      get email(): string {
        throw new TypeError("cannot read " + MARKER);
      },
    };

    expect(inspector.extractSchema(props)).toEqual([]);

    const internal = matching(/something went wrong/);
    expect(internal).toEqual([
      "Avo Inspector: something went wrong. Please report to support@avo.app. (TypeError)",
    ]);
    expect(lines.join("\n")).not.toContain(MARKER);
  });

  test("the type is a fixed label: an error's own name is never printed", () => {
    const renamed = new TypeError("hidden");
    renamed.name = MARKER;
    AvoLog.internal(renamed);

    expect(lines).toEqual([
      "Avo Inspector: something went wrong. Please report to support@avo.app. (TypeError)",
    ]);
  });

  test("a throwing name getter or proxy trap cannot break or leak into the line", () => {
    const getter = new Error("hidden");
    Object.defineProperty(getter, "name", { get() { throw new Error(MARKER); } });
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(MARKER); } });

    expect(() => AvoLog.internal(getter)).not.toThrow();
    now += 10_000;
    expect(() => AvoLog.internal(proxy)).not.toThrow();

    expect(lines).toEqual([
      "Avo Inspector: something went wrong. Please report to support@avo.app. (Error)",
      "Avo Inspector: something went wrong. Please report to support@avo.app. (unknown)",
    ]);
  });

  test("only the error's type is printed, whatever was thrown", () => {
    AvoLog.internal(new RangeError(MARKER));
    now += 10_000;
    AvoLog.internal(MARKER);

    expect(lines).toEqual([
      "Avo Inspector: something went wrong. Please report to support@avo.app. (RangeError)",
      "Avo Inspector: something went wrong. Please report to support@avo.app. (string)",
    ]);
  });
});

describe("a missing event name", () => {
  // Captures every batch the dev instance sends.
  const dev = () => {
    const inspector = new AvoInspector({ apiKey: API_KEY, env: "dev", version: "1.0.0" });
    const sent: InspectorBody[] = [];
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation((batch: Array<InspectorBody>) => { sent.push(...batch); return Promise.resolve(200); });
    return { inspector, sent };
  };
  const line = 'Avo Inspector: 1 event(s) tracked without an event name in the last 1s, sent as "Missing Event Name".';
  const schema = [{ propertyName: "a", propertyType: "int" }];

  test.each([
    ["null", null], ["undefined", undefined], ["a number", 5], ["an object", {}], ["empty", ""], ["whitespace-only", "  "],
  ])("a %s event name is sent as \"Missing Event Name\", with one line", async (_label, eventName) => {
    const { inspector, sent } = dev();

    await expect(inspector.trackSchemaFromEvent(eventName as any, { a: 1 })).resolves.toEqual(schema);

    expect(sent.map((event) => [event.eventName, event.eventProperties])).toEqual([["Missing Event Name", schema]]);
    expect(matching(/without an event name/)).toEqual([line]);
    inspector.destroy();
  });

  test("the Codegen path sends it as \"Missing Event Name\" too", async () => {
    const { inspector, sent } = dev();

    // @ts-ignore
    await expect(inspector._avoFunctionTrackSchemaFromEvent(undefined, { a: 1 }, "id", "hash")).resolves.toEqual(schema);

    expect(sent.map((event) => [event.eventName, event.avoFunction, event.eventId])).toEqual([["Missing Event Name", true, "id"]]);
    expect(matching(/without an event name/)).toEqual([line]);
    inspector.destroy();
  });

  test("the line is rate-limited and reports the suppressed count", async () => {
    const { inspector, sent } = dev();

    for (let i = 0; i < 3; i++) await inspector.trackSchemaFromEvent("", { i });
    now += 10_000;
    await inspector.trackSchemaFromEvent(null as any, { i: 3 });

    expect(sent).toHaveLength(4);
    expect(matching(/without an event name/)).toEqual([
      line,
      'Avo Inspector: 3 event(s) tracked without an event name in the last 10s, sent as "Missing Event Name".',
    ]);
    inspector.destroy();
  });

  test("a valid name is sent unchanged, surrounding whitespace included, with no line", async () => {
    const { inspector, sent } = dev();

    await inspector.trackSchemaFromEvent("  Signed Up ", { a: 1 });

    expect(sent.map((event) => event.eventName)).toEqual(["  Signed Up "]);
    expect(matching(/without an event name/)).toEqual([]);
    inspector.destroy();
  });
});

describe("a batch dispatch that fails internally", () => {
  const internal = "Avo Inspector: something went wrong. Please report to support@avo.app.";

  test("a dispatch that throws logs the internal error and the dropped events", async () => {
    const inspector = staging({ batchSize: 2 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockImplementation(() => {
      throw new Error("boom");
    });

    await inspector.trackSchemaFromEvent("E1", {});
    await inspector.trackSchemaFromEvent("E2", {});
    await inspector.flush();

    expect(matching(/something went wrong/)).toEqual([expect.stringContaining(internal)]);
    expect(matching(/internal error/)).toEqual(["Avo Inspector: dropped 2 event(s) (internal error) in the last 1s."]);
    inspector.destroy();
  });

  test("a dispatch that rejects logs the internal error and the dropped events", async () => {
    const inspector = staging({ batchSize: 3 });
    jest.spyOn(inspector as any, "sendBatch").mockImplementation(() => Promise.reject(new Error("boom")));

    for (let i = 0; i < 3; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    await inspector.flush();

    expect(matching(/something went wrong/)).toEqual([expect.stringContaining(internal)]);
    expect(matching(/internal error/)).toEqual(["Avo Inspector: dropped 3 event(s) (internal error) in the last 1s."]);
    inspector.destroy();
  });
});

describe("a send failure with an arbitrary error", () => {
  test.each([
    ["an Error", new TypeError("MARKER-in-message-1"), "Request failed (TypeError)"],
    ["a non-fixed string", "MARKER-in-message-2", "Request failed (string)"],
  ])("%s prints only a fixed reason and its type, never the message", async (_label, error, reason) => {
    const inspector = staging({ batchSize: 1 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockRejectedValue(error);

    await inspector.trackSchemaFromEvent("E1", {});
    await inspector.trackSchemaFromEvent("E2", {});

    expect(lines.join("\n")).not.toContain("MARKER-in-message");
    // One window for both: the key is the fixed reason, not the message.
    expect(matching(/schema sending failed/)).toEqual([`Avo Inspector: schema sending failed: ${reason}.`]);
    inspector.destroy();
  });

  test("the fixed transport reasons are printed as is", async () => {
    const inspector = staging({ batchSize: 1 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockRejectedValue("Request timed out");

    await inspector.trackSchemaFromEvent("E1", {});

    expect(matching(/schema sending failed/)).toEqual(["Avo Inspector: schema sending failed: Request timed out."]);
    inspector.destroy();
  });
});

describe("pending counts at lifecycle points, worded by real elapsed time", () => {
  const dropLines = () => matching(/^Avo Inspector: dropped/);

  test("a burst of 5,000 drops, then flush() after the window, prints one line at once and one with the rest", async () => {
    const inspector = staging({ batchSize: 30, maxQueueSize: 1 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

    for (let i = 0; i < 5001; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    now += 12_000;
    await inspector.flush();

    expect(dropLines()).toEqual([
      "Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.",
      "Avo Inspector: dropped 4999 event(s) (queue full) in the last 12s.",
    ]);
    inspector.destroy();
  });

  test("flush() inside the window leaves the count pending, so serverless flushes keep the limit", async () => {
    const inspector = staging({ batchSize: 30, maxQueueSize: 1 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

    for (let i = 0; i < 5; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    now += 3_000;
    await inspector.flush();
    expect(dropLines()).toEqual(["Avo Inspector: dropped 1 event(s) (queue full) in the last 1s."]);

    inspector.destroy();
    expect(dropLines()[1]).toBe("Avo Inspector: dropped 3 event(s) (queue full) in the last 3s.");
  });

  test("a count left pending by an early flush() is printed by the first flush() after its window", async () => {
    const inspector = staging({ batchSize: 30, maxQueueSize: 1 });
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

    for (let i = 0; i < 5; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    now += 3_000;
    await inspector.flush();
    expect(dropLines()).toEqual(["Avo Inspector: dropped 1 event(s) (queue full) in the last 1s."]);

    now += 10_000;
    await inspector.flush();
    expect(dropLines()).toEqual([
      "Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.",
      "Avo Inspector: dropped 3 event(s) (queue full) in the last 13s.",
    ]);
    inspector.destroy();
  });

  test("destroy() prints a pending count", async () => {
    const inspector = staging({ batchSize: 30, maxQueueSize: 1 });
    for (let i = 0; i < 4; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    now += 2_000;

    inspector.destroy();

    expect(dropLines()).toEqual([
      "Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.",
      "Avo Inspector: dropped 2 event(s) (queue full) in the last 2s.",
    ]);
  });

  test("beforeExit prints only expired counts: it also fires at idle points that are not the exit", () => {
    AvoLog.failed("Request failed");
    AvoLog.failed("Request failed");
    now += 4_000;

    // An idle point inside the window: the count stays pending (the real exit prints it;
    // see TestExitLogs, which runs real processes).
    process.emit("beforeExit", 0);
    expect(matching(/schema sending failed/)).toEqual(["Avo Inspector: schema sending failed: Request failed."]);

    now += 6_000;
    process.emit("beforeExit", 0);
    expect(matching(/schema sending failed/)).toEqual([
      "Avo Inspector: schema sending failed: Request failed.",
      "Avo Inspector: schema sending failed: Request failed. (1 more in the last 10s)",
    ]);
  });

  test("a stale count reports its real span", () => {
    AvoLog.dropped(1, "queue full");
    AvoLog.dropped(2, "queue full");
    now += 3_600_000;

    AvoLog.dropped(1, "queue full");

    expect(dropLines()).toEqual([
      "Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.",
      "Avo Inspector: dropped 3 event(s) (queue full) in the last 3600s.",
    ]);
  });

  test("a flushed count is not printed again", async () => {
    AvoLog.dropped(1, "queue full");
    AvoLog.dropped(5, "queue full");
    AvoLog.flushPending();
    AvoLog.flushPending();
    now += 10_000;

    AvoLog.dropped(1, "queue full");

    expect(dropLines()).toEqual([
      "Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.",
      "Avo Inspector: dropped 5 event(s) (queue full) in the last 1s.",
      "Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.",
    ]);
  });
});
