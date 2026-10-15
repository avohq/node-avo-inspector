/**
 * Type definitions for Event Spec validation responses.
 */

/**
 * The value constraints the spec sets on one property. Each constraint maps a key to the
 * tracking-plan event IDs (base event or variant) that require it, so one property can carry
 * different rules for different variants.
 */
export interface PropertyConstraints {
  /** Tracking-plan type name, e.g. "string", "int", "float", "bool", "object" (not validated) */
  type: string;
  /** Whether the property is required (a missing value fails only when it is) */
  required: boolean;
  /** True when the property is a list of `type` */
  isList?: boolean;
  /** Pinned values: exact value -> event IDs that require it */
  pinnedValues?: Record<string, string[]>;
  /** Allowed values: JSON array of strings -> event IDs that accept only those values */
  allowedValues?: Record<string, string[]>;
  /** Regex patterns: pattern -> event IDs that require a match */
  regexPatterns?: Record<string, string[]>;
  /** Ranges: "min,max" (either bound may be empty) -> event IDs that require it */
  minMaxRanges?: Record<string, string[]>;
  /** Constraints on the properties of an object, or of each object in a list */
  children?: Record<string, PropertyConstraints>;
}

/** One tracking-plan event matching the requested name: its base event and variants. */
export interface EventSpecEntry {
  branchId: string;
  baseEventId: string;
  variantIds: string[];
  /** Only the properties that carry value constraints */
  props: Record<string, PropertyConstraints>;
}

/** The spec for an event name, as returned by the API. */
export interface EventSpec {
  eventName: string;
  /** Several entries when name mapping matches more than one event */
  events: EventSpecEntry[];
}

/** Metadata identifying the spec source. */
export interface EventSpecMetadata {
  schemaId: string;
  branchId: string;
  latestActionId: string;
  sourceId: string;
}

/** Full response from the spec endpoint. */
export interface EventSpecResponse {
  eventSpec: EventSpec | null;
  metadata: EventSpecMetadata;
}

/**
 * The outcome for one property: the tracking-plan event IDs whose constraints the value
 * breaks, and the outcome for the object's properties when it has any.
 */
export interface PropertyValidationOutcome {
  failedEventIds: string[];
  children?: Record<string, PropertyValidationOutcome>;
}

/** Per-property validation result. */
export interface PropertyValidationResult extends PropertyValidationOutcome {
  propertyName: string;
}
