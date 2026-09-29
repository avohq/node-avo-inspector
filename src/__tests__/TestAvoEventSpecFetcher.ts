import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";
import { EventSpecResponse } from "../eventSpec/AvoEventSpecFetchTypes";
import * as https from "https";
import { EventEmitter } from "events";

jest.mock("https");

const mockedHttps = https as jest.Mocked<typeof https>;

class MockIncomingMessage extends EventEmitter {
  statusCode: number;
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
}

class MockClientRequest extends EventEmitter {
  end = jest.fn();
  destroy = jest.fn();
  setTimeout = jest.fn();
}

/** Build a wire-format response body matching the /trackingPlan/eventSpec API */
function wireResponse(
  eventName: string,
  properties: Record<string, { t: string }>,
  metadata: { schemaId: string; branchId: string; latestActionId: string; sourceId: string }
) {
  const p: Record<string, any> = {};
  for (const [name, constraint] of Object.entries(properties)) {
    p[name] = { t: constraint.t, r: true };
  }
  return {
    events: [{ b: metadata.branchId, id: "evt1", vids: [], p }],
    metadata,
  };
}

function setupMockRequest(
  responseStatusCode: number,
  responseBody: any
): MockClientRequest {
  const mockReq = new MockClientRequest();
  const mockRes = new MockIncomingMessage(responseStatusCode);

  (mockedHttps.request as jest.Mock).mockImplementation(
    (_options: any, callback: (res: any) => void) => {
      callback(mockRes);
      const data = JSON.stringify(responseBody);
      mockRes.emit("data", Buffer.from(data));
      mockRes.emit("end");
      return mockReq;
    }
  );

  return mockReq;
}

function setupMockRequestError(): MockClientRequest {
  const mockReq = new MockClientRequest();

  (mockedHttps.request as jest.Mock).mockImplementation(
    (_options: any, _callback: (res: any) => void) => {
      process.nextTick(() => mockReq.emit("error", new Error("network failure")));
      return mockReq;
    }
  );

  return mockReq;
}

