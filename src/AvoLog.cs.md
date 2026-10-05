---
import:
  - src/AvoInspector.cs.md
  - src/AvoBatchQueue.cs.md
---
# AvoLog

Always-on, rate-limited log lines for lost data and failed sends: dropped events, non-200 responses, send failures and internal errors. They print whatever the logging flag, because they report data the caller will never see arrive.

## Tech stack

- TypeScript on Node.js; `console.warn` / `console.error` (stderr). No imports, so it can be loaded before anything else (the jest setup resets it per test).

## Data

```ts
export const INTERNAL_ERROR_MESSAGE = "Avo Inspector: something went wrong. Please report to support@avo.app."; // @internal
export const MISSING_EVENT_NAME = "Missing Event Name"; // the name sent for a track call with a missing event name
export type DropReason = "queue full" | "send backlog full" | "internal error";
class AvoLog {
  static now: () => number;              // monotonic milliseconds (process.hrtime); overridable in tests
  static dropped(count: number, reason: DropReason): void;
  static rejected(status: number): void;
  static failed(reason: string): void;
  static internal(error: unknown): void;
  static errorType(error: unknown): string; // @internal: the fixed label, also used by other log lines that report a caught error
  static streamIdColon(): void;
  static missingEventName(): void;
  static _resetForTesting(): void;       // @internal
}
```

Process-wide state: a map from key to `{ start, suppressed }`: the start of the key's current 10 s window, and the amount counted in it without being printed. Keys: `dropped:<reason>`, `non200:<status>`, `failed:<reason>`, `internal`, `streamid-colon`, `missing-event-name`.

## Users and permissions

- Internal; called by `AvoBatchQueue` (drops, and a dispatch that throws or rejects: `internal` plus `dropped` with reason `internal error`), `AvoInspector` (non-200, send failures, internal errors, track calls with a missing event name) and `AvoStreamId` (a stream id containing `':'`).

## Functional requirements

### Rate limit (every kind)

1. An occurrence with amount `a` for key `k` at time `now`:
   - no window for `k`, or `now - start >= 10 000 ms` → print a line with total `a + suppressed` (the previous window's count), and start a new window at `now` with `suppressed = 0`;
   - otherwise → `suppressed += a`, print nothing.
2. There is no timer: a suppressed count is reported only with the next occurrence of that key after its window. Nothing keeps the process alive.

### Lines

| Call | Amount | Output |
|---|---|---|
| `dropped(count, reason)` | `count` | `console.warn("Avo Inspector: dropped <total> event(s) (<reason>) in the last 10s.")` |
| `rejected(status)` | 1 | `console.warn("Avo Inspector: <total> batch(es) rejected with HTTP <status> in the last 10s.")` |
| `failed(reason)` | 1 | `console.error("Avo Inspector: schema sending failed: <reason>.")`, plus ` (<total - 1> more in the last 10s)` when `total > 1` |
| `internal(error)` | 1 | `console.error(INTERNAL_ERROR_MESSAGE + suffix + " (<type>)")`, with the same suffix; `<type>` is a fixed label: the most specific built-in error class the value is an instance of (`TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `URIError`, `EvalError`, `Error`), else `typeof error`, or `unknown` if the check throws (a proxy trap). The value's own `name` or any other field is never read |
| `streamIdColon()` | 1 | `console.warn("[Avo Inspector] Warning: streamId contains ':' which is not supported" + suffix)`, with the same suffix |
| `missingEventName()` | 1 | `console.warn('Avo Inspector: <total> event(s) tracked without an event name in the last 10s, sent as "Missing Event Name".')` |

## Non-functional requirements

- **IMPORTANT:** never prints the API key, a response body or a property value; only counts, reasons, HTTP status codes, send-failure reasons and an internal error's type. An internal error's message and stack are never printed, because a throwing getter or proxy can put a property value in them.
- At most one line per key per 10 s.
- Callers do not report sends abandoned by `destroy()`, or sampling drops.

## Examples

<example>
10 enqueues with maxQueueSize 2 (8 drops, one at a time) within 10 s → one line: `Avo Inspector: dropped 1 event(s) (queue full) in the last 10s.` One more drop 10 s later → `Avo Inspector: dropped 8 event(s) (queue full) in the last 10s.`
</example>
<example>
50 send failures ("Request failed") within 10 s → `Avo Inspector: schema sending failed: Request failed.` once; the next failure after the window → `Avo Inspector: schema sending failed: Request failed. (49 more in the last 10s)`.
</example>
<example>
Responses 500, 500, 400, 500, 400, 500 within 10 s → `1 batch(es) rejected with HTTP 500 ...` and `1 batch(es) rejected with HTTP 400 ...`; the next 500 after the window → `4 batch(es) rejected with HTTP 500 in the last 10s.`
</example>
