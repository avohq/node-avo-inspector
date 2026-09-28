let isArray = (obj: any): boolean => {
  return Object.prototype.toString.call(obj) === "[object Array]";
};

let isComplex = (value: any): boolean => {
  return typeof value === "object" && value != null;
};

// Deeper complex values are reported as "object" instead of being descended into, which
// also keeps cyclic input finite.
const MAX_DEPTH = 10;

export class AvoSchemaParser {
  static extractSchema(eventProperties: {
    [propName: string]: any;
  }): Array<{
    propertyName: string;
    propertyType: string;
    children?: any;
  }> {
    if (eventProperties === null || eventProperties === undefined) {
      return [];
    }

    let mapping = (object: any, depth: number) => {
      if (isArray(object)) {
        let list = object.map((x: any) => {
          return depth >= MAX_DEPTH && isComplex(x) ? "object" : mapping(x, depth + 1);
        });
        return this.removeDuplicates(list);
      } else if (typeof object === "object") {
        let mappedResult: any = [];
        for (var key in object) {
          if (object.hasOwnProperty(key)) {
            let val = object[key];

            let mappedEntry: {
              propertyName: string;
              propertyType: string;
              children?: any;
            } = {
              propertyName: key,
              propertyType: this.getPropValueType(val),
            };

            if (isComplex(val)) {
              if (depth >= MAX_DEPTH) {
                mappedEntry.propertyType = "object";
                mappedEntry["children"] = [];
              } else {
                mappedEntry["children"] = mapping(val, depth + 1);
              }
            }

            mappedResult.push(mappedEntry);
          }
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
    } else if (propType === "number" || propType === "bigint") {
      if ((propValue + "").indexOf(".") >= 0) {
        return "float";
      } else {
        return "int";
      }
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
