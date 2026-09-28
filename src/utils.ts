const isValueEmpty = (value: string | null | undefined): boolean => {
  return value === null || value === undefined || value.trim().length == 0;
};

// `comparing` holds the object pairs already being compared further up the recursion, so
// cyclic structures terminate: a pair met again is assumed equal (its other properties
// are still compared where it was first met).
function deepEquals(x: any, y: any, comparing: Map<object, Set<object>> = new Map()) {

  if (x === y) {
    return true;
  }

  if (!(x instanceof Object) || !(y instanceof Object)) {
    return false;
  }

  if (x.constructor !== y.constructor) {
    return false;
  }

  let partners = comparing.get(x);
  if (partners && partners.has(y)) {
    return true;
  }
  if (!partners) {
    partners = new Set();
    comparing.set(x, partners);
  }
  partners.add(y);

  for (var p in x) {
    if (!x.hasOwnProperty(p)) {
      continue;
    }

    if (!y.hasOwnProperty(p)) {
      return false;
    }

    if (x[p] === y[p]) {
      continue;
    }

    if (typeof x[p] !== "object") {
      return false;
    }

    if (!deepEquals(x[p], y[p], comparing)) {
      return false;
    }
  }

  for (p in y) {
    if (y.hasOwnProperty(p) && !x.hasOwnProperty(p)) {
      return false;
    }
  }
  return true;
}

// Trims a gateway option value; anything that is not a non-blank string is absent.
const normalizeOption = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// CR, LF and NUL delimit HTTP/1.1 header fields and must never reach a header value.
const hasHeaderControlChar = (value: string): boolean => /[\r\n\0]/.test(value);

// JSON for log lines only: a repeated object reference is written as "[Circular]" instead
// of throwing on cyclic input.
const safeStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    return String(
      JSON.stringify(value, (_key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) {
            return "[Circular]";
          }
          seen.add(val);
        }
        return val;
      })
    );
  } catch (e) {
    return "[unserializable]";
  }
};

export { isValueEmpty, deepEquals, safeStringify, normalizeOption, hasHeaderControlChar };
