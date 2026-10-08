import { writeSync } from "fs";

import { monotonicNowMs } from "./utils";

// Lines about lost data and failed sends, written to stderr whatever the logging flag. Each
// kind (per drop reason, HTTP status or failure reason) prints at most one line per 10 s:
// the first occurrence prints at once, and later ones in the window are counted. A count is
// printed with the next occurrence after the window, by flush() once the window has expired,
// or by destroy() and the exit drain at once. "in the last Ns" is the real whole seconds
// since the window began (at least 1). There is no timer. While a count is pending, a
// "beforeExit" listener prints the expired ones (beforeExit also fires at every idle point of
// a script whose only pending work is the SDK's, so it is not treated as the exit), and an
// "exit" listener prints the rest, synchronously, when the process really exits.

const WINDOW_MS = 10_000;
// How many names (unknown InspectorEvent keys, error types) a line prints, and how much of each key.
const MAX_LOGGED_OPTION_KEYS = 5;
const MAX_LOGGED_OPTION_KEY_LENGTH = 64;

// Imports only utils, which imports nothing: the jest setup loads this module before test
// files install their mocks, so it must not pull in the rest of the SDK.
/** @internal The track rejection reason and internal-error log text (SPEC §4.2 step 5). */
export const INTERNAL_ERROR_MESSAGE =
  "Avo Inspector: something went wrong. Please report to support@avo.app.";

/** The event name sent for a track call whose event name is missing. */
export const MISSING_EVENT_NAME = "Missing Event Name";

// Prints one line for a key: `count` is the total the line reports (a count-kind line), and
// `more` the occurrences it reports beyond the current one (a suffix-kind line).
type Printer = (count: number, more: number, seconds: number) => void;

// The start of a key's current window, what was counted in it without being printed, and
// how to print that count.
interface Window {
  start: number;
  suppressed: number;
  print: Printer;
}

export type DropReason =
  | "queue full"
  | "send backlog full"
  | "internal error"
  // At the real exit: events never sent, and events in sends that had not completed.
  | "unsent at exit"
  | "unconfirmed at exit";

export class AvoLog {
  // Milliseconds from a monotonic clock; overridable in tests.
  static now: () => number = monotonicNowMs;

  private static windows: Map<string, Window> = new Map();
  private static exitListenerArmed = false;
  // Set by the "exit" listener: from then on lines are written synchronously, because
  // console writes to a pipe are asynchronous and would be lost as the process ends.
  private static exiting = false;

  /** Events dropped because the unsent buffer or the send backlog is full. */
  static dropped(count: number, reason: DropReason): void {
    AvoLog.occur("dropped:" + reason, count, (total, _more, seconds) => {
      AvoLog.write("warn", `Avo Inspector: dropped ${total} event(s) (${reason}) in the last ${seconds}s.`);
    });
  }

  /** A batch answered with an HTTP status other than 200. Only the status is logged. */
  static rejected(status: number): void {
    AvoLog.occur("non200:" + status, 1, (total, _more, seconds) => {
      AvoLog.write("warn", `Avo Inspector: ${total} batch(es) rejected with HTTP ${status} in the last ${seconds}s.`);
    });
  }

  /** A batch that could not be sent (network error, timeout, header guard). */
  static failed(error: unknown): void {
    // The two fixed transport reasons print as is; anything else (an Error thrown while
    // sending, any other value) prints only its type, so neither the line nor the limiter
    // key ever depends on an error's message.
    const reason = error === "Request failed" || error === "Request timed out"
      ? error
      : "Request failed (" + AvoLog.errorType(error) + ")";
    AvoLog.occur("failed:" + reason, 1, (_total, more, seconds) => {
      AvoLog.write("error", "Avo Inspector: schema sending failed: " + reason + "." + AvoLog.suffix(more, seconds));
    });
  }

  /**
   * An internal error. Only its type is printed: the error may come from reading a property
   * (a throwing getter or proxy), so its message or stack can carry a property value.
   */
  static internal(error: unknown): void {
    AvoLog.noteNames("internal", [AvoLog.errorType(error)]);
    AvoLog.occur("internal", 1, (_total, more, seconds) => {
      const types = AvoLog.takeNames("internal", (type) => type);
      AvoLog.write("error", INTERNAL_ERROR_MESSAGE + AvoLog.suffix(more, seconds) + " (" + types + ")");
    });
  }

