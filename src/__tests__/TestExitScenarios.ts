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
// others get "no spec" at once. Each track request is answered after `trackDelayMs`.
let server: Server;
let endpoint: string;
let closeConnections: () => void;
let trackDelayMs = 0;
let received: string[] = [];

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), "avo-inspector-scenarios-"));
  execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", join(repoRoot, "tsconfig.json"), "--outDir", distDir]);

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://mock");
    if (url.pathname === "/trackingPlan/eventSpec") {
      if ((url.searchParams.get("eventName") || "").startsWith("Hang")) {
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events: [], metadata: {} }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"));
      received.push(...body.map((e: any) => e.eventName));
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
  received = [];
});

// Runs `script` in a child process. prod instances send to api.avo.app, so every https
// request is routed to the mock over http (and nothing else can be reached).
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
      ["-e", prelude + script],
      { env: { ...process.env, AVO_INSPECTOR_MOCK_ENDPOINT: endpoint, NODE_PATH: join(repoRoot, "node_modules") }, timeout },
      (_err, stdout, stderr) => resolve({ code: child.exitCode, elapsedMs: Date.now() - started, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

// "dropped N event(s) (<reason>)" lines at exit, summed by reason.
const reported = (stderr: string, reason: string) =>
  stderr.split("\n").filter((l) => l.includes(`(${reason})`))
    .reduce((sum, l) => sum + Number(l.match(/dropped (\d+) event/)![1]), 0);

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
