# utils

Small shared helpers: blank-string check, structural deep equality used by the deduplicator, option normalization and header-value validation.

## Tech stack

- TypeScript, no dependencies.

## Data

```ts
monotonicNowMs(): number
isValueEmpty(value: string | null | undefined): boolean
deepEquals(x: any, y: any, comparing?: Map<object, Set<object>>): boolean
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
4. If the pair `(x, y)` is already recorded in `comparing` -> true (cycle cut); otherwise record it.
5. For each own enumerable key of `x` (`Object.keys`):
   - missing on `y` (`Object.prototype.hasOwnProperty.call`) -> false;
   - strictly equal values -> continue;
   - non-object `x[p]` -> false;
   - otherwise recurse with the same `comparing`; unequal -> false.
6. Any own key of `y` missing on `x` -> false. Else true.

### normalizeOption

- Non-string -> `undefined`; otherwise the trimmed string, or `undefined` if blank.

### hasHeaderControlChar

- True if the string contains any Unicode Cc control character (U+0000–U+001F, U+007F–U+009F) **except tab (U+0009)**.

### hasNonLatin1Char

- True if the string contains any character above U+00FF.

## Non-functional requirements

- `deepEquals` terminates on cyclic input and never calls methods on the compared objects.
- Objects with no own enumerable keys (e.g. two different `Date`s) compare equal.
- Pure; no side effects.

## Examples

<example>
`normalizeOption("  web ")` -> `"web"`; `normalizeOption("  ")` -> `undefined`; `normalizeOption(5)` -> `undefined`.
</example>

<example>
`hasHeaderControlChar("a\tb")` -> false; `hasHeaderControlChar("a\r\nb")` -> true; `hasNonLatin1Char("é")` -> false; `hasNonLatin1Char("€")` -> true.
</example>
