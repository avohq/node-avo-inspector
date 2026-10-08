# Avo Inspector SDK for Node.js

[![npm version](https://badge.fury.io/js/node-avo-inspector.svg)](https://badge.fury.io/js/node-avo-inspector)

This is a quick start guide. For more information about the Inspector project please read the [Inspector SDK Reference](https://www.avo.app/docs/implementation/avo-inspector-sdk-reference) and the [Inspector Setup Guide](https://www.avo.app/docs/implementation/setup-inspector-sdk).

Implements [avohq/spec-first-inspector-server-sdk](https://github.com/avohq/spec-first-inspector-server-sdk) v3.0.1 (exported as `SPEC_VERSION`).

# Installation

The library is distributed with npm, install with npm:
```
    npm i node-avo-inspector
```

or yarn:
```
    yarn add node-avo-inspector
```

# Initialization

Obtain the API key from the Inspector tab (Inspector > Manage Sources) in your [Avo workspace](https://www.avo.app/welcome)

```javascript
import * as Inspector from "node-avo-inspector";

let inspector = new Inspector.AvoInspector({
  apiKey: "your api key",
  env: Inspector.AvoInspectorEnv.Dev,
  version: "1.0.0",
  appName: "My app",
});
```

Then report each event where you track it:

```javascript
inspector.trackSchemaFromEvent("Purchase", { amount: 42 });
```

With a gateway-scoped API key, always pass `originHint` and `originAppVersion`. Pass `outputReference` when the payload was bound for a specific output; leave it out for an observation at the gateway checkpoint. They go in the options object, the fourth argument (see [Gateway options](#gateway-options)):

```javascript
inspector.trackSchemaFromEvent("Purchase", { amount: 42 }, undefined, {
  outputReference: "meta-x7k2q",
  originHint: "android",
  originAppVersion: "4.2.0",
});
```

## Batching options

Events are buffered in memory and sent in batches. All options are optional:

| Option | Default | Meaning |
|---|---|---|
| `batchSize` | `30` | Send when this many events are buffered. Always `1` in `dev`, so every event is sent on its own as soon as it is queued. |
| `batchFlushSeconds` | `30` | Send once the oldest buffered event is this many seconds old. |
| `maxQueueSize` | `1000` | Maximum events buffered before a batch is formed; the oldest are dropped first when it is exceeded, and the drop is logged. Batches already formed and waiting to be sent have their own limit (see [High-volume and backfill scripts](#high-volume-and-backfill-scripts)). |
| `disableBatchTimer` | `false` | Start no background flush timer. Set it to `true` in serverless functions. |

```javascript
let inspector = new Inspector.AvoInspector({
  apiKey: "your api key",
  env: Inspector.AvoInspectorEnv.Prod,
  version: "1.0.0",
  appName: "My app",
  batchSize: 50,
  batchFlushSeconds: 10,
});
```

While an instance has events that are buffered or still being sent, the SDK keeps a reference to it so they can be sent when the process ends. Such an instance is not garbage-collected until its events are sent or it is destroyed, even if your code has dropped it. With `disableBatchTimer: true` and no `flush()`, buffered events leave only on a size trigger or at exit, so the instance and its buffer stay in memory until then. Call `flush()` or `destroy()` when you are done with an instance.

### High-volume and backfill scripts

At most 4 requests are sent at once. Batches formed while all 4 are busy wait their turn, and up to 10,000 events can wait. Beyond that the oldest waiting events are dropped and the drop is logged, so the number of events held for sending stays bounded when the endpoint is slow or down.

A loop that awaits each track, such as a backfill script doing `for (...) await inspector.trackSchemaFromEvent(...)`, is slowed down to the speed of the sends, as in 1.x: once 1,000 events are waiting for a send slot, the promise of the next track call resolves only when fewer than 1,000 wait (the event itself is already queued). Each such call waits at most about one request timeout (10 seconds), so against an endpoint that is slower than that for long, the backlog can still fill and the oldest waiting events are dropped (the drop is logged): backpressure slows the backlog's growth but doesn't guarantee delivery. Calls you don't await are not slowed down, so a loop that tracks without awaiting can still fill the 10,000-event backlog and drop the oldest waiting events.

At the end, flush until the instance reports drained. Each `flush()` waits at most `timeoutMs` (10 seconds by default) and resolves `true` once nothing is buffered, waiting or in flight, or `false` if the timeout passed first. Bound the attempts: each one shrinks the backlog, but against a hung endpoint draining can take minutes (up to about 1,000 waiting events, in batches of 30 sent 4 at a time, each giving up after 10 seconds), and tracking from elsewhere in the process can keep it from ever reporting drained.

```javascript
for (const row of rows) {
  await inspector.trackSchemaFromEvent(row.event, row.properties);
}

let drained = false;
for (let attempt = 0; attempt < 6 && !drained; attempt++) {
  drained = await inspector.flush();
}
if (!drained) {
  console.error("Backfill: Avo Inspector did not drain; some events may not have been sent.");
}
```

# Flushing before exit (required)

Buffered events live in memory only and are lost if the process exits first. Delivery is at-most-once: a batch that fails to send is dropped, never retried.

When a process ends because it has nothing left to do, the SDK sends what is still buffered on its own: it listens for Node's `beforeExit` event and flushes, holding the process for at most 10 seconds for this drain (or until the deadline of a `flush(timeoutMs)` you started that is still running, if later). The deadline bounds the SDK's own drain, not the process: other work in your process can keep it running longer. While you await a `trackSchemaFromEvent` call that is waiting on its event spec (in `dev` and `staging`) or, in `dev`, on its send, the SDK keeps the process alive until that call settles, so an awaited loop is not mistaken for the end of the process. That wait is at most 30 seconds per call (a spec fetch can take up to 20 seconds when it first waits for a connection, then a `dev` send up to 10). A call still pending after 30 seconds, for example a send with batch size 1 still waiting for one of the 4 send slots, resolves with its schema so your script carries on; its event stays queued and goes out with the exit drain, or is reported as unsent at exit. If your script then ends, the exit drain described here can add up to 10 seconds more, so a script ending on such a call against unresponsive endpoints can take about 40 seconds to exit. This applies to any call whose promise is observed (`await`, `.then`, `.catch`, `.finally`, `Promise.all`, ...), so a fire-and-forget `inspector.trackSchemaFromEvent(...).catch(() => {})` in `dev` or `staging` holds the process within the same bounds. Only a call whose promise nothing touches holds nothing. Two short waits can come before the drain: if tracks you didn't await are still waiting on a full send backlog (see [High-volume and backfill scripts](#high-volume-and-backfill-scripts)), the drain starts once they are released, within 10 seconds; and if events are still waiting for their event spec, the SDK first gives them up to 1 second. Events whose spec still hasn't arrived halfway through the drain are sent without validation. Events that could not be sent in time are reported on stderr when the process exits. This is a best-effort safety net, not a guarantee. The SDK never keeps an idle process alive, and `beforeExit` does **not** fire when:

- the process calls `process.exit()`;
- the process is stopped by a signal such as `SIGTERM` or `SIGINT` (container shutdown, Ctrl-C);
- a serverless platform freezes or reclaims the function after the handler returns.

So call `flush()` yourself in those cases:

- Call `await inspector.flush()` before `process.exit()`, in your `SIGTERM`/`SIGINT` handlers, and before a serverless handler (AWS Lambda, Google Cloud Functions, Vercel, ...) returns. It sends everything buffered, waits for in-flight requests (up to `timeoutMs`, default 10000) and never rejects. It resolves once those send attempts finish, whether or not they succeeded: a batch that fails is dropped, not retried. It resolves `true` if the instance then has nothing buffered, waiting or in flight, and `false` if the timeout passed first (`flush(0)` starts the sends and reports whether anything is still pending). After `destroy()` it resolves `true`.
- In serverless functions, also pass `disableBatchTimer: true`.

```javascript
export const handler = async (event) => {
  await inspector.trackSchemaFromEvent("Order Placed", { amount: 42 });
  await inspector.flush();
};

process.on("SIGTERM", async () => {
  await inspector.flush();
  process.exit(0);
});
```

`destroy()` is different: it discards buffered events without sending them, abandons in-flight requests and stops the timer. After `destroy()`, `trackSchemaFromEvent` resolves `[]` and sends nothing; a call still waiting on its send or on an event spec fetch when `destroy()` runs also resolves `[]`.

# Integrating with Avo Codegen

The setup is lightweight and is covered [in this guide](https://www.avo.app/docs/implementation/start-using-inspector-with-avo-functions).

Every event sent with your Codegen after this integration will automatically be sent to Inspector.

## Deduplication with Codegen

If you also call `trackSchemaFromEvent` for events that Codegen already reports, the SDK drops the second report of the same observation. A Codegen call and a manual call are treated as duplicates when they have the same event name, the same stream id and deeply equal properties, and arrive within 500 ms of each other in either order. The duplicate call sends nothing and resolves `[]`. Two manual calls, or two Codegen calls, are never deduplicated against each other. The comparison stops at the [schema extraction limits](#schema-extraction-limits): properties nested more than 10 levels deep, with more than 10,000 objects and lists, or with more than 10,000 properties to compare (counting nested ones), are treated as different, so both calls are sent. The exception is a Codegen call and a manual call that pass the very same properties object: the same reference always compares equal, before any limit applies.

Calls that carry [gateway options](#gateway-options) are never deduplicated: each gateway output is a distinct observation. They still go through sampling and batching like any other event.

# Sending event schemas for events reported outside of Codegen

Whenever you send tracking event call the following methods:

Read more in the [Avo documentation](https://www.avo.app/docs/implementation/devs-101#inspecting-events)

This method gets actual tracking event parameters, extracts schema automatically and sends it to the Inspector backend.
It is the easiest way to use the library, just call this method at the same place you call your analytics tools' track methods with the same parameters.

```javascript
inspector.trackSchemaFromEvent("Event name", {
  "String Prop": "Prop Value",
  "Float Prop": 1.0,
  "Boolean Prop": true,
});
```

`trackSchemaFromEvent` returns a promise that resolves with the extracted schema once the event has been through sampling: when the event is queued, or at once when sampling drops it (a dropped event is never queued, so `flush()` does not send it either). In `dev` a queued event is sent within the call, and the promise resolves `[]` if the Inspector API answers with a non-200 status. Only a non-200 does: if the request fails (connection refused, timeout) the promise still resolves the schema, and the failure is logged on stderr, so don't treat a resolved schema as proof of delivery. When 1,000 events are already waiting for a send slot, the promise resolves once fewer wait (see [High-volume and backfill scripts](#high-volume-and-backfill-scripts)). You can pass an optional stream id as the third argument to correlate events.

## Schema extraction limits

Schema extraction runs on your thread, inside `trackSchemaFromEvent`. Without limits, a payload such as an ORM object or a full API response could make that work unbounded, so extraction stops expanding a value:

- more than 10 levels deep, where each step into an object or into a list element counts as one level;
- that contains itself (a cycle);
- once 10,000 objects and lists have been expanded in one call (the event properties object, every list and every piece of binary data count).

A property cut off this way is reported as `"object"` with empty `children`; a list element cut off this way is reported as the type string `"object"`. Strings, numbers and booleans never count toward the limits, whatever their size.

At most 10,000 properties are reported per call, counting nested ones; past that the remaining properties are left out, in the order the object lists them.

A list's `children` hold each distinct element schema once, in the order they first appear: `[{ a: 1, b: "x" }, { b: "y", a: 2 }, { a: 3 }]` has two children, `[{a: int, b: string}]` and `[{a: int}]`, because objects with the same property names and types are equal whatever their property order. Every element still counts toward the limits above.

Binary data is never walked byte by byte: a `Float32Array` or `Float64Array` is reported as `list(float)` with children `["float"]`, any other typed array, `Buffer` or `DataView` as `list(int)` with children `["int"]`, and an `ArrayBuffer` as `"object"` with empty `children`, whatever their size. Each one still counts as one value toward the limits above, like an object or a list: past them it is cut off and reported as `"object"`, as the Java and Go SDKs do.

For example, an object that refers to itself:

```javascript
const order = { id: 7 };
order.self = order;
inspector.extractSchema({ order });
// [{ propertyName: "order", propertyType: "object", children: [
//   { propertyName: "id", propertyType: "int" },
//   { propertyName: "self", propertyType: "object", children: [] } ] }]
```

## Event order

Each event carries its own `createdAt`, stamped when `trackSchemaFromEvent` is called. Events in a batch are not guaranteed to be in call order: in `dev` and `staging`, an event whose spec must first be fetched for validation joins the queue when the fetch completes, so it can be sent after events tracked later. Use `createdAt` if you need the call order.

At most 1,000 events wait for an event spec fetch at once, across every instance in the process. When that many are already waiting (for example when the Avo API is slow), further events are sent at once without validation instead of waiting. A spec fetch that gets no connection within 10 seconds, or no answer within 10 seconds of getting one, is abandoned, and its event is sent without validation, so an event waits for its spec for about 20 seconds at most.

## Gateway options

When you use a gateway-scoped Inspector API key, pass the gateway coordinates in an optional options object as the fourth argument (JavaScript has no named arguments, so the three are grouped in one object):

```javascript
inspector.trackSchemaFromEvent(
  "Purchase",
  { amount: 42 },
  undefined, // streamId
  {
    outputReference: "meta-x7k2q", // the gateway output this event was bound for; omit for the gateway checkpoint
    originHint: "android",         // which source the event came from
    originAppVersion: "4.2.0",     // that source's app version
  }
);
```

- `originHint` must be a low-cardinality label such as `"web"`, `"ios"` or `"android"`, never a user id or any other high-cardinality value.
- Values are trimmed; blank or non-string values are ignored.
- Any other key in the options object (a typo such as `outputRef`) is ignored and prints a warning on stderr naming the key, whatever the logging flag, at most once per 10 seconds. Only key names are printed, never values. The event is still sent, with the options that were recognised.
- `originAppVersion` replaces the constructor `version` for that event. If you pass `originHint` without `originAppVersion`, the event is sent without an app version (`null`), because the constructor version belongs to a different source.

# Enabling logs

Logs are enabled by default in the dev mode and disabled in prod mode. You can enable and disable logs by calling the `enableLogging` method:

```javascript
inspector.enableLogging(true | false);
```

The logging flag is shared by every instance in the process, and each constructor resets it, so creating a `dev` instance turns logging on for a `prod` instance too. Log lines never contain property values or the API key. They do show event names and the extracted schema (property names and types), so do not put personal data such as emails in event or property names.

Some lines are printed whatever the logging flag, on stderr, because they report lost data or failed sends:

- `Avo Inspector: dropped N event(s) (queue full) in the last Ns.` or `(send backlog full)`: events dropped because the buffer (`maxQueueSize`) or the 10,000-event send backlog is full; `(internal error)`: events in a batch whose send failed with an internal error (logged with the internal-error line below); `(unsent at exit)`: events never sent when the process exited (naturally, past the 10-second exit drain, or through `process.exit()`): still buffered, waiting for a send slot, or still being validated; `(unconfirmed at exit)`: events in sends that had not completed when the process exited, which may or may not have arrived. A process stopped by a signal without a handler prints nothing, so call `flush()` in your signal handlers;
- `Avo Inspector: N event(s) tracked without an event name in the last Ns, sent as "Missing Event Name".`: track calls whose event name is `null`, `undefined`, not a string, empty or whitespace-only. The event is still sent, under the name `"Missing Event Name"`, and the call resolves its schema as usual;
- `Avo Inspector: N batch(es) rejected with HTTP <status> in the last Ns.`: the Inspector API answered with a status other than 200 (only the status is printed);
- `Avo Inspector: schema sending failed: Request failed.` or `Request timed out.`: a batch could not be sent;
- `Avo Inspector: something went wrong. Please report to support@avo.app. (<error type>)`: an internal error. Only the error's type (for example `TypeError`) is printed, never its message, which could contain a property value.

Each kind prints at most one line per 10 seconds (per reason or status): the first occurrence prints at once, and later ones are counted, then reported with the next occurrence after the 10 seconds, by `flush()` once the 10 seconds have passed, or at once by `destroy()` and when the process exits (naturally or through `process.exit()`). So a burst is always reported, even if it never recurs. Idle moments of a script whose only pending work is the SDK's, such as the pause after each awaited `flush()` in a loop, are not exits: they print only counts whose 10 seconds have passed. "in the last Ns" is the real time the count covers, in whole seconds (for example `(12 more in the last 37s)`); a line about a single occurrence says `1s`. Sends abandoned by `destroy()` and events dropped by sampling are not reported.

# Upgrading from 1.x to 2.0

2.0 implements spec 3.0.1. These are the changes you may notice:

- **The promise resolves when the event is queued (or dropped by sampling), not when it is delivered.** Outside `dev`, events are batched (see [Batching options](#batching-options)), so `await inspector.trackSchemaFromEvent(...)` no longer means the event reached Avo. In `dev` each event is still sent within the call.
- **The SDK no longer keeps your process alive.** 1.x ran a keep-alive timer while sends were pending; it is gone. Buffered events are still sent, best-effort, when the process ends naturally (on `beforeExit`), but not on `process.exit()`, on signals, or when a serverless function is frozen. Call `await inspector.flush()` in those cases (see [Flushing before exit](#flushing-before-exit-required)).
- **A non-200 response in `dev` resolves `[]`.** 1.x resolved the extracted schema whatever the status. Outside `dev` the promise resolves the schema, because the send happens later.
- **`destroy()` terminates the instance.** It discards buffered events unsent and aborts in-flight requests. Afterwards `trackSchemaFromEvent` resolves `[]` and sends nothing; 1.x kept sending.
- **`callInspectorWithBatchBody` changed**, if you call it directly:
  - it no longer applies sampling (sampling now happens per event when it is queued);
  - it resolves with the HTTP status code instead of `undefined`;
  - besides network errors and timeouts, it rejects with `"Request failed"` without sending when a header value contains a control character (anything but tab) or a character above U+00FF.
- **An API key containing a control character (anything but tab) or a character above U+00FF now throws in the constructor**, because the key is sent as a request header.
- **At most 4 batches are sent at once**, and up to 10,000 events can wait to be sent; beyond that the oldest waiting events are dropped. An awaited `trackSchemaFromEvent` waits for a send slot once 1,000 events are waiting (at most 10 seconds per call), which slows an awaited loop down to the speed of the sends, as in 1.x. This slows the backlog's growth but doesn't guarantee delivery: if the Inspector API is slow or down for long, the oldest waiting events can still be dropped (logged). Calls that are not awaited are not slowed down (see [High-volume and backfill scripts](#high-volume-and-backfill-scripts)).
- **A non-string `streamId` is converted, not rejected.** A number, bigint or boolean is sent as its string form; any other non-string is ignored. In 1.x the track promise rejected.
- **A non-string `env` falls back to `dev`** with a warning. In 1.x the constructor threw a `TypeError`.
- **`NaN`, `±Infinity` and exponent-form numbers such as `1e-7` are classified `float`.** 1.x classified them `int`.
- **A `null` list element is typed `"null"`.** `{ v: [null, 1] }` has children `["null", "int"]`; 1.x reported the null element as `[]`.
- **Node.js 14 or later is required** (`"engines": { "node": ">=14" }`).
- **Wire changes:** requests go to `https://api.avo.app/inspector/v2/track` and carry the API key and env as `api-key` and `env` headers. Bodies of 1024 bytes or more are gzipped. Events no longer carry `sessionId` or `trackingId`, and every event now carries `streamId`. `sessionId` is not sent; ingestion treats it as optional.

Unchanged from 1.x, but easy to trip over: the logging flag is shared by every instance in the process, and each constructor resets it (on for `dev`, off otherwise). Creating a `prod` instance after a `dev` one turns logging off for both. Call `enableLogging` after constructing your instances if you need a specific setting.

# Testing

To test against a local mock server, set the `AVO_INSPECTOR_MOCK_ENDPOINT` environment variable to its URL, for example `http://127.0.0.1:9876`. It exists for the spec's conformance suite and for local mock servers (spec §7.1).

- Track requests and event spec fetches go to that URL exactly as they would go to Avo, including your real API key (in the `api-key` header and the spec query), so point it only at a server you control.
- Don't set it in shared `staging` or `dev` environments (a CI image or base environment that many services inherit, for example): every non-prod instance there would send its API key and events to that host. Only `prod` instances ignore it.
- It is ignored when `env` is `prod`, whatever its value.
- Event spec fetches (`dev` and `staging`) go to the same server: `GET <scheme>://<host>:<port>/trackingPlan/eventSpec?apiKey=…&eventName=…&streamId=…`, with the API key in the query. A mock that has no specs to serve can answer `200` with `{"events": [], "metadata": {}}` (events are then sent without validation); any other answer, such as a 404, also sends them without validation.
- The variable is read once, when an instance is created; set it before constructing your instances.
- The first redirected send prints a one-time warning naming the scheme, host and port (never the path, the query or the API key).
- A value that is not an `http` or `https` URL is ignored with a one-time warning that gives the reason but never the value, and requests go to Avo as usual.

# Development

## Releasing

Update the `VERSION` constant in `src/AvoInspectorVersion.ts` and the `version` in `package.json` on every release. `VERSION` is sent to Avo as `libVersion`, and a unit test fails if the two differ.

## Conformance suite

`scripts/run-conformance.sh` builds the SDK and runs the spec's conformance suite (36 fixtures) against the harness in `conformance/avo-inspector-conformance.js` (runner contract 1.1.0). It fetches the spec at the pinned commit into `.spec-repo/`; set `SPEC_DIR` to use a local checkout instead.

```
./scripts/run-conformance.sh
```

## Author
Avo (https://www.avo.app), hi@avo.app

## License
AvoInspector is available under the MIT license.
