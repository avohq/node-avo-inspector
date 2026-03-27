import safeRegex from "safe-regex2";
import {
  EventSpec,
  PropertyValidationResult,
} from "./AvoEventSpecFetchTypes";

interface EventProperty {
  propertyName: string;
  propertyType: string;
  propertyValue?: string;
}

export class EventValidator {
  /**
   * Validates event properties against the spec.
   * Returns per-property validation results with bandwidth optimization:
   * passedEventIds is returned only when strictly smaller than failedEventIds.
   */
  validate(
    spec: EventSpec,
    eventProperties: EventProperty[],
    eventId: string
  ): PropertyValidationResult[] {
    const results: PropertyValidationResult[] = [];
    const eventPropMap = new Map<string, EventProperty>();

    for (const prop of eventProperties) {
      eventPropMap.set(prop.propertyName, prop);
    }

    for (const specProp of spec.properties) {
      const actualProp = eventPropMap.get(specProp.propertyName);
      let passed = false;

      if (actualProp) {
        // Type check
        passed = actualProp.propertyType === specProp.propertyType;

        // Regex check (only if type passed, regex is defined, and value is available)
        if (passed && specProp.regex && actualProp.propertyValue !== undefined) {
          if (!safeRegex(specProp.regex)) {
            console.warn(
              `[Avo Inspector] Warning: Unsafe regex pattern skipped for property "${specProp.propertyName}": ${specProp.regex}`
            );
          } else {
            try {
              const re = new RegExp(specProp.regex);
              passed = re.test(actualProp.propertyValue);
            } catch (e) {
              console.warn(
                `[Avo Inspector] Warning: Invalid regex pattern for property "${specProp.propertyName}": ${specProp.regex}`
              );
            }
          }
        }
      }

      const result: PropertyValidationResult = {
        propertyName: specProp.propertyName,
        failedEventIds: passed ? [] : [eventId],
        passedEventIds: passed ? [eventId] : [],
      };

      // Bandwidth optimization: return passedEventIds only when strictly smaller than failedEventIds
      if (result.passedEventIds.length >= result.failedEventIds.length) {
        result.passedEventIds = [];
      }

      results.push(result);
    }

    return results;
  }
}