describe("AvoEventSpecFetcher", () => {
  let fetcher: AvoEventSpecFetcher;

  beforeEach(() => {
    jest.clearAllMocks();
    fetcher = new AvoEventSpecFetcher("test-api-key");
  });

  afterEach(() => {
    fetcher.destroy();
  });

  test("fetches event spec via HTTPS GET", (done) => {
    const metadata = { schemaId: "s1", branchId: "b1", latestActionId: "a1", sourceId: "src1" };
    const wire = wireResponse("click", { target: { t: "string" } }, metadata);

    const expectedParsed: EventSpecResponse = {
      eventSpec: {
        eventName: "click",
        properties: [{ propertyName: "target", propertyType: "string" }],
      },
      metadata,
    };

    setupMockRequest(200, wire);

    fetcher.fetch("click", "stream1", (result) => {
      expect(result).toEqual(expectedParsed);
      expect(mockedHttps.request).toHaveBeenCalledTimes(1);

      const callArgs = (mockedHttps.request as jest.Mock).mock.calls[0][0];
      expect(callArgs.method).toBe("GET");
      expect(callArgs.hostname).toBe("api.avo.app");
      done();
    });
  });

  test("in-flight dedup: exactly ONE https.request for concurrent same-key events", (done) => {
    const metadata = { schemaId: "s1", branchId: "b1", latestActionId: "a1", sourceId: "src1" };
    const wire = wireResponse("purchase", {}, metadata);

    const expectedParsed: EventSpecResponse = {
      eventSpec: { eventName: "purchase", properties: [] },
      metadata,
    };

    // Delay the response so both calls are in-flight
    const mockReq = new MockClientRequest();
    const mockRes = new MockIncomingMessage(200);

    (mockedHttps.request as jest.Mock).mockImplementation(
      (_options: any, callback: (res: any) => void) => {
        // Defer the response
        setTimeout(() => {
          callback(mockRes);
          const data = JSON.stringify(wire);
          mockRes.emit("data", Buffer.from(data));
          mockRes.emit("end");
        }, 10);
        return mockReq;
      }
    );

    let callCount = 0;
    const checkDone = (result: EventSpecResponse | null) => {
      callCount++;
      expect(result).toEqual(expectedParsed);
      if (callCount === 2) {
        // Only ONE actual https.request
        expect(mockedHttps.request).toHaveBeenCalledTimes(1);
        done();
      }
    };

    fetcher.fetch("purchase", "stream1", checkDone);
    fetcher.fetch("purchase", "stream1", checkDone);
  });

  test("in-flight failure: all queued callbacks resolved with null", (done) => {
    setupMockRequestError();

    let callCount = 0;
    const checkDone = (result: EventSpecResponse | null) => {
      callCount++;
      expect(result).toBeNull();
      if (callCount === 2) {
        expect(mockedHttps.request).toHaveBeenCalledTimes(1);
        done();
      }
    };

    fetcher.fetch("fail-event", "stream1", checkDone);
    fetcher.fetch("fail-event", "stream1", checkDone);
  });

  test("non-200 status code resolves callback with null", (done) => {
    setupMockRequest(500, { error: "Internal Server Error" });

    fetcher.fetch("click", "stream1", (result) => {
      expect(result).toBeNull();
      expect(mockedHttps.request).toHaveBeenCalledTimes(1);
      done();
    });
  });

  test("malformed JSON body resolves callback with null", (done) => {
    const mockReq = new MockClientRequest();
    const mockRes = new MockIncomingMessage(200);

    (mockedHttps.request as jest.Mock).mockImplementation(
      (_options: any, callback: (res: any) => void) => {
        callback(mockRes);
        mockRes.emit("data", Buffer.from("not valid json {{{"));
        mockRes.emit("end");
        return mockReq;
      }
    );

    fetcher.fetch("click", "stream1", (result) => {
      expect(result).toBeNull();
      expect(mockedHttps.request).toHaveBeenCalledTimes(1);
      done();
    });
  });

  describe("deadline", () => {
    afterEach(() => {
      (AvoEventSpecFetcher as any).fetchTimeoutMs = 10_000;
    });

    test("a request that never answers is destroyed and resolves null at the deadline (fetchTimeoutMs = 0)", (done) => {
      (AvoEventSpecFetcher as any).fetchTimeoutMs = 0;
      const mockReq = new MockClientRequest();
      (mockedHttps.request as jest.Mock).mockImplementation(() => mockReq); // never answers

      fetcher.fetch("click", "stream1", (result) => {
        expect(result).toBeNull();
        expect(mockReq.destroy).toHaveBeenCalled();
        expect(mockedHttps.request).toHaveBeenCalledTimes(1);
        done();
      });
    });

    test("no socket-idle timeout is set: the wall-clock deadline is the only one", () => {
      const mockReq = new MockClientRequest();
      (mockedHttps.request as jest.Mock).mockImplementation(() => mockReq);

      fetcher.fetch("click", "stream1", () => {});

      expect(mockReq.setTimeout).not.toHaveBeenCalled();
    });

    test("request() throwing synchronously resolves null, frees the key and leaves no deadline behind", async () => {
      (AvoEventSpecFetcher as any).fetchTimeoutMs = 0;
      (mockedHttps.request as jest.Mock).mockImplementationOnce(() => {
        throw new TypeError("invalid options");
      });
      const results: Array<EventSpecResponse | null> = [];

      expect(() => fetcher.fetch("click", "stream1", (r) => results.push(r))).not.toThrow();
      expect(results).toEqual([null]);

      // Past the (zero) deadline nothing fires, and the key is free for a new request.
      await new Promise((resolve) => setTimeout(resolve, 20));
      setupMockRequest(200, { events: [], metadata: {} });
      fetcher.fetch("click", "stream1", () => {});
      expect(mockedHttps.request).toHaveBeenCalledTimes(2);
    });
  });

  test("separate keys make separate requests", (done) => {
    const metadata = { schemaId: "s1", branchId: "b1", latestActionId: "a1", sourceId: "src1" };
    const wire = wireResponse("click", {}, metadata);

    const expectedParsed: EventSpecResponse = {
      eventSpec: { eventName: "click", properties: [] },
      metadata,
    };

    setupMockRequest(200, wire);

    let callCount = 0;
    const checkDone = () => {
      callCount++;
      if (callCount === 2) {
        expect(mockedHttps.request).toHaveBeenCalledTimes(2);
        done();
      }
    };

    fetcher.fetch("click", "stream1", (result) => {
      expect(result).toEqual(expectedParsed);
      checkDone();
    });

    fetcher.fetch("purchase", "stream1", (result) => {
      // Both resolve with the same mock but that's fine for this test
      checkDone();
    });
  });

  test("parseWireResponse transforms wire format correctly", () => {
    const wire = {
      events: [{
        b: "main",
        id: "evt1",
        vids: [],
        p: {
          "Cli Action": { t: "string", r: true, v: { '["Status","Pull"]': ["evt1"] } },
          "Client": { t: "string", r: true },
        },
      }],
      metadata: { schemaId: "s1", branchId: "main", latestActionId: "a1", sourceId: "src1" },
    };

    const result = AvoEventSpecFetcher.parseWireResponse(wire, "Cli Invoked");

    expect(result.metadata).toEqual({ schemaId: "s1", branchId: "main", latestActionId: "a1", sourceId: "src1" });
    expect(result.eventSpec).not.toBeNull();
    expect(result.eventSpec!.eventName).toBe("Cli Invoked");
    expect(result.eventSpec!.properties).toEqual([
      { propertyName: "Cli Action", propertyType: "string" },
      { propertyName: "Client", propertyType: "string" },
    ]);
  });

  test("parseWireResponse returns null eventSpec for empty events array", () => {
    const wire = { events: [], metadata: { schemaId: "s1", branchId: "b1", latestActionId: "a1", sourceId: "src1" } };
    const result = AvoEventSpecFetcher.parseWireResponse(wire, "test");
    expect(result.eventSpec).toBeNull();
  });
});

