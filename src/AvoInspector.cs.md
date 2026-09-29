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
- Collaborators: `AvoNetworkCallsHandler` (body building, HTTP send, sampling rate), `AvoBatchQueue` (buffer, size/time triggers, in-flight cap), `AvoDeduplicator`, `AvoSchemaParser`, `AvoStreamId`, `AvoEventSpecFetcher` / `AvoEventSpecCache` / `EventValidator`, utils (`isValueEmpty`, `normalizeOption`, `safeStringify`, header-character checks).
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

Module export `INTERNAL_ERROR_MESSAGE = "Avo Inspector: something went wrong. Please report to support@avo.app."`, marked `@internal` (stripped from the published typings, not re-exported from the package index); `AvoBatchQueue` logs it for a synchronous dispatch throw.

Internal state: event spec fetcher/cache/validator (null in prod); an empty generated anonymous id used when no stream id is given; the batch queue; a `destroyed` flag; the set of pending promises (spec validations before enqueue, and batch sends) that `flush()` awaits; per-validation `flushRequested` markers; waiters settled by `destroy()`.

Static state shared by all instances: the set of instances with work, whether the `beforeExit` listener is armed, and one exit deadline.

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
8. Batch options: each numeric option that is present but invalid (`batchSize`/`maxQueueSize` not a positive integer, `batchFlushSeconds` not finite and > 0) warns "Invalid <name> <value>. Using default <default>." and uses the default. `disableBatchTimer` is true only when exactly `true`. `batchSize` is 1 in dev. When `batchSize > maxQueueSize` it warns and keeps both values (a batch never fills; oldest events are dropped).
9. Creates the batch queue: dispatch is `sendBatch`, a discarded batch's outcome is `"failed"`, and every swapped-out batch is registered as pending as soon as it is swapped out.
10. Outside prod, creates the event spec fetcher, cache and validator.

### trackSchemaFromEvent(eventName, eventProperties, streamId?, options?) / _avoFunctionTrackSchemaFromEvent(eventName, eventProperties, eventId, eventHash, streamId?, options?)

Both delegate to one shared path (Codegen sets `fromAvoFunction`, `eventId`, `eventHash`).

1. After `destroy()`: resolves `[]` and does nothing.
2. Anonymous id: `streamId` normalized through `AvoStreamId`, else the generated anonymous id (empty).
3. Gateway options (`resolveTrackOptions`): each field is trimmed; a non-string or blank value is absent, and non-object `options` counts as none. The event is gateway-scoped when any field is present. `appVersion` is `originAppVersion` if present, else `null` when `originHint` is present, else the instance version. `outputReference` / `originHint` are included only when present.
4. Deduplication: a gateway-scoped event is always registered and never passed to the deduplicator. Otherwise `avoDeduplicator.shouldRegisterEvent(...)`; a duplicate logs "Deduplicated event" and resolves `[]`.
5. Extracts the schema (`extractSchema(props, false)`), then samples and enqueues (below).
6. A synchronous exception logs the internal error and rejects with `"Avo Inspector: something went wrong. Please report to support@avo.app."`.

### Sampling and enqueue

1. Reads the current sampling rate and stamps `createdAt` at call time. If `Math.random() > rate`, the event is dropped (logged) and the call resolves with the schema.
2. Body: validated body (`buildEventProperties` + `bodyForValidatedEventSchemaCall`) when a validation result exists, else `bodyForEventSchemaCall`; both receive the resolved track options. The body's `samplingRate` and `createdAt` are overwritten with the values captured at call time.
3. Validation inactive (prod, after destroy, or while a valid mock-endpoint override is in effect, i.e. `AvoNetworkCallsHandler.mockEndpointFor(env)` is non-null): the body is enqueued immediately. An invalid override value is ignored, so validation stays on.
4. Validation active: `fetchAndValidate` runs first. A rejection is logged as a warning and the event is sent without validation. If `destroy()` ran meanwhile, resolves `[]`. A body-building error logs the internal error and rejects with the internal error message. Otherwise the body is enqueued. The work (validation, plus any send the enqueue triggered) is pending until it settles.
5. `flush()` marks validations pending at its start; when such a validation enqueues without triggering a send, one drain is scheduled (`setImmediate`) and shared by every marked validation that settles in the same event-loop turn.
6. Resolution:
   - Batch size 1 (dev): the send happens within the call. Resolves `[]` when the outcome is `"non200"` or the instance was destroyed before the send settled; otherwise the schema (including after a transport failure).
   - Otherwise: resolves with the schema once queued; the HTTP outcome is not observable.

