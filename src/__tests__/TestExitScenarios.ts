import { execFile, execFileSync } from "child_process";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";

import { trackConnections } from "./constants";

// Whole-process scenarios from the PR review: real child processes that exit on their own,
// against a local mock of the Avo API (track requests and spec fetches).

const repoRoot = join(__dirname, "..", "..");
let distDir: string;

// The mock: a spec fetch for an event whose name starts with "Hang" never gets an answer;
// others get a spec for property "a" after `specDelayMs`. Each track request is answered
// after `trackDelayMs` (never, if it is null).
let server: Server;
let endpoint: string;
let closeConnections: () => void;
let trackDelayMs: number | null = 0;
let specDelayMs = 0;
let received: string[] = [];
let validated = 0;
let trackRequests = 0;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), "avo-inspector-scenarios-"));
  // tsc's JS entry point run with this Node (the .bin shim is a .cmd file on Windows).
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "-p", join(repoRoot, "tsconfig.json"), "--outDir", distDir,
  ]);

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://mock");
    if (url.pathname === "/trackingPlan/eventSpec") {
      if ((url.searchParams.get("eventName") || "").startsWith("Hang")) {
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          events: [{ b: "b", id: "ev1", vids: [], p: { a: { t: "int", r: true } } }],
          metadata: { schemaId: "s", branchId: "b", latestActionId: "l", sourceId: "src" },
        }));
      }, specDelayMs);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"));
      received.push(...body.map((e: any) => e.eventName));
      validated += body.filter((e: any) => e.eventSpecMetadata).length;
      trackRequests++;
      if (trackDelayMs === null) {
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ samplingRate: 1 }));
      }, trackDelayMs);
    });
  });
  closeConnections = trackConnections(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  closeConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  trackDelayMs = 0;
  specDelayMs = 0;
  received = [];
  validated = 0;
  trackRequests = 0;
});

// Runs `script` in a child process. prod instances send to api.avo.app, so every https
// request is routed to the mock over http (and nothing else can be reached).
// Measured inside the child, from the start of the script (after the SDK is loaded) to
// its exit: process start-up under a loaded test run is not the SDK's time.
const ELAPSED_PRELUDE = `const __started = Date.now(); process.on("exit", () => process.stderr.write("__ELAPSED " + (Date.now() - __started) + "\\n"));\n`;
const childElapsed = (stderr: string, fallback: number) => {
  const match = stderr.match(/__ELAPSED (\d+)/);
  return match ? Number(match[1]) : fallback;
};

