import * as https from "https";
import { EventEmitter } from "events";
import { AvoInspector } from "../AvoInspector";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";
import { AvoEventSpecCache } from "../eventSpec/AvoEventSpecCache";
import { EventSpecResponse } from "../eventSpec/AvoEventSpecFetchTypes";

// Gateway coordinates on the event spec fetch (AVO-4070): the event's originHint and
// outputReference go on the request URL and into the cache and in-flight keys.

jest.mock("https");

const mockedHttps = https as jest.Mocked<typeof https>;

const wire = {
  events: [{ b: "main", id: "evt", vids: [], p: { plan: { t: "string", r: true, v: { '["free"]': ["evt"] } } } }],
  metadata: { schemaId: "s", branchId: "main", latestActionId: "a", sourceId: "src" },
};

class MockClientRequest extends EventEmitter {
  end = jest.fn();
  destroy = jest.fn();
  setTimeout = jest.fn();
}

class MockIncomingMessage extends EventEmitter {
  complete = true;
  constructor(public statusCode: number) {
    super();
  }
}

// Every request answers `status` with `body`, after a tick so concurrent fetches overlap.
function answerEveryRequest(status: number, body: any): void {
  (mockedHttps.request as jest.Mock).mockImplementation((_options: any, callback: (res: any) => void) => {
    const req = new MockClientRequest();
    setTimeout(() => {
      const res = new MockIncomingMessage(status);
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(body)));
      res.emit("end");
    }, 1);
    return req;
  });
}

const requestedPaths = (): string[] =>
  (mockedHttps.request as jest.Mock).mock.calls.map((call) => call[0].path);

const fetchOnce = (
  fetcher: AvoEventSpecFetcher,
  coordinates?: { originHint?: string; outputReference?: string }
): Promise<EventSpecResponse | null> =>
  new Promise((resolve) => fetcher.fetch("Checkout", "stream1", resolve, coordinates));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  answerEveryRequest(200, wire);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("spec fetch URL", () => {
  let fetcher: AvoEventSpecFetcher;
  beforeEach(() => {
    fetcher = new AvoEventSpecFetcher("key");
  });
  afterEach(() => fetcher.destroy());

  const sourcePath = "/trackingPlan/eventSpec?apiKey=key&eventName=Checkout&streamId=stream1";

  test("without coordinates the request is byte-identical to a source fetch", async () => {
    await fetchOnce(fetcher);
    await fetchOnce(fetcher, {});
    await fetchOnce(fetcher, { originHint: undefined, outputReference: undefined });
    expect(requestedPaths()).toEqual([sourcePath, sourcePath, sourcePath]);
  });

  test("originHint alone is appended", async () => {
    await fetchOnce(fetcher, { originHint: "web" });
    expect(requestedPaths()).toEqual([sourcePath + "&originHint=web"]);
  });

  test("originHint and outputReference are both appended", async () => {
    await fetchOnce(fetcher, { originHint: "web app", outputReference: "out/1" });
    expect(requestedPaths()).toEqual([sourcePath + "&originHint=web+app&outputReference=out%2F1"]);
  });

  test("outputReference alone is appended", async () => {
    await fetchOnce(fetcher, { outputReference: "out-1" });
    expect(requestedPaths()).toEqual([sourcePath + "&outputReference=out-1"]);
  });

  test("blank coordinates are omitted and others trimmed, never sent empty", async () => {
    await fetchOnce(fetcher, { originHint: "   ", outputReference: "" });
    await fetchOnce(fetcher, { originHint: "  web  ", outputReference: " \t" });
    expect(requestedPaths()).toEqual([sourcePath, sourcePath + "&originHint=web"]);
  });

  test("in-flight dedupe is per coordinates", async () => {
    await Promise.all([
      fetchOnce(fetcher),
      fetchOnce(fetcher),
      fetchOnce(fetcher, { originHint: "web" }),
      fetchOnce(fetcher, { originHint: " web " }),
      fetchOnce(fetcher, { originHint: "web", outputReference: "out-1" }),
      fetchOnce(fetcher, { outputReference: "web" }),
    ]);
    expect(requestedPaths().sort()).toEqual(
      [
        sourcePath,
        sourcePath + "&originHint=web",
        sourcePath + "&originHint=web&outputReference=out-1",
        sourcePath + "&outputReference=web",
      ].sort()
    );
  });
});

