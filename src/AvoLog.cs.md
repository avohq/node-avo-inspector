---
import:
  - src/AvoInspector.cs.md
  - src/AvoBatchQueue.cs.md
---
# AvoLog

Always-on, rate-limited log lines for lost data and failed sends: dropped events, non-200 responses, send failures and internal errors. They print whatever the logging flag, because they report data the caller will never see arrive.

## Tech stack

- TypeScript on Node.js; `console.warn` / `console.error` (stderr). Imports only `monotonicNowMs` from `utils` (which imports nothing), so it can be loaded before the rest of the SDK (the jest setup resets it per test).

## Data

```ts
export const INTERNAL_ERROR_MESSAGE = "Avo Inspector: something went wrong. Please report to support@avo.app."; // @internal
export const MISSING_EVENT_NAME = "Missing Event Name"; // the name sent for a track call with a missing event name
export type DropReason = "queue full" | "send backlog full" | "internal error" | "unsent at exit" | "unconfirmed at exit";
class AvoLog {
  static now: () => number;              // utils.monotonicNowMs by default; overridable in tests
  static dropped(count: number, reason: DropReason): void;
  static rejected(status: number): void;
  static failed(error: unknown): void;
  static internal(error: unknown): void;
  static errorType(error: unknown): string; // @internal: the fixed label, also used by other log lines that report a caught error
  static streamIdColon(): void;
  static unknownEventKeys(keys: string[], known: string[]): void;
  static notAnInspectorEvent(): void;
  static missingEventName(): void;
  static flushPending(onlyExpired?: boolean): void; // prints pending counts (see Lifecycle)
  static enterExit(): void;              // @internal: from now on lines are written synchronously (the exit listeners call it)
  static _resetForTesting(): void;       // @internal
}
```

Process-wide state: a map from key to `{ start, suppressed, print }`: the start of the key's current 10 s window, the amount counted in it without being printed, and how to print that count; plus whether its exit listeners are armed, and whether the process is exiting (lines are then written synchronously). Keys: `dropped:<reason>`, `non200:<status>`, `failed:<reason>`, `internal`, `streamid-colon`, `unknown-event-keys`, `not-an-inspector-event`, `missing-event-name`.

## Users and permissions

- Internal; called by `AvoBatchQueue` (drops, and a dispatch that throws or rejects: `internal` plus `dropped` with reason `internal error`), `AvoInspector` (non-200, send failures, internal errors, track calls with a missing event name, and at the real exit the events still unsent or unconfirmed: it calls `AvoLog.enterExit()` first so those lines are written synchronously) and `AvoStreamId` (a stream id containing `':'`).

## Functional requirements

### Rate limit (every kind)