function runChild(script: string, timeout = 60_000): Promise<{ code: number | null; elapsedMs: number; stdout: string; stderr: string }> {
  const started = Date.now();
  const prelude = `
    const http = require("http"), https = require("https");
    https.request = (url, options, callback) => {
      const u = new URL(url);
      return http.request({ host: "127.0.0.1", port: ${JSON.stringify(new URL(endpoint).port)}, path: u.pathname, method: options.method, headers: options.headers }, callback);
    };
    const { AvoInspector } = require(${JSON.stringify(join(distDir, "index.js"))});
  `;
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["-e", prelude + ELAPSED_PRELUDE + script],
      { env: { ...process.env, AVO_INSPECTOR_MOCK_ENDPOINT: endpoint, NODE_PATH: join(repoRoot, "node_modules") }, timeout },
      (_err, stdout, stderr) => resolve({ code: child.exitCode, elapsedMs: childElapsed(String(stderr), Date.now() - started), stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

// "dropped N event(s) (<reason>)" lines at exit, summed by reason.
const reported = (stderr: string, reason: string) =>
  stderr.split("\n").filter((l) => l.includes(`(${reason})`))
    .reduce((sum, l) => sum + Number(l.match(/dropped (\d+) event/)![1]), 0);

describe("an awaited loop whose tracks wait on spec fetches", () => {
  // Every row is a spec-cache miss (its own stream id), so each track waits on a fetch.
  const loop = (env: string, rows: number, after = "") => `
    const inspector = new AvoInspector({ apiKey: "k", env: "${env}", version: "1.0.0", batchSize: 30 });
    inspector.enableLogging(false);
    (async () => {
      let n = 0;
      for (; n < ${rows}; n++) await inspector.trackSchemaFromEvent("Row Event", { a: n }, "user-" + n);
      console.log("LOOP DONE " + n);
      ${after}
    })();
  `;

  test("staging, slow spec and hung track: the loop finishes and the code after it runs", async () => {
    specDelayMs = 2000;
    trackDelayMs = null;
    const { code, stdout } = await runChild(loop("staging", 12, `
      console.log("FLUSH " + (await inspector.flush(1000)));
      console.log("AFTER LOOP");
    `), 90_000);

    expect(code).toBe(0);
    expect(stdout).toContain("LOOP DONE 12");
    expect(stdout).toContain("AFTER LOOP");
  }, 100_000);

  test("dev, slow spec and hung track: the loop finishes and the code after it runs", async () => {
    // Each track waits for its spec and then for its own send, which times out after 10 s.
    specDelayMs = 2000;
    trackDelayMs = null;
    const { code, stdout } = await runChild(loop("dev", 3, `console.log("AFTER LOOP");`), 90_000);

    expect(code).toBe(0);
    expect(stdout).toContain("LOOP DONE 3");
    expect(stdout).toContain("AFTER LOOP");
    expect(received).toHaveLength(3);
  }, 100_000);

  test("dev, slow spec and slow track: the loop finishes and every event is sent validated", async () => {
    specDelayMs = 2000;
    trackDelayMs = 500;
    const { code, stdout } = await runChild(loop("dev", 12, `console.log("AFTER LOOP");`), 90_000);

    expect(code).toBe(0);
    expect(stdout).toContain("AFTER LOOP");
    expect(received).toHaveLength(12);
    expect(validated).toBe(12);
  }, 100_000);

  test("staging, spec slower than track: no event is given up and sent unvalidated mid-loop", async () => {
    specDelayMs = 3000;
    trackDelayMs = 5000;
    const { stdout } = await runChild(loop("staging", 6, `await inspector.flush(); console.log("AFTER LOOP");`), 90_000);

    expect(stdout).toContain("AFTER LOOP");
    expect(received).toHaveLength(6);
    expect(validated).toBe(6);
  }, 100_000);

  test("staging, spec slower than the exit grace: the events still go out as one batch", async () => {
    specDelayMs = 1200;
    const { stdout } = await runChild(loop("staging", 10, `await inspector.flush(); console.log("AFTER LOOP");`), 90_000);

    expect(stdout).toContain("AFTER LOOP");
    expect(received).toHaveLength(10);
    expect(trackRequests).toBe(1);
  }, 100_000);
});

describe("backpressure in an awaited loop", () => {
  test("a stalled awaited loop is not taken for the exit: the loop finishes and every event is accounted for", async () => {
    trackDelayMs = 1500;
    const { code, stdout, stderr, elapsedMs } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
      (async () => {
        let n = 0;
        for (; n < 3000; n++) await inspector.trackSchemaFromEvent("E", { n });
        console.log("LOOP DONE " + n);
      })();
    `, 120_000);

    expect(code).toBe(0);
    expect(stdout).toContain("LOOP DONE 3000");
    // Received by the endpoint, or reported as never sent: nothing vanishes. (Events in
    // sends still open at exit reached the endpoint and are also reported as unconfirmed.)
    expect(received.length + reported(stderr, "unsent at exit")).toBe(3000);
    expect(reported(stderr, "unconfirmed at exit")).toBeLessThanOrEqual(4 * 30);
    expect(elapsedMs).toBeLessThan(110_000);
  }, 130_000);
});
describe("an awaited track whose send waits for a slot", () => {
  test("batch size 1 (dev and prod): the hold resolves the call with its schema, and its event is sent or reported", async () => {
    // 24 sends take every slot for 8 s each, so the awaited track's send starts only after
    // its 30 s hold has run out.
    trackDelayMs = 8000;
    const script = (env: string) => `
      const inspector = new AvoInspector({ apiKey: "k", env: "${env}", version: "1.0.0", batchSize: 1 });
      inspector.enableLogging(false);
      (async () => {
        for (let i = 0; i < 24; i++) inspector.trackSchemaFromEvent("E" + i, { i });
        const schema = await inspector.trackSchemaFromEvent("Awaited", { i: 24 });
        console.log("AFTER AWAIT " + JSON.stringify(schema));
      })();
    `;
    const runs = await Promise.all(["dev", "prod"].map((env) => runChild(script(env), 90_000)));

    runs.forEach(({ code, stdout, stderr }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('AFTER AWAIT [{"propertyName":"i","propertyType":"int"}]');
      expect(reported(stderr, "unsent at exit")).toBeGreaterThanOrEqual(1);
    });
    expect(received.length + runs.reduce((sum, { stderr }) => sum + reported(stderr, "unsent at exit"), 0)).toBe(50);
  }, 100_000);
});

describe("exit while a spec fetch hangs", () => {
  test("events already validated are sent; only the one still being validated is held back", async () => {
    const { stderr } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
      (async () => {
        for (let i = 0; i < 5; i++) await inspector.trackSchemaFromEvent("E" + i, { i });
        inspector.trackSchemaFromEvent("Hang", { i: 5 });
      })();
    `);

    expect(received.filter((name) => name.startsWith("E")).sort()).toEqual(["E0", "E1", "E2", "E3", "E4"]);
    // The held-back event is sent unvalidated once its validation is given up, or reported.
    expect(received.filter((n) => n === "Hang").length + reported(stderr, "unsent at exit")).toBe(1);
  }, 60_000);

  test("another instance's events are sent while one instance waits on a hung spec", async () => {
    await runChild(`
      const prod = new AvoInspector({ apiKey: "k", env: "prod", version: "1.0.0", batchSize: 30 });
      const staging = new AvoInspector({ apiKey: "k2", env: "staging", version: "1.0.0", batchSize: 30 });
      for (let i = 0; i < 5; i++) prod.trackSchemaFromEvent("P" + i, { i });
      staging.trackSchemaFromEvent("Hang", { i: 0 });
    `);

    expect(received.filter((name) => name.startsWith("P")).sort()).toEqual(["P0", "P1", "P2", "P3", "P4"]);
  }, 60_000);

  test("9 hung spec fetches (8 at once, 1 a second later): the exit ends within one deadline, and every event is sent or reported", async () => {
    const { stderr, elapsedMs } = await runChild(`
      const inspector = new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30 });
      for (let i = 0; i < 8; i++) inspector.trackSchemaFromEvent("Hang" + i, { i });
      setTimeout(() => inspector.trackSchemaFromEvent("Hang8", { i: 8 }), 1000);
    `);

    expect(elapsedMs).toBeLessThan(14_000);
    expect(received.length + reported(stderr, "unsent at exit")).toBe(9);
    // Given up at the deadline, they go out unvalidated rather than being lost.
    expect(received.length).toBe(9);
  }, 60_000);
});
