import { AvoInspector } from "../AvoInspector";
import { InspectorBody } from "../AvoNetworkCallsHandler";

// Robustness under load: bounded concurrency, bounded memory, bounded exit time.

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const staging = (extra: object = {}) =>
  new AvoInspector({ apiKey: "test-key", env: "staging", version: "1.0.0", disableBatchTimer: true, ...extra });

// Replaces the network with sends that stay open until released, recording each batch.
function holdSends(inspector: AvoInspector) {
  const batches: Array<Array<InspectorBody>> = [];
  const releases: Array<(status: number) => void> = [];
  const send = jest
    .spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
    .mockImplementation((batch) => {
      batches.push(batch);
      return new Promise((resolve) => { releases.push(resolve); });
    });
  const releaseAll = async () => {
    // Released sends free slots for waiting batches; keep releasing until none are open.
    for (let i = 0; i < 100 && releases.length > 0; i++) {
      releases.splice(0).forEach((release) => release(200));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { send, batches, releaseAll };
}

// Polls until `done` holds (up to 5 s).
async function waitFor(done: () => boolean) {
  for (let waited = 0; !done() && waited < 5000; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const names = (batches: Array<Array<InspectorBody>>) =>
  batches.map((batch) => batch.map((event) => event.eventName));

describe("bounded concurrent batch sends", () => {
  test("at most 4 batch sends are in flight; the rest wait and go out as slots free", async () => {
    const inspector = staging({ batchSize: 2 });
    const { send, batches, releaseAll } = holdSends(inspector);

    for (let i = 0; i < 20; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    expect(send).toHaveBeenCalledTimes(4);

    await releaseAll();
    expect(send).toHaveBeenCalledTimes(10);
    expect(names(batches).flat()).toEqual(Array.from({ length: 20 }, (_, i) => "E" + i));
  });

  test("events waiting for a send slot do not count toward maxQueueSize", async () => {
    const inspector = staging({ batchSize: 2, maxQueueSize: 6 });
    // Logging on, so a drop would be logged and the check below could fail.
    inspector.enableLogging(true);
    const { batches, releaseAll } = holdSends(inspector);

    for (let i = 0; i < 20; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringMatching(/dropped/));
    await releaseAll();

    expect(names(batches).flat()).toEqual(Array.from({ length: 20 }, (_, i) => "E" + i));
  });

  test("a tight loop of 9,000 events that never yields, then flush(), delivers all 9,000", async () => {
    const inspector = staging();
    const { batches, releaseAll } = holdSends(inspector);

    for (let i = 0; i < 9000; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    const flushing = inspector.flush();
    await releaseAll();
    await flushing;

    expect(names(batches).flat()).toEqual(Array.from({ length: 9000 }, (_, i) => "E" + i));
  });

  test("past 10,000 waiting events the oldest waiting ones are dropped, and the drop is logged", async () => {
    const inspector = staging();
    inspector.enableLogging(true);
    const { batches, releaseAll } = holdSends(inspector);

    let maxWaiting = 0;
    for (let i = 0; i < 20_000; i++) {
      await inspector.trackSchemaFromEvent("E" + i, {});
      maxWaiting = Math.max(maxWaiting, (inspector as any).batchQueue.waitingLength);
    }
    expect(maxWaiting).toBe(10_000);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Avo Inspector: dropped \d+ event\(s\) \(send backlog full\) in the last \d+s\.$/)
    );

    const flushing = inspector.flush();
    await releaseAll();
    await flushing;

    // Sent at once: the first 4 batches (E0-E119). Kept: the newest 10,000 events, including
    // the 20-event buffer that flush() swapped out last (E10000-E19999).
    const expected = [
      ...Array.from({ length: 120 }, (_, i) => "E" + i),
      ...Array.from({ length: 10_000 }, (_, i) => "E" + (10_000 + i)),
    ];
    expect(names(batches).flat()).toEqual(expected);
  });

  test("flush() waits for batches still waiting for a send slot", async () => {
    const inspector = staging({ batchSize: 2 });
    const { send, releaseAll } = holdSends(inspector);
    for (let i = 0; i < 12; i++) await inspector.trackSchemaFromEvent("E" + i, {});

    let flushed = false;
    const flushing = inspector.flush().then(() => { flushed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);

    await releaseAll();
    await flushing;
    expect(flushed).toBe(true);
    expect(send).toHaveBeenCalledTimes(6);
  });

  test("destroy() discards batches still waiting for a send slot", async () => {
    const inspector = staging({ batchSize: 2 });
    const { send, batches, releaseAll } = holdSends(inspector);
    for (let i = 0; i < 12; i++) await inspector.trackSchemaFromEvent("E" + i, {});

    inspector.destroy();
    expect((inspector as any).batchQueue.waitingLength).toBe(0);
    // Freeing the 4 slots must not start the discarded batches.
    await releaseAll();

    expect(send).toHaveBeenCalledTimes(4);
    expect(names(batches).flat()).toEqual(["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"]);
    expect((inspector as any).batchQueue.length).toBe(0);
    expect((inspector as any).pending.size).toBe(0);
  });

  test("in dev, a track whose send waits for a slot still resolves once it is sent", async () => {
    const inspector = new AvoInspector({ apiKey: "test-key", env: "dev", version: "1.0.0" });
    const { send, releaseAll } = holdSends(inspector);

    const tracks = Array.from({ length: 6 }, (_, i) => inspector.trackSchemaFromEvent("E" + i, { a: i }));
    // Each event is sent once its spec fetch (answered by the test mock) completes.
    await waitFor(() => send.mock.calls.length >= 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).toHaveBeenCalledTimes(4);

    await releaseAll();
    await expect(Promise.all(tracks)).resolves.toEqual(
      Array.from({ length: 6 }, () => [{ propertyName: "a", propertyType: "int" }])
    );
    expect(send).toHaveBeenCalledTimes(6);
  });
});

describe("deduplicator cleanup", () => {
  const { AvoDeduplicator } = require("../AvoDeduplicator");

  test("cleanup cost does not grow with the number of distinct milliseconds in the window", () => {
    const dedup = new AvoDeduplicator();
    let now = 1_000_000;
    dedup.now = () => now;

    // One registration per millisecond keeps ~500 distinct timestamps inside the window.
    const started = process.hrtime.bigint();
    for (let i = 0; i < 30_000; i++) {
      now++;
      dedup.shouldRegisterEvent("E" + (i % 50), { i }, i % 2 === 0, "s");
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(1000);
  });

  test("every registration expires after 500 ms, even one sharing its millisecond with another", () => {
    const dedup = new AvoDeduplicator();
    let now = 1_000_000;
    dedup.now = () => now;

    dedup.shouldRegisterEvent("A", { a: 1 }, true, "s");
    dedup.shouldRegisterEvent("B", { b: 1 }, true, "s"); // same millisecond as A
    now += 600;

    // Past 500 ms the Codegen registration of A is gone, so a manual A is not a duplicate.
    expect(dedup.shouldRegisterEvent("A", { a: 1 }, false, "s")).toBe(true);
  });

  test("within 500 ms a manual call matching a Codegen call is still a duplicate", () => {
    const dedup = new AvoDeduplicator();
    let now = 1_000_000;
    dedup.now = () => now;

    dedup.shouldRegisterEvent("A", { a: 1 }, true, "s");
    now += 400;

    expect(dedup.shouldRegisterEvent("A", { a: 1 }, false, "s")).toBe(false);
  });
});

describe("flush() during event spec validation", () => {
  const { AvoEventSpecFetcher } = require("../eventSpec/AvoEventSpecFetcher");

  test("events whose validations settle together go out in one batch", async () => {
    // Hold every spec response, then deliver them all in one synchronous loop: they settle
    // in the same event-loop turn. (One timer per fetch did not guarantee that: on a slow
    // run the timers straddled a millisecond and fired in different turns.)
    const specCallbacks: Array<(result: null) => void> = [];
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((...args: any[]) => {
      specCallbacks.push(args[2]);
    });
    const inspector = staging({ batchSize: 30 });
    const { send, batches, releaseAll } = holdSends(inspector);

    const tracks = Array.from({ length: 20 }, (_, i) => inspector.trackSchemaFromEvent("E" + i, {}));
    const flushing = inspector.flush();
    expect(specCallbacks).toHaveLength(20);
    specCallbacks.forEach((callback) => callback(null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await releaseAll();
    await flushing;
    await Promise.all(tracks);

    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0]).toHaveLength(20);
  });

  test("waits for a flush-marked event's batch even when another drain sent it first", async () => {
    const specCallbacks: { [name: string]: (result: null) => void } = {};
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((...args: any[]) => {
      specCallbacks[args[0]] = args[2];
    });
    const inspector = staging({ batchSize: 2 });
    const { send, batches, releaseAll } = holdSends(inspector);

    const a = inspector.trackSchemaFromEvent("A", {});
    let flushed = false;
    const flushing = inspector.flush().then(() => { flushed = true; });
    // B starts after flush(), so it is not flush-marked.
    const b = inspector.trackSchemaFromEvent("B", {});
    // Both validations settle in the same turn: A queues (flush-marked, no size trigger), then
    // B reaches batchSize 2 and its size-triggered drain sends A and B before A's own drain.
    specCallbacks["A"](null);
    specCallbacks["B"](null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0].map((event: any) => event.eventName)).toEqual(["A", "B"]);
    // That batch is still in flight, so flush() must not have resolved.
    expect(flushed).toBe(false);

    await releaseAll();
    await flushing;
    expect(flushed).toBe(true);
    await Promise.all([a, b]);
    inspector.destroy();
  });
});

describe("a batch send that throws synchronously", () => {
  test("releases its slot, settles its batch, logs, and does not block later sends", async () => {
    const inspector = staging({ batchSize: 1 });
    let calls = 0;
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockImplementation(() => {
      calls++;
      if (calls <= 4) {
        throw new Error("boom");
      }
      return Promise.resolve(200);
    });

    const results = [];
    for (let i = 0; i < 8; i++) results.push(await inspector.trackSchemaFromEvent("E" + i, { a: i }));
    const started = Date.now();
    await inspector.flush();

    expect(calls).toBe(8);
    expect(results.every((schema) => schema.length === 1)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(console.error).toHaveBeenCalledWith(
      "Avo Inspector: something went wrong. Please report to support@avo.app. (Error)"
    );
  }, 10_000);
});

describe("the Codegen duplicate-shape scan in extractSchema", () => {
  const { AvoDeduplicator } = require("../AvoDeduplicator");

  test("does not run when its warning cannot print (tracking, or logging off)", async () => {
    const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1", disableBatchTimer: true });
    const scan = jest.spyOn(AvoDeduplicator.prototype, "hasSeenEventParams");

    inspector.enableLogging(true);
    await inspector.trackSchemaFromEvent("E", { a: 1 }); // tracking passes shouldLogIfEnabled = false
    inspector.enableLogging(false);
    inspector.extractSchema({ a: 1 });
    expect(scan).not.toHaveBeenCalled();

    inspector.enableLogging(true);
    inspector.extractSchema({ a: 1 });
    expect(scan).toHaveBeenCalledTimes(1);
    inspector.destroy();
  });
});
