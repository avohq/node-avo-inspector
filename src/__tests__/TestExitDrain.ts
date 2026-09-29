import { execFile, execFileSync } from "child_process";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";

import { AvoInspector } from "../AvoInspector";

// These tests run a real Node process that exits on its own, so they need the compiled SDK.
const repoRoot = join(__dirname, "..", "..");
let distDir: string;
let server: Server;
let endpoint: string;
let received: any[] = [];
const defaultEndpoint = process.env.AVO_INSPECTOR_MOCK_ENDPOINT;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), "avo-inspector-exit-"));
  execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), [
    "-p", join(repoRoot, "tsconfig.json"), "--outDir", distDir,
  ]);

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(...JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
});

// Runs `script` in a child Node process with the compiled SDK as `AvoInspector`.
function runChild(script: string, target: string = endpoint): Promise<{ elapsedMs: number }> {
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
      (err) => (err ? reject(err) : resolve({ elapsedMs: Date.now() - started }))
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
  let hungRequests: number[] = [];

  beforeAll(async () => {
    hung = createServer((req) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const body = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
        hungRequests.push(JSON.parse(body.toString("utf8")).length);
      });
    });
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    hungEndpoint = "http://127.0.0.1:" + (hung.address() as AddressInfo).port;
  });

  afterAll(async () => {
    hung.closeAllConnections();
    await new Promise((resolve) => hung.close(resolve));
  });

  test("a natural exit sends the in-flight batch and the tail together, within about 10 s", async () => {
    hungRequests = [];
    // 45 events with batchSize 30: one size-triggered batch, and a 15-event tail at exit.
    const { elapsedMs } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
      for (let i = 0; i < 45; i++) inspector.trackSchemaFromEvent("E" + i, { i });
    `, hungEndpoint);

    expect(hungRequests.sort((a, b) => a - b)).toEqual([15, 30]);
    // About 10 s: one shared deadline, not two in a row (20 s). Wide upper margin for slow
    // machines; the lower bound shows the exit really waited for the drain.
    expect(elapsedMs).toBeGreaterThan(9_000);
    expect(elapsedMs).toBeLessThan(15_000);
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
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = defaultEndpoint;
    jest.restoreAllMocks();
  });

  test("one listener serves every instance with work, and destroy() removes it", async () => {
    const before = process.listenerCount("beforeExit");
    const inspectors = Array.from({ length: 12 }, () =>
      new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30, disableBatchTimer: true })
    );
    expect(process.listenerCount("beforeExit")).toBe(before);

    await Promise.all(inspectors.map((inspector) => inspector.trackSchemaFromEvent("E", {})));
    expect(process.listenerCount("beforeExit")).toBe(before + 1);

    inspectors.forEach((inspector) => inspector.destroy());
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});
