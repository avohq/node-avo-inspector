---
import:
  - src/AvoInspector.cs.md
---
# AvoStreamId

Holds the stream id a caller passes to a track call, defaulting to empty.

## Tech stack

- TypeScript. Reads `AvoInspector.shouldLog` to gate its type warning, and uses `AvoLog` for the `':'` warning.

## Data

```ts
class AvoStreamId {
  constructor(streamId?: unknown)
  get streamId(): string
}
```

## Functional requirements

1. Normalize the input to a string:
   - `undefined` / `null` -> `""`;
   - string -> itself;
   - number, bigint, boolean -> `String(value)` (e.g. `42` -> `"42"`, `false` -> `"false"`, `NaN` -> `"NaN"`);
   - anything else (object, array, symbol, function) -> `""`, and when `AvoInspector.shouldLog` is on, `console.warn("[Avo Inspector] Warning: streamId must be a string; ignoring a value of type <typeof>")`.
2. If the stored value contains `":"`, call `AvoLog.streamIdColon()`: `console.warn("[Avo Inspector] Warning: streamId contains ':' which is not supported")` whatever the logging flag, rate-limited to one line per 10 s under the key `streamid-colon`; the next line after a window adds ` (N more in the last Ss)` for the calls it suppressed, where S is the whole seconds since the window began (at least 1: `destroy()` and the exit print a pending count at once). The value is kept unchanged.

## Examples

<example>
20 track calls with stream ids `"user:0"` … `"user:19"` within 10 s → one warning. The next such call, 10 s after the first → `[Avo Inspector] Warning: streamId contains ':' which is not supported (19 more in the last 10s)`.
</example>

## Non-functional requirements

- **IMPORTANT:** The constructor never throws; `streamId` is always a string. An ignored value yields `""`, which callers treat as absent.
