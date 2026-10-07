---
import:
  - src/index.cs.md
  - src/AvoInspector.cs.md
---
# Avo Inspector conformance harness

Executable Node script that implements the conformance runner contract (version `1.1.0`): it reads one JSON input envelope from stdin, drives the **built** SDK (`dist/index.js`, so the package must be built first) for exactly one fixture, and writes one JSON output envelope to stdout. It contains no assertion logic; the external suite runner judges results. `scripts/run-conformance.sh` builds the SDK, checks out the spec repository at a pinned commit (or uses `SPEC_DIR`), and runs the suite runner with this harness.

## Tech stack

- Node.js CommonJS script (`#!/usr/bin/env node`, `"use strict"`), no dependencies beyond the built SDK.
- Exports `{ HARNESS_CONTRACT_VERSION: "1.1.0" }`.

## Data

Input envelope fields read by the harness:

| Field | Rule |
|---|---|
| `fixture_id` | string |
| `suite` | one of `schema-extraction`, `wire-protocol`, `error-handling`, `batching` |
| `operation` | string, optional; defaults to `extractSchema` only for `schema-extraction` |
| `constructor` | own property, plain object; passed verbatim to `new AvoInspector(...)` |
| `input` | `extractSchema`: object or `null`; `trackSchemaFromEvent`: `{ eventName: string, eventProperties: object, streamId?: string, options?: object }` |
| `steps` | `sequence`: array of `track` (same fields as `input`), `trackN` (`count` int >= 1, `eventNamePrefix?`, `streamId?` strings), `flush` (`timeoutMs?` int >= 0), `destroy` |
| `precondition` | optional object; only `samplingRate` (finite number in [0, 1]) is allowed |

Output envelope: `{ fixture_id, passed, actual, outcome: "resolve" | "reject", error }`.

## Functional requirements

1. Redirect `console.log`, `console.info`, `console.warn` to stderr so stdout carries only the envelope.
2. Read all of stdin, trim, `JSON.parse`; non-JSON or non-object -> config error.
3. Validate the whole envelope (fields above, unknown operation, unknown step action, unknown precondition key) **before** constructing the SDK; any violation -> config error.
4. `new AvoInspector(envelope.constructor)`; a throw -> exit 1 with `error: "Constructor threw: <message>"`.
5. Apply `precondition.samplingRate` via `_setSamplingRateForTesting`.
6. Run the operation:
   - `extractSchema`: synchronous `inspector.extractSchema(input)`; `actual` = returned array, `outcome: "resolve"`.
   - `trackSchemaFromEvent`: await the call; `actual` = resolved value or rejection reason, `outcome` accordingly.
   - `sequence`: steps run in order and each appends `{ action, outcome, value }` to `actual`:
     - `track`: settled like `trackSchemaFromEvent`.
     - `trackN`: starts `count` calls `trackSchemaFromEvent("<prefix><i>", {}, streamId ?? "")` concurrently, awaits all; `value: count`.
     - `flush`: awaits `flush()` or `flush(timeoutMs)`; `value` = the boolean it resolves to (`true` drained, `false` the timeout won).
     - `destroy`: calls `destroy()`; `value: null`.
7. Trailing optional arguments not supplied by the fixture are omitted from the `trackSchemaFromEvent` call (`streamId`, `options`); `options` is passed verbatim.
8. Success envelopes have `passed: true`, `error: null`, exit 0.

## Non-functional requirements

- **Exit codes:** `0` envelope written; `1` constructor throw or runtime error (`error: "harness runtime error: <message>"`, `actual: null`); `2` configuration error (`fixture_id` may be `null`, `actual: null`).
- **IMPORTANT:** the harness always leaves via `process.exit` after the stdout write callback fires, so the envelope is flushed and the SDK's `beforeExit` drain never runs (buffered events stay unsent).
- Exactly one envelope is written: exiting throws an internal sentinel that unwinds past all later code and is swallowed at top level; any other top-level error is rethrown.
- Rejection reasons and resolved values are placed in `actual` unchanged, then JSON-serialized.
- The inspector is never destroyed or flushed implicitly.

## Examples

<example>
stdin:  {"fixture_id":"f1","suite":"schema-extraction","constructor":{...},"input":null}
stdout: {"fixture_id":"f1","passed":true,"actual":<extractSchema(null) result>,"outcome":"resolve","error":null}   exit 0
</example>

<example>
stdin:  {"fixture_id":"f2","suite":"batching","operation":"sequence","constructor":{...},"steps":[{"action":"jump"}]}
stdout: {"fixture_id":"f2","passed":false,"actual":null,"outcome":"resolve","error":"unsupported sequence action: jump"}   exit 2
</example>
