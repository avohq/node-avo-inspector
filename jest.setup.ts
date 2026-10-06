// Keeps every test off real hosts (api.avo.app included).
//
// 1. Non-prod instances send track requests and event spec fetches to
//    AVO_INSPECTOR_MOCK_ENDPOINT: the local mock started by jest.globalSetup.ts, which
//    answers spec fetches with "no spec". Falls back to a closed local port if unset.
//    Tests that need a server set their own.
// 2. Every TCP/TLS connection goes through net.Socket.prototype.connect. Connections to any
//    host other than loopback are refused and recorded, and the test file fails if any
//    were attempted (a prod instance ignores the mock endpoint, so this catches it too).
import * as net from "net";
import { AvoLog } from "./src/AvoLog";

process.env.AVO_INSPECTOR_MOCK_ENDPOINT =
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT || "http://127.0.0.1:1";

type Guarded = typeof net & { __blockedHosts?: string[] };
const guarded = net as Guarded;

// A hostname such as "127.example.com" can resolve anywhere, so only a literal IPv4
// address counts as 127.0.0.0/8.
const isLoopback = (host: string) =>
  host === "localhost" || host === "::1" || (net.isIPv4(host) && host.startsWith("127."));

// net is shared by every test file in a worker, so patch it once.
if (!guarded.__blockedHosts) {
  guarded.__blockedHosts = [];
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    // net.connect passes its normalized [options, callback] array as the first argument.
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host =
      options !== null && typeof options === "object"
        ? options.path
          ? "localhost"
          : options.host || "localhost"
        : typeof args[1] === "string"
        ? args[1]
        : "localhost";
    if (!isLoopback(host)) {
      guarded.__blockedHosts!.push(host);
      process.nextTick(() => this.destroy(new Error("Network access blocked in tests: " + host)));
      return this;
    }
    return (connect as any).apply(this, args);
  } as any;
}

// This module runs once per test file, before the file itself is evaluated, so the reset
// here keeps connections attempted by imports and top-level code in the file's record.
guarded.__blockedHosts!.length = 0;

// Always-on log lines are rate-limited per process; each test starts with fresh windows.
beforeEach(() => {
  AvoLog._resetForTesting();
});

afterAll(() => {
  const blocked = guarded.__blockedHosts!;
  if (blocked.length > 0) {
    throw new Error("Tests tried to reach real hosts: " + Array.from(new Set(blocked)).join(", "));
  }
});