describe("AvoEventSpecFetcher connection reuse", () => {
  const metadata = { schemaId: "s1", branchId: "b1", latestActionId: "a1", sourceId: "src1" };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("every fetcher uses one shared agent, and destroy() leaves it usable for the others", async () => {
    setupMockRequest(200, wireResponse("a", { x: { t: "string" } }, metadata));
    const first = new AvoEventSpecFetcher("key-1");
    const second = new AvoEventSpecFetcher("key-2");

    // The fetcher swallows callback exceptions, so assert outside the callbacks.
    await new Promise((resolve) => first.fetch("a", "s", resolve));
    first.destroy();
    const result = await new Promise((resolve) => second.fetch("a", "s", resolve));
    second.destroy();

    const agents = (mockedHttps.request as jest.Mock).mock.calls.map((call) => call[0].agent);
    expect(result).not.toBeNull();
    expect(agents).toHaveLength(2);
    expect(agents[0]).toBeDefined();
    expect(agents[1]).toBe(agents[0]);
    expect(agents[0].destroy).not.toHaveBeenCalled();
  });

  test("destroy() aborts the fetcher's own in-flight request", () => {
    const mockReq = new MockClientRequest();
    (mockedHttps.request as jest.Mock).mockImplementation(() => mockReq);
    const fetcher = new AvoEventSpecFetcher("key-1");

    fetcher.fetch("a", "s", () => {});
    fetcher.destroy();

    expect(mockReq.destroy).toHaveBeenCalled();
  });
});
