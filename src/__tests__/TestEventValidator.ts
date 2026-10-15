import { EventValidator } from "../eventSpec/EventValidator";
import {
  EventSpec,
  EventSpecEntry,
  PropertyConstraints,
  PropertyValidationResult,
} from "../eventSpec/AvoEventSpecFetchTypes";

const entry = (
  props: Record<string, PropertyConstraints>,
  baseEventId = "evt",
  variantIds: string[] = []
): EventSpecEntry => ({ branchId: "main", baseEventId, variantIds, props });

const spec = (...events: EventSpecEntry[]): EventSpec => ({ eventName: "E", events });

const string = (constraints: Partial<PropertyConstraints> = {}): PropertyConstraints => ({
  type: "string",
  required: false,
  ...constraints,
});

const validate = (eventSpec: EventSpec, values: { [name: string]: any }): PropertyValidationResult[] =>
  new EventValidator().validate(
    eventSpec,
    Object.keys(values).map((propertyName) => ({ propertyName })),
    values
  );

const failedIds = (results: PropertyValidationResult[], name: string): string[] | undefined =>
  results.find((r) => r.propertyName === name)?.failedEventIds;

describe("EventValidator", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("allowed values", () => {
    const plans = spec(entry({ plan: string({ allowedValues: { '["free","pro"]': ["evt"] } }) }));

    test("passes a value in the list", () => {
      expect(validate(plans, { plan: "pro" })).toEqual([]);
    });

    test("fails a value outside the list", () => {
      expect(validate(plans, { plan: "Pro" })).toEqual([{ propertyName: "plan", failedEventIds: ["evt"] }]);
    });

    test("fails only the variants whose list does not have the value", () => {
      const variants = spec(
        entry(
          {
            plan: string({
              allowedValues: { '["free","pro"]': ["evt", "evt.v1"], '["free"]': ["evt.v2"] },
            }),
          },
          "evt",
          ["evt.v1", "evt.v2"]
        )
      );

      expect(failedIds(validate(variants, { plan: "pro" }), "plan")).toEqual(["evt.v2"]);
    });

    test("compares a non-string value as its string form", () => {
      const counts = spec(entry({ count: { type: "int", required: false, allowedValues: { '["1","2"]': ["evt"] } } }));

      expect(validate(counts, { count: 2 })).toEqual([]);
      expect(failedIds(validate(counts, { count: 3 }), "count")).toEqual(["evt"]);
    });

    test("skips a list that is not a JSON array of strings", () => {
      const broken = spec(entry({ plan: string({ allowedValues: { "not json": ["evt"], "[1,2]": ["evt"] } }) }));

      expect(validate(broken, { plan: "pro" })).toEqual([]);
    });
  });

  describe("pinned values", () => {
    test("passes the pinned value and fails any other", () => {
      const pinned = spec(entry({ method: string({ pinnedValues: { email: ["evt"], phone: ["evt.v1"] } }) }, "evt", ["evt.v1"]));

      expect(failedIds(validate(pinned, { method: "email" }), "method")).toEqual(["evt.v1"]);
      expect(failedIds(validate(pinned, { method: "sms" }), "method")).toEqual(["evt", "evt.v1"]);
    });

    test("compares a boolean as its string form", () => {
      const pinned = spec(entry({ isTrial: { type: "bool", required: false, pinnedValues: { true: ["evt"] } } }));

      expect(validate(pinned, { isTrial: true })).toEqual([]);
      expect(failedIds(validate(pinned, { isTrial: false }), "isTrial")).toEqual(["evt"]);
    });
  });

  describe("regex patterns", () => {
    test("passes a matching string and fails one that does not match", () => {
      const emails = spec(entry({ email: string({ regexPatterns: { "^[^@]+@[^@]+$": ["evt"] } }) }));

      expect(validate(emails, { email: "a@b.co" })).toEqual([]);
      expect(failedIds(validate(emails, { email: "nope" }), "email")).toEqual(["evt"]);
    });

    test("applies each pattern to its own event IDs", () => {
      const variants = spec(
        entry({ code: string({ regexPatterns: { "^[A-Z]+$": ["evt"], "^[A-Z]{3}$": ["evt.v1"] } }) }, "evt", ["evt.v1"])
      );

      expect(failedIds(validate(variants, { code: "ABCD" }), "code")).toEqual(["evt.v1"]);
    });

    test("fails a value that is not a string", () => {
      const codes = spec(entry({ code: string({ regexPatterns: { "^\\d+$": ["evt"] } }) }));

      expect(failedIds(validate(codes, { code: 123 }), "code")).toEqual(["evt"]);
    });

    test("skips an invalid pattern with a warning", () => {
      const invalid = spec(entry({ code: string({ regexPatterns: { "[unclosed-invalid": ["evt"] } }) }));

      expect(validate(invalid, { code: "anything" })).toEqual([]);
      // safe-regex2 already rejects a pattern it cannot parse, so it is reported as unsafe.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("regex pattern skipped: [unclosed-invalid"));
    });

    test("skips an unsafe pattern with a warning, once per pattern", () => {
      const unsafe = spec(entry({ code: string({ regexPatterns: { "(a+)+unsafe$": ["evt"] } }) }));

      expect(validate(unsafe, { code: "aaaa" })).toEqual([]);
      expect(validate(unsafe, { code: "aaaa" })).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unsafe regex pattern skipped: (a+)+unsafe$"));
    });
  });

  describe("min/max ranges", () => {
    const amounts = (range: string) =>
      spec(entry({ amount: { type: "float", required: false, minMaxRanges: { [range]: ["evt"] } } }));

    test.each([
      ["0,100", 0, true],
      ["0,100", 100, true],
      ["0,100", -0.5, false],
      ["0,100", 100.5, false],
      ["0,", 1e9, true],
      ["0,", -1, false],
      [",10", -1e9, true],
      [",10", 11, false],
    ])("range %p with %p passes: %p", (range, value, passes) => {
      expect(validate(amounts(range), { amount: value })).toEqual(passes ? [] : [{ propertyName: "amount", failedEventIds: ["evt"] }]);
    });

    test("checks a bigint as a number", () => {
      expect(validate(amounts("0,100"), { amount: BigInt(5) })).toEqual([]);
      expect(failedIds(validate(amounts("0,100"), { amount: BigInt(500) }), "amount")).toEqual(["evt"]);
    });

    test("fails NaN and values that are not numbers", () => {
      expect(failedIds(validate(amounts("0,100"), { amount: NaN }), "amount")).toEqual(["evt"]);
      expect(failedIds(validate(amounts("0,100"), { amount: "5" }), "amount")).toEqual(["evt"]);
    });

    test("skips a range that does not parse", () => {
      expect(validate(amounts("low,high"), { amount: 5 })).toEqual([]);
    });
  });

  describe("missing values", () => {
    test("does not check an optional property sent as null or undefined", () => {
      const plans = spec(entry({ plan: string({ allowedValues: { '["free"]': ["evt"] } }) }));

      expect(validate(plans, { plan: null })).toEqual([]);
      expect(validate(plans, { plan: undefined })).toEqual([]);
    });

    test("checks a required property sent as null", () => {
      const plans = spec(entry({ plan: string({ required: true, allowedValues: { '["free"]': ["evt"] } }) }));

      expect(failedIds(validate(plans, { plan: null }), "plan")).toEqual(["evt"]);
    });
  });

  describe("object properties", () => {
    const checkout = spec(
      entry({
        cart: {
          type: "object",
          required: false,
          children: {
            currency: string({ allowedValues: { '["EUR","USD"]': ["evt"] } }),
            total: { type: "float", required: false, minMaxRanges: { "0,": ["evt"] } },
          },
        },
      })
    );

    test("reports the failing object property under children", () => {
      expect(validate(checkout, { cart: { currency: "GBP", total: 10 } })).toEqual([
        { propertyName: "cart", failedEventIds: [], children: { currency: { failedEventIds: ["evt"] } } },
      ]);
    });

    test("passes an object whose properties all pass, or are optional and absent", () => {
      expect(validate(checkout, { cart: { currency: "EUR", total: 10 } })).toEqual([]);
      expect(validate(checkout, { cart: {} })).toEqual([]);
    });

    test("reads only the object's own properties", () => {
      const inherited = Object.create({ currency: "GBP" });

      expect(validate(checkout, { cart: inherited })).toEqual([]);
    });

    test("checks one level of nesting, not deeper", () => {
      const nested = spec(
        entry({
          a: {
            type: "object",
            required: false,
            children: {
              b: {
                type: "object",
                required: false,
                children: { c: string({ allowedValues: { '["ok"]': ["evt"] } }) },
              },
            },
          },
        })
      );

      expect(validate(nested, { a: { b: { c: "not ok" } } })).toEqual([]);
    });
  });

  describe("list properties", () => {
    test("fails a list of primitives when any item fails", () => {
      const tags = spec(entry({ tags: string({ isList: true, allowedValues: { '["a","b"]': ["evt"] } }) }));

      expect(validate(tags, { tags: ["a", "b"] })).toEqual([]);
      expect(failedIds(validate(tags, { tags: ["a", "c"] }), "tags")).toEqual(["evt"]);
    });

    test("fails an object property of a list of objects when any item's value fails", () => {
      const items = spec(
        entry({
          items: {
            type: "object",
            required: false,
            isList: true,
            children: { sku: string({ regexPatterns: { "^SKU-\\d+$": ["evt"] } }) },
          },
        })
      );

      expect(validate(items, { items: [{ sku: "SKU-1" }, { sku: "SKU-2" }] })).toEqual([]);
      expect(validate(items, { items: [{ sku: "SKU-1" }, { sku: "bad" }] })).toEqual([
        { propertyName: "items", failedEventIds: [], children: { sku: { failedEventIds: ["evt"] } } },
      ]);
    });

    test("does not check a list property whose value is not an array", () => {
      const tags = spec(entry({ tags: string({ isList: true, allowedValues: { '["a"]': ["evt"] } }) }));

      expect(validate(tags, { tags: "c" })).toEqual([]);
    });
  });

  describe("several matching events", () => {
    test("checks each event's constraints against its own IDs", () => {
      const mapped = spec(
        entry({ plan: string({ allowedValues: { '["free","pro"]': ["evt-a"] } }) }, "evt-a"),
        entry({ plan: string({ allowedValues: { '["free"]': ["evt-b"] } }) }, "evt-b")
      );

      expect(failedIds(validate(mapped, { plan: "pro" }), "plan")).toEqual(["evt-b"]);
    });

    test("checks a null value only when every event requires the property", () => {
      const allowed = { '["free"]': ["evt-a", "evt-b"] };
      const oneRequires = spec(
        entry({ plan: string({ required: true, allowedValues: allowed }) }, "evt-a"),
        entry({ plan: string({ required: false, allowedValues: allowed }) }, "evt-b")
      );

      expect(validate(oneRequires, { plan: null })).toEqual([]);
    });
  });

  test("leaves out properties the spec has no constraints for", () => {
    const plans = spec(entry({ plan: string({ allowedValues: { '["free"]': ["evt"] } }) }));

    expect(validate(plans, { plan: "pro", other: "x" })).toEqual([{ propertyName: "plan", failedEventIds: ["evt"] }]);
  });

  test("treats property names such as constructor as ordinary names", () => {
    const props: Record<string, PropertyConstraints> = Object.create(null);
    props["constructor"] = string({ allowedValues: { '["ok"]': ["evt"] } });
    const named = spec(entry(props));

    expect(failedIds(validate(named, { constructor: "no" }), "constructor")).toEqual(["evt"]);
    expect(validate(named, { toString: "x" })).toEqual([]);
  });
});
