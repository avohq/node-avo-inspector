---
import:
  - src/AvoInspector.cs.md
  - src/AvoInspectorVersion.cs.md
---
# index

Public entry point of the package.

## Data

```ts
export { AvoInspector } from "./AvoInspector";
export type { TrackOptions } from "./AvoInspector";
export { AvoInspectorEnv } from "./AvoInspectorEnv";
export { VERSION, SPEC_VERSION } from "./AvoInspectorVersion";
```

## Functional requirements

- Consumers import the inspector class, the environment enum, the `TrackOptions` type (per-call gateway options) and the `VERSION` / `SPEC_VERSION` constants from the package root; nothing else is public.
- `LIB_PLATFORM` is internal and not re-exported.
