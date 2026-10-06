import { execFile, execFileSync } from "child_process";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";

import { AvoInspector } from "../AvoInspector";
import { answerSpecFetch, restoreEnv, trackConnections } from "./constants";

// These tests run a real Node process that exits on its own, so they need the compiled SDK.
const repoRoot = join(__dirname, "..", "..");
let distDir: string;
let server: Server;
let endpoint: string;
let received: any[] = [];
let requestSizes: number[] = [];
const defaultEndpoint = process.env.AVO_INSPECTOR_MOCK_ENDPOINT;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), "avo-inspector-exit-"));
  // tsc's JS entry point run with this Node (the .bin shim is a .cmd file on Windows).
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "-p", join(repoRoot, "tsconfig.json"), "--outDir", distDir,
  ]);

  server = createServer((req, res) => {
    if (answerSpecFetch(req, res)) {
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const events = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"));
      requestSizes.push(events.length);
      received.push(...events);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ samplingRate: 1.0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
  requestSizes = [];
});

// Runs `script` in a child Node process with the compiled SDK as `AvoInspector`.
function runChild(script: string, target: string = endpoint): Promise<{ elapsedMs: number; stdout: string; stderr: string }> {
  const started = Date.now();
  const source =
    `const { AvoInspector } = require(${JSON.stringify(join(distDir, "index.js"))});\n` + script;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", source],
      {
        env: {
          ...process.env,
          AVO_INSPECTOR_MOCK_ENDPOINT: target,
          NODE_PATH: join(repoRoot, "node_modules"),
        },
        timeout: 30_000,
      },
      (err, stdout, stderr) =>
        err ? reject(err) : resolve({ elapsedMs: Date.now() - started, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

const trackWithoutFlush = `
  const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
  inspector.trackSchemaFromEvent("Exit Event", { a: 1 });
`;

describe("exit against an endpoint that never answers", () => {
  let hung: Server;
  let hungEndpoint: string;
  let closeHungConnections: () => void;
  let hungRequests: number[] = [];

  beforeAll(async () => {
    hung = createServer((req, res) => {
      if (answerSpecFetch(req, res)) {
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const body = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
        hungRequests.push(JSON.parse(body.toString("utf8")).length);
      });
    });
    closeHungConnections = trackConnections(hung);
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    hungEndpoint = "http://127.0.0.1:" + (hung.address() as AddressInfo).port;
  });

  afterAll(async () => {
    closeHungConnections();
    await new Promise((resolve) => hung.close(resolve));
  });

  test("a natural exit sends the in-flight batch and the tail together, within about 10 s", async () => {
    hungRequests = [];
    // 45 events with batchSize 30: one size-triggered batch, and a 15-event tail at exit.
    // Spec-fetch sockets do not hold the process, so the script holds it until every event
    // is validated and queued; otherwise the exit drain would start mid-validation.
    const { elapsedMs } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
      const hold = setInterval(() => {}, 1000);
      const tracks = [];
      for (let i = 0; i < 45; i++) tracks.push(inspector.trackSchemaFromEvent("E" + i, { i }));
      Promise.all(tracks).then(() => clearInterval(hold));
    `, hungEndpoint);

    expect(hungRequests.sort((a, b) => a - b)).toEqual([15, 30]);
    // About 10 s: one shared deadline, not two in a row (20 s). Wide upper margin for slow
    // machines; the lower bound shows the exit really waited for the drain.
    expect(elapsedMs).toBeGreaterThan(9_000);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 40_000);
});

describe("exit while a spec fetch hangs", () => {
  let silent: Server;
  let silentEndpoint: string;
  let closeSilentConnections: () => void;

  beforeAll(async () => {
    // Answers nothing: neither spec fetches nor track requests.
    silent = createServer(() => {});
    closeSilentConnections = trackConnections(silent);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    silentEndpoint = "http://127.0.0.1:" + (silent.address() as AddressInfo).port;
  });

  afterAll(async () => {
    closeSilentConnections();
    await new Promise((resolve) => silent.close(resolve));
  });

  test("an awaited script mid-validation is not an exit: its batch stays whole", async () => {
    // Spec fetches answered at once; nothing but the SDK holds the process, so beforeExit
    // fires while each track waits for its spec. The drain must not send then.
    received = [];
    await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 3 });
      (async () => {
        for (let i = 0; i < 4; i++) await inspector.trackSchemaFromEvent("E" + i, { i });
      })();
    `);
    // One size-triggered batch of 3, then the 1-event tail at the exit: not 4 single sends.
    expect(received.map((e: any) => e.eventName)).toEqual(["E0", "E1", "E2", "E3"]);
    expect(requestSizes).toEqual([3, 1]);
  }, 40_000);

  test("a hung spec fetch does not hold the process before the exit drain: about 10 s in all", async () => {
    // Before the fix the fetch's socket held the loop for its own 10 s, then the drain
    // started its 10 s: about 20 s.
    const { elapsedMs } = await runChild(trackWithoutFlush, silentEndpoint);
    expect(elapsedMs).toBeGreaterThan(9_000);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 40_000);
});

describe("events still unsent at exit are logged", () => {
  let slow: Server;
  let slowEndpoint: string;
  let closeSlowConnections: () => void;
  let received = 0;
  let answered = 0;

  beforeAll(async () => {
    // Answers spec fetches at once and each track request after 3 s.
    slow = createServer((req, res) => {
      if (answerSpecFetch(req, res)) {
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const events = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8")).length;
        received += events;
        setTimeout(() => {
          answered += events;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ samplingRate: 1.0 }));
        }, 3000);
      });
    });
    closeSlowConnections = trackConnections(slow);
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    slowEndpoint = "http://127.0.0.1:" + (slow.address() as AddressInfo).port;
  });

  afterAll(async () => {
    closeSlowConnections();
    await new Promise((resolve) => slow.close(resolve));
  });

  beforeEach(() => {
    received = 0;
    answered = 0;
  });

  const exitLines = (stderr: string) => stderr.split("\n").filter((line) => line.includes("at exit"));
  const count = (lines: string[], reason: string) => {
    const line = lines.find((l) => l.includes(`(${reason})`));
    return line ? Number(line.match(/dropped (\d+) event/)![1]) : 0;
  };

  test("process.exit() with buffered events prints them as unsent at exit", async () => {
    const { stderr } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
      // Held open while validating, so no idle point lets the exit drain send early.
      setInterval(() => {}, 1000);
      (async () => {
        for (let i = 0; i < 10; i++) await inspector.trackSchemaFromEvent("E" + i, { i });
        process.exit(0);
      })();
    `, slowEndpoint);

    expect(received).toBe(0);
    expect(exitLines(stderr)).toEqual(["Avo Inspector: dropped 10 event(s) (unsent at exit) in the last 1s."]);
  }, 40_000);

  test("a natural exit past the deadline prints the unsent and the unconfirmed events", async () => {
    // 3,000 events in 100 batches; 4 sends at a time, 3 s each: about 12 go out by the deadline.
    const { stderr } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
      // Not awaited, and nothing holds the process: the exit drain starts at once.
      for (let i = 0; i < 3000; i++) inspector.trackSchemaFromEvent("E" + i, { i });
    `, slowEndpoint);

    const lines = exitLines(stderr);
    const unsent = count(lines, "unsent at exit");
    const unconfirmed = count(lines, "unconfirmed at exit");
    expect(lines).toHaveLength(2);
    expect(unconfirmed).toBeGreaterThan(0);
    expect(unconfirmed).toBeLessThanOrEqual(4 * 30);
    // Every event is accounted for: answered, in flight at exit, or never sent.
    expect(answered + unconfirmed + unsent).toBe(3000);
    expect(unsent).toBe(3000 - received);
  }, 60_000);
});

