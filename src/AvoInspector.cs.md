---
import:
  - src/AvoBatchQueue.cs.md
  - src/AvoNetworkCallsHandler.cs.md
  - src/AvoDeduplicator.cs.md
  - src/AvoSchemaParser.cs.md
  - src/AvoStreamId.cs.md
  - src/AvoInspectorVersion.cs.md
  - src/eventSpec/AvoEventSpecFetcher.cs.md
  - src/utils.cs.md
---
# AvoInspector

## Short description

The public entry class of the Node Avo Inspector SDK. It validates configuration, extracts event schemas, deduplicates Codegen/manual reports, optionally validates events against their Avo event spec (dev/staging), and queues each event into a batch sent to the Inspector API, with `flush()`, `destroy()` and a best-effort flush at natural process exit.

## Tech stack

- TypeScript on Node.js.
- Collaborators: `AvoNetworkCallsHandler` (body building, HTTP send, sampling rate), `AvoBatchQueue` (buffer, size/time triggers, in-flight cap), `AvoDeduplicator`, `AvoSchemaParser`, `AvoStreamId`, `AvoEventSpecFetcher` / `AvoEventSpecCache` / `EventValidator`, utils (`isValueEmpty`, `normalizeOption`, header-character checks).
- The library version comes from `AvoInspectorVersion.VERSION`.

## Data

```ts
constructor(options: {
  apiKey: string;
  env: AvoInspectorEnvValueType; // "dev" | "staging" | "prod"
  version: string;
  appName?: string;
  publicEncryptionKey?: string;
  batchSize?: number;          // default 30; forced to 1 in dev
  batchFlushSeconds?: number;  // default 30
  maxQueueSize?: number;       // default 1000
  disableBatchTimer?: boolean; // default false
})

type SchemaEntry = { propertyName: string; propertyType: string; children?: any };

export interface TrackOptions {
  outputReference?: string;  // gateway output; absent = gateway checkpoint
  originHint?: string;       // low-cardinality source label
  originAppVersion?: string; // per-event app version override
}

type SendOutcome = "ok" | "non200" | "failed";
```

Public fields: `environment`, `apiKey`, `version`, `avoNetworkCallsHandler`, `avoDeduplicator`.

Static `AvoInspector.shouldLog` (getter/setter) is one flag shared by every instance.

Uses `INTERNAL_ERROR_MESSAGE` from `AvoLog` (the track rejection reason). It is **not** re-exported: `AvoLog` marks it `@internal`, so `stripInternal` removes it from `AvoLog.d.ts`, and a re-export would leave `AvoInspector.d.ts` importing a missing member and break the published typings for `skipLibCheck: false` users.

Internal state: event spec fetcher/cache/validator (null in prod); an empty generated anonymous id used when no stream id is given; the batch queue; a `destroyed` flag; the set of pending promises (spec validations before enqueue, and batch sends) that `flush()` awaits; per-validation `flushRequested` markers; waiters settled by `destroy()`.

Static state shared by all instances: the set of instances with work, whether the `beforeExit` listener is armed, one exit-drain deadline, when an event was last tracked (monotonic), and the deadlines of explicit `flush()` calls still running.

## Users and permissions

Called by application code (manual tracking) and by Avo Codegen (`_avoFunctionTrackSchemaFromEvent`). The API key authenticates every request; there are no other gates.

## Functional requirements

### Construction

