---
import:
  - src/AvoInspectorVersion.cs.md
  - src/utils.cs.md
---
# AvoNetworkCallsHandler

Builds Inspector wire bodies for tracked events (optionally encrypting property values) and POSTs batches of them to the Avo Inspector track endpoint, adopting the sampling rate the server returns.

## Tech stack

- TypeScript, Node.js `https` and `http`, `zlib.gzip`.
- Depends on `AvoGuid` (message ids), `AvoEncryption` (encryption decision, list-type check, value encryption), `AvoInspector.shouldLog` (global logging flag), event-spec types `EventSpecMetadata` / `PropertyValidationResult`.
- `LIB_PLATFORM` (`"node"`) from `AvoInspectorVersion`; `hasHeaderControlChar` / `hasNonLatin1Char` from `utils`.

## Data

```ts
interface BaseBody {
  apiKey: string; appName: string; appVersion: string | null; libVersion: string;
  env: string; libPlatform: "node"; messageId: string;
  streamId: string;
  anonymousId: string; createdAt: string; samplingRate: number;
  publicEncryptionKey?: string;
}
// Per-event gateway fields, already normalized by the caller.
interface ResolvedTrackOptions {
  appVersion: string | null;
  outputReference?: string;
  originHint?: string;
  gatewayScoped: boolean; // true when at least one non-blank gateway option was supplied
}
type EventProperty = (EventPropertyEncrypted | EventPropertyPlain) & EventPropertyValidation;
// EventPropertyPlain:     { propertyName; propertyType; children? }
// EventPropertyEncrypted: EventPropertyPlain & { encryptedPropertyValue: string }
// EventPropertyValidation:{ failedEventIds?: string[]; passedEventIds?: string[] }
interface EventSchemaBody extends BaseBody {
  type: "event"; eventName: string; eventProperties: EventProperty[];
  avoFunction: boolean; eventId: string | null; eventHash: string | null;
  outputReference?: string; originHint?: string;
  eventSpecMetadata?: EventSpecMetadata;
}
type InspectorBody = EventSchemaBody;
```

Instance state: `apiKey`, `envName`, `appName`, `appVersion`, `libVersion`, optional `publicEncryptionKey` (all from the constructor), `mockEndpoint` (the override in effect, read once by the constructor), and `samplingRate` (starts at `1.0`, updated from server responses). Also a set of in-flight requests and a sticky `aborted` flag.

Process-wide state: a set of override warnings already printed (`warnedMockEndpoint`), so each prints once per process.

Endpoint: `https://api.avo.app/inspector/v2/track`, unless overridden (see `mockEndpointFor`). Constants: request timeout 10 000 ms, gzip threshold 1024 bytes.

## Functional requirements

### Constructor

`new AvoNetworkCallsHandler(apiKey, envName, appName, appVersion, libVersion, publicEncryptionKey?)` stores the values and sets `mockEndpoint = mockEndpointFor(envName)` (so an invalid value warns at construction); no I/O. The override is read only here: never per event or per send.

### static mockEndpointFor(envName): string | null

Test-only endpoint override, and the only place its value is checked.

1. **IMPORTANT: fail-closed** — `envName === "prod"` returns `null` before the variable is even read: no validation, no warning.
2. Unset or empty `AVO_INSPECTOR_MOCK_ENDPOINT` returns `null`.
3. A value that does not parse as a URL, or whose protocol is not `http:` or `https:`, returns `null` (the override is ignored) and prints, once per process per value, `[Avo Inspector] Ignoring invalid AVO_INSPECTOR_MOCK_ENDPOINT: <reason>` where the reason is `not a valid URL` or `unsupported protocol <protocol>`. **IMPORTANT:** the value itself is never printed (it may carry credentials or tokens); it is used only as the once-per-value key.
4. Otherwise returns the value.

The first send to a non-null `mockEndpoint` prints, once per process, `[Avo Inspector] AVO_INSPECTOR_MOCK_ENDPOINT is set: sending to <protocol>//<host> instead of api.avo.app (ignored in prod).` — scheme, host and port only, never the path, the query or the API key.

Both warnings use `console.warn` (stderr) whatever `AvoInspector.shouldLog` says. Callers therefore only ever see a valid URL or `null`. `AvoInspector` passes `mockEndpoint` to its event spec fetcher, so spec fetches go to the same mock server; validation stays on either way.

### getSamplingRate(): number / _setSamplingRateForTesting(rate)

Return / overwrite (unvalidated, test-only) the current sampling rate. Sampling decisions are made by the caller, per event, using this value.

### abortInFlight(): void

Sets the sticky `aborted` flag, empties the in-flight set and destroys each request. Every later send (including one still being compressed) rejects with `"Request failed"` without opening a request. Destroyed requests settle their promises via the error/truncation/timeout paths.

### callInspectorWithBatchBody(inEvents): Promise<number | void>

