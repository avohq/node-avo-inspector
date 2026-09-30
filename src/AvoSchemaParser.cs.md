# AvoSchemaParser

Derives the Inspector schema (property names, wire types and nested child schemas) from a caller's event properties object. Values themselves are never included; only their shapes.

## Tech stack

- TypeScript, no runtime dependencies.

## Data

```ts
static extractSchema(eventProperties: { [propName: string]: any }): Array<{
  propertyName: string;
  propertyType: string;
  children?: any;
}>
```

- `propertyType` is one of `"null"`, `"string"`, `"int"`, `"float"`, `"boolean"`, `"object"`, `"unknown"`, or `list(<elementType>)`.
- `children` is present only when the value is a non-null object or array.
  - For an object: an array of child entries of the same shape.
  - For an array: the de-duplicated list of mapped elements (type strings for primitives, entry arrays for objects/arrays).
- Limits (per `extractSchema` call):
  - `MAX_DEPTH = 10` — complex values nested more than 10 levels below the root are not descended into.
  - `MAX_EXPANSIONS = 10000` — budget of complex values expanded (the root counts as one).

## Users and permissions

- Called by the inspector's `extractSchema` / track path with arbitrary caller-supplied properties. No auth.

## Functional requirements

1. A root that is not a non-array object returns `[]`: `null` / `undefined`, a primitive (string, number, boolean, symbol), a function, or an array.
2. Mapping a value:
   - Array: map every element recursively, then de-duplicate.
   - Object: for each own enumerable string key (`Object.keys`), emit `{ propertyName, propertyType }`; if the value is a non-null object or array, add `children` = mapping of the value.
   - Primitive, `null` or `undefined` (including a list element): its type string. **IMPORTANT:** a `null` list element maps to `"null"` (spec §9.2), not to `[]` as the JS reference did (the §9.3.4 quirk, not a conformance gate).
3. Recursion is bounded. A complex value is a **leaf** when any of:
   - its depth has reached `MAX_DEPTH`;
   - it is one of its own ancestors on the current path (a cycle);
   - `MAX_EXPANSIONS` complex values have already been expanded in this call.
   - A leaf property is emitted as `{ propertyType: "object", children: [] }` (even if it is an array).
   - A leaf list element is emitted as the string `"object"`.
   - Shared, non-cyclic references are re-expanded at each occurrence (ancestors are path-scoped), consuming budget each time.
4. De-duplication: primitive-typed items (boolean/number/string) are de-duplicated by value; other items (entry arrays) by identity only, so structurally equal objects in a list each produce their own entry.

### Type classification

- `null` / `undefined` -> `"null"`; string -> `"string"`; boolean -> `"boolean"`; non-array object -> `"object"`; anything else (function, symbol) -> `"unknown"`.
- bigint -> `"int"`. number -> `"int"` when `Number.isInteger`, else `"float"` (so exponent forms, `NaN`, `±Infinity` are `"float"`; `-0` and `0.0` are `"int"`).
- Array -> `list(<type of element 0>)` using the rules above; an empty list or null/undefined first element -> `"list(string)"`. A nested array element gives `list(object)`. **An `"unknown"` element type is reported as `list(object)`**; the element's own mapped child stays `"unknown"`.

## Non-functional requirements

- **IMPORTANT:** Cyclic input, null-prototype objects and objects with an own `hasOwnProperty` key are mapped without throwing. Expansion is bounded by `MAX_DEPTH` and `MAX_EXPANSIONS`; truncation is silent.
- A throwing getter still propagates to the caller; ancestor tracking is cleaned up on the way out.
- Pure; no side effects.

## Examples

<example>
`{ a: 1, b: 1.5, c: [1, 2], d: { e: null } }` ->
`[{a,"int"}, {b,"float"}, {c,"list(int)",children:["int"]}, {d,"object",children:[{e,"null"}]}]`
</example>

<example>
`1e-7` -> `"float"`; `NaN` -> `"float"`; `Infinity` -> `"float"`; `10n` -> `"int"`.
</example>

<example>
`c = { x: 1 }; c.self = c` -> `[{x,"int"}, {self,"object",children:[]}]`
</example>

<example>
`{ fn: [() => 1] }` -> `[{fn,"list(object)",children:["unknown"]}]`
</example>

<example>
Root `"abc"`, `42`, `[1, 2]` or `() => 1` -> `[]`
</example>

<example>
`{ v: ["a", null] }` -> `[{v,"list(string)",children:["string","null"]}]`; `{ v: [null, 1] }` -> children `["null","int"]`
</example>