describe("exit while an explicit long flush() runs", () => {
  let slow: Server;
  let slowEndpoint: string;
  let slowRequests = 0;
  let closeSlowConnections: () => void;

  beforeAll(async () => {
    // Answers every request after 6 s.
    slow = createServer((req, res) => {
      if (answerSpecFetch(req, res)) {
        return;
      }
      req.resume();
      req.on("end", () => {
        slowRequests++;
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ samplingRate: 1.0 }));
        }, 6000);
      });
    });
    closeSlowConnections = trackConnections(slow);
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    slowEndpoint = "http://127.0.0.1:" + (slow.address() as AddressInfo).port;
  });

  afterAll(async () => {
    closeSlowConnections();
    await new Promise((resolve) => slow.close(resolve));
  });

  test("the exit drain honours a longer explicit flush deadline", async () => {
    slowRequests = 0;
    // 5 batches, 4 sent at a time, 6 s each: the 5th finishes at about 12 s, inside the
    // flush's 20 s but past the exit drain's own 10 s.
    const { stdout, elapsedMs } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 1 });
      for (let i = 0; i < 5; i++) inspector.trackSchemaFromEvent("E" + i, { i });
      inspector.flush(20000).then(() => console.log("FLUSHED"));
    `, slowEndpoint);

    expect(slowRequests).toBe(5);
    expect(stdout).toContain("FLUSHED");
    expect(elapsedMs).toBeGreaterThan(11_000);
  }, 40_000);
});

describe("drain on beforeExit", () => {
  test("a process that returns without flush() still delivers its buffered event", async () => {
    await runChild(trackWithoutFlush);

    expect(received.map((e) => e.eventName)).toEqual(["Exit Event"]);
  }, 30_000);

  test("control: without the beforeExit hook the buffered event is lost", async () => {
    await runChild(trackWithoutFlush + `process.removeAllListeners("beforeExit");`);

    expect(received).toEqual([]);
  }, 30_000);

  test("an idle instance does not keep the process alive", async () => {
    const { elapsedMs } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0" });
    `);

    expect(elapsedMs).toBeLessThan(5_000);
    expect(received).toEqual([]);
  }, 30_000);

  test("many instances share one listener, with no MaxListeners warning", async () => {
    const script = `
      process.on("warning", (w) => { process.stderr.write("WARNING " + w.name + "\\n"); process.exitCode = 3; });
      for (let i = 0; i < 25; i++) {
        const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
        inspector.trackSchemaFromEvent("E" + i, {});
      }
      if (process.listenerCount("beforeExit") !== 1) process.exitCode = 4;
    `;
    await runChild(script);

    expect(received).toHaveLength(25);
  }, 30_000);
});

