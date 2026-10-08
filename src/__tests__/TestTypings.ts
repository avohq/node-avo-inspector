import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The published typings must compile for a TypeScript user who does not skip lib checks.
const repoRoot = join(__dirname, "..", "..");
// The compiler's JS entry point, run with this Node: node_modules/.bin/tsc is a .cmd shim on
// Windows, which execFile/spawn cannot launch without a shell.
const tscJs = require.resolve("typescript/bin/tsc");
const tsc = (args: string[]) => [process.execPath, [tscJs, ...args]] as const;

test("the built declarations type-check with skipLibCheck off", () => {
  // Built with the package's own tsconfig, so stripInternal applies as in the release.
  const outDir = mkdtempSync(join(tmpdir(), "avo-inspector-typings-"));
  execFileSync(...tsc(["-p", join(repoRoot, "tsconfig.json"), "--outDir", outDir]));

  // A user's code, against the published signatures.
  const consumer = join(outDir, "consumer.ts");
  writeFileSync(consumer, [
    `import { AvoInspector, InspectorEvent } from "./index";`,
    `async function drain(inspector: AvoInspector): Promise<void> {`,
    `  const drained: boolean = await inspector.flush(1000);`,
    `  while (!(await inspector.flush())) {}`,
    `  void drained;`,
    `}`,
    `async function track(inspector: AvoInspector): Promise<void> {`,
    `  const event: InspectorEvent = { eventName: "Purchase", eventProperties: { amount: 42 }, originHint: "web" };`,
    `  await inspector.trackSchemaFromEvent(event);`,
    `  await inspector.trackSchemaFromEvent({ eventName: "Purchase" });`,
    `  // @ts-expect-error The 1.x positional form no longer type-checks.`,
    `  await inspector.trackSchemaFromEvent("Purchase", { amount: 42 });`,
    `  // @ts-expect-error A misspelt key is an excess property on an object literal.`,
    `  await inspector.trackSchemaFromEvent({ eventName: "Purchase", outputRef: "o" });`,
    `  await inspector._avoFunctionTrackSchemaFromEvent("Purchase", {}, "id", "hash", "s", { originHint: "web" });`,
    `}`,
    `void drain;`,
    `void track;`,
  ].join("\n"));

  const result = spawnSync(...tsc([
    "--noEmit", "--skipLibCheck", "false", "--strict", "--target", "ES6",
    "--moduleResolution", "node", "--types", "node", "--typeRoots", join(repoRoot, "node_modules", "@types"),
    join(outDir, "index.d.ts"), consumer,
  ]), { encoding: "utf8" });

  expect(result.stdout + result.stderr).toBe("");
  expect(result.status).toBe(0);
}, 120_000);
