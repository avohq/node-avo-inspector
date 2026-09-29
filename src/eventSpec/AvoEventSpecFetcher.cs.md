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

- In-flight map: dedupe key `"<apiKey>:<streamId>:<eventName>"` -> list of waiting callbacks.
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
2. Otherwise register `[callback]` and send `GET https://api.avo.app:443/trackingPlan/eventSpec?apiKey=&eventName=&streamId=` with `Accept: application/json`, through the shared agent, and add the request to the instance's request set.
3. On response end:
   - status != 200 -> resolve all callbacks with `null`.
   - status 200 -> `JSON.parse` the body and `parseWireResponse`; a parse/convert exception resolves with `null`.
4. Request `error` -> resolve with `null`.
5. **10 s socket timeout** -> destroy the request and resolve with `null`.
6. Resolving removes the key from the in-flight map first, then invokes every queued callback in registration order; an exception thrown by one callback is swallowed and does not stop the others.

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
- A request that times out may also emit `error` afterwards; the second resolve for the key is a no-op unless a new fetch for the same key has been registered meanwhile.
- At most 8 concurrent spec requests per process to the API host (across all instances); further requests queue in the agent, and their 10 s timeout starts only once they obtain a socket.
