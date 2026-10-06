# AvoEventSpecFetcher

Fetches the tracking-plan event spec for one event from the Avo API over HTTPS, collapses concurrent identical requests into one, and converts the compact wire format into the internal `EventSpecResponse` shape.

## Tech stack

- TypeScript, Node.js `https` and `http` (`request`, `Agent`, `ClientRequest`).
- Types from `./AvoEventSpecFetchTypes`; reads the static `AvoInspector.shouldLog` flag for diagnostics.

## Data

```ts
type FetchCallback = (result: EventSpecResponse | null) => void;
class AvoEventSpecFetcher {
  constructor(apiKey: string, mockEndpoint?: string | null);
  fetch(eventName: string, streamId: string, callback: FetchCallback): void;
  static parseWireResponse(wire: any, eventName: string): EventSpecResponse;
  destroy(): void;
}
```

- In-flight map: dedupe key `"<apiKey>:<streamId>:<eventName>"` -> `{ callbacks, owner }`: the waiting callbacks and an owner token identifying the request that serves the key.
- Target: `https://api.avo.app:443` by default. With a `mockEndpoint` (the valid `AVO_INSPECTOR_MOCK_ENDPOINT` override, as read by `AvoNetworkCallsHandler`), that URL's scheme, host and port (default 80/443); its path and query are not used.
- Per-fetch deadline: `private static fetchTimeoutMs = 10_000` (overridable in tests), counted from the moment the request is assigned a socket.
- Socket-wait deadline: `private static socketWaitTimeoutMs = 10_000` (overridable in tests), counted from the request until it is assigned a socket.
- Connection pool: **one module-level keep-alive `https.Agent` shared by every instance**, `maxSockets: 8`, `maxFreeSockets: 2` (and an `http.Agent` with the same settings for an `http:` mock endpoint). **IMPORTANT:** every request's socket is unref'd on each `socket` assignment (the keep-alive agent re-refs a socket it reuses), so a spec fetch never holds the process open by itself. At exit, a pending validation is awaited by the exit drain, within its deadline, like a track send.
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
2. Otherwise register `{ callbacks: [callback], owner }` with a fresh owner token, then send `GET <target>/trackingPlan/eventSpec?apiKey=&eventName=&streamId=` with `Accept: application/json` (over `http` for an `http:` mock endpoint, `https` otherwise), through the shared agent, and add the request to the instance's request set. Start the socket-wait timer (unref'd) at once. When the request is assigned a socket (and has not settled yet), replace it with the fetch's deadline timer (unref'd).
   **IMPORTANT:** everything after the key is registered runs inside one try: any synchronous throw (building the query or the debug line, `request()` itself, wiring the listeners) destroys the request if one was created and settles the key with `null` (callbacks deferred). Otherwise the key would stay registered with no request behind it, and every later fetch of it would wait forever. The debug line prints the event name as is, never `encodeURIComponent` (which throws for a lone surrogate).
3. On response end:
   - status != 200 -> settle with `null`.
   - status 200 -> `JSON.parse` the body and `parseWireResponse`; a parse/convert exception settles with `null`.
4. Request `error` -> settle with `null`. Request `close` -> settle with `null` (a no-op after any other settlement; it covers a request destroyed before it got a socket, which can close with no response and no error). A response that ends before its body is complete (`aborted`, `error` or `close` on the response while `res.complete` is false, with no `end`) -> settle with `null` at once, freeing the key, instead of waiting for the deadline.
5. **Deadline:** `fetchTimeoutMs` (10 s) after the request is assigned a socket (its `socket` event) -> destroy the request and settle with `null`. Time spent queued in the agent for a socket does not count, so a fetch queued behind 8 slow ones still gets its full budget once sent. No socket-idle timeout is set.
6. **Socket wait:** a request not assigned a socket within `socketWaitTimeoutMs` (10 s), for example behind 8 hung fetches holding the pool, is destroyed and settles with `null`, like a timeout, so the event is sent without validation. Separately, `AvoInspector` lets at most 1,000 events wait for a spec at once.
7. If `request()` throws synchronously, the fetch settles with `null`: the key is freed and the deadline cleared before `fetch` returns, and the callbacks receive `null` on the next tick (never before `fetch` returns); nothing is thrown to the caller.
8. **IMPORTANT:** a request settles at most once, and only while it still owns its key. Settling clears the deadline. If the key's in-flight entry has a different owner (a newer fetch registered after this request settled), the settlement is ignored.
9. Settling removes the key from the in-flight map first, then invokes every queued callback in registration order; an exception thrown by one callback is swallowed and does not stop the others.

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
- At most 8 concurrent spec requests per process to the API host (across all instances); further requests queue in the agent. Every fetch settles within about `socketWaitTimeoutMs` of being requested if it gets no socket, or within about `fetchTimeoutMs` of getting one.

## Examples

<example>
20 fetches for different events; the API never answers the first 8 and answers the rest at once → fetches 1–8 settle with `null` after 10 s; fetches 9–20 get sockets as those are freed and settle with their responses, not with `null` at the moment a deadline counted from the request would have expired.
</example>
<example>
A fetch for key K times out and settles with `null`; one of its callbacks fetches K again → the new request owns K. The timed-out request's later `error` is ignored, and the new fetch settles only from its own response.
</example>
