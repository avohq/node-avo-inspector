# Example: node-inspector-js

Minimal runnable demo of the package from JavaScript (CommonJS).

## Tech stack

- JavaScript (CommonJS); depends on the published `node-avo-inspector` package (`const Inspector = require("node-avo-inspector");`).

## Functional requirements

1. Construct an `AvoInspector` with `{ apiKey: "My Api Key", env: Prod, version: "1.0.0", appName: "My App" }`.
2. Build an `"App Launched"` event whose params cover every schema type: string, boolean, int, float, null, list of strings, and a nested object; enable logging.
3. Track the event with `trackSchemaFromEvent(eventName, eventParams)` and, when the promise resolves, log `"Event schema queued for Avo Inspector"` with the returned schema, then return `inspector.flush()` so queued events are sent before the process exits.

## Non-functional requirements

- **Outside dev, events are batched; the example flushes explicitly** so the demo event is delivered before exit.
