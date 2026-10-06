/** True for null, undefined, or a string that is empty after trimming. */
const isValueEmpty = (value: string | null | undefined): boolean => {
  return value === null || value === undefined || value.trim().length == 0;
};

/**
 * Structural equality. `comparing` holds the object pairs already being compared further
 * up the recursion, so cyclic structures terminate: a pair met again is assumed equal
 * (its other properties are still compared where it was first met).
 */
function deepEquals(x: any, y: any, comparing: Map<object, Set<object>> = new Map()) {

  if (x === y) {
    return true;
  }

  // typeof, not instanceof Object: a null-prototype object is not an instance of Object.
  if (x === null || y === null || typeof x !== "object" || typeof y !== "object") {
    return false;
  }

  if (Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) {
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

  // hasOwn, not x.hasOwnProperty: user objects may lack the method or shadow it.
  for (const p of Object.keys(x)) {
    if (!hasOwn(y, p)) {
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

  for (const p of Object.keys(y)) {
    if (!hasOwn(x, p)) {
      return false;
    }
  }
  return true;
}

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** Trims a gateway option value; anything that is not a non-blank string is absent. */
const normalizeOption = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * No control character (Unicode Cc: C0, DEL, C1) may reach a header value; CR, LF and NUL
 * would split or end the header field. Tab is the one exception: it is valid in a value.
 */
const hasHeaderControlChar = (value: string): boolean =>
  /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/.test(value);

/** Node sends header values as Latin-1 and throws synchronously on anything above U+00FF. */
const hasNonLatin1Char = (value: string): boolean => /[^\u0000-\u00FF]/.test(value);

/**
 * Milliseconds from a monotonic clock (process.hrtime): only differences are meaningful, and
 * they never jump with wall-clock changes. Shared by the deduplicator, AvoLog and the exit
 * drain deadline.
 */
const monotonicNowMs = (): number => Number(process.hrtime.bigint()) / 1e6;

export { monotonicNowMs, isValueEmpty, deepEquals, normalizeOption, hasHeaderControlChar, hasNonLatin1Char };