### sendBatch(batch)

- After destroy: `"failed"` without sending.
- `callInspectorWithBatchBody(batch)`: a numeric status other than 200 is `"non200"`; otherwise `"ok"` (logs "Saved event" per event when logging is on). A rejection is `"failed"`, logged as "schema sending failed" unless destroyed.
- **IMPORTANT:** at-most-once. A failed batch is dropped, never re-queued or retried.

### flush(timeoutMs = 10000): Promise<void>

1. Budget: `timeoutMs` when it is a finite number >= 0 (capped at the max timer delay), else 10000.
2. Destroyed: returns at once.
3. Snapshots the pending promises present at call time, marks pending validations as flush-requested, and drains the queue (adding that send).
4. Waits until all of those settle or the budget elapses (the budget timer does not hold the process open).
5. **IMPORTANT:** never rejects.

### Exit drain

- An instance is registered while it is not destroyed and has buffered events or pending work; a single `process.once("beforeExit")` listener is armed while any instance is registered and removed when none are (which also resets the exit deadline).
- On `beforeExit`: sets one 10 s deadline for the whole exit (first firing only); if time remains, holds the process with a timer for the remaining time, calls `flush(remaining)` on every registered instance, clears the timer when all settle, and re-arms for work added during the drain. Past the deadline it does nothing and the rest is dropped.
- Nothing else keeps the process alive; `process.exit()`, signals and serverless freezes need an explicit `flush()`.

### Event spec validation (fetchAndValidate)

- Returns null without fetching when validation is not set up (prod, or after `destroy()`).
- Cache key: `AvoEventSpecCache.makeKey(apiKey, anonymousId, eventName)`.
- Cache hit: validates against the cached response. Cache miss: fetches; a non-null response is cached and validated; a null response returns null.
- A response whose `eventSpec` is null returns null.
- Validation input: each schema entry, plus `propertyValue` (the raw value's `String()` form, or its `Object.prototype.toString` tag when conversion throws) when the raw value is defined. Validation id is `eventId`, else `eventName`.
- Result: `{ metadata, propertyResults }`.

### extractSchema(eventProperties, shouldLogIfEnabled = true)

Returns `AvoSchemaParser.extractSchema(eventProperties)` without tracking. When logging is on and `shouldLogIfEnabled`, warns if Codegen just reported the same properties. Logs input with `safeStringify`. Any exception is logged and returns `[]`.

### enableLogging(enable)

Sets the shared static logging flag.

### _setSamplingRateForTesting(rate)

Test-only: sets the network handler's sampling rate.

### destroy()

Terminates the instance: marks it destroyed; settles every track waiting on a spec fetch or immediate send (they resolve `[]`); discards buffered and waiting batches unsent; clears pending work and validation markers; unregisters from the exit drain; aborts in-flight requests; destroys the spec fetcher, flushes the spec cache, drops the validator. Does not flush. Later track calls resolve `[]` and send nothing.

## Non-functional requirements

- **IMPORTANT:** the SDK never keeps an idle process alive; only the exit drain holds it, for at most the 10 s exit deadline.
- Events are batched outside dev; the track promise means "queued", not "delivered". Events whose spec must be fetched join the queue later, so batch order is not call order; `createdAt` preserves call time.
- An instance with buffered or pending work is strongly referenced by static state until its work finishes or it is destroyed.
- Send failures never reject the track promise; only synchronous internal errors or body-building errors do. Validation failures degrade to an unvalidated send.
- Logging state is global across instances; constructing any instance resets it.