1. `options` that is null or not an object throws the no-API-key error.
2. Environment: missing or blank-string `env` falls back to dev with warning "No environment provided. Defaulting to dev."; any other value outside `AvoInspectorEnv` (including non-strings) falls back to dev with an "Unsupported environment" warning.
3. `apiKey`: non-string or empty throws `"[Avo Inspector] No API key provided. Inspector can't operate without API key."`; containing CR, LF or NUL throws the "API key contains a control character..." error; any other header control character throws `"[Avo Inspector] apiKey must not contain control characters"`; a non-Latin-1 character throws `"[Avo Inspector] apiKey must only contain characters that can be sent in an HTTP header"`.
4. `version`: non-string or empty throws `"[Avo Inspector] No version provided. ..."`.
5. `publicEncryptionKey`, outside prod: warns when it is not hex or its length is not 66 or 130. The key is still used.
6. Logging is turned on in dev and off otherwise; this overwrites the shared static flag for every instance.
7. Builds the network handler (`appName` defaults to `""`) and the deduplicator.
8. Batch options: each numeric option that is present but invalid (`batchSize`/`maxQueueSize` not a positive integer, `batchFlushSeconds` not finite and > 0) warns "Invalid <name> <value>. Using default <default>." (the value formatted with `valueToString`, so a symbol or a null-prototype object cannot make the constructor throw) and uses the default. `disableBatchTimer` is true only when exactly `true`. `batchSize` is 1 in dev. When `batchSize > maxQueueSize` it warns and keeps both values (a batch never fills; oldest events are dropped).
9. Creates the batch queue: dispatch is `sendBatch`, a discarded batch's outcome is `"failed"`, and every swapped-out batch is registered as pending as soon as it is swapped out.
10. Outside prod, creates the event spec fetcher (with the network handler's `mockEndpoint`), cache and validator.

### trackSchemaFromEvent(eventName, eventProperties, streamId?, options?) / _avoFunctionTrackSchemaFromEvent(eventName, eventProperties, eventId, eventHash, streamId?, options?)

Both delegate to one shared path (Codegen sets `fromAvoFunction`, `eventId`, `eventHash`).

1. After `destroy()`: resolves `[]` and does nothing.
1a. **Missing event name:** an `eventName` that is `null`, `undefined`, not a string, empty or whitespace-only is replaced by `MISSING_EVENT_NAME` (`"Missing Event Name"`, from `AvoLog`), and `AvoLog.missingEventName()` reports it (always on, rate-limited). The event then goes through every step below like any other: deduplication, extraction, sampling, validation and batching. The call resolves its schema and never throws, in every env. A valid name is used unchanged, surrounding whitespace included.
2. Anonymous id: `streamId` normalized through `AvoStreamId`, else the generated anonymous id (empty).
3. Gateway options (`resolveTrackOptions`): each field is trimmed; a non-string or blank value is absent, and non-object `options` counts as none. The event is gateway-scoped when any field is present. `appVersion` is `originAppVersion` if present, else `null` when `originHint` is present, else the instance version. `outputReference` / `originHint` are included only when present.
4. Deduplication: a gateway-scoped event is always registered and never passed to the deduplicator. Otherwise `avoDeduplicator.shouldRegisterEvent(...)`; a duplicate logs "Deduplicated event" and resolves `[]`.
5. Extracts the schema (`extractSchema(props, false)`); when logging, prints `Supplied event <eventName> with schema <JSON of the schema>` (names, types and children, never values). Then samples and enqueues (below).
6. A synchronous exception is logged with `AvoLog.internal` (always on, rate-limited) and the call rejects with `"Avo Inspector: something went wrong. Please report to support@avo.app."`.

### Awaited track calls

- `trackSchemaFromEvent` and `_avoFunctionTrackSchemaFromEvent` return the track's promise wrapped in an `AwaitedTrackPromise` (a `Promise` subclass; `Symbol.species` is `Promise`, so derived promises are plain). Its first `then` call (made by `await`, `then`, `catch`, `finally` or `Promise.all`) starts, if the call has not settled yet, a ref'd timer of `AWAITED_TRACK_HOLD_MS` (30 s: a spec fetch's socket wait and fetch, 10 s each, then a dev send's 10 s), cleared when the call settles.
- **IMPORTANT:** a call still pending when the timer fires resolves then with its schema (the extracted schema, recorded by `track` in a `TrackCall`), so the script resumes; a later outcome of its work is ignored. Its event stays where it is (queued, waiting for a send slot, or being validated): the exit drain sends it, or the exit report counts it. Without this, a batch-size-1 send waiting behind the 4 send slots outlasts the hold, the process looks idle, and the exit drain ends it (exit code 0) with the `await` still pending.
- **IMPORTANT:** the SDK's sockets and timers are unref'd, so without this a script awaiting a track that waits on a spec fetch or its dev send looks idle: `beforeExit` fires mid-loop and the exit drain could end the process (exit code 0) before the loop resumes, or send events unvalidated / in partial batches while the script is still running. Any observer counts, so a fire-and-forget `track(...).catch(() => {})` is held like an awaited call; only a call whose promise nothing touches holds nothing, and the exit bounds for those tracks are unchanged.

### Sampling and enqueue

1. Reads the current sampling rate and stamps `createdAt` at call time. If `Math.random() > rate`, the event is dropped (logged) and the call resolves with the schema.
2. Body: validated body (`buildEventProperties` + `bodyForValidatedEventSchemaCall`) when a validation result exists, else `bodyForEventSchemaCall`; both receive the resolved track options and the stamp `{ createdAt, samplingRate }` captured at call time, which the body carries. The body is built from a deep copy of the extracted schema: the call resolves with the schema itself, and a caller who changes it must not change an event still waiting in the batch.
3. Validation inactive (prod, or after destroy): the body is enqueued immediately. A mock-endpoint override does not turn validation off: the spec fetcher is created with the network handler's `mockEndpoint`, so spec fetches go to the mock server too.
4. Validation active: `fetchAndValidate` runs first. A rejection is logged as a warning (when logging is on) that names only the error's type (`AvoLog.errorType`), never its message, and the event is sent without validation. An error thrown while validating rejects on both paths: on a cache hit directly, and on a cache miss the fetcher callback catches it and rejects (the fetcher swallows callback errors, so an uncaught throw there would leave the call pending forever). If `destroy()` ran meanwhile, resolves `[]`. Otherwise the body is built and enqueued; an error thrown while building, queueing or scheduling the flush-requested send is logged with `AvoLog.internal` and rejects with the internal error message, as on the unvalidated path. The work (validation, plus any send the enqueue triggered) is pending until it settles.
5. `flush()` marks validations pending at its start; when such a validation enqueues without triggering a send, one drain is scheduled (`setImmediate`) and shared by every marked validation that settles in the same event-loop turn. **IMPORTANT:** the validation's pending work then waits for `batchQueue.bufferedBatchOutcome()`, the batch that actually carries the event, not for that scheduled drain: a size trigger or the timer can swap the buffer out first, and `flush()` must still wait for that batch's send.
6. Resolution:
   - Batch size 1 (dev): the send happens within the call. Resolves `[]` when the outcome is `"non200"` or the instance was destroyed before the send settled; otherwise the schema (including after a transport failure).
   - Otherwise: resolves with the schema once queued; the HTTP outcome is not observable.
   - **Backpressure:** if, after queueing, `batchQueue.waitingLength >= BACKPRESSURE_WAITING_EVENTS` (1,000), the call resolves only once `batchQueue.whenBelowBackpressure()` resolves (a freed send slot brings the waiting count below 1,000), with the schema, or `[]` if `destroy()` ran first. The event is already queued either way, so waiting never drops it. An awaited loop therefore slows to the speed of the sends (as in 1.x, whose track waited for its own send); since each wait is bounded, this slows the backlog's growth but does not guarantee delivery (an endpoint slow or down for long can still fill the backlog, and drops are logged); a caller that does not await is unaffected, and the 10,000-event backlog cap with its drops stays the last resort. A wait lasts at most `BACKPRESSURE_MAX_WAIT_MS` (10 s, one request timeout), on a ref'd timer: a stalled awaited loop keeps the process alive, so it is never taken for the exit. Each overflow of the 10,000 cap releases every waiting call (the callers are evidently not awaiting), so calls that are not awaited hold fewer than one batch of waiters; an awaited loop is throttled again right after.

### sendBatch(batch)

- After destroy: `"failed"` without sending.
- `callInspectorWithBatchBody(batch)`: a numeric status other than 200 is `"non200"`, reported with `AvoLog.rejected(status)` unless destroyed; otherwise `"ok"` (logs "Saved event" per event when logging is on). A rejection is `"failed"`, reported with `AvoLog.failed(error)` unless destroyed; it prints the fixed transport reason or `Request failed (<type>)`, never an error's message. Both reports are always on and rate-limited; sends abandoned by `destroy()` are not reported.
- **IMPORTANT:** at-most-once. A failed batch is dropped, never re-queued or retried.

### flush(timeoutMs = 10000): Promise<boolean>

1. Budget: `timeoutMs` when it is a finite number >= 0 (capped at the max timer delay), else 10000.
2. Destroyed: resolves `true` at once (nothing is pending).
3. Snapshots the pending promises present at call time, marks pending validations as flush-requested, and drains the queue (adding that send).
4. Waits until all of those settle or the budget elapses (the budget timer does not hold the process open).
5. **IMPORTANT:** never rejects.
6. On return (every path): `AvoLog.flushPending(true)` prints the always-on counts whose 10 s window has expired; counts still inside their window stay pending.
7. **Result:** resolves `true` if, at that moment, the instance is destroyed or has nothing buffered, waiting for a send slot, or pending (no spec validation and no batch send in flight); otherwise `false` (the budget elapsed first, or work tracked during the flush is still pending). `flush(0)` starts the sends and resolves `true` only if nothing is pending afterwards. The exit drain uses the same body and ignores the result.

### Exit drain

- An instance is registered while it is not destroyed and has buffered events or pending work; a single `process.once("beforeExit")` listener is armed while any instance is registered and removed when none are (which also resets the exit deadline).
- Each public `flush(timeoutMs)` records its deadline (monotonic clock) while it runs. The drain's own flushes use the same body without recording one.
- On `beforeExit`: sets one 10 s deadline for the whole exit drain, from the monotonic clock. It starts a new deadline when there is none, or when the existing one has passed and an event was tracked (by any instance) after it passed: the process carried on from that exit. Otherwise it keeps the existing one, however long ago it passed: `beforeExit` re-firing with no track since, for example while the app's own `beforeExit` work keeps the loop alive, is the same exit, so its budget never restarts. **Validation grace:** spec-fetch sockets are unref'd, so `beforeExit` also fires while a script awaits a track whose spec is being fetched. If any instance with work has validations pending and this deadline's grace is unused, the drain sends nothing: it holds the process with a ref'd timer of `min(1 s, remaining)`, marks the grace used for this deadline, re-arms and returns. If the validations settle within the grace, before the deadline, with no spec fetch given up meanwhile (`AvoEventSpecFetcher.timeouts` unchanged), the deadline is cleared, as for any idle point that completed in time: an awaited script carries on and its batches stay whole. Otherwise the next `beforeExit` drains. Nothing waits unbounded.
- **Drain:** The drain's budget runs to the later of that deadline and the latest deadline of any explicit `flush()` still running, so an app's `flush(20000)` is not cut off at 10 s. If time remains, it holds the process with a timer for the remaining time, flushes every registered instance within it (each sends what is ready at once; events still being validated follow as they are validated; halfway through the budget every validation still pending is given up (`giveUpValidations`), so those events are sent unvalidated within the rest of it), clears the timer when all settle, and re-arms for work added during the drain. It clears the deadline only if every instance's flush completed before its budget ran out (`flushWithin` resolves whether its work won the race against the budget timer). **IMPORTANT:** decided by the race, never by reading the clock: under load a timer can fire while the monotonic clock still reads just short of the deadline, and a timed-out drain would then get another 10 s (an exit with hung endpoints overran to ~16.5 s). Past the deadline it does nothing and the rest is dropped.
- **Exit report:** while any instance has work, one `process.on("exit")` listener is armed (removed with the beforeExit listener). At the real exit (natural, including past the drain's deadline, or `process.exit()`) it sums over the instances with work: buffered + waiting-for-a-slot + still-validating events, printed as `AvoLog.dropped(n, "unsent at exit")`, and events in sends not yet completed, printed as `AvoLog.dropped(n, "unconfirmed at exit")`. It calls `AvoLog.enterExit()` first so the lines are written synchronously, prints only non-zero counts, then `AvoLog.flushPending()`. Destroyed instances are not counted (sends abandoned by `destroy()` are not logged). **IMPORTANT:** no signal handler is ever installed; signals do not emit `exit`, so they print nothing.
- Nothing else keeps the process alive; `process.exit()`, signals and serverless freezes need an explicit `flush()`.

### Event spec validation (fetchAndValidate)

- Returns null without fetching when validation is not set up (prod, or after `destroy()`).
- Cache key: `AvoEventSpecCache.makeKey(apiKey, anonymousId, eventName)`.
- Cache hit: validates against the cached response. Cache miss: fetches; a non-null response is cached and validated; a null response returns null. Every track sharing one fetch stores the same response object; the cache ignores a store of the value a key already holds, so such a burst counts as one cache operation and does not rotate unrelated entries out.
- **Waiting cap:** at most 1,000 events wait for a spec fetch at once, counted across every instance (the fetches share one 8-socket pool). A cache miss past the cap returns null at once (sent without validation; logged only when logging is on) instead of fetching. A waiting event frees its place when its fetch settles, when `fetch()` throws synchronously (the call then falls back to an unvalidated send), or when its instance is destroyed.
- A response whose `eventSpec` is null returns null.
- Validation input: each schema entry, plus `propertyValue` (the raw value's `String()` form, or its `Object.prototype.toString` tag when conversion throws) when the raw value is defined. Validation id is `eventId`, else `eventName`.
- Result: `{ metadata, propertyResults }`.

### extractSchema(eventProperties, shouldLogIfEnabled = true)

Returns `AvoSchemaParser.extractSchema(eventProperties)` without tracking. When logging is on and `shouldLogIfEnabled`, warns if Codegen just reported the same properties; the Codegen scan (O(recent Codegen entries)) runs only then, never on the tracking path. When logging, prints `extracting schema` and then the parsed schema's `propertyName: propertyType` pairs, never the input values. Any exception is logged with `AvoLog.internal` (always on, rate-limited) and returns `[]`.

### enableLogging(enable)

Sets the shared static logging flag.

### _setSamplingRateForTesting(rate)

Test-only: sets the network handler's sampling rate.

### destroy()

Terminates the instance: marks it destroyed; settles every track waiting on a spec fetch or immediate send (they resolve `[]`); discards buffered and waiting batches unsent; clears pending work and validation markers; unregisters from the exit drain; aborts in-flight requests; destroys the spec fetcher, flushes the spec cache, drops the validator, and prints every pending always-on count (`AvoLog.flushPending()`). Does not flush events. Later track calls resolve `[]` and send nothing.

## Non-functional requirements

- **IMPORTANT:** the SDK never keeps an idle process alive; only the exit drain holds it, for at most its 10 s deadline or the deadline of an explicit `flush()` still running, whichever is later. Other handles in the process can keep it running longer.
- Events are batched outside dev; the track promise means "queued" (or "dropped by sampling", which also resolves the schema and is never sent), not "delivered". Events whose spec must be fetched join the queue later, so batch order is not call order; `createdAt` preserves call time.
- An instance with buffered or pending work is strongly referenced by static state until its work finishes or it is destroyed.
- Send failures never reject the track promise; only synchronous internal errors or body-building errors do. Validation failures degrade to an unvalidated send.
- Logging state is global across instances; constructing any instance resets it.
- **IMPORTANT:** no log line contains a property value or the API key. Because the flag is global, a prod instance can log once any dev instance turns logging on, so logs show only event names, schema (property names and types), counts, statuses and error types (never a caught error's message). Event and property names are printed as given, so they must not carry personal data.
