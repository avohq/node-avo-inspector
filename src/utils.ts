/** True for null, undefined, or a string that is empty after trimming. */
const isValueEmpty = (value: string | null | undefined): boolean => {
  return value === null || value === undefined || value.trim().length == 0;
};

// The schema extraction limits: deepEquals expands no deeper and no more than this.
const DEEP_EQUALS_MAX_DEPTH = 10;
const DEEP_EQUALS_MAX_EXPANSIONS = 10_000;

/**
 * Structural equality, within the schema extraction limits: objects and lists nested more
 * than 10 levels deep, or past the 10,000th compared in one call, are treated as not equal
 * (unless they are the same reference), so a huge payload cannot overflow the stack.
 */
function deepEquals(x: any, y: any): boolean {
  return deepEqualsWithin(x, y, 0, new Map(), { expansions: 0 });
}

// `comparing` holds the object pairs already compared, so cyclic structures terminate: a
// pair met again is assumed equal (its other properties are still compared where it was
// first met).
function deepEqualsWithin(
  x: any,
  y: any,
  depth: number,
  comparing: Map<object, Set<object>>,
  budget: { expansions: number }
): boolean {

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

  if (depth >= DEEP_EQUALS_MAX_DEPTH || budget.expansions >= DEEP_EQUALS_MAX_EXPANSIONS) {
    return false;
  }
  budget.expansions++;

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

    if (!deepEqualsWithin(x[p], y[p], depth + 1, comparing, budget)) {
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
