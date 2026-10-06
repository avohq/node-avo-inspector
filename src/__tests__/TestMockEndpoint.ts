import * as https from "https";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { EventEmitter } from "events";

import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { restoreEnv, trackingEndpoint } from "./constants";

// AVO_INSPECTOR_MOCK_ENDPOINT: the test-only override of the track URL (SPEC §7.1).

let server: Server;
let port: number;
let requests: string[] = [];
let specRequests: string[] = [];
const defaultEndpoint = process.env.AVO_INSPECTOR_MOCK_ENDPOINT;
const specMetadata = { schemaId: "mock-schema", branchId: "mock-branch", latestActionId: "mock-action", sourceId: "mock-source" };

beforeAll(async () => {
  // Answers spec fetches with a spec for property "a", and records track requests.
  server = createServer((req, res) => {
    const url = req.url || "";
    if (url.startsWith("/trackingPlan/eventSpec")) {
      specRequests.push(url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events: [{ b: "mock-branch", id: "e", vids: [], p: { a: { t: "string" } } }], metadata: specMetadata }));
      return;
    }
    requests.push(url);
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
  restoreEnv("AVO_INSPECTOR_MOCK_ENDPOINT", defaultEndpoint);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  specRequests = [];
  (AvoNetworkCallsHandler as any).warnedMockEndpoint = null;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  restoreEnv("AVO_INSPECTOR_MOCK_ENDPOINT", defaultEndpoint);
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

describe("default endpoint", () => {
  test("without the override, track requests go to https://api.avo.app/inspector/v2/track", async () => {
    delete process.env.AVO_INSPECTOR_MOCK_ENDPOINT;
    const urls = stubHttps();
    const inspector = create("dev");

    await inspector.trackSchemaFromEvent("E", { a: 1 });

    const tracks = urls.filter((url) => !url.includes("/trackingPlan/"));
    expect(tracks).toEqual([trackingEndpoint]);
    const url = new URL(tracks[0]);
    expect([url.protocol, url.hostname, url.port, url.pathname]).toEqual([
      "https:", "api.avo.app", "", "/inspector/v2/track",
    ]);
  });
});

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

  test("debug logging prints only the override's origin, never its path", async () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = `http://127.0.0.1:${port}/SECRET-TOKEN/track`;
    const inspector = create("dev");
    inspector.enableLogging(true);

    await inspector.trackSchemaFromEvent("E", { a: 1 });

    const logged = (console.log as jest.Mock).mock.calls.map((call) => call.join(" "));
    expect(logged).toContain(`Avo Inspector: [network] POST http://127.0.0.1:${port}`);
    expect(logged.some((line) => line.includes("SECRET-TOKEN"))).toBe(false);
    inspector.destroy();
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
      `[Avo Inspector] Ignoring invalid AVO_INSPECTOR_MOCK_ENDPOINT: ${reason}`,
    ]);
  });

  test.each([
    ["ftp://mock.example/private-path?k=hidden-value", "unsupported protocol ftp:"],
    ["hidden-value is not a url", "not a valid URL"],
  ])("an invalid value is never printed, only the reason (%j)", (value, reason) => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = value;

    expect(AvoNetworkCallsHandler.mockEndpointFor("staging")).toBeNull();

    const printed = (console.warn as jest.Mock).mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain(reason);
    expect(printed).not.toContain("hidden-value");
    expect(printed).not.toContain("private-path");
    expect(printed).not.toContain("mock.example");
  });

  test("an invalid value leaves event spec validation on", () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = "not a url";

    expect(AvoNetworkCallsHandler.mockEndpointFor("staging")).toBeNull();
    expect((create("staging") as any).isValidationActive()).toBe(true);
  });

  test("a valid value routes event spec fetches to the mock endpoint, and validation stays on", async () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = `http://127.0.0.1:${port}/private/path?token=abc`;
    const inspector = create("staging");
    const sent: any[] = [];
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
      .mockImplementation((batch) => { sent.push(...batch); return Promise.resolve(200); });

    await inspector.trackSchemaFromEvent("Spec Event", { a: "x" }, "stream-1");
    await inspector.flush();

    // The mock's origin, the spec path, and the usual query; never the override's own path.
    expect(specRequests).toHaveLength(1);
    const url = new URL(specRequests[0], "http://mock");
    expect(url.pathname).toBe("/trackingPlan/eventSpec");
    expect(url.searchParams.get("apiKey")).toBe("secret-key-123");
    expect(url.searchParams.get("eventName")).toBe("Spec Event");
    expect(url.searchParams.get("streamId")).toBe("stream-1");
    expect(sent).toHaveLength(1);
    expect(sent[0].eventSpecMetadata).toEqual(specMetadata);
    inspector.destroy();
  });

  test("the override is read once per instance, not per event or send", async () => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = `http://127.0.0.1:${port}`;
    const read = jest.spyOn(AvoNetworkCallsHandler, "mockEndpointFor");
    const inspector = new AvoInspector({ apiKey: "secret-key-123", env: "dev", version: "1.0.0" });

    for (let i = 0; i < 5; i++) await inspector.trackSchemaFromEvent("E" + i, { a: "x" });
    await inspector.flush();

    expect(requests).toHaveLength(5);
    expect(read).toHaveBeenCalledTimes(1);
    inspector.destroy();
  });

  test("the default test setup answers event spec fetches, so tests exercise validation", async () => {
    restoreEnv("AVO_INSPECTOR_MOCK_ENDPOINT", defaultEndpoint);
    const inspector = create("staging");
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);

    await inspector.trackSchemaFromEvent("E", { a: "x" }, "s");

    // An answered fetch (even with no spec) is cached; a failed one is not.
    expect((inspector as any).eventSpecCache.get("secret-key-123\0s\0E")).toBeDefined();
    inspector.destroy();
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
