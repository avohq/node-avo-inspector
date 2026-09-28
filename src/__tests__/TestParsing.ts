import { AvoInspector } from "../AvoInspector";
import { defaultOptions, type } from "./constants";

describe("Schema Parsing", () => {
  const inspector = new AvoInspector(defaultOptions);

  beforeAll(() => {
    inspector.enableLogging(false);
  });

  test("Empty array returned if eventProperties are not set", () => {
    // @ts-ignore
    const schema = inspector.extractSchema();

    expect(schema).toEqual([]);
  });

  test("Property types and names are set", () => {
    // Given
    const eventProperties = {
      prop0: true,
      prop1: 1,
      prop2: "str",
      prop3: 0.5,
      prop4: undefined,
      prop5: null,
      prop6: { an: "object" },
      prop7: [
        "a",
        "list",
        {
          "obj in list": true,
          "int field": 1,
        },
        ["another", "list"],
        [1, 2],
      ],
    };

    // When
    const res = inspector.extractSchema(eventProperties);

    // Then
    res.forEach(({ propertyName }, index) => {
      expect(propertyName).toBe(`prop${index}`);
    });

    expect(res[0].propertyType).toBe(type.BOOL);
    expect(res[1].propertyType).toBe(type.INT);
    expect(res[2].propertyType).toBe(type.STRING);
    expect(res[3].propertyType).toBe(type.FLOAT);
    expect(res[4].propertyType).toBe(type.NULL);
    expect(res[5].propertyType).toBe(type.NULL);

    expect(res[6].propertyType).toBe(type.OBJECT);
    expect(res[6].children).toMatchObject([
      {
        propertyName: "an",
        propertyType: type.STRING,
      },
    ]);

    expect(res[7].propertyType).toBe(type.STRINGLIST);
    expect(res[7].children).toMatchObject([
      type.STRING,
      [
        {
          propertyName: "obj in list",
          propertyType: type.BOOL,
        },
        {
          propertyName: "int field",
          propertyType: type.INT,
        },
      ],
      [type.STRING],
      [type.INT],
    ]);
  });

  test("Duplicated values are removed", () => {
    // Given
    const eventProperties = {
      prop0: ["true", "false", true, 10, "true", true, 11, 10, 0.1, 0.1],
    };

    // When
    const res = inspector.extractSchema(eventProperties);

    // Then
    expect(res[0].propertyType).toBe(type.STRINGLIST);
  });

  test("Empty and falsy values are set correctly", () => {
    // Given
    const eventProperties = {
      prop0: false,
      prop1: 0,
      prop2: "",
      prop3: 0.0,
      prop4: undefined,
      prop5: null,
      prop6: {},
      prop7: [],
    };

    // When
    const res = inspector.extractSchema(eventProperties);

    // Then
    expect(res[0].propertyType).toBe(type.BOOL);
    expect(res[1].propertyType).toBe(type.INT);
    expect(res[2].propertyType).toBe(type.STRING);
    expect(res[3].propertyType).toBe(type.INT);
    expect(res[4].propertyType).toBe(type.NULL);
    expect(res[5].propertyType).toBe(type.NULL);

    expect(res[6].propertyType).toBe(type.OBJECT);
    expect(res[6].children).toMatchObject([]);

    expect(res[7].propertyType).toBe(type.STRINGLIST);
    expect(res[7].children).toMatchObject([]);
  });

  test("List of string returns list(string)", () => {
    // Given
    const eventProperties = {
      prop0: ["a", "b", "c"],
    };

    // When
    const res = inspector.extractSchema(eventProperties);

    // Then
    expect(res[0].propertyType).toBe(type.STRINGLIST);
  });


  test("List of multiple types returns list(`firstType`)", () => {
    // Given
    const eventProperties = {
      prop0: [1.2, "two", {"three": 3}],
    };

    // When
    const res = inspector.extractSchema(eventProperties);

    // Then
    expect(res[0].propertyType).toBe(type.FLOATLIST);
  });

  describe("depth cap (10 levels)", () => {
    const nest = (levels: number, leaf: any): any =>
      levels === 0 ? leaf : { next: nest(levels - 1, leaf) };

    // Follows `next` down `levels` times from the top-level entry, which is at depth 0,
    // so the entry returned is at depth `levels`.
    const descend = (schema: any[], levels: number): any => {
      let entry = schema[0];
      for (let i = 0; i < levels; i++) entry = entry.children[0];
      return entry;
    };

    test("an object nested deeper than the cap becomes an object leaf with empty children", () => {
      const schema = inspector.extractSchema(nest(15, 1));

      expect(descend(schema, 9)).toMatchObject({ propertyName: "next", propertyType: "object" });
      expect(descend(schema, 9).children).toHaveLength(1);
      expect(descend(schema, 10)).toEqual({ propertyName: "next", propertyType: "object", children: [] });
    });

    test("a scalar at the cap is still classified", () => {
      const schema = inspector.extractSchema(nest(11, 1));

      expect(descend(schema, 10)).toEqual({ propertyName: "next", propertyType: "int" });
    });

    test("a list at the cap is reported as an object with empty children", () => {
      const schema = inspector.extractSchema(nest(11, [1, 2]));

      expect(descend(schema, 10)).toEqual({ propertyName: "next", propertyType: "object", children: [] });
    });

    test("complex list elements at the cap become the type string object", () => {
      const schema = inspector.extractSchema(nest(10, [{ a: 1 }, [2], "s"]));

      expect(descend(schema, 9)).toEqual({
        propertyName: "next",
        propertyType: "list(object)",
        children: ["object", "string"],
      });
    });

    test("a cyclic object is truncated at the cap instead of yielding []", () => {
      const cyclic: any = { name: "root" };
      cyclic.self = cyclic;

      const schema = inspector.extractSchema(cyclic);

      expect(schema[0]).toEqual({ propertyName: "name", propertyType: "string" });
      let entry = schema[1];
      for (let i = 0; i < 10; i++) {
        expect(entry).toMatchObject({ propertyName: "self", propertyType: "object" });
        entry = entry.children[1];
      }
      expect(entry).toEqual({ propertyName: "self", propertyType: "object", children: [] });
    });
  });

  test("A list whose first element has no JSON type is list(object), never list(unknown)", () => {
    const eventProperties = {
      prop0: [() => 1, "two"],
      prop1: [Symbol("s")],
    };

    const res = inspector.extractSchema(eventProperties);

    expect(res[0].propertyType).toBe(type.OBJECTLIST);
    expect(res[1].propertyType).toBe(type.OBJECTLIST);
  });


});
