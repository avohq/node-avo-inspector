import { execFileSync, spawnSync } from "child_process";
import { join } from "path";

// The harness drives the built SDK in dist/, so build it first.
const repoRoot = join(__dirname, "..", "..");
const harness = join(repoRoot, "conformance", "avo-inspector-conformance.js");

beforeAll(() => {
  execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), [
    "-p", join(repoRoot, "tsconfig.json"), "--outDir", join(repoRoot, "dist"),
  ]);
}, 60_000);

function runHarness(envelope: object) {
  const result = spawnSync(process.execPath, [harness], {
    input: JSON.stringify(envelope) + "\n",
    encoding: "utf8",
  });
  return { status: result.status, output: JSON.parse(result.stdout.trim()) };
}

describe("conformance harness", () => {
  test("an envelope without a constructor is a configuration error (exit 2)", () => {
    const { status, output } = runHarness({
      suite: "schema-extraction",
      fixture_id: "no-constructor",
      input: { a: 1 },
    });

    expect(status).toBe(2);
    expect(output).toMatchObject({ fixture_id: "no-constructor", passed: false });
    expect(output.error).toContain("constructor");
  });

  test("a constructor that is not an object is a configuration error (exit 2)", () => {
    const { status } = runHarness({
      suite: "schema-extraction",
      fixture_id: "bad-constructor",
      constructor: "test-key",
      input: { a: 1 },
    });

    expect(status).toBe(2);
  });

  test("a well-formed envelope runs the operation (exit 0)", () => {
    const { status, output } = runHarness({
      suite: "schema-extraction",
      fixture_id: "ok",
      constructor: { apiKey: "test-key", env: "dev", version: "1.0.0" },
      input: { a: 1 },
    });

    expect(status).toBe(0);
    expect(output.actual).toEqual([{ propertyName: "a", propertyType: "int" }]);
  });

  test("a constructor that throws is a harness failure (exit 1)", () => {
    const { status, output } = runHarness({
      suite: "schema-extraction",
      fixture_id: "throws",
      constructor: { apiKey: "", env: "dev", version: "1.0.0" },
      input: { a: 1 },
    });

    expect(status).toBe(1);
    expect(output.error).toContain("Constructor threw");
  });
});
