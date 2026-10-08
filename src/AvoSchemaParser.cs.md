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
  - `MAX_PROPERTIES = 10000` — budget of property entries emitted, at every depth (top-level and nested). Independent of `MAX_EXPANSIONS`: one object with a million keys is one expansion but is cut off here.

## Users and permissions

- Called by the inspector's `extractSchema` / track path with arbitrary caller-supplied properties. No auth.

## Functional requirements

1. A root that is not a non-array object returns `[]`: `null` / `undefined`, a primitive (string, number, boolean, symbol), a function, an array, or binary data (an ArrayBuffer view such as a Buffer, typed array or DataView, or an ArrayBuffer / SharedArrayBuffer). So a track call with such properties sends `eventProperties: []` and resolves `[]`, never a bare type string.
2. Mapping a value:
   - Array: map every element recursively, then de-duplicate.
   - Object: for each own enumerable string key (`Object.keys`), in insertion order, emit `{ propertyName, propertyType }`; if the value is a non-null object or array, add `children` = mapping of the value. Each entry counts toward `MAX_PROPERTIES` when it is emitted, before its value is mapped (pre-order), at every depth, including properties of objects inside lists; list elements are not entries. Once the budget is spent every later entry is omitted silently, in iteration order. This is the cross-SDK extraction bound: Node, Java and Go produce the same schema, digest for digest (pinned in TestExtractionDigests).
   - **Binary data is never enumerated** (a Buffer has one indexed key per byte): an ArrayBuffer view (`ArrayBuffer.isView`: Buffer, any typed array, DataView) is typed by its element type, whatever its length (as Java and Go type primitive arrays): a float view (Float16Array, Float32Array, Float64Array, matched by `Object.prototype.toString` tag) is `list(float)` with children `["float"]`, any other (Buffer, integer and BigInt typed arrays, DataView) `list(int)` with children `["int"]`. As a list element it maps to `["float"]` or `["int"]`. An ArrayBuffer or SharedArrayBuffer is `object` with children `[]` (an empty list element `[]`). Binary data is a complex value like any other for the leaf rules below, as a property or a list element: past the depth cap or the expansion budget it is a leaf (`"object"`), and otherwise mapping it costs one expansion. This matches Java and Go (pinned in TestExtractionDigests).
   - Primitive, `null` or `undefined` (including a list element): its type string. **IMPORTANT:** a `null` list element maps to `"null"` (spec §9.2), not to `[]` as the JS reference did (the §9.3.4 quirk, not a conformance gate).
3. Recursion is bounded. A complex value is a **leaf** when any of:
   - its depth has reached `MAX_DEPTH`;
   - it is one of its own ancestors on the current path (a cycle);
   - `MAX_EXPANSIONS` complex values have already been expanded in this call.
   - A leaf property is emitted as `{ propertyType: "object", children: [] }` (even if it is an array).
   - A leaf list element is emitted as the string `"object"`.
   - Shared, non-cyclic references are re-expanded at each occurrence (ancestors are path-scoped), consuming budget each time.
4. De-duplication: a list's children hold each distinct child schema once, the first occurrence, in first-occurrence order (as in Java and Go). Children are compared by value through a canonical key (`childKey`): a type string by itself; an object's entries by name, type and children, sorted so property order does not matter; a nested list's children in order. A `Set` of keys keeps it linear in the output size (no pairwise compare). It runs on the mapped output only, so every element has already been expanded and counted toward `MAX_EXPANSIONS` and `MAX_PROPERTIES`; an empty object and an empty list both map to `[]` and so are one child.

### Type classification

- `null` / `undefined` -> `"null"`; string -> `"string"`; boolean -> `"boolean"`; non-array object -> `"object"`; anything else (function, symbol) -> `"unknown"`.
- bigint -> `"int"`. number -> `"int"` when `Number.isInteger`, else `"float"` (so exponent forms, `NaN`, `±Infinity` are `"float"`; `-0` and `0.0` are `"int"`).
- Array -> `list(<type of element 0>)` using the rules above; an empty list or null/undefined first element -> `"list(string)"`. A nested array element gives `list(object)`. **An `"unknown"` element type is reported as `list(object)`**; the element's own mapped child stays `"unknown"`.

## Non-functional requirements

- **IMPORTANT:** Cyclic input, null-prototype objects and objects with an own `hasOwnProperty` key are mapped without throwing. Expansion is bounded by `MAX_DEPTH`, `MAX_EXPANSIONS` and `MAX_PROPERTIES`, and binary data costs one expansion and is never walked; truncation is silent.
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