1. An occurrence with amount `a` for key `k` at time `now`:
   - no window for `k`, or `now - start >= 10 000 ms` → print a line with total `a + suppressed` (the previous window's count), and start a new window at `now` with `suppressed = 0`. The line's `<N>s` is the real whole seconds since the previous window began (at least 1) when it reports a suppressed count, else `1`;
   - otherwise → `suppressed += a`, print nothing.
2. There is no timer.

### Lifecycle: pending counts (`flushPending`)

- `flushPending()` prints every key with `suppressed > 0` at once (total = `suppressed`, `<N>s` = whole seconds since the window began, at least 1) and deletes that key's window, so its next occurrence prints immediately.
- `flushPending(true)` (called by `flush()`) prints only keys whose window has expired (`now - start >= 10 000 ms`); a count still inside its window stays pending, so an app that calls `flush()` after every event keeps one line per kind per 10 s.
- `destroy()` calls `flushPending()`.
- While any count is pending, two listeners are armed, and both are removed once nothing is pending. They schedule nothing, so they never keep the process alive.
  - `beforeExit` calls `flushPending(true)`: expired counts only, like `flush()`. **IMPORTANT:** `beforeExit` is not the exit. In a script whose only pending work is the SDK's, it fires at every idle point (for example after each awaited `flush()`) and the exit drain resumes the process, so printing everything there would print one line per idle point and break the rate limit.
  - `exit` (a natural exit or `process.exit()`) marks the process as exiting and calls `flushPending()`, printing every pending count. From then on lines are written with a synchronous `fs.writeSync(2, …)` instead of `console`, because console writes to a pipe are asynchronous and would be lost as the process ends. This also covers exits where no instance has work left (no exit drain).

### Lines

| Call | Amount | Output |
|---|---|---|
| `dropped(count, reason)` | `count` | `console.warn("Avo Inspector: dropped <total> event(s) (<reason>) in the last <N>s.")` |
| `rejected(status)` | 1 | `console.warn("Avo Inspector: <total> batch(es) rejected with HTTP <status> in the last <N>s.")` |
| `failed(error)` | 1 | `console.error("Avo Inspector: schema sending failed: <reason>.")`, plus the suffix when `total > 1`. `<reason>` (also the key) is `error` itself when it is exactly `"Request failed"` or `"Request timed out"`, else `"Request failed (<errorType(error)>)"`: never an error's message |
| `internal(error)` | 1 | `console.error(INTERNAL_ERROR_MESSAGE + suffix + " (<type>)")`, with the same suffix; `<type>` is a fixed label: the most specific built-in error class the value is an instance of (`TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, `URIError`, `EvalError`, `Error`), else `typeof error`, or `unknown` if the check throws (a proxy trap). The value's own `name` or any other field is never read |
| `streamIdColon()` | 1 | `console.warn("[Avo Inspector] Warning: streamId contains ':' which is not supported" + suffix)`, with the same suffix |
| `notAnInspectorEvent()` | 1 | `console.error('[Avo Inspector] Error: since 2.0.0, trackSchemaFromEvent takes one InspectorEvent object; nothing was sent. Replace trackSchemaFromEvent(eventName, eventProperties) with trackSchemaFromEvent({ eventName, eventProperties }).' + suffix)`, with the same suffix. Nothing about the argument is printed |
| `unknownEventKeys(keys, known)` | 1 | `console.warn('[Avo Inspector] Warning: unknown InspectorEvent key(s) <names> ignored; the known keys are <known joined by ", ">' + suffix)`, with the same suffix. `<names>`: the first 5 keys, each cut to 64 characters (then `…`) and JSON-quoted, joined by `, `, then `, …` if there were more. Never a value. A held count prints with the names of the window's first occurrence |
| `missingEventName()` | 1 | `console.warn('Avo Inspector: <total> event(s) tracked without an event name in the last <N>s, sent as "Missing Event Name".')` |

The suffix is ` (<more> more in the last <N>s)`, where `<more>` is the count reported beyond the current occurrence (all of `suppressed` for a `flushPending` line); it is omitted when `<more>` is 0.

## Non-functional requirements

- **IMPORTANT:** never prints the API key, a response body or a property value; only counts, reasons, HTTP status codes, send-failure reasons and an internal error's type. An internal error's message and stack are never printed, because a throwing getter or proxy can put a property value in them.
- At most one line per key per 10 s.
- Callers do not report sends abandoned by `destroy()`, or sampling drops.

## Examples

<example>
10 enqueues with maxQueueSize 2 (8 drops, one at a time) within 10 s → one line: `Avo Inspector: dropped 1 event(s) (queue full) in the last 1s.` One more drop 10 s later → `Avo Inspector: dropped 8 event(s) (queue full) in the last 10s.`
</example>
<example>
5,000 queue-full drops in a burst, then `flush()` 12 s later → `dropped 1 event(s) (queue full) in the last 1s.` at once, then `dropped 4999 event(s) (queue full) in the last 12s.` from the flush. Had the flush come 3 s later, the count would have stayed pending until the next drop after the window, a later flush, `destroy()` or exit.
</example>
<example>
2 drops, then nothing for an hour, then one more → the line reports `dropped 3 event(s) (queue full) in the last 3600s.`
</example>
<example>
50 send failures ("Request failed") within 10 s → `Avo Inspector: schema sending failed: Request failed.` once; the next failure, 10 s after the first → `Avo Inspector: schema sending failed: Request failed. (49 more in the last 10s)`.
</example>
<example>
Responses 500, 500, 400, 500, 400, 500 within 10 s → `1 batch(es) rejected with HTTP 500 ...` and `1 batch(es) rejected with HTTP 400 ...`; the next 500, 10 s after the first → `4 batch(es) rejected with HTTP 500 in the last 10s.`
</example>
