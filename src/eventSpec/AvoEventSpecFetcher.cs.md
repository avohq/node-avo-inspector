# AvoEventSpecFetcher

Fetches the tracking-plan event spec for one event from the Avo API over HTTPS, collapses concurrent identical requests into one, and converts the compact wire format into the internal `EventSpecResponse` shape.

## Tech stack

- TypeScript, Node.js `https` (`request`, `Agent`) and `http.ClientRequest`.
- Types from `./AvoEventSpecFetchTypes`; reads the static `AvoInspector.shouldLog` flag for diagnostics.

## Data

```ts
type FetchCallback = (result: EventSpecResponse | null) => void;
class AvoEventSpecFetcher {
  constructor(apiKey: string);
  fetch(eventName: string, streamId: string, callback: FetchCallback): void;
  static parseWireResponse(wire: any, eventName: string): EventSpecResponse;
  destroy(): void;
}
```

- In-flight map: dedupe key `"<apiKey>:<streamId>:<eventName>"` -> `{ callbacks, owner }`: the waiting callbacks and an owner token identifying the request that serves the key.
- Per-fetch deadline: `private static fetchTimeoutMs = 10_000` (overridable in tests), a wall-clock budget from the moment the fetch is requested.
- Connection pool: **one module-level keep-alive `https.Agent` shared by every instance**, `maxSockets: 8`, `maxFreeSockets: 2`. Idle sockets are unref'd and do not keep the process alive.
- Request set: each instance tracks its own open `ClientRequest`s; a request leaves the set on `close`.

Wire format (input) and internal format (output):

```
wire:     { events: [{ b, id, vids, p: { "<prop>": { t, r, v, rx: { "<pattern>": [...] } } } }],
            metadata: { schemaId, branchId, latestActionId, sourceId } }
internal: { eventSpec: { eventName, properties: [{ propertyName, propertyType, regex? }] } | null,
            metadata: { schemaId, branchId, latestActionId, sourceId } }
```

## Users and permissions

- Called by `AvoInspector` during event-spec validation; authenticated only by the `apiKey` query parameter.

## Functional requirements

### fetch

1. Build the dedupe key. If a request for that key is already in flight, append the callback and return (no new request).
2. Otherwise register `{ callbacks: [callback], owner }` with a fresh owner token, start the fetch's deadline timer (unref'd), then send `GET https://api.avo.app:443/trackingPlan/eventSpec?apiKey=&eventName=&streamId=` with `Accept: application/json`, through the shared agent, and add the request to the instance's request set. The deadline is created before the request because a response can settle synchronously.
3. On response end:
   - status != 200 -> settle with `null`.
   - status 200 -> `JSON.parse` the body and `parseWireResponse`; a parse/convert exception settles with `null`.
4. Request `error` -> settle with `null`.
5. **Deadline:** `fetchTimeoutMs` (10 s) after the fetch was requested, queue time for a socket included -> destroy the request (if one was created) and settle with `null`. This wall-clock deadline is the only timeout; no socket-idle timeout is set.
6. If `request()` throws synchronously, the fetch settles with `null` at once (the key is freed and the deadline cleared); nothing is thrown to the caller.
7. **IMPORTANT:** a request settles at most once, and only while it still owns its key. Settling clears the deadline. If the key's in-flight entry has a different owner (a newer fetch registered after this request settled), the settlement is ignored.
8. Settling removes the key from the in-flight map first, then invokes every queued callback in registration order; an exception thrown by one callback is swallowed and does not stop the others.

### parseWireResponse

1. `metadata` fields default to `""` when missing.
2. Missing, non-array or empty `events` -> `{ eventSpec: null, metadata }`.
3. Otherwise only `events[0]` is used. Each key of its `p` object becomes a property: `propertyType = t ?? "unknown"`; if `rx` is a non-empty object its **first key** becomes `regex`. Other constraint fields (`r`, `v`, ...) are ignored.
4. `eventSpec.eventName` is the requested `eventName`, not a value from the wire.

### destroy

- Snapshots and clears the instance's request set, then destroys each of those requests; they fail and resolve their callbacks with `null`.
- **IMPORTANT:** the shared agent is left intact, so other instances (and later instances) keep working.

## Non-functional requirements

- **IMPORTANT:** callbacks are always invoked asynchronously and with `null` on any failure; `fetch` never throws for network, status or parse problems.
- Logging (request URL without apiKey/streamId, status, raw body, parsed spec, errors) only when `AvoInspector.shouldLog` is true; non-200 bodies and the full response body are logged in that mode.
- A request that times out may also emit `error` afterwards (from `destroy`); that late event never settles a newer fetch of the same key.
- At most 8 concurrent spec requests per process to the API host (across all instances); further requests queue in the agent. Every fetch settles within about `fetchTimeoutMs` of being requested, however long it queued.

## Examples

<example>
20 fetches for different events against an API that never answers → requests 9–20 wait in the agent for a socket, yet every callback receives `null` about 10 s after its fetch was requested (not after about 30 s).
</example>
<example>
A fetch for key K times out and settles with `null`; one of its callbacks fetches K again → the new request owns K. The timed-out request's later `error` is ignored, and the new fetch settles only from its own response.
</example>
