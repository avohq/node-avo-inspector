# utils

Small shared helpers: monotonic clock, blank-string check, structural deep equality used by the deduplicator, debug schema formatting, option normalization and header-value validation.

## Tech stack

- TypeScript, no dependencies.

## Data

```ts
monotonicNowMs(): number
isValueEmpty(value: string | null | undefined): boolean
deepEquals(x: any, y: any): boolean
formatSchema(schema: Array<{ propertyName: string; propertyType: string }>): string
normalizeOption(value: unknown): string | undefined
hasHeaderControlChar(value: string): boolean
hasNonLatin1Char(value: string): boolean
```

## Functional requirements

### monotonicNowMs

- Milliseconds from `process.hrtime.bigint()`: monotonic, so only differences are meaningful and wall-clock steps never affect them. The one clock for the deduplicator, `AvoLog` and the exit drain deadline.

### isValueEmpty

- True for `null`, `undefined`, or a string that is empty after `trim()`.

### deepEquals

1. `x === y` -> true.
2. Either side `null` or `typeof !== "object"` -> false (null-prototype objects are compared structurally).
3. Different prototype (`Object.getPrototypeOf`) -> false.
4. If the pair `(x, y)` was already compared in this call -> true (cycle cut).
5. **Binary data** (an ArrayBuffer view, ArrayBuffer or SharedArrayBuffer; same prototype already checked): equal iff the bytes are equal (`byteLength` and a native `Buffer.compare`), never enumerated.
6. **Limits** (the schema extraction limits): if the pair is at depth 10 or more (the top-level pair is depth 0, each step into a property one more), or 10,000 pairs have already been expanded in this call -> false. Otherwise count this pair as expanded and record it.
7. For each own enumerable key of `x` (`Object.keys`): count it toward a 10,000-property budget for the call; past it -> false.
   - missing on `y` (`Object.prototype.hasOwnProperty.call`) -> false;
   - strictly equal values -> continue;
   - non-object `x[p]` -> false;
   - otherwise recurse one level deeper, with the same recorded pairs and expansion count; unequal -> false.
8. Any own key of `y` missing on `x` -> false. Else true.

### formatSchema

- The schema as debug logs print it: `{`, a newline, one `\t"<name>": "<type>"` per property joined by `;` and a newline, a newline, `}`. Used by the "Parsed schema", "Sending event" and "Saved event" debug lines.

### normalizeOption

- Non-string -> `undefined`; otherwise the trimmed string, or `undefined` if blank.

### hasHeaderControlChar

- True if the string contains any Unicode Cc control character (U+0000–U+001F, U+007F–U+009F) **except tab (U+0009)**.

### hasNonLatin1Char

- True if the string contains any character above U+00FF.

## Non-functional requirements

- `deepEquals` terminates on cyclic input and never calls methods on the compared objects.
- Recursion is at most 10 levels deep and expands at most 10,000 object/list pairs, so stack depth is bounded however deep the payload is. A call compares at most 10,000 properties (requirement 7), so a wide payload is bounded too; the check on `y`'s keys stops at the first key `x` lacks, so it never runs past that count either. Payloads past any of these limits compare not equal (the same reference is still equal).
- Objects with no own enumerable keys (e.g. two different `Date`s) compare equal.
- Pure; no side effects.

## Examples

<example>
`normalizeOption("  web ")` -> `"web"`; `normalizeOption("  ")` -> `undefined`; `normalizeOption(5)` -> `undefined`.
</example>

<example>
`hasHeaderControlChar("a\tb")` -> false; `hasHeaderControlChar("a\r\nb")` -> true; `hasNonLatin1Char("é")` -> false; `hasNonLatin1Char("€")` -> true.
</example>
