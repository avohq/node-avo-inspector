# Changelog

## 2.0.1

Fixes for inputs that JavaScript callers pass. All of these behaved the same way in 1.x.

- **Null-prototype objects no longer wipe the schema.** A null-prototype object anywhere in the event properties (for example `querystring.parse()` output), or an object with its own `hasOwnProperty` key, made schema extraction fail: the event was sent with an empty schema and a stack trace was printed. These objects are now extracted exactly like plain objects, and deduplication, event spec validation and encryption handle them too.
- **A non-string `streamId` no longer rejects.** A number, bigint or boolean (a numeric user id, say) is sent as its string form. Any other non-string is treated as absent, with a warning when logging is on. Before, the track promise rejected, and a call without `.catch()` crashed the process with an unhandled rejection.
- **A non-string `env` falls back to `dev`** with a warning instead of throwing `value.trim is not a function`.
- **Non-whole numbers in exponent form are `float`.** `1e-7` and `5e-324` were classified `int`. A number is now `int` when it is a whole number and `float` otherwise; `NaN` and `±Infinity` are `float`.
- **Invalid constructor arguments throw the documented messages.** A non-string `apiKey`, missing options (`new AvoInspector()`) or `null` options throw "[Avo Inspector] No API key provided…", and a non-string `version` throws "[Avo Inspector] No version provided…", instead of a `TypeError`.
- The two newer API key errors now start with `[Avo Inspector] `, like the other constructor errors. Their wording is unchanged.
- `package.json` now declares `"types"` and `"engines": { "node": ">=14" }`.

Robustness under load:

- **At most 4 batches are sent at once.** Before, every batch was sent immediately, so a fast producer or a slow or unresponsive endpoint could open thousands of requests at once and use gigabytes of memory. Further batches now wait their turn. Events waiting to be sent count toward `maxQueueSize`, so when the endpoint cannot keep up the oldest events are dropped, and the drop is logged, instead of memory growing without bound. `flush()` waits for waiting batches, and `destroy()` discards them.
- **Exiting naturally takes at most about 10 seconds.** A request in flight used to delay the exit-time send until it finished or timed out, and the rest of the buffer then got its own 10 seconds, so exit could take 20 seconds against an unresponsive endpoint. In-flight requests no longer hold the process open, and at exit everything left is sent at once under a single 10-second deadline.
- **Lower CPU cost per event.** The Codegen/manual deduplicator's cleanup no longer scans every recent timestamp on each call, which took most of the CPU time under load. As a side effect, a registration that shared its millisecond with another now expires after 500 ms like any other.
- **Fewer requests from `flush()` during event spec validation.** Events whose validations finish together are sent as one batch instead of one request per event.
- **One shared connection pool for event spec fetches.** Every instance now reuses one keep-alive agent with a small socket limit, so creating instances without destroying them no longer leaves idle connections behind.

## 2.0.0

Implements [avohq/spec-first-inspector-server-sdk](https://github.com/avohq/spec-first-inspector-server-sdk) v3.0.1: the `/inspector/v2/track` endpoint, batching with `flush()` and `destroy()`, gzip, and gateway options. This is a breaking release; see [Upgrading from 1.x to 2.0](README.md#upgrading-from-1x-to-20) in the README.
