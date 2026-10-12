# AvoInspectorVersion

Single source of truth for the SDK's version identifiers and platform name.

## Tech stack

- TypeScript, no dependencies.

## Data

```ts
export const VERSION = "2.0.0";      // sent on the wire as `libVersion`; plain SemVer, no suffix
export const SPEC_VERSION = "3.0.1"; // version of the Inspector server SDK spec this SDK implements
export const LIB_PLATFORM = "node";  // sent as `libPlatform` on every event and as the `X-Avo-Client` header
```

## Non-functional requirements

- **`VERSION` must equal `package.json` `version` without any pre-release suffix** (a `2.0.0-beta.0` package sends `2.0.0`, because `libVersion` must be plain SemVer); both are updated together on every release.
