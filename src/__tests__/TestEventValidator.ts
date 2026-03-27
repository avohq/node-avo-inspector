import { EventValidator } from "../eventSpec/EventValidator";
import { EventSpec, PropertyConstraint, PropertyValidationResult } from "../eventSpec/AvoEventSpecFetchTypes";

// We need to mock safe-regex2 for some tests
jest.mock("safe-regex2", () => {
  const actual = jest.requireActual("safe-regex2");
  return {
    __esModule: true,
    default: actual.default || actual,
    _mockable: true,
  };
});

describe("EventValidator", () => {
  let validator: EventValidator;

  beforeEach(() => {
    validator = new EventValidator();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("type validation", () => {
    test("passes when property types match spec", () => {
      const spec: EventSpec = {
        eventName: "click",
        properties: [
          { propertyName: "target", propertyType: "string" },
          { propertyName: "count", propertyType: "int" },
        ],
      };
      const eventProperties = [
        { propertyName: "target", propertyType: "string" },
        { propertyName: "count", propertyType: "int" },
      ];

      const results = validator.validate(spec, eventProperties, "evt-1");
      // All properties passed type check, so failedEventIds should be empty
      expect(results.every((r: PropertyValidationResult) => r.failedEventIds.length === 0)).toBe(true);
      // Bandwidth optimization: passedEventIds cleared because passed >= failed for each property
      expect(results.every((r: PropertyValidationResult) => r.passedEventIds.length === 0)).toBe(true);
    });

    test("fails when property type does not match spec", () => {
      const spec: EventSpec = {
        eventName: "click",
        properties: [{ propertyName: "count", propertyType: "int" }],
      };
      const eventProperties = [
        { propertyName: "count", propertyType: "string" },
      ];

      const results = validator.validate(spec, eventProperties, "evt-2");
      const countResult = results.find((r: PropertyValidationResult) => r.propertyName === "count");
      expect(countResult?.failedEventIds).toContain("evt-2");
      expect(countResult?.passedEventIds).not.toContain("evt-2");
    });

    test("fails for missing required properties", () => {
      const spec: EventSpec = {
        eventName: "click",
        properties: [
          { propertyName: "target", propertyType: "string" },
          { propertyName: "count", propertyType: "int" },
        ],
      };
      const eventProperties = [
        { propertyName: "target", propertyType: "string" },
        // count is missing
      ];

      const results = validator.validate(spec, eventProperties, "evt-3");
      const countResult = results.find((r: PropertyValidationResult) => r.propertyName === "count");
      expect(countResult?.failedEventIds).toContain("evt-3");
    });
  });

  describe("regex validation", () => {
    test("passes when value matches safe regex pattern (type match)", () => {
      const spec: EventSpec = {
        eventName: "navigate",
        properties: [
          {
            propertyName: "url",
            propertyType: "string",
            regex: "^https://",
          },
        ],
      };
      const eventProperties = [
        { propertyName: "url", propertyType: "string", propertyValue: "https://example.com" },
      ];

      const results = validator.validate(spec, eventProperties, "evt-4");
      const urlResult = results.find((r: PropertyValidationResult) => r.propertyName === "url");
      // Type matches and regex matches, property passed. Bandwidth optimization: passedEventIds cleared
      // because passed count (1) >= failed count (0)
      expect(urlResult?.failedEventIds).toEqual([]);
    });

    test("fails when value does not match safe regex pattern", () => {
      const spec: EventSpec = {
        eventName: "navigate",
        properties: [
          {
            propertyName: "url",
            propertyType: "string",
            regex: "^https://",
          },
        ],
      };
      const eventProperties = [
        { propertyName: "url", propertyType: "string", propertyValue: "http://example.com" },
      ];

      const results = validator.validate(spec, eventProperties, "evt-regex-fail");
      const urlResult = results.find((r: PropertyValidationResult) => r.propertyName === "url");
      expect(urlResult?.failedEventIds).toContain("evt-regex-fail");
      expect(urlResult?.passedEventIds).not.toContain("evt-regex-fail");
    });

    test("logs warning and passes type check when regex syntax is invalid", () => {
      const spec: EventSpec = {
        eventName: "filter",
        properties: [
          {
            propertyName: "pattern",
            propertyType: "string",
            regex: "[invalid",
          },
        ],
      };
      const eventProperties = [
        { propertyName: "pattern", propertyType: "string", propertyValue: "anything" },
      ];

      const results = validator.validate(spec, eventProperties, "evt-bad-regex");
      const patternResult = results.find((r: PropertyValidationResult) => r.propertyName === "pattern");
      // Invalid regex is caught, property still passes type check
      expect(patternResult?.failedEventIds).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("[Avo Inspector] Warning")
      );
    });

    test("skips unsafe regex patterns with warning", () => {
      const spec: EventSpec = {
        eventName: "search",
        properties: [
          {
            propertyName: "query",
            propertyType: "string",
            // Catastrophic backtracking pattern
            regex: "(a+)+$",
          },
        ],
      };
      const eventProperties = [
        { propertyName: "query", propertyType: "string", propertyValue: "aaa" },
      ];

      const results = validator.validate(spec, eventProperties, "evt-5");
      // Unsafe regex should be skipped, property still passes type check
      const queryResult = results.find((r: PropertyValidationResult) => r.propertyName === "query");
      // Bandwidth optimization: passedEventIds cleared because passed count >= failed count
      expect(queryResult?.failedEventIds).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("[Avo Inspector] Warning")
      );
    });
  });

  describe("extra/unexpected properties", () => {
    test("ignores properties present in event but not in the spec", () => {
      const spec: EventSpec = {
        eventName: "click",
        properties: [
          { propertyName: "target", propertyType: "string" },
        ],
      };
      const eventProperties = [
        { propertyName: "target", propertyType: "string" },
        { propertyName: "extraProp", propertyType: "int" },
        { propertyName: "anotherExtra", propertyType: "boolean" },
      ];

      const results = validator.validate(spec, eventProperties, "evt-extra");
      // Only spec properties get results — extra properties are not reported
      expect(results).toHaveLength(1);
      expect(results[0].propertyName).toBe("target");
      expect(results.find((r: PropertyValidationResult) => r.propertyName === "extraProp")).toBeUndefined();
      expect(results.find((r: PropertyValidationResult) => r.propertyName === "anotherExtra")).toBeUndefined();
    });
  });

  describe("bandwidth optimization", () => {
    test("returns passedEventIds only when strictly smaller than failedEventIds", () => {
      const spec: EventSpec = {
        eventName: "click",
        properties: [{ propertyName: "target", propertyType: "string" }],
      };

      // Single pass
      const passResults = validator.validate(
        spec,
        [{ propertyName: "target", propertyType: "string" }],
        "evt-pass"
      );
      const passResult = passResults.find((r: PropertyValidationResult) => r.propertyName === "target");

      // When there's only passed and no failed, passedEventIds count (1) > failedEventIds count (0)
      // So passedEventIds is NOT strictly smaller - it should be returned
      // But the optimization says: return passedEventIds ONLY when strictly smaller than failedEventIds
      // So when passedEventIds.length >= failedEventIds.length, we clear passedEventIds
      expect(passResult?.passedEventIds).toEqual([]);

      // Single fail
      const failResults = validator.validate(
        spec,
        [{ propertyName: "target", propertyType: "int" }],
        "evt-fail"
      );
      const failResult = failResults.find((r: PropertyValidationResult) => r.propertyName === "target");
      // failedEventIds has 1, passedEventIds has 0 -> passedEventIds is strictly smaller, return it
      expect(failResult?.failedEventIds).toContain("evt-fail");
    });
  });
});
