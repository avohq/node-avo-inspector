# Example: node-inspector-ts

Minimal runnable demo of the package from TypeScript (ES module import).

## Tech stack

- TypeScript (ES module import); depends on the published `node-avo-inspector` package (`import * as Inspector from "node-avo-inspector";`).

## Functional requirements

1. Construct an `AvoInspector` with `{ apiKey: "My Api Key", env: Prod, version: "1.0.0", appName: "My App" }`.
2. Build an `"App Launched"` event whose params cover every schema type: string, boolean, int, float, null, list of strings, and a nested object; enable logging.
3. Track the event with `trackSchemaFromEvent({ eventName, eventProperties: eventParams })` and, when the promise resolves, log `"Event schema queued for Avo Inspector"` with the returned schema, then return `inspector.flush()`, which waits for the send attempts of queued events before the process exits.

## Non-functional requirements

- **Outside dev, events are batched; the example flushes explicitly** so the demo event's send is attempted before exit. `flush()` resolves once that attempt finishes; a batch that fails is dropped, not retried, so delivery is not guaranteed.
