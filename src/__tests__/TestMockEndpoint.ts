import * as https from "https";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { EventEmitter } from "events";

import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";

// AVO_INSPECTOR_MOCK_ENDPOINT: the test-only override of the track URL (SPEC §7.1).

let server: Server;
let port: number;
let requests: string[] = [];
const defaultEndpoint = process.env.AVO_INSPECTOR_MOCK_ENDPOINT;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url || "");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ samplingRate: 1.0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT = defaultEndpoint;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  (AvoNetworkCallsHandler as any).warnedMockEndpoint = null;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.AVO_INSPECTOR_MOCK_ENDPOINT = defaultEndpoint;
  jest.restoreAllMocks();
});

const create = (env: "dev" | "staging" | "prod") =>
  new AvoInspector({ apiKey: "secret-key-123", env, version: "1.0.0" });

const warningsAbout = (spy: any) =>
  spy.mock.calls.map((call: any[]) => call.join(" ")).filter((line: string) =>
    line.includes("AVO_INSPECTOR_MOCK_ENDPOINT")
  );

// Replaces https.request with a request that fails without connecting, recording its URL.
function stubHttps() {
  const urls: string[] = [];
  jest.spyOn(https, "request").mockImplementation(((target: any) => {
    // Track sends pass a URL; event spec fetches pass an options object.
    urls.push(
      typeof target === "string" || target instanceof URL
        ? String(target)
        : "https://" + target.hostname + String(target.path).split("?")[0]
    );
    const req: any = new EventEmitter();
    req.end = () => process.nextTick(() => req.emit("error", new Error("stubbed")));
    req.destroy = () => {};
    req.setTimeout = () => {};
    return req;
  }) as any);
  return urls;
}

describe("AVO_INSPECTOR_MOCK_ENDPOINT", () => {
  test("a redirected send warns once, on stderr, with only scheme, host and port", async () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = `http://127.0.0.1:${port}/private/path?token=abc`;
    const inspector = create("dev");

    for (let i = 0; i < 5; i++) await inspector.trackSchemaFromEvent("E" + i, {});

    expect(requests).toHaveLength(5);
    expect(warningsAbout(console.warn)).toEqual([
      `[Avo Inspector] AVO_INSPECTOR_MOCK_ENDPOINT is set: sending to http://127.0.0.1:${port} instead of api.avo.app (ignored in prod).`,
    ]);
    const everything = [console.warn, console.error, console.log]
      .flatMap((spy: any) => spy.mock.calls.map((call: any[]) => call.join(" ")));
    expect(everything.some((line) => line.includes("secret-key-123"))).toBe(false);
    expect(everything.some((line) => line.includes("token=abc"))).toBe(false);
    expect(warningsAbout(console.log)).toEqual([]);
  });

  test.each([
    ["not a url", "not a valid URL"],
    ["ftp://x", "unsupported protocol ftp:"],
  ])("an invalid value %j warns once and falls back to the real endpoint", async (value, reason) => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = value;
    const urls = stubHttps();
    const inspector = create("dev");

    await expect(inspector.trackSchemaFromEvent("E1", { a: 1 })).resolves.toHaveLength(1);
    await expect(inspector.trackSchemaFromEvent("E2", { a: 1 })).resolves.toHaveLength(1);

    expect(urls.filter((url) => url.endsWith("/inspector/v2/track"))).toEqual([
      "https://api.avo.app/inspector/v2/track",
      "https://api.avo.app/inspector/v2/track",
    ]);
    // The value is ignored, so event spec validation stays on and fetches as usual.
    expect(urls.filter((url) => url.endsWith("/trackingPlan/eventSpec"))).toHaveLength(2);
    expect(warningsAbout(console.warn)).toEqual([
      `[Avo Inspector] Ignoring invalid AVO_INSPECTOR_MOCK_ENDPOINT "${value}": ${reason}`,
    ]);
  });

  test("an invalid value leaves event spec validation on", () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = "not a url";

    expect(AvoNetworkCallsHandler.mockEndpointFor("staging")).toBeNull();
    expect((create("staging") as any).isValidationActive()).toBe(true);
  });

  test("a valid value turns event spec validation off", () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = `http://127.0.0.1:${port}`;

    expect((create("staging") as any).isValidationActive()).toBe(false);
  });

  test("prod ignores the variable, without any warning", async () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = `http://127.0.0.1:${port}`;
    const urls = stubHttps();
    const inspector = create("prod");

    await inspector.trackSchemaFromEvent("E", {});
    await inspector.flush();

    expect(urls).toEqual(["https://api.avo.app/inspector/v2/track"]);
    expect(requests).toHaveLength(0);
    expect(warningsAbout(console.warn)).toEqual([]);
  });

  test("prod does not even validate the variable", () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = "not a url";

    expect(AvoNetworkCallsHandler.mockEndpointFor("prod")).toBeNull();
    expect(warningsAbout(console.warn)).toEqual([]);
  });
});
