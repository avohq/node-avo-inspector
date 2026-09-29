// SDK library version, sent on the wire as `libVersion`. Plain SemVer, no suffix.
// Update this constant (and package.json "version") on every release.
export const VERSION = "2.0.1";

// Version of avohq/spec-first-inspector-server-sdk this SDK implements.
export const SPEC_VERSION = "3.0.1";

// Sent as `libPlatform` on every event and as the `X-Avo-Client` request header.
export const LIB_PLATFORM = "node";
