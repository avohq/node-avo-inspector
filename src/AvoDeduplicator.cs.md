# AvoDeduplicator

Suppresses the second report of the same observation when both Codegen (Avo Functions) and a manual `trackSchemaFromEvent` call report the same event, with the same stream id and deeply equal properties, within 500 ms of each other in either order.

## Tech stack

- TypeScript, no runtime dependencies beyond `deepEquals` from `src/utils`.

## Data

- Dedup key: `streamId + "\0" + eventName` (stream id defaults to `""`), so the same event name on different streams never suppresses each other.
- Two independent registries, one per source (Codegen, manual). Each holds:
  - a registration log: an append-only array in time order, plus a `head` index of the first unexpired entry;
    ```ts
    interface Registration { time: number; key: string; generation: number }
    ```
  - a params map: `{ [key: string]: params }`, holding the params of the latest registration of each key;
  - a latest map: `{ [key: string]: number }`, holding the `generation` of each key's latest registration.
- `generation` is a per-instance counter, incremented on every registration.
- `msToConsiderOld = 500` (ms).
- **IMPORTANT:** registration times come from the shared monotonic clock `utils.monotonicNowMs` (milliseconds from `process.hrtime.bigint()`), never the wall clock, so a clock step (NTP, manual change) cannot stall or hasten expiry. The clock is an internal `now` field, replaceable in tests. Event `createdAt` timestamps are unaffected; they stay wall-clock.

<invariant>
Every registration gets its own log entry, including registrations of the same source in the same millisecond.
</invariant>

## Users and permissions

- Internal; called by `AvoInspector` on every plain track call and during schema extraction. No auth.

## Functional requirements

### `shouldRegisterEvent(eventName, params, fromAvoFunction, streamId = ""): boolean`

1. Expire old registrations (see Cleanup).
2. Append a registration `{ time: now(), key, generation }` (monotonic ms) for the caller's source, record `generation` as the key's latest, and store `params` as that key's params in the source's params map (overwriting any previous params for the key).
3. Look up the same key in the OTHER source's params map. It is a duplicate when params exist there and `deepEquals(params, otherParams)`. `deepEquals` treats params past the schema extraction limits (10 levels, 10,000 objects and lists) as not equal, so such a pair is never a duplicate.
4. On a duplicate, delete the key's params from BOTH params maps (a pair is consumed once).
5. Return `true` (send it) when no duplicate was found, `false` when it is a duplicate.

- Two calls from the same source are never deduplicated against each other.

### `hasSeenEventParams(params, checkInAvoFunctions): boolean`

- Returns `true` when any key in the chosen source's params map has params deeply equal to `params`, regardless of event name or stream. Does not expire entries and does not mutate state. Used only to log a duplicate-reporting warning.

### Cleanup

- On each `shouldRegisterEvent`, each source's log is popped from `head` while the head entry is more than 500 ms old. For each popped entry, the key's params and latest entry are deleted **only if** the popped `generation` is still the key's latest; an older registration's expiry never deletes params written by a newer one.
- Popping stops at the first unexpired entry; the log is in time order because the clock is monotonic.
- When `head > 1024` and more than half the log is expired, the log is compacted (sliced from `head`, `head` reset to 0).

### `_clearEvents()` (tests only)

- Resets both logs, both heads, both params maps and both latest maps.

## Non-functional requirements

- Cleanup cost is amortised O(1) per call; memory holds only the last ~500 ms of registrations plus at most one compaction's worth of expired slots.
- Pure in-memory; no I/O, no timers. Expiry happens only when `shouldRegisterEvent` runs.

## Examples

<example>
Codegen reports `Signup` `{plan: "pro"}` on stream `s1`; 100 ms later a manual call reports the same → manual call returns `false`; both params entries are removed.
</example>
<example>
Same pair but on streams `s1` and `s2` → both return `true`.
</example>
<example>
Manual call, then 600 ms later a Codegen call with equal params → both return `true` (the manual entry expired).
</example>
<example>
Manual `A` at t=0, manual `A` (new params) at t=400, Codegen `A` with the new params at t=600 → the t=0 expiry does not delete the t=400 params, so the Codegen call returns `false`.
</example>
