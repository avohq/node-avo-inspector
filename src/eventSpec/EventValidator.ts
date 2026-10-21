import safeRegex from "safe-regex2";
import {
  EventSpec,
  EventSpecEntry,
  PropertyConstraints,
  PropertyValidationOutcome,
  PropertyValidationResult,
} from "./AvoEventSpecFetchTypes";
import { AvoInspector } from "../AvoInspector";

// Validation covers a property (depth 0) and the properties of an object or of each object in
// a list (depth 1); deeper objects are not checked, as in the web and Android SDKs.
const MAX_CHILD_DEPTH = 2;

// Compiled patterns and parsed allowed-value lists, keyed by their wire string. Both come from
// the tracking plan, so they stay few; the bound only guards a long-lived process against a
// plan that keeps changing. null marks a pattern that was skipped (unsafe or invalid).
const MAX_CACHED_CONSTRAINTS = 1_000;

// Validation runs synchronously on the track path, so a value past these bounds is not
// checked: a list with more items, or a string longer than this against a regex (safe-regex2
// rejects exponential patterns, not quadratic ones).
const MAX_VALIDATED_LIST_ITEMS = 1_000;
const MAX_REGEX_INPUT_LENGTH = 10_000;
const regexCache = new Map<string, RegExp | null>();
const allowedValuesCache = new Map<string, Set<string> | null>();

/**
 * Checks event property values against the value constraints of an event spec: pinned values,
 * allowed values, regex patterns and min/max ranges, on a property and on the properties of an
 * object (or of each object in a list).
 *
 * Each constraint applies to the tracking-plan event IDs (base event and variants) the spec
 * lists for it, so a value can pass for one variant and fail for another. Types and required
 * properties are not checked here; Avo compares the reported schema with the plan for those.
 */
export class EventValidator {
  /**
   * Returns one result per property that failed for at least one event ID, or whose object
   * properties did. Properties the spec has no constraints for are left out.
   */
  validate(
    spec: EventSpec,
    eventSchema: Array<{ propertyName: string }>,
    rawEventProperties: { [propName: string]: any } | undefined
  ): PropertyValidationResult[] {
    const constraintsByName = collectConstraintsByName(spec.events);
    const results: PropertyValidationResult[] = [];

    for (const { propertyName } of eventSchema) {
      const constraints = constraintsByName.get(propertyName);
      if (constraints === undefined) {
        continue;
      }
      const value = rawEventProperties ? ownValue(rawEventProperties, propertyName) : undefined;
      const outcome = validateProperty(value, constraints, 0);
      if (outcome !== null) {
        results.push({ propertyName, ...outcome });
      }
    }

    return results;
  }
}

// =============================================================================
// Constraints across events
// =============================================================================

/**
 * One lookup of constraints per property name across every event in the spec. Name mapping
 * can match several events; each constraint keeps its own event IDs, so merging is a union.
 */
function collectConstraintsByName(events: EventSpecEntry[]): Map<string, PropertyConstraints> {
  const result = new Map<string, PropertyConstraints>();
  for (const event of events) {
    for (const name of Object.keys(event.props)) {
      const constraints = event.props[name];
      const existing = result.get(name);
      result.set(name, existing === undefined ? constraints : mergeConstraints(existing, constraints));
    }
  }
  return result;
}

function mergeConstraints(a: PropertyConstraints, b: PropertyConstraints): PropertyConstraints {
  const merged: PropertyConstraints = {
    type: a.type,
    // A missing value fails only where every matching event requires the property.
    required: a.required && b.required,
  };
  if (a.isList || b.isList) {
    merged.isList = true;
  }
  const pinnedValues = mergeIdMappings(a.pinnedValues, b.pinnedValues);
  if (pinnedValues) {
    merged.pinnedValues = pinnedValues;
  }
  const allowedValues = mergeIdMappings(a.allowedValues, b.allowedValues);
  if (allowedValues) {
    merged.allowedValues = allowedValues;
  }
  const regexPatterns = mergeIdMappings(a.regexPatterns, b.regexPatterns);
  if (regexPatterns) {
    merged.regexPatterns = regexPatterns;
  }
  const minMaxRanges = mergeIdMappings(a.minMaxRanges, b.minMaxRanges);
  if (minMaxRanges) {
    merged.minMaxRanges = minMaxRanges;
  }
  if (a.children || b.children) {
    const children: Record<string, PropertyConstraints> = Object.create(null);
    for (const source of [a.children, b.children]) {
      if (!source) {
        continue;
      }
      for (const name of Object.keys(source)) {
        const existing = children[name];
        children[name] = existing === undefined ? source[name] : mergeConstraints(existing, source[name]);
      }
    }
    merged.children = children;
  }
  return merged;
}

