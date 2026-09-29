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

## Batching options

Events are buffered in memory and sent in batches. All options are optional:

| Option | Default | Meaning |
|---|---|---|
| `batchSize` | `30` | Send when this many events are buffered. Always `1` in `dev`, so every event is sent immediately. |
| `batchFlushSeconds` | `30` | Send once the oldest buffered event is this many seconds old. |
| `maxQueueSize` | `1000` | Maximum buffered events; the oldest are dropped first when it is exceeded. |
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

# Flushing before exit (required)

Buffered events live in memory only and are lost if the process exits first. Delivery is at-most-once: a batch that fails to send is dropped, never retried.

When a process ends because it has nothing left to do, the SDK sends what is still buffered on its own: it listens for Node's `beforeExit` event and flushes (bounded by the 10-second flush timeout). This is a best-effort safety net, not a guarantee. The SDK never keeps an idle process alive, and `beforeExit` does **not** fire when:

- the process calls `process.exit()`;
- the process is stopped by a signal such as `SIGTERM` or `SIGINT` (container shutdown, Ctrl-C);
- a serverless platform freezes or reclaims the function after the handler returns.

So call `flush()` yourself in those cases:

- Call `await inspector.flush()` before `process.exit()`, in your `SIGTERM`/`SIGINT` handlers, and before a serverless handler (AWS Lambda, Google Cloud Functions, Vercel, ...) returns. It sends everything buffered, waits for in-flight requests (up to `timeoutMs`, default 10000) and never rejects.
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

If you also call `trackSchemaFromEvent` for events that Codegen already reports, the SDK drops the second report of the same observation. A Codegen call and a manual call are treated as duplicates when they have the same event name, the same stream id and deeply equal properties, and arrive within 500 ms of each other in either order. The duplicate call sends nothing and resolves `[]`. Two manual calls, or two Codegen calls, are never deduplicated against each other.

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

`trackSchemaFromEvent` returns a promise that resolves with the extracted schema once the event is queued. In `dev` the event is sent within the call, and the promise resolves `[]` if the Inspector API answers with a non-200 status. You can pass an optional stream id as the third argument to correlate events.

## Event order

Each event carries its own `createdAt`, stamped when `trackSchemaFromEvent` is called. Events in a batch are not guaranteed to be in call order: in `dev` and `staging`, an event whose spec must first be fetched for validation joins the queue when the fetch completes, so it can be sent after events tracked later. Use `createdAt` if you need the call order.

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
- `originAppVersion` replaces the constructor `version` for that event. If you pass `originHint` without `originAppVersion`, the event is sent without an app version (`null`), because the constructor version belongs to a different source.

# Enabling logs

Logs are enabled by default in the dev mode and disabled in prod mode. You can enable and disable logs by calling the `enableLogging` method:

```javascript
inspector.enableLogging(true | false);
```

# Upgrading from 1.x to 2.0

2.0 implements spec 3.0.1. These are the changes you may notice:

- **The promise resolves when the event is queued, not when it is delivered.** Outside `dev`, events are batched (see [Batching options](#batching-options)), so `await inspector.trackSchemaFromEvent(...)` no longer means the event reached Avo. In `dev` each event is still sent within the call.
- **The SDK no longer keeps your process alive.** 1.x ran a keep-alive timer while sends were pending; it is gone. Buffered events are still sent when the process ends naturally (on `beforeExit`), but not on `process.exit()`, on signals, or when a serverless function is frozen. Call `await inspector.flush()` in those cases (see [Flushing before exit](#flushing-before-exit-required)).
- **A non-200 response in `dev` resolves `[]`.** 1.x resolved the extracted schema whatever the status. Outside `dev` the promise resolves the schema, because the send happens later.
- **`destroy()` terminates the instance.** It discards buffered events unsent and aborts in-flight requests. Afterwards `trackSchemaFromEvent` resolves `[]` and sends nothing; 1.x kept sending.
- **`callInspectorWithBatchBody` changed**, if you call it directly:
  - it no longer applies sampling (sampling now happens per event when it is queued);
  - it resolves with the HTTP status code instead of `undefined`;
  - besides network errors and timeouts, it rejects with `"Request failed"` without sending when a header value contains a control character (anything but tab) or a character above U+00FF.
- **An API key containing a control character (anything but tab) or a character above U+00FF now throws in the constructor**, because the key is sent as a request header.
- **Wire changes:** requests go to `https://api.avo.app/inspector/v2/track` and carry the API key and env as `api-key` and `env` headers. Bodies of 1024 bytes or more are gzipped. Events no longer carry `sessionId` or `trackingId`, and every event now carries `streamId`. `sessionId` is not sent; ingestion treats it as optional.

Unchanged from 1.x, but easy to trip over: the logging flag is shared by every instance in the process, and each constructor resets it (on for `dev`, off otherwise). Creating a `prod` instance after a `dev` one turns logging off for both. Call `enableLogging` after constructing your instances if you need a specific setting.

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
