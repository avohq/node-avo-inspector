import { execFile, execFileSync } from "child_process";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { answerSpecFetch } from "./constants";

// The always-on log limiter across real process lifecycles. A script whose only pending work
// is the SDK's goes idle (and emits "beforeExit") after every awaited flush(); those idle
// points must not print pending counts, which only a real exit does.

const repoRoot = join(__dirname, "..", "..");
let distDir: string;
let server: Server;
let endpoint: string;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), "avo-inspector-exitlogs-"));
  // tsc's JS entry point run with this Node (the .bin shim is a .cmd file on Windows).
  execFileSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "-p", join(repoRoot, "tsconfig.json"), "--outDir", distDir,
  ]);
  // Every track request is rejected with a 500; spec fetches get "no spec".
  server = createServer((req, res) => {
    if (answerSpecFetch(req, res)) {
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Runs `script` in a child Node process with the compiled SDK as `AvoInspector` and returns
// its stderr lines about rejected batches.
function rejectedLines(script: string): Promise<string[]> {
  const source =
    `const { AvoInspector } = require(${JSON.stringify(join(distDir, "index.js"))});\n` +
    `const j = new AvoInspector({ apiKey: "k", env: "staging", version: "1", disableBatchTimer: true });\n` +
    `j.enableLogging(false);\n` +
    script;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", source],
      {
        // NODE_PATH: the compiled SDK lives in a temp dir, outside this package's node_modules.
        env: { ...process.env, AVO_INSPECTOR_MOCK_ENDPOINT: endpoint, NODE_PATH: join(repoRoot, "node_modules") },
        timeout: 30_000,
      },
      (err, _stdout, stderr) =>
        err ? reject(err) : resolve(String(stderr).split("\n").filter((line) => /rejected with HTTP 500/.test(line)))
    );
  });
}

const first = "Avo Inspector: 1 batch(es) rejected with HTTP 500 in the last 1s.";
const remainder = (count: number) => new RegExp(`^Avo Inspector: ${count} batch\\(es\\) rejected with HTTP 500 in the last \\d+s\\.$`);

test("idle points between awaited flushes do not print; the real exit prints the remainder", async () => {
  const lines = await rejectedLines(`
    (async () => {
      for (let k = 0; k < 50; k++) { await j.trackSchemaFromEvent("E", { a: 1 }); await j.flush(5000); }
    })();
  `);

  expect(lines[0]).toBe(first);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(remainder(49));
}, 60_000);

test("a burst followed by a natural exit prints the remainder", async () => {
  const lines = await rejectedLines(`
    (async () => {
      const tracks = [];
      for (let k = 0; k < 10; k++) tracks.push(j.trackSchemaFromEvent("E" + k, { a: k }));
      await Promise.all(tracks);
      await j.flush(5000);
      for (let k = 0; k < 9; k++) await j.trackSchemaFromEvent("F" + k, { a: k }).then(() => j.flush(5000));
    })();
  `);

  expect(lines[0]).toBe(first);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(/^Avo Inspector: \d+ batch\(es\) rejected with HTTP 500 in the last \d+s\.$/);
}, 60_000);

test("with a keepalive interval the output is the same", async () => {
  const lines = await rejectedLines(`
    const keepalive = setInterval(() => {}, 1000);
    (async () => {
      for (let k = 0; k < 50; k++) { await j.trackSchemaFromEvent("E", { a: 1 }); await j.flush(5000); }
      clearInterval(keepalive);
    })();
  `);

  expect(lines).toEqual([first, expect.stringMatching(remainder(49))]);
}, 60_000);

test("process.exit() also prints the remainder", async () => {
  const lines = await rejectedLines(`
    (async () => {
      for (let k = 0; k < 50; k++) { await j.trackSchemaFromEvent("E", { a: 1 }); await j.flush(5000); }
      process.exit(0);
    })();
  `);

  expect(lines).toEqual([first, expect.stringMatching(remainder(49))]);
}, 60_000);
