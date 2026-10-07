let isArray = (obj: any): boolean => {
  return Object.prototype.toString.call(obj) === "[object Array]";
};

let isComplex = (value: any): boolean => {
  return typeof value === "object" && value != null;
};

// Binary data is a leaf, never enumerated (a Buffer has one indexed key per byte): an
// ArrayBuffer view (Buffer, typed array, DataView) is a list typed from its element type, an
// ArrayBuffer or SharedArrayBuffer an object with no properties.
const binaryElementType = (value: any): string | null => {
  if (!ArrayBuffer.isView(value)) {
    return null;
  }
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Float32Array]" || tag === "[object Float64Array]" || tag === "[object Float16Array]"
    ? "float"
    : "int";
};
const isArrayBufferLike = (value: any): boolean => {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
};
// A view's children: its element type, or none when it is empty.
const binaryChildren = (value: ArrayBufferView, elementType: string): string[] =>
  value.byteLength > 0 ? [elementType] : [];

// Deeper complex values are reported as "object" instead of being descended into.
const MAX_DEPTH = 10;
// Complex values expanded per extractSchema call. Shared references that are not cycles
// can otherwise expand exponentially; the rest are reported as "object" like the depth cap.
const MAX_EXPANSIONS = 10000;
// Properties emitted per extractSchema call, at every depth; past it the rest are omitted
// (in iteration order). Independent of MAX_EXPANSIONS: one object with a million keys is a
// single expansion.
const MAX_PROPERTIES = 10000;

export class AvoSchemaParser {
  /**
   * Maps each property to its name, type and (for objects and lists) child schema.
   * Values nested deeper than MAX_DEPTH, cyclic references, and complex values past the
   * MAX_EXPANSIONS budget are reported as "object".
   */
  static extractSchema(eventProperties: {
    [propName: string]: any;
  }): Array<{
    propertyName: string;
    propertyType: string;
    children?: any;
  }> {
    // Only a plain object has named properties. JavaScript callers can pass anything, and
    // mapping a primitive or an array root would return a bare type or an element list.
    if (!isComplex(eventProperties) || isArray(eventProperties)) {
      return [];
    }

    // Objects and arrays on the path from the root to the value being mapped. A value that
    // is its own ancestor (a cycle) is reported like one past the depth cap, so an object
    // holding itself under several keys cannot expand exponentially.
    const ancestors = new Set<any>();
    let expansions = 0;
    let properties = 0;
    const isLeaf = (value: any, depth: number): boolean =>
      isComplex(value) &&
      (depth >= MAX_DEPTH || ancestors.has(value) || expansions >= MAX_EXPANSIONS);

    let mapping = (object: any, depth: number) => {
      if (isComplex(object)) {
        ancestors.add(object);
        expansions += 1;
      }
      try {
        return mapValue(object, depth);
      } finally {
        ancestors.delete(object);
      }
    };

    let mapValue = (object: any, depth: number): any => {
      const elementType = binaryElementType(object);
      if (elementType !== null) {
        return binaryChildren(object, elementType);
      }
      if (isArrayBufferLike(object)) {
        return [];
      }
      if (isArray(object)) {
        let list = object.map((x: any) => {
          return isLeaf(x, depth) ? "object" : mapping(x, depth + 1);
        });
        return this.removeDuplicates(list);
      } else if (isComplex(object)) {
        // isComplex, not typeof: a null list element is the type "null" (spec §9.2), not
        // an object to enumerate.
        let mappedResult: any = [];
        // Object.keys, not object.hasOwnProperty: a null-prototype object has no such method,
        // and a property named "hasOwnProperty" would shadow it.
        for (const key of Object.keys(object)) {
          if (properties >= MAX_PROPERTIES) {
            break;
          }
          properties += 1;
          let val = object[key];

          let mappedEntry: {
            propertyName: string;
            propertyType: string;
            children?: any;
          } = {
            propertyName: key,
            propertyType: this.getPropValueType(val),
          };

          const valElementType = binaryElementType(val);
          if (valElementType !== null) {
            mappedEntry["children"] = binaryChildren(val, valElementType);
          } else if (isArrayBufferLike(val)) {
            mappedEntry["children"] = [];
          } else if (isComplex(val)) {
            if (isLeaf(val, depth)) {
              mappedEntry.propertyType = "object";
              mappedEntry["children"] = [];
            } else {
              mappedEntry["children"] = mapping(val, depth + 1);
            }
          }

          mappedResult.push(mappedEntry);
        }

        return mappedResult;
      } else {
        return this.getPropValueType(object);
      }
    };

    var mappedEventProps = mapping(eventProperties, 0);

    return mappedEventProps;
  }

  private static removeDuplicates(array: Array<any>): Array<any> {
    // XXX TODO fix any types
    var primitives: any = { boolean: {}, number: {}, string: {} };
    var objects: Array<any> = [];

    return array.filter((item: any) => {
      var type: string = typeof item;
      if (type in primitives) {
        return primitives[type].hasOwnProperty(item)
          ? false
          : (primitives[type][item] = true);
      } else {
        return objects.indexOf(item) >= 0 ? false : objects.push(item);
      }
    });
  }


  private static getBasicPropType(propValue: any): string {
    let propType = typeof propValue;
    if (propValue == null) {
      return "null";
    } else if (propType === "string") {
      return "string";
    } else if (propType === "bigint") {
      return "int";
    } else if (propType === "number") {
      // Whole numbers (including 0.0, which JS cannot tell from 0) are "int"; everything
      // else, including exponent forms like 1e-7, NaN and ±Infinity, is "float".
      return Number.isInteger(propValue) ? "int" : "float";
    } else if (propType === "boolean") {
      return "boolean";
    } else if (propType === "object") {
      return "object"
  }
  else {
  return "unknown";
  }
}

  private static getPropValueType(propValue: any): string {
    const elementType = binaryElementType(propValue);
    if (elementType !== null) {
      return `list(${elementType})`;
    }
    if (isArray(propValue)){

      //we now know that propValue is an array. get first element in propValue array
      let propElement = propValue[0];

      if (propElement == null) {
        return "list(string)"; // Default to list(string) if the list is empty.
      }
      else {
      let propElementType = this.getBasicPropType(propElement);
      // "list(unknown)" is not a wire type; elements with no JSON type count as objects.
      if (propElementType === "unknown") {
        propElementType = "object";
      }
      return `list(${propElementType})`
      }
    }
    else {
      return this.getBasicPropType(propValue);
    }
  }
}
