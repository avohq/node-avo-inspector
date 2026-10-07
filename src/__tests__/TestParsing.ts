import { AvoInspector } from "../AvoInspector";
import { AvoSchemaParser } from "../AvoSchemaParser";
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

  describe("a null list element is the type null (spec §9.2)", () => {
    test.each([
      [["a", null], ["string", "null"]],
      [[null, 1], ["null", "int"]],
    ])("%j maps its elements to %j", (list, children) => {
      const [entry] = inspector.extractSchema({ v: list });

      expect(entry.children).toEqual(children);
    });

    test("a null inside a list of objects is typed, not dropped", () => {
      expect(inspector.extractSchema({ v: [{ a: null, b: [null] }] })).toEqual([
        {
          propertyName: "v",
          propertyType: "list(object)",
          children: [[
            { propertyName: "a", propertyType: "null" },
            { propertyName: "b", propertyType: "list(string)", children: ["null"] },
          ]],
        },
      ]);
    });
  });

  describe("a root that is not a plain object", () => {
    test.each([
      ["a string", "abc"],
      ["an int", 42],
      ["a float", 1.5],
      ["a boolean", true],
      ["an array", [1, 2]],
      ["an array of objects", [{ a: 1 }]],
      ["a function", () => 1],
      ["a symbol", Symbol("s")],
    ])("maps to [] for %s, not a bare type or a list", (_name, root) => {
      expect(AvoSchemaParser.extractSchema(root as any)).toEqual([]);
      expect(inspector.extractSchema(root as any)).toEqual([]);
    });
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

    test("a cyclic object is cut at the repeat instead of yielding [], with logging on", () => {
      const cyclic: any = { name: "root" };
      cyclic.self = cyclic;
      // Logging stringifies the input, which must not throw on a cycle.
      const log = jest.spyOn(console, "log").mockImplementation(() => {});
      inspector.enableLogging(true);

      let schema: any[];
      try {
        schema = inspector.extractSchema(cyclic);
      } finally {
        inspector.enableLogging(false);
        log.mockRestore();
      }

      expect(schema).toEqual([
        { propertyName: "name", propertyType: "string" },
        { propertyName: "self", propertyType: "object", children: [] },
      ]);
    });
  });

  describe("cycles are cut by ancestor identity", () => {
    test("an object holding itself under several keys is not expanded", () => {
      const o: any = { n: 1 };
      o.a = o;
      o.b = o;
      o.c = o;

      expect(inspector.extractSchema(o)).toEqual([
        { propertyName: "n", propertyType: "int" },
        { propertyName: "a", propertyType: "object", children: [] },
        { propertyName: "b", propertyType: "object", children: [] },
        { propertyName: "c", propertyType: "object", children: [] },
      ]);
    });

    test("an object holding itself under 5 keys finishes fast with a small schema", () => {
      // Without the ancestor check this expands to about 5^10 (~10M) nodes.
      const o: any = {};
      for (const key of ["a", "b", "c", "d", "e"]) o[key] = o;

      const started = Date.now();
      const schema = inspector.extractSchema(o);

      expect(Date.now() - started).toBeLessThan(1000);
      expect(schema).toEqual(
        ["a", "b", "c", "d", "e"].map((key) => ({ propertyName: key, propertyType: "object", children: [] }))
      );
    }, 5000);

    test("an array containing itself maps that element to the type string object", () => {
      const list: any[] = [1];
      list.push(list);

      expect(inspector.extractSchema({ list })).toEqual([
        { propertyName: "list", propertyType: "list(int)", children: ["int", "object"] },
      ]);
    });

    test("a list element that is an ancestor object maps to object", () => {
      const o: any = { n: 1 };
      o.items = [o];

      expect(inspector.extractSchema(o)).toEqual([
        { propertyName: "n", propertyType: "int" },
        { propertyName: "items", propertyType: "list(object)", children: ["object"] },
      ]);
    });

    test("a shared reference that is not an ancestor is expanded each time", () => {
      const shared = { v: 1 };

      expect(inspector.extractSchema({ a: shared, b: shared })).toEqual([
        { propertyName: "a", propertyType: "object", children: [{ propertyName: "v", propertyType: "int" }] },
        { propertyName: "b", propertyType: "object", children: [{ propertyName: "v", propertyType: "int" }] },
      ]);
    });

    test("shared references expand at most 10000 objects and lists per call; the rest map to object", () => {
      // Every list holds the next under 4 elements: a DAG, not a cycle, so the ancestor
      // check does not apply. Lists, so the 10,000-property budget is not what stops it.
      // Unbounded, it expands 4^0 + ... + 4^7 (~22k) lists within the depth cap.
      let level: any = [1];
      for (let i = 0; i < 7; i += 1) level = [level, level, level, level];

      let expanded = 0;
      let truncated = 0;
      const walk = (elements: any[]) =>
        elements.forEach((element) => {
          if (Array.isArray(element)) {
            expanded += 1;
            walk(element);
          } else if (element === "object") {
            truncated += 1;
          }
        });
      const schema = inspector.extractSchema({ l: level });
      expanded += 1; // the list under "l"
      walk(schema[0].children);

      // The root object counts toward the 10,000 but is not a list.
      expect(expanded).toBe(9999);
      expect(truncated).toBeGreaterThan(0);
    });

    test("a DAG of objects is cut off by the 10,000-property budget", () => {
      let level: any = { v: 1 };
      for (let i = 0; i < 12; i += 1) level = { a: level, b: level, c: level };

      let entries = 0;
      const walk = (list: any[]) =>
        list.forEach((entry) => {
          entries += 1;
          if (entry.children) walk(entry.children);
        });
      walk(inspector.extractSchema(level));

      expect(entries).toBe(10_000);
    });

    test("an array element past the expansion budget maps to the type string object", () => {
      const list = Array.from({ length: 10001 }, () => ({ v: 1 }));

      const [entry] = inspector.extractSchema({ list });

      // Expanded elements are distinct arrays, so removeDuplicates keeps each; the
      // "object" strings past the budget collapse into one.
      // The event properties object and the list count toward the 10,000: 9,998 expanded
      // elements, then one collapsed "object".
      expect(entry.children.length).toBe(9999);
      expect(entry.children[0]).toEqual([{ propertyName: "v", propertyType: "int" }]);
      expect(entry.children[entry.children.length - 1]).toBe("object");
    });
  });

  test("A list whose first element has no JSON type is list(object), never list(unknown)", () => {
    const eventProperties = {
      prop0: [() => 1, "two"],
      prop1: [Symbol("s")],
    };

    const res = inspector.extractSchema(eventProperties);

    expect(res).toEqual([
      { propertyName: "prop0", propertyType: type.OBJECTLIST, children: ["unknown", "string"] },
      { propertyName: "prop1", propertyType: type.OBJECTLIST, children: ["unknown"] },
    ]);
  });


});
