// Keeps every test off real hosts (api.avo.app included).
//
// 1. Non-prod instances send to AVO_INSPECTOR_MOCK_ENDPOINT, which also turns off event spec
//    fetching, so default it to a closed local port. Tests that need a server set their own.
// 2. Every TCP/TLS connection goes through net.Socket.prototype.connect. Connections to any
//    host other than loopback are refused and recorded, and the test file fails if any
//    were attempted (a prod instance ignores the mock endpoint, so this catches it too).
import * as net from "net";

process.env.AVO_INSPECTOR_MOCK_ENDPOINT =
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT || "http://127.0.0.1:1";

type Guarded = typeof net & { __blockedHosts?: string[] };
const guarded = net as Guarded;

const isLoopback = (host: string) =>
  host === "localhost" || host === "::1" || host.startsWith("127.");

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

beforeAll(() => {
  guarded.__blockedHosts!.length = 0;
});

afterAll(() => {
  const blocked = guarded.__blockedHosts!;
  if (blocked.length > 0) {
    throw new Error("Tests tried to reach real hosts: " + Array.from(new Set(blocked)).join(", "));
  }
});
