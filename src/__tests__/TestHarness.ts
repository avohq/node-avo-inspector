import { execFileSync, spawn } from "child_process";
import { join } from "path";

// The harness drives the built SDK in dist/, so build it first.
const repoRoot = join(__dirname, "..", "..");
const harness = join(repoRoot, "conformance", "avo-inspector-conformance.js");

beforeAll(() => {
  // tsc's JS entry point run with this Node (the .bin shim is a .cmd file on Windows).
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "-p", join(repoRoot, "tsconfig.json"), "--outDir", join(repoRoot, "dist"),
  ]);
}, 60_000);

// Spawned asynchronously: a synchronous spawn blocks this process, which under
// --runInBand also hosts the global mock server, so the harness's requests would get no
// answer. The child gets a deadline of its own and a timeout fails the test with a clear
// message.
const HARNESS_TIMEOUT_MS = 20_000;
// Past the child's deadline, so a hung harness fails with the message above.
jest.setTimeout(HARNESS_TIMEOUT_MS + 5_000);

type HarnessRun = { status: number | null; signal: NodeJS.Signals | null; stdout: string; timedOut: boolean };

function spawnHarness(args: string[], input: string, timeout = HARNESS_TIMEOUT_MS): Promise<HarnessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args);
    let stdout = "";
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    child.on("close", (status, signal) => {
      clearTimeout(deadline);
      resolve({ status, signal, stdout, timedOut });
    });
    child.stdin.end(input);
  });
}

async function runHarnessRaw(input: string) {
  const result = await spawnHarness([harness], input);
  if (result.timedOut) {
    throw new Error("harness did not complete within " + HARNESS_TIMEOUT_MS + " ms");
  }
  return { status: result.status, output: JSON.parse(result.stdout.trim()) };
}

function runHarness(envelope: object) {
  return runHarnessRaw(JSON.stringify(envelope) + "\n");
}