describe("spec cache key", () => {
  test("without coordinates the key is unchanged", () => {
    expect(AvoEventSpecCache.makeKey("k", "s", "e")).toBe("k\0s\0e");
    expect(AvoEventSpecCache.makeKey("k", "s", "e", {})).toBe("k\0s\0e");
    expect(AvoEventSpecCache.makeKey("k", "s", "e", { originHint: " ", outputReference: "" })).toBe("k\0s\0e");
  });

  test("each set of coordinates has its own key", () => {
    const keys = [
      AvoEventSpecCache.makeKey("k", "s", "e"),
      AvoEventSpecCache.makeKey("k", "s", "e", { originHint: "a" }),
      AvoEventSpecCache.makeKey("k", "s", "e", { outputReference: "a" }),
      AvoEventSpecCache.makeKey("k", "s", "e", { originHint: "a", outputReference: "b" }),
      AvoEventSpecCache.makeKey("k", "s", "e", { originHint: "b", outputReference: "a" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(AvoEventSpecCache.makeKey("k", "s", "e", { originHint: " a " })).toBe(keys[1]);
  });
});

describe("a failed fetch tells a 404 from other failures", () => {
  let fetcher: AvoEventSpecFetcher;
  beforeEach(() => {
    fetcher = new AvoEventSpecFetcher("key");
  });
  afterEach(() => fetcher.destroy());

  const settle = (): Promise<[EventSpecResponse | null, boolean | undefined]> =>
    new Promise((resolve) =>
      fetcher.fetch("Checkout", "stream1", (result, notFound) => resolve([result, notFound]), { originHint: "web" })
    );

  test("a 404 settles null with notFound", async () => {
    answerEveryRequest(404, { error: "event_not_found", name: "Checkout" });
    expect(await settle()).toEqual([null, true]);
  });

  test("a 5xx or a network error settles null without notFound", async () => {
    answerEveryRequest(500, { error: "internal" });
    expect(await settle()).toEqual([null, false]);

    (mockedHttps.request as jest.Mock).mockImplementation(() => {
      const req = new MockClientRequest();
      setTimeout(() => req.emit("error", new Error("ECONNRESET")), 1);
      return req;
    });
    expect(await settle()).toEqual([null, false]);
  });

  test("a spec settles without notFound", async () => {
    const [result, notFound] = await settle();
    expect(result).not.toBeNull();
    expect(notFound).toBe(false);
  });
});

describe("tracking a gateway event", () => {
  let sent: any[];
  // Spec fetches go through the mocked https module, not the suite's local mock endpoint.
  const mockEndpoint = process.env.AVO_INSPECTOR_MOCK_ENDPOINT;
  beforeEach(() => {
    delete process.env.AVO_INSPECTOR_MOCK_ENDPOINT;
  });
  afterEach(() => {
    process.env.AVO_INSPECTOR_MOCK_ENDPOINT = mockEndpoint;
  });

  function staging(): AvoInspector {
    const inspector = new AvoInspector({ apiKey: "key", env: "staging", version: "1.0.0", disableBatchTimer: true });
    sent = [];
    jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockImplementation((batch) => {
      sent.push(...batch);
      return Promise.resolve(200);
    });
    return inspector;
  }

  test("the event's normalized coordinates reach the spec fetch, and each checkpoint is cached apart", async () => {
    const inspector = staging();
    const track = (extra: object) =>
      inspector.trackSchemaFromEvent({ eventName: "Checkout", eventProperties: { plan: "pro" }, streamId: "u1", ...extra });

    await track({});
    await track({ originHint: " web " });
    await track({ originHint: "web", outputReference: " out-1 " });
    // Cached: no further fetches for any of the three.
    await track({});
    await track({ originHint: "web" });
    await track({ originHint: "web", outputReference: "out-1" });
    await inspector.flush();
    inspector.destroy();

    const base = "/trackingPlan/eventSpec?apiKey=key&eventName=Checkout&streamId=u1";
    expect(requestedPaths()).toEqual([
      base,
      base + "&originHint=web",
      base + "&originHint=web&outputReference=out-1",
    ]);
    expect(sent).toHaveLength(6);
    sent.forEach((event) => expect(event.eventSpecMetadata).toEqual(wire.metadata));
  });

  test("a 404 for a gateway event without originHint still sends the event, unvalidated", async () => {
    answerEveryRequest(404, { error: "event_not_found", name: "Checkout" });
    const inspector = staging();

    const schema = await inspector.trackSchemaFromEvent({
      eventName: "Checkout",
      eventProperties: { plan: "pro" },
      outputReference: "out-1",
    });
    await inspector.flush();
    inspector.destroy();

    expect(schema).toEqual([{ propertyName: "plan", propertyType: "string" }]);
    expect(requestedPaths()).toEqual([
      expect.stringMatching(/&outputReference=out-1$/),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].outputReference).toBe("out-1");
    expect(sent[0].eventSpecMetadata).toBeUndefined();
    expect(sent[0].eventProperties[0].failedEventIds).toBeUndefined();
  });

  describe("how long a failed fetch is cached", () => {
    let now: number;
    beforeEach(() => {
      now = Date.now();
      jest.spyOn(Date, "now").mockImplementation(() => now);
    });
    const trackGatewayEvent = (inspector: AvoInspector) =>
      inspector.trackSchemaFromEvent({ eventName: "Checkout", eventProperties: { plan: "pro" }, outputReference: "out-1" });

    test("a 404 (no spec) stays cached for 60 s", async () => {
      answerEveryRequest(404, { error: "event_not_found", name: "Checkout" });
      const inspector = staging();

      await trackGatewayEvent(inspector);
      now += 59_000;
      await trackGatewayEvent(inspector);
      expect(requestedPaths()).toHaveLength(1);

      now += 2_000;
      await trackGatewayEvent(inspector);
      await inspector.flush();
      inspector.destroy();
      expect(requestedPaths()).toHaveLength(2);
      expect(sent).toHaveLength(3);
    });

    test("any other failure is fetched again after 5 s", async () => {
      answerEveryRequest(503, { error: "unavailable" });
      const inspector = staging();

      await trackGatewayEvent(inspector);
      now += 4_000;
      await trackGatewayEvent(inspector);
      expect(requestedPaths()).toHaveLength(1);

      now += 2_000;
      answerEveryRequest(200, wire);
      await trackGatewayEvent(inspector);
      await inspector.flush();
      inspector.destroy();
      expect(requestedPaths()).toHaveLength(2);
      expect(sent).toHaveLength(3);
      expect(sent[2].eventSpecMetadata).toEqual(wire.metadata);
    });
  });

  test("a 404 is cached, so later events of that checkpoint do not fetch again", async () => {
    answerEveryRequest(404, { error: "event_not_found", name: "Checkout" });
    const inspector = staging();

    await inspector.trackSchemaFromEvent({ eventName: "Checkout", eventProperties: { plan: "pro" }, outputReference: "out-1" });
    await inspector.trackSchemaFromEvent({ eventName: "Checkout", eventProperties: { plan: "free" }, outputReference: "out-1" });
    await inspector.trackSchemaFromEvent({ eventName: "Checkout", eventProperties: { plan: "pro" }, originHint: "ios" });
    await inspector.flush();
    inspector.destroy();

    expect(requestedPaths()).toEqual([
      expect.stringMatching(/&outputReference=out-1$/),
      expect.stringMatching(/&originHint=ios$/),
    ]);
    expect(sent).toHaveLength(3);
    sent.forEach((event) => expect(event.eventSpecMetadata).toBeUndefined());
  });
});