  // Built-in error classes, most specific first. Matched by prototype, never by reading the
  // error's own `name`, which is writable and may be a getter.
  private static readonly errorTypes: Array<[Function, string]> = [
    [TypeError, "TypeError"],
    [RangeError, "RangeError"],
    [ReferenceError, "ReferenceError"],
    [SyntaxError, "SyntaxError"],
    [URIError, "URIError"],
    [EvalError, "EvalError"],
    [Error, "Error"],
  ];

  /**
   * @internal A fixed label for what was thrown, for any log line that reports a caught
   * error; it never reads a field of the value. A proxy whose traps throw yields "unknown".
   */
  static errorType(error: unknown): string {
    try {
      for (const [type, label] of AvoLog.errorTypes) {
        if (error instanceof type) {
          return label;
        }
      }
      return typeof error;
    } catch (e) {
      return "unknown";
    }
  }

  /** A track call without a usable event name, sent as MISSING_EVENT_NAME. */
  static missingEventName(): void {
    AvoLog.occur("missing-event-name", 1, (total, _more, seconds) => {
      AvoLog.write(
        "warn",
        `Avo Inspector: ${total} event(s) tracked without an event name in the last ${seconds}s, sent as "${MISSING_EVENT_NAME}".`
      );
    });
  }

  /** A streamId containing ':' (warned on every call before; now once per window). */
  static streamIdColon(): void {
    AvoLog.occur("streamid-colon", 1, (_total, more, seconds) => {
      AvoLog.write("warn", "[Avo Inspector] Warning: streamId contains ':' which is not supported" + AvoLog.suffix(more, seconds));
    });
  }

  /**
   * A tracked InspectorEvent with keys the SDK does not know (a typo such as `outputRef` or
   * `eventname`). Only the key names are printed, JSON-quoted, at most
   * MAX_LOGGED_OPTION_KEYS of them, each cut to MAX_LOGGED_OPTION_KEY_LENGTH characters;
   * never a value.
   */
  static unknownEventKeys(keys: string[], known: string[]): void {
    AvoLog.noteNames(
      "unknown-event-keys",
      keys.map((key) => (key.length > MAX_LOGGED_OPTION_KEY_LENGTH ? key.slice(0, MAX_LOGGED_OPTION_KEY_LENGTH) + "…" : key))
    );
    AvoLog.occur("unknown-event-keys", 1, (_total, more, seconds) => {
      const names = AvoLog.takeNames("unknown-event-keys", (key) => JSON.stringify(key));
      AvoLog.write(
        "warn",
        "[Avo Inspector] Warning: unknown InspectorEvent key(s) " + names + " ignored; the known keys are " +
          known.join(", ") + AvoLog.suffix(more, seconds)
      );
    });
  }

  /**
   * trackSchemaFromEvent called with something other than an InspectorEvent object, such
   * as a 1.x call with the event name first. Nothing about the argument is printed.
   */
  static notAnInspectorEvent(): void {
    AvoLog.occur("not-an-inspector-event", 1, (_total, more, seconds) => {
      AvoLog.write(
        "error",
        "[Avo Inspector] Error: since 2.0.0, trackSchemaFromEvent takes one InspectorEvent object; nothing was sent. " +
          "Replace trackSchemaFromEvent(eventName, eventProperties) with trackSchemaFromEvent({ eventName, eventProperties })." +
          AvoLog.suffix(more, seconds)
      );
    });
  }

  /**
   * Prints every pending count and resets its key. With `onlyExpired` (flush()), only keys
   * whose window has expired; destroy() and the exit drain print them all.
   */
  static flushPending = (onlyExpired: boolean = false): void => {
    const now = AvoLog.now();
    for (const [key, window] of Array.from(AvoLog.windows)) {
      if (window.suppressed === 0 || (onlyExpired && now - window.start < WINDOW_MS)) {
        continue;
      }
      AvoLog.windows.delete(key);
      window.print(window.suppressed, window.suppressed, AvoLog.seconds(now - window.start));
    }
    AvoLog.updateExitListener();
  };