1. Drop `null`/`undefined` entries. If none remain, resolve immediately (with `undefined`) without sending.
2. No sampling is applied here.
3. When logging, print each event's name, a ` (validated)` marker when it has `eventSpecMetadata`, and its `propertyName: propertyType` pairs.
4. Serialize `events` to UTF-8 JSON. If it is ≥ 1024 bytes, gzip it asynchronously; on a gzip error send the uncompressed bytes instead.
5. If `aborted`, reject with `"Request failed"`.
6. Headers: `api-key: apiKey`, `env: envName`, `X-Avo-Client: "node"`, `Accept: application/json`, `Content-Type: application/json`, `Content-Length`, and `Content-Encoding: gzip` when compressed. If any string header value contains a control character (other than tab) or a character above U+00FF, log (when logging) and reject with `"Request failed"` without sending.
7. POST to `mockEndpoint` (printing the one-time redirect warning) or, when that is `null`, the default endpoint, using `http` for an `http:` URL and `https` otherwise. The request is tracked in the in-flight set and its socket is unref'd.
8. On response end:
   - status 200: parse the body as JSON; if it is non-null and `samplingRate` is a number in `[0, 1]`, adopt it. A parse failure is logged (when logging) and ignored.
   - any other status: logged (when logging).
   - Resolve with the HTTP status code in both cases (non-200 is not an error).
9. A response that is aborted, errors or closes before its body is complete: its status already arrived and decides, as for an unparseable body. Log it (when logging), leave the sampling rate unchanged, and resolve with the status code, so a cut-off 200 counts as delivered and any other status as a non-200 (as in Java and Go).
10. On request `error`: reject with the string `"Request failed"`. If creating the request throws synchronously (for example invalid request options), reject with `"Request failed"` too; nothing was started, so no request is tracked. The only rejection reasons are `"Request failed"` and `"Request timed out"`.
11. Wall-clock timeout of 10 s for the whole request (unref'd timer): reject with `"Request timed out"` and destroy the request.

**IMPORTANT:** a batch is sent at most once; this method never retries. The promise settles exactly once; later events are ignored (and not logged), and settling clears the timer and removes the request from the in-flight set.

### bodyForEventSchemaCall(anonymousId, eventName, eventProperties, eventId, eventHash, rawEventProperties?, trackOptions?, stamp?): EventSchemaBody

Base body (see below) plus `type: "event"`, `eventName`, and `eventProperties` — encrypted via `encryptProperties` when `AvoEncryption.shouldEncrypt(envName, publicEncryptionKey)` and `rawEventProperties` is given, otherwise passed through. Avo-function fields (`applyAvoFunctionFields`, shared by both builders): if `eventId != null` then `avoFunction: true, eventId, eventHash`; else `avoFunction: false, eventId: null, eventHash: null`.

### buildEventProperties(eventProperties, rawEventProperties?): EventProperty[]

Same encryption decision as above, returning just the property list.

### bodyForValidatedEventSchemaCall(anonymousId, eventName, eventProperties, eventId, eventHash, eventSpecMetadata, propertyResults, trackOptions?, stamp?): EventSchemaBody

1. Index `propertyResults` by `propertyName` (last one wins).
2. For each property with a result, copy it and attach `failedEventIds` / `passedEventIds` only when the respective array is non-empty; properties without a result pass through unchanged.
3. Base body plus `type: "event"`, `eventName`, merged `eventProperties`, `eventSpecMetadata`, and the same Avo-function fields as above. Properties are not encrypted here (callers pass already-built properties).

### encryptProperties (private)

For each property:
- list-typed (`AvoEncryption.isListType`) → omitted entirely;
- value = `JSON.stringify(raw[propertyName]) ?? "null"`; a value that cannot be serialized (e.g. cyclic, or a throwing `toJSON`/getter) → property omitted with an unconditional `console.warn` naming the property and only the error's type (`AvoLog.errorType`), never its message, which may contain the value;
- encrypted with `publicEncryptionKey`;
- encryption returns `null` → property omitted (the encryption module logs);
- otherwise emit `{ propertyName, propertyType, encryptedPropertyValue, children? }` (`children` only when defined).

### createBaseCallBody (private)

`{ apiKey, appName, appVersion, libVersion, env: envName, libPlatform: "node", messageId: new GUID, streamId: anonymousId, anonymousId, createdAt, samplingRate }` (from the optional `stamp: { createdAt, samplingRate }` the body builders pass through; `AvoInspector` passes the call time and the rate that decided sampling, otherwise now and the current rate), plus `publicEncryptionKey` when it is non-empty.

With `trackOptions`: `appVersion` is taken from `trackOptions.appVersion` (may be `null`) instead of the constructor value; `outputReference` / `originHint` are added only when defined — never sent as `null` or `""`.

## Non-functional requirements

- The `[network] POST` debug line prints the default endpoint's origin and path, but only the origin of a mock-endpoint override (its path may carry a token).
- Logging is gated on the global `AvoInspector.shouldLog`, except the two override warnings of `mockEndpointFor` (always printed, once each, on stderr) and the unconditional warning for an unserializable encrypted value.
- An in-flight request does not keep the process alive (socket and timer are unref'd); sending at exit relies on the caller's `beforeExit` drain.
- Sampling rate is per-instance, mutable, and is only changed by a valid 200 response (or the test hook).
- Compression runs off the event loop.
- `abortInFlight` is terminal for the instance.

## Examples

<example>
`AVO_INSPECTOR_MOCK_ENDPOINT=http://127.0.0.1:9876/path?token=x`, env `dev`, 5 sends → all 5 go to that URL; one warning: `... sending to http://127.0.0.1:9876 instead of api.avo.app (ignored in prod).`
</example>
<example>
`AVO_INSPECTOR_MOCK_ENDPOINT=ftp://x`, env `dev` → `[Avo Inspector] Ignoring invalid AVO_INSPECTOR_MOCK_ENDPOINT: unsupported protocol ftp:` once (the value is not printed); sends go to `https://api.avo.app/inspector/v2/track`.
</example>
<example>
Any value, env `prod` → `mockEndpointFor` returns `null` with no warning; sends go to the default endpoint.
</example>
