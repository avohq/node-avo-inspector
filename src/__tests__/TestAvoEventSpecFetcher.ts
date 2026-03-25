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
    const specResponse: EventSpecResponse = {
      eventSpec: {
        eventName: "click",
        properties: [{ propertyName: "target", propertyType: "string" }],
      },
      metadata: {
        schemaId: "s1",
        branchId: "b1",
        latestActionId: "a1",
        sourceId: "src1",
      },
    };

    setupMockRequest(200, specResponse);

    fetcher.fetch("click", "stream1", (result) => {
      expect(result).toEqual(specResponse);
      expect(mockedHttps.request).toHaveBeenCalledTimes(1);

      const callArgs = (mockedHttps.request as jest.Mock).mock.calls[0][0];
      expect(callArgs.method).toBe("GET");
      expect(callArgs.hostname).toBe("api.avo.app");
      done();
    });
  });

  test("in-flight dedup: exactly ONE https.request for concurrent same-key events", (done) => {
    const specResponse: EventSpecResponse = {
      eventSpec: {
        eventName: "purchase",
        properties: [],
      },
      metadata: {
        schemaId: "s1",
        branchId: "b1",
        latestActionId: "a1",
        sourceId: "src1",
      },
    };

    // Delay the response so both calls are in-flight
    const mockReq = new MockClientRequest();
    const mockRes = new MockIncomingMessage(200);

    (mockedHttps.request as jest.Mock).mockImplementation(
      (_options: any, callback: (res: any) => void) => {
        // Defer the response
        setTimeout(() => {
          callback(mockRes);
          const data = JSON.stringify(specResponse);
          mockRes.emit("data", Buffer.from(data));
          mockRes.emit("end");
        }, 10);
        return mockReq;
      }
    );

    let callCount = 0;
    const checkDone = (result: EventSpecResponse | null) => {
      callCount++;
      expect(result).toEqual(specResponse);
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

  test("timeout resolves callback with null", (done) => {
    const mockReq = new MockClientRequest();

    (mockedHttps.request as jest.Mock).mockImplementation(
      (_options: any, _callback: (res: any) => void) => {
        // Simulate timeout: never call the response callback,
        // instead emit "timeout" on next tick
        process.nextTick(() => mockReq.emit("timeout"));
        return mockReq;
      }
    );

    fetcher.fetch("click", "stream1", (result) => {
      expect(result).toBeNull();
      expect(mockReq.destroy).toHaveBeenCalled();
      expect(mockedHttps.request).toHaveBeenCalledTimes(1);
      done();
    });
  });

  test("separate keys make separate requests", (done) => {
    const spec1: EventSpecResponse = {
      eventSpec: { eventName: "click", properties: [] },
      metadata: {
        schemaId: "s1",
        branchId: "b1",
        latestActionId: "a1",
        sourceId: "src1",
      },
    };

    setupMockRequest(200, spec1);

    let callCount = 0;
    const checkDone = () => {
      callCount++;
      if (callCount === 2) {
        expect(mockedHttps.request).toHaveBeenCalledTimes(2);
        done();
      }
    };

    fetcher.fetch("click", "stream1", (result) => {
      expect(result).toEqual(spec1);
      checkDone();
    });

    fetcher.fetch("purchase", "stream1", (result) => {
      // Both resolve with the same mock but that's fine for this test
      checkDone();
    });
  });
});
