---
import:
  - src/AvoInspector.cs.md
---
# AvoStreamId

Holds the stream id a caller passes to a track call, defaulting to empty.

## Tech stack

- TypeScript, no dependencies.
- Reads `AvoInspector.shouldLog` to gate its type warning.

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
2. If the stored value contains `":"`, `console.warn("[Avo Inspector] Warning: streamId contains ':' which is not supported")` (always, regardless of logging settings). The value is kept unchanged.

## Non-functional requirements

- **IMPORTANT:** The constructor never throws; `streamId` is always a string. An ignored value yields `""`, which callers treat as absent.