  // Distinct names (unknown keys, error types) a kind has seen since its last line, in order,
  // for the line that reports them: a count line covers every occurrence it counts, so it
  // names all of theirs, not only the first. At most MAX_LOGGED_OPTION_KEYS + 1 are kept, so
  // the line can tell that more were seen.
  private static names: Map<string, string[]> = new Map();

  private static noteNames(kind: string, names: string[]): void {
    const seen = AvoLog.names.get(kind) || [];
    for (const name of names) {
      if (seen.length > MAX_LOGGED_OPTION_KEYS) {
        break;
      }
      if (seen.indexOf(name) < 0) {
        seen.push(name);
      }
    }
    AvoLog.names.set(kind, seen);
  }

  // The names noted for `kind`, formatted, joined and capped (", …" past the cap), and forgets
  // them: the next line names only what is seen after this one.
  private static takeNames(kind: string, format: (name: string) => string): string {
    const seen = AvoLog.names.get(kind) || [];
    AvoLog.names.delete(kind);
    return seen.slice(0, MAX_LOGGED_OPTION_KEYS).map(format).join(", ") +
      (seen.length > MAX_LOGGED_OPTION_KEYS ? ", …" : "");
  }

  /** @internal Test-only: forget every window. */
  static _resetForTesting(): void {
    AvoLog.windows.clear();
    AvoLog.names.clear();
    AvoLog.updateExitListener();
  }

  // Counts `amount` for `key`, or prints a line when the key's window is over (or new). The
  // line reports this occurrence plus what the previous window counted, over the real time
  // since that window began; with nothing counted it covers just this occurrence (1 s).
  private static occur(key: string, amount: number, print: Printer): void {
    const now = AvoLog.now();
    const window = AvoLog.windows.get(key);
    if (window && now - window.start < WINDOW_MS) {
      window.suppressed += amount;
      AvoLog.updateExitListener();
      return;
    }
    const previous = window ? window.suppressed : 0;
    AvoLog.windows.set(key, { start: now, suppressed: 0, print });
    print(amount + previous, previous, previous > 0 ? AvoLog.seconds(now - window!.start) : 1);
    AvoLog.updateExitListener();
  }

  private static seconds(elapsedMs: number): number {
    return Math.max(1, Math.floor(elapsedMs / 1000));
  }

  private static suffix(more: number, seconds: number): string {
    return more > 0 ? ` (${more} more in the last ${seconds}s)` : "";
  }

  // Armed only while some key has a pending count: it prints them at a natural exit. It
  // schedules nothing, so it never keeps the process alive.
  private static updateExitListener(): void {
    let pending = false;
    AvoLog.windows.forEach((window) => {
      pending = pending || window.suppressed > 0;
    });
    if (pending && !AvoLog.exitListenerArmed) {
      process.on("beforeExit", AvoLog.onBeforeExit);
      process.on("exit", AvoLog.onExit);
      AvoLog.exitListenerArmed = true;
    } else if (!pending && AvoLog.exitListenerArmed) {
      process.removeListener("beforeExit", AvoLog.onBeforeExit);
      process.removeListener("exit", AvoLog.onExit);
      AvoLog.exitListenerArmed = false;
    }
  }

  // Not the exit: the SDK's exit drain may resume the process. Only expired counts print,
  // as in flush(), so idle points cannot break the rate limit.
  private static onBeforeExit = (): void => {
    AvoLog.flushPending(true);
  };

  // The real exit (natural, or process.exit()): print everything still pending.
  private static onExit = (): void => {
    AvoLog.enterExit();
    AvoLog.flushPending();
  };

  /** @internal From now on lines are written synchronously: the process is exiting. */
  static enterExit(): void {
    AvoLog.exiting = true;
  }

  private static write(level: "warn" | "error", line: string): void {
    if (!AvoLog.exiting) {
      console[level](line);
      return;
    }
    try {
      writeSync(2, line + "\n");
    } catch (e) {
      // stderr is gone; nothing else to do as the process exits.
    }
  }
}