function mergeIdMappings(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (!a || !b) {
    return a ?? b;
  }
  const merged: Record<string, string[]> = Object.create(null);
  for (const source of [a, b]) {
    for (const key of Object.keys(source)) {
      const ids = merged[key];
      merged[key] = ids === undefined ? source[key] : Array.from(new Set([...ids, ...source[key]]));
    }
  }
  return merged;
}

// =============================================================================
// Validation
// =============================================================================

function validateProperty(
  value: unknown,
  constraints: PropertyConstraints,
  depth: number
): PropertyValidationOutcome | null {
  if (depth >= MAX_CHILD_DEPTH) {
    return null;
  }
  if (constraints.isList) {
    return validateList(value, constraints, depth);
  }
  if (constraints.children) {
    return validateObject(value, constraints.children, depth);
  }
  // An optional property sent as null or undefined has no value to check.
  if ((value === null || value === undefined) && !constraints.required) {
    return null;
  }
  return outcomeOf(checkValue(value, constraints, new Set<string>()));
}

/**
 * A list of objects is checked property by property across every item: an event ID fails a
 * child property when any item's value fails it. A list of primitives is checked item by item.
 * A value that is not an array is not checked (its type is reported in the schema).
 */
function validateList(
  value: unknown,
  constraints: PropertyConstraints,
  depth: number
): PropertyValidationOutcome | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length > MAX_VALIDATED_LIST_ITEMS) {
    if (AvoInspector.shouldLog) {
      console.warn(
        `[Avo Inspector] Warning: List of ${value.length} items not validated (limit ${MAX_VALIDATED_LIST_ITEMS})`
      );
    }
    return null;
  }

  if (constraints.children) {
    const children: Record<string, PropertyValidationOutcome> = Object.create(null);
    let failed = false;
    for (const name of Object.keys(constraints.children)) {
      const failedIds = new Set<string>();
      for (const item of value) {
        const outcome = validateProperty(childValue(item, name), constraints.children[name], depth + 1);
        if (outcome !== null) {
          outcome.failedEventIds.forEach((id) => failedIds.add(id));
        }
      }
      const outcome = outcomeOf(failedIds);
      if (outcome !== null) {
        children[name] = outcome;
        failed = true;
      }
    }
    return failed ? { failedEventIds: [], children } : null;
  }

  const failedIds = new Set<string>();
  for (const item of value) {
    checkValue(item, constraints, failedIds);
  }
  return outcomeOf(failedIds);
}

function validateObject(
  value: unknown,
  childConstraints: Record<string, PropertyConstraints>,
  depth: number
): PropertyValidationOutcome | null {
  const children: Record<string, PropertyValidationOutcome> = Object.create(null);
  let failed = false;
  for (const name of Object.keys(childConstraints)) {
    const outcome = validateProperty(childValue(value, name), childConstraints[name], depth + 1);
    if (outcome !== null) {
      children[name] = outcome;
      failed = true;
    }
  }
  return failed ? { failedEventIds: [], children } : null;
}

function outcomeOf(failedIds: Set<string>): PropertyValidationOutcome | null {
  return failedIds.size > 0 ? { failedEventIds: Array.from(failedIds) } : null;
}

// A property of a plain object (null-prototype included); anything else has none.
function childValue(container: unknown, name: string): unknown {
  if (container === null || typeof container !== "object" || Array.isArray(container)) {
    return undefined;
  }
  return ownValue(container as { [key: string]: unknown }, name);
}

// Own properties only, so "constructor" or "toString" never reads a prototype method.
function ownValue(container: { [key: string]: unknown }, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(container, name) ? container[name] : undefined;
}

/** Adds to failedIds the event IDs whose constraints the value breaks. */
function checkValue(value: unknown, constraints: PropertyConstraints, failedIds: Set<string>): Set<string> {
  if (constraints.pinnedValues || constraints.allowedValues) {
    const actual = comparableString(value);
    if (constraints.pinnedValues) {
      checkPinnedValues(actual, constraints.pinnedValues, failedIds);
    }
    if (constraints.allowedValues) {
      checkAllowedValues(actual, constraints.allowedValues, failedIds);
    }
  }
  if (constraints.regexPatterns) {
    checkRegexPatterns(value, constraints.regexPatterns, failedIds);
  }
  if (constraints.minMaxRanges) {
    checkMinMaxRanges(value, constraints.minMaxRanges, failedIds);
  }
  return failedIds;
}