describe("conformance harness", () => {
  test("an envelope without a constructor is a configuration error (exit 2)", async () => {
    const { status, output } = await runHarness({
      suite: "schema-extraction",
      fixture_id: "no-constructor",
      input: { a: 1 },
    });

    expect(status).toBe(2);
    expect(output).toMatchObject({ fixture_id: "no-constructor", passed: false });
    expect(output.error).toContain("constructor");
  });

  test("a constructor that is not an object is a configuration error (exit 2)", async () => {
    const { status } = await runHarness({
      suite: "schema-extraction",
      fixture_id: "bad-constructor",
      constructor: "test-key",
      input: { a: 1 },
    });

    expect(status).toBe(2);
  });

  test("a well-formed envelope runs the operation (exit 0)", async () => {
    const { status, output } = await runHarness({
      suite: "schema-extraction",
      fixture_id: "ok",
      constructor: { apiKey: "test-key", env: "dev", version: "1.0.0" },
      input: { a: 1 },
    });

    expect(status).toBe(0);
    expect(output.actual).toEqual([{ propertyName: "a", propertyType: "int" }]);
  });

  test.each(["null", "42", "[]"])("a JSON input that is not an object (%s) is a configuration error (exit 2)", async (input) => {
    const { status, output } = await runHarnessRaw(input + "\n");

    expect(status).toBe(2);
    expect(output).toMatchObject({ fixture_id: null, passed: false });
  });

  const ctor = { apiKey: "test-key", env: "dev", version: "1.0.0" };
  const track = { eventName: "E", eventProperties: { a: 1 } };
  const bases: { [name: string]: any } = {
    extract: { suite: "schema-extraction", fixture_id: "f", constructor: ctor, input: { a: 1 } },
    track: { suite: "wire-protocol", fixture_id: "f", constructor: ctor, operation: "trackSchemaFromEvent", input: track },
    sequence: { suite: "batching", fixture_id: "f", constructor: ctor, operation: "sequence", steps: [{ action: "flush" }] },
  };

  // [description, base, overrides]; each yields a malformed envelope.
  const malformed: Array<[string, string, object]> = [
    ["fixture_id is not a string", "extract", { fixture_id: 7 }],
    ["suite is missing", "extract", { suite: undefined }],
    ["suite is not a string", "extract", { suite: ["schema-extraction"] }],
    ["suite is not a contract suite id", "extract", { suite: "unknown", operation: "extractSchema" }],
    ["suite differs from a contract id only by case", "extract", { suite: "Batching" }],
    ["operation is not a string", "track", { operation: 1 }],
    ["operation is missing outside schema-extraction", "track", { operation: undefined }],
    ["operation is unsupported", "track", { operation: "identify" }],
    ["operation differs from a contract operation only by case", "track", { operation: "TrackSchemaFromEvent" }],
    ["constructor is an array", "extract", { constructor: [] }],
    ["extractSchema input is missing", "extract", { input: undefined }],
    ["extractSchema input is an array", "extract", { input: [1] }],
    ["extractSchema input is a string", "extract", { input: "a" }],
    ["trackSchemaFromEvent input is null", "track", { input: null }],
    ["trackSchemaFromEvent input is missing", "track", { input: undefined }],
    ["input.eventName is missing", "track", { input: { eventProperties: {} } }],
    ["input.eventName is not a string", "track", { input: { ...track, eventName: 1 } }],
    ["input.eventProperties is null", "track", { input: { ...track, eventProperties: null } }],
    ["input.eventProperties is an array", "track", { input: { ...track, eventProperties: [] } }],
    ["input.streamId is null", "track", { input: { ...track, streamId: null } }],
    ["input.options is null", "track", { input: { ...track, options: null } }],
    ["input.options is an array", "track", { input: { ...track, options: [] } }],
    ["steps is missing", "sequence", { steps: undefined }],
    ["steps is an object", "sequence", { steps: {} }],
    ["a step is null", "sequence", { steps: [null] }],
    ["a step action is unsupported", "sequence", { steps: [{ action: "reset" }] }],
    ["a step action is missing", "sequence", { steps: [{ type: "flush" }] }],
    ["a track step lacks eventProperties", "sequence", { steps: [{ action: "track", eventName: "E" }] }],
    ["a track step has array options", "sequence", { steps: [{ action: "track", ...track, options: [] }] }],
    ["a trackN count is 0", "sequence", { steps: [{ action: "trackN", count: 0 }] }],
    ["a trackN count is not an integer", "sequence", { steps: [{ action: "trackN", count: 1.5 }] }],
    ["a trackN eventNamePrefix is not a string", "sequence", { steps: [{ action: "trackN", count: 1, eventNamePrefix: 1 }] }],
    ["a trackN streamId is not a string", "sequence", { steps: [{ action: "trackN", count: 1, streamId: null }] }],
    ["a flush timeoutMs is negative", "sequence", { steps: [{ action: "flush", timeoutMs: -1 }] }],
    ["a flush timeoutMs is a string", "sequence", { steps: [{ action: "flush", timeoutMs: "10" }] }],
    ["precondition is null", "track", { precondition: null }],
    ["precondition is an array", "track", { precondition: [] }],
    ["precondition is a string", "track", { precondition: "x" }],
    ["precondition has an unsupported field", "track", { precondition: { samplingRate: 1, seed: 2 } }],
    ["precondition.samplingRate is a string", "track", { precondition: { samplingRate: "0" } }],
    ["precondition.samplingRate is above 1", "track", { precondition: { samplingRate: 1.5 } }],
    ["precondition.samplingRate is negative", "track", { precondition: { samplingRate: -0.1 } }],
  ];

  test.each(malformed)("a malformed envelope is a configuration error (exit 2): %s", async (_name, base, overrides) => {
    const envelope = { ...bases[base], ...overrides };
    for (const key of Object.keys(envelope)) {
      if (envelope[key] === undefined) delete envelope[key];
    }

    const { status, output } = await runHarness(envelope);

    expect(status).toBe(2);
    expect(output).toMatchObject({ passed: false });
    expect(typeof output.error).toBe("string");
  });

  test.each(Object.keys(bases))("the well-formed %s base envelope runs (exit 0)", async (base) => {
    expect((await runHarness(bases[base])).status).toBe(0);
  });

  test.each(["schema-extraction", "wire-protocol", "error-handling", "batching"])(
    "every contract suite id is accepted (%s)",
    async (suite) => {
      expect((await runHarness({ ...bases.track, suite })).status).toBe(0);
    }
  );

  test("an extractSchema input of null is passed through (fixture-8)", async () => {
    const { status, output } = await runHarness({ ...bases.extract, input: null });

    expect(status).toBe(0);
    expect(output.actual).toEqual([]);
  });

  test("a child that outlives the deadline is killed and reported, not waited on", async () => {
    const started = Date.now();
    const hang = await spawnHarness(["-e", "setInterval(() => {}, 1000)"], "", 500);

    expect(hang.signal).toBe("SIGKILL");
    expect(hang.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a large output envelope reaches the pipe in full before the harness exits", async () => {
    // 10,000 properties (the extraction budget), named long enough for a ~700 KB envelope,
    // far past a pipe buffer.
    const input: { [key: string]: string } = {};
    for (let i = 0; i < 10000; i += 1) {
      input["property_with_a_long_name_padded_to_fill_the_pipe_buffer_" + i] = "value";
    }
    const { status, output } = await runHarness({
      suite: "schema-extraction",
      fixture_id: "large",
      constructor: { apiKey: "test-key", env: "dev", version: "1.0.0" },
      input,
    });

    expect(status).toBe(0);
    expect(output.actual).toHaveLength(10000);
  });

  test("a constructor that throws is a harness failure (exit 1)", async () => {
    const { status, output } = await runHarness({
      suite: "schema-extraction",
      fixture_id: "throws",
      constructor: { apiKey: "", env: "dev", version: "1.0.0" },
      input: { a: 1 },
    });

    expect(status).toBe(1);
    expect(output.error).toContain("Constructor threw");
  });
});
