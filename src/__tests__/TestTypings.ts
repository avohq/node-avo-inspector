import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The published typings must compile for a TypeScript user who does not skip lib checks.
const repoRoot = join(__dirname, "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

test("the built declarations type-check with skipLibCheck off", () => {
  // Built with the package's own tsconfig, so stripInternal applies as in the release.
  const outDir = mkdtempSync(join(tmpdir(), "avo-inspector-typings-"));
  execFileSync(tsc, ["-p", join(repoRoot, "tsconfig.json"), "--outDir", outDir]);

  const result = spawnSync(tsc, [
    "--noEmit", "--skipLibCheck", "false", "--strict", "--target", "ES6",
    "--moduleResolution", "node", "--types", "node", "--typeRoots", join(repoRoot, "node_modules", "@types"),
    join(outDir, "index.d.ts"),
  ], { encoding: "utf8" });

  expect(result.stdout + result.stderr).toBe("");
  expect(result.status).toBe(0);
}, 120_000);
