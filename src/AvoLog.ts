// Lines about lost data and failed sends, written to stderr whatever the logging flag. Each
// kind (per drop reason, HTTP status or failure text) prints at most one line per 10 s: the
// first occurrence prints at once, later ones in the window are counted and reported with
// the next line after it. There is no timer, so nothing here keeps the process alive.

const WINDOW_MS = 10_000;

// No imports: the jest setup loads this module before test files install their mocks.
/** @internal The track rejection reason and internal-error log text (SPEC §4.2 step 5). */
export const INTERNAL_ERROR_MESSAGE =
  "Avo Inspector: something went wrong. Please report to support@avo.app.";

// The start of a key's current window, and what was counted in it without being printed.
interface Window {
  start: number;
  suppressed: number;
}

export type DropReason = "queue full" | "send backlog full";

export class AvoLog {
  // Milliseconds from a monotonic clock; overridable in tests.
  static now: () => number = () => Number(process.hrtime.bigint()) / 1e6;

  private static windows: Map<string, Window> = new Map();

  /** Events dropped because the unsent buffer or the send backlog is full. */
  static dropped(count: number, reason: DropReason): void {
    const total = AvoLog.due("dropped:" + reason, count);
    if (total !== null) {
      console.warn(`Avo Inspector: dropped ${total} event(s) (${reason}) in the last 10s.`);
    }
  }

  /** A batch answered with an HTTP status other than 200. Only the status is logged. */
  static rejected(status: number): void {
    const total = AvoLog.due("non200:" + status, 1);
    if (total !== null) {
      console.warn(`Avo Inspector: ${total} batch(es) rejected with HTTP ${status} in the last 10s.`);
    }
  }

  /** A batch that could not be sent (network error, timeout, header guard). */
  static failed(reason: string): void {
    const total = AvoLog.due("failed:" + reason, 1);
    if (total !== null) {
      console.error("Avo Inspector: schema sending failed: " + reason + "." + AvoLog.more(total));
    }
  }

  /**
   * An internal error. Only its type is printed: the error may come from reading a property
   * (a throwing getter or proxy), so its message or stack can carry a property value.
   */
  static internal(error: unknown): void {
    const total = AvoLog.due("internal", 1);
    if (total !== null) {
      const type = error instanceof Error ? error.name : typeof error;
      console.error(INTERNAL_ERROR_MESSAGE + AvoLog.more(total) + " (" + type + ")");
    }
  }

  /** A streamId containing ':' (warned on every call before; now once per window). */
  static streamIdColon(): void {
    const total = AvoLog.due("streamid-colon", 1);
    if (total !== null) {
      console.warn("[Avo Inspector] Warning: streamId contains ':' which is not supported" + AvoLog.more(total));
    }
  }

  /** @internal Test-only: forget every window. */
  static _resetForTesting(): void {
    AvoLog.windows.clear();
  }

  // Counts `amount` for `key`. Returns the total to print (this amount plus what the
  // previous window counted) when a line is due, or null while the window is open.
  private static due(key: string, amount: number): number | null {
    const now = AvoLog.now();
    const window = AvoLog.windows.get(key);
    if (window && now - window.start < WINDOW_MS) {
      window.suppressed += amount;
      return null;
    }
    AvoLog.windows.set(key, { start: now, suppressed: 0 });
    return amount + (window ? window.suppressed : 0);
  }

  private static more(total: number): string {
    return total > 1 ? ` (${total - 1} more in the last 10s)` : "";
  }
}
