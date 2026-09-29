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

  test("events waiting for a send slot count toward maxQueueSize; the oldest are dropped first", async () => {
    const inspector = staging({ batchSize: 2, maxQueueSize: 6 });
    inspector.enableLogging(true);
    const { batches, releaseAll } = holdSends(inspector);

    for (let i = 0; i < 20; i++) await inspector.trackSchemaFromEvent("E" + i, {});
    expect((inspector as any).batchQueue.length).toBe(6);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/pending batch is full \(maxQueueSize 6\), dropped 1 oldest event/)
    );

    await releaseAll();
    // E0-E7 were already being sent; of the rest only the newest 6 were kept.
    expect(names(batches).flat()).toEqual(["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7",
      "E14", "E15", "E16", "E17", "E18", "E19"]);
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
    const { send } = holdSends(inspector);
    for (let i = 0; i < 12; i++) await inspector.trackSchemaFromEvent("E" + i, {});

    inspector.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(send).toHaveBeenCalledTimes(4);
    expect((inspector as any).batchQueue.length).toBe(0);
    expect((inspector as any).pending.size).toBe(0);
  });

  test("in dev, a track whose send waits for a slot still resolves once it is sent", async () => {
    const inspector = new AvoInspector({ apiKey: "test-key", env: "dev", version: "1.0.0" });
    const { send, releaseAll } = holdSends(inspector);

    const tracks = Array.from({ length: 6 }, (_, i) => inspector.trackSchemaFromEvent("E" + i, { a: i }));
    expect(send).toHaveBeenCalledTimes(4);

    await releaseAll();
    await expect(Promise.all(tracks)).resolves.toHaveLength(6);
    expect(send).toHaveBeenCalledTimes(6);
  });
});

describe("deduplicator cleanup", () => {
  const { AvoDeduplicator } = require("../AvoDeduplicator");

  test("cleanup cost does not grow with the number of distinct milliseconds in the window", () => {
    const dedup = new AvoDeduplicator();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

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
    jest.spyOn(Date, "now").mockImplementation(() => now);

    dedup.shouldRegisterEvent("A", { a: 1 }, true, "s");
    dedup.shouldRegisterEvent("B", { b: 1 }, true, "s"); // same millisecond as A
    now += 600;

    // Past 500 ms the Codegen registration of A is gone, so a manual A is not a duplicate.
    expect(dedup.shouldRegisterEvent("A", { a: 1 }, false, "s")).toBe(true);
  });

  test("within 500 ms a manual call matching a Codegen call is still a duplicate", () => {
    const dedup = new AvoDeduplicator();
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    dedup.shouldRegisterEvent("A", { a: 1 }, true, "s");
    now += 400;

    expect(dedup.shouldRegisterEvent("A", { a: 1 }, false, "s")).toBe(false);
  });
});

describe("flush() during event spec validation", () => {
  const { AvoNetworkCallsHandler } = require("../AvoNetworkCallsHandler");
  const { AvoEventSpecFetcher } = require("../eventSpec/AvoEventSpecFetcher");

  test("events whose validations settle together go out in one batch", async () => {
    jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor").mockReturnValue(null);
    // Every spec response arrives in the same timers phase.
    jest.spyOn(AvoEventSpecFetcher.prototype, "fetch").mockImplementation((...args: any[]) => {
      setTimeout(() => args[2](null), 20);
    });
    const inspector = staging({ batchSize: 30 });
    const { send, batches, releaseAll } = holdSends(inspector);

    const tracks = Array.from({ length: 20 }, (_, i) => inspector.trackSchemaFromEvent("E" + i, {}));
    const flushing = inspector.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await releaseAll();
    await flushing;
    await Promise.all(tracks);

    expect(send).toHaveBeenCalledTimes(1);
    expect(batches[0]).toHaveLength(20);
  });
});
