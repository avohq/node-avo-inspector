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

## 2.0.0

Implements [avohq/spec-first-inspector-server-sdk](https://github.com/avohq/spec-first-inspector-server-sdk) v3.0.1: the `/inspector/v2/track` endpoint, batching with `flush()` and `destroy()`, gzip, and gateway options. This is a breaking release; see [Upgrading from 1.x to 2.0](README.md#upgrading-from-1x-to-20) in the README.