function addAll(ids: string[], failedIds: Set<string>): void {
  for (const id of ids) {
    failedIds.add(id);
  }
}

/**
 * The string a value is compared as against pinned and allowed values: String() for a
 * primitive, JSON for an object or list. A value with neither (a cyclic object, a throwing
 * toJSON or toString) falls back to its tag, e.g. "[object Object]".
 */
function comparableString(value: unknown): string {
  if (value !== null && typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) {
        return json;
      }
    } catch (e) {
      // Falls through to String().
    }
  }
  try {
    return String(value);
  } catch (e) {
    return Object.prototype.toString.call(value);
  }
}

function checkPinnedValues(actual: string, pinnedValues: Record<string, string[]>, failedIds: Set<string>): void {
  for (const pinned of Object.keys(pinnedValues)) {
    if (actual !== pinned) {
      addAll(pinnedValues[pinned], failedIds);
    }
  }
}

function checkAllowedValues(actual: string, allowedValues: Record<string, string[]>, failedIds: Set<string>): void {
  for (const json of Object.keys(allowedValues)) {
    const allowed = parseAllowedValues(json);
    // A list that is not a JSON array of strings is skipped: nothing fails it.
    if (allowed !== null && !allowed.has(actual)) {
      addAll(allowedValues[json], failedIds);
    }
  }
}

function checkRegexPatterns(value: unknown, regexPatterns: Record<string, string[]>, failedIds: Set<string>): void {
  if (typeof value === "string" && value.length > MAX_REGEX_INPUT_LENGTH) {
    if (AvoInspector.shouldLog) {
      console.warn(
        `[Avo Inspector] Warning: String of ${value.length} characters not checked against regex patterns (limit ${MAX_REGEX_INPUT_LENGTH})`
      );
    }
    return;
  }
  for (const pattern of Object.keys(regexPatterns)) {
    // Only a string can match; an unsafe or invalid pattern is skipped (nothing fails it).
    if (typeof value !== "string") {
      addAll(regexPatterns[pattern], failedIds);
      continue;
    }
    const regex = compileRegex(pattern);
    if (regex !== null && !regex.test(value)) {
      addAll(regexPatterns[pattern], failedIds);
    }
  }
}

/**
 * "min,max" with either bound possibly empty: "0," has no maximum, ",100" no minimum. Only a
 * number (or bigint) can be in range; NaN never is. A range that does not parse is skipped.
 */
function checkMinMaxRanges(value: unknown, minMaxRanges: Record<string, string[]>, failedIds: Set<string>): void {
  const actual = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : NaN;
  for (const range of Object.keys(minMaxRanges)) {
    const bounds = parseRange(range);
    if (bounds === null) {
      if (AvoInspector.shouldLog) {
        console.warn(`[Avo Inspector] Warning: Invalid min/max range skipped: ${range}`);
      }
      continue;
    }
    if (Number.isNaN(actual) || actual < bounds.min || actual > bounds.max) {
      addAll(minMaxRanges[range], failedIds);
    }
  }
}

function parseRange(range: string): { min: number; max: number } | null {
  const parts = range.split(",");
  if (parts.length !== 2) {
    return null;
  }
  const [minPart, maxPart] = parts.map((part) => part.trim());
  const min = minPart === "" ? -Infinity : Number(minPart);
  const max = maxPart === "" ? Infinity : Number(maxPart);
  return Number.isNaN(min) || Number.isNaN(max) ? null : { min, max };
}

function parseAllowedValues(json: string): Set<string> | null {
  const cached = allowedValuesCache.get(json);
  if (cached !== undefined) {
    return cached;
  }
  let allowed: Set<string> | null = null;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      allowed = new Set(parsed);
    }
  } catch (e) {
    // Left null: skipped below.
  }
  if (allowed === null && AvoInspector.shouldLog) {
    console.warn(`[Avo Inspector] Warning: Invalid allowed values skipped: ${json}`);
  }
  cacheConstraint(allowedValuesCache, json, allowed);
  return allowed;
}

function compileRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  let regex: RegExp | null = null;
  if (!safeRegex(pattern)) {
    console.warn(`[Avo Inspector] Warning: Unsafe regex pattern skipped: ${pattern}`);
  } else {
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      console.warn(`[Avo Inspector] Warning: Invalid regex pattern skipped: ${pattern}`);
    }
  }
  cacheConstraint(regexCache, pattern, regex);
  return regex;
}

function cacheConstraint<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MAX_CACHED_CONSTRAINTS) {
    cache.clear();
  }
  cache.set(key, value);
}
