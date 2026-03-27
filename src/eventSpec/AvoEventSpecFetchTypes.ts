/**
 * Type definitions for Event Spec validation responses.
 */

/** A single property constraint from the spec. */
export interface PropertyConstraint {
  propertyName: string;
  /** Expected type, e.g. "string", "int", "float", "boolean", "object", "list(string)" */
  propertyType: string;
  /** Optional regex pattern that the value must match */
  regex?: string;
}

/** The spec for a single event, as returned by the API. */
export interface EventSpec {
  eventName: string;
  properties: PropertyConstraint[];
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

/** Per-property validation result. */
export interface PropertyValidationResult {
  propertyName: string;
  failedEventIds: string[];
  passedEventIds: string[];
}

/** Payload sent to reportValidatedEvent. */
export interface ValidatedEventPayload {
  streamId: string;
  eventName: string;
  eventSpecMetadata: EventSpecMetadata;
  propertyResults: PropertyValidationResult[];
}
