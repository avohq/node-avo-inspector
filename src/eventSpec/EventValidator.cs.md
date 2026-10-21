# EventValidator

Checks an event's property values against the value constraints of its Avo event spec (pinned values, allowed values, regex patterns, min/max ranges), on each property and on the properties of an object or of each object in a list, and reports, per property, the tracking-plan event IDs whose constraints the value breaks. Same rules as the web (`js-avo-inspector`) and Android SDKs.

## Tech stack

- TypeScript; `safe-regex2` to reject patterns prone to catastrophic backtracking.
- Types from `./AvoEventSpecFetchTypes`; reads the static `AvoInspector.shouldLog` flag at call time only (circular import).

## Data

```ts
class EventValidator {
  validate(
    spec: EventSpec,
    eventSchema: Array<{ propertyName: string }>,
    rawEventProperties: { [propName: string]: any } | undefined
  ): PropertyValidationResult[];
}
// PropertyValidationResult: { propertyName; failedEventIds: string[]; children?: Record<string, PropertyValidationOutcome> }
// PropertyValidationOutcome: { failedEventIds: string[]; children?: Record<string, PropertyValidationOutcome> }
```

- `MAX_CHILD_DEPTH = 2`: a property is depth 0, its object properties depth 1; nothing at depth 2 or deeper is checked.
- Module-level caches, keyed by the wire string: compiled regex (`null` for a skipped pattern) and parsed allowed-value sets (`null` for a list that is not a JSON array of strings). Each is cleared when it reaches 1,000 entries.

## Users and permissions

- Called by `AvoInspector.fetchAndValidate` in dev and staging, with the extracted schema and the raw properties of one event.

## Functional requirements

### validate

1. Merges the constraints of every spec entry by property name. Each constraint keeps its own event IDs, so merging is a union of keys and IDs. A merged property is a list if any entry says so, and required only if every entry requires it. `children` merge recursively.
2. For each schema entry whose name has constraints, reads the raw value (an own property only; absent -> `undefined`) and validates it at depth 0. Properties without constraints are skipped.
3. Returns only the properties with an outcome, in schema order.

### Per value (depth d)

1. `d >= MAX_CHILD_DEPTH` -> no outcome.
2. **List** (`isList`): a non-array value, or one of more than 1,000 items (logged when logging is on), -> no outcome.
   - With `children`: for each child name, the union of the failed IDs of `item[name]` (own property of a plain or null-prototype object item, else `undefined`) at depth d+1 over every item. Outcome `{ failedEventIds: [], children }` with the child names that failed; none -> no outcome.
   - Without: every item is checked against the constraints; the union of failed IDs.
3. **Object** (`children`, not a list): each child's own value at depth d+1 (a value that is not a plain object has none). Outcome `{ failedEventIds: [], children }` with the children that have an outcome; none -> no outcome.
4. **Primitive**: `null`/`undefined` on a non-required property -> no outcome. Otherwise the union of failed IDs of every constraint.
5. An outcome with no failed IDs is no outcome.

### Constraints

- **Pinned values** `value -> ids`: the value's comparable string must equal the key, else those IDs fail.
- **Allowed values** `JSON array -> ids`: the comparable string must be in the parsed list, else those IDs fail. A key that is not a JSON array of strings is skipped (logged when logging is on).
- **Regex** `pattern -> ids`: a non-string value fails every pattern's IDs. A string longer than 10,000 characters is not checked against any pattern (logged when logging is on). A string must match (`new RegExp(pattern)`, no flags), else those IDs fail. A pattern `safe-regex2` rejects, or that does not compile, is skipped with a `console.warn` (always on) the first time it is seen.
- **Min/max** `"min,max" -> ids`: either bound may be empty (no limit). A number is compared as is, a bigint as `Number(value)`; anything else, and `NaN`, fails every range. A key that does not parse is skipped (logged when logging is on).
- **Comparable string** (computed once per value, shared by pinned and allowed values): an object or array -> `JSON.stringify`; otherwise, or when that throws or gives `undefined`, `String(value)`; when that throws too, the `Object.prototype.toString` tag.

## Non-functional requirements

- **IMPORTANT:** validation runs synchronously on the track path, so the list and string bounds above keep one value from blocking the event loop; `safe-regex2` rejects exponential patterns, not quadratic ones.
- **IMPORTANT:** only `failedEventIds` are produced. Avo's ingestion reads only `failedEventIds`, so a smaller "passed" list (as the web SDK sends) would hide the failures it stands for.
- **IMPORTANT:** types are not checked (Avo compares the reported schema with the plan). `required` only decides whether a `null` or missing value is checked against the constraints: a required property sent as `null`, or a required object property whose parent is `null`, not an object, or a list item without it, fails. A property absent from the event is not validated.
- Log lines never contain property values: warnings name only patterns, allowed-value lists or ranges from the spec.
- A getter or proxy that throws while a value is read propagates; `AvoInspector` then sends the event without validation.
- Name-keyed records built here are null-prototype, so `constructor`, `toString` or `__proto__` are ordinary names.

## Examples

<example>
Spec: `plan` allowed `["free","pro"]` for `evt`, `["free"]` for `evt.v1`. Value `"pro"` -> `[{ propertyName: "plan", failedEventIds: ["evt.v1"] }]`.
</example>
<example>
Spec: `items` a list of objects whose `sku` must match `^SKU-\d+$` for `evt`. Value `[{ sku: "SKU-1" }, { sku: "bad" }]` -> `[{ propertyName: "items", failedEventIds: [], children: { sku: { failedEventIds: ["evt"] } } }]`.
</example>