describe("exit hook registration", () => {
  beforeEach(() => {
    // Keeps staging off the real event-spec endpoint.
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = endpoint;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv("AVO_INSPECTOR_MOCK_ENDPOINT", defaultEndpoint);
    jest.restoreAllMocks();
  });

  test("one listener serves every instance with work, and destroy() removes it", async () => {
    const counts = () => ["beforeExit", "exit", "SIGTERM", "SIGINT"].map((name) => process.listenerCount(name));
    const before = counts();
    const inspectors = Array.from({ length: 12 }, () =>
      new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30, disableBatchTimer: true })
    );
    expect(counts()).toEqual(before);

    await Promise.all(inspectors.map((inspector) => inspector.trackSchemaFromEvent("E", {})));
    // One beforeExit drain and one exit report; never a signal handler.
    expect(counts()).toEqual([before[0] + 1, before[1] + 1, before[2], before[3]]);

    inspectors.forEach((inspector) => inspector.destroy());
    expect(counts()).toEqual(before);
  });
});

describe("exit deadline", () => {
  beforeEach(() => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = endpoint;
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv("AVO_INSPECTOR_MOCK_ENDPOINT", defaultEndpoint);
    (AvoInspector as any).exitDeadline = null;
    jest.restoreAllMocks();
  });

  test("a stale deadline from an earlier beforeExit does not skip the next drain", async () => {
    const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30, disableBatchTimer: true });
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);
    await inspector.trackSchemaFromEvent("E", {});
    // An earlier exit drain left its deadline behind a minute ago.
    (AvoInspector as any).exitDeadline = require("../utils").monotonicNowMs() - 60_000;

    (AvoInspector as any).drainOnExit();
    await new Promise((resolve) => setImmediate(resolve));

    expect(send).toHaveBeenCalledTimes(1);
    inspector.destroy();
  });

  test("a deadline that passed with no track since is the same exit: its budget does not restart", async () => {
    const now = () => require("../utils").monotonicNowMs();
    const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30, disableBatchTimer: true });
    const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);
    await inspector.trackSchemaFromEvent("E", {});
    // The exit drain's deadline passed 5 s ago while the app's own beforeExit work kept the
    // loop alive; the last track was before it.
    (AvoInspector as any).exitDeadline = now() - 5_000;
    (AvoInspector as any).lastTrackAt = now() - 15_000;

    (AvoInspector as any).drainOnExit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).not.toHaveBeenCalled();

    // A track after the deadline means the process carried on: the next exit gets a new one.
    await inspector.trackSchemaFromEvent("F", {});
    (AvoInspector as any).drainOnExit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    inspector.destroy();
  });
});
