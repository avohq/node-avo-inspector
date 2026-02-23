import { AvoInspector } from "../AvoInspector";
import { AvoInspectorEnv } from "../AvoInspectorEnv";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";
import { AvoEventSpecCache } from "../eventSpec/AvoEventSpecCache";
import { EventSpecResponse } from "../eventSpec/AvoEventSpecFetchTypes";

jest.mock("../AvoNetworkCallsHandler");
jest.mock("../eventSpec/AvoEventSpecFetcher");
jest.mock("../eventSpec/AvoEventSpecCache");

describe("fetchAndValidateAsync integration", () => {
  let inspector: AvoInspector;
  let mockFetcher: jest.Mocked<AvoEventSpecFetcher>;
  let mockCache: jest.Mocked<AvoEventSpecCache>;

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

  beforeEach(() => {
    jest.clearAllMocks();
    (AvoEventSpecCache as unknown as jest.Mock).mockImplementation(() => ({
      get: jest.fn().mockReturnValue(undefined),
      set: jest.fn(),
      flush: jest.fn(),
      makeKey: jest.fn(),
    }));
    (AvoEventSpecFetcher as unknown as jest.Mock).mockImplementation(() => ({
      fetch: jest.fn(),
    }));
  });

  test("validation is active in dev environment", () => {
    inspector = new AvoInspector({
      apiKey: "test-key",
      env: AvoInspectorEnv.Dev,
      version: "1",
    });

    // Dev should have spec validation enabled
    expect(inspector.isSpecValidationEnabled()).toBe(true);
  });

  test("validation is active in staging environment", () => {
    inspector = new AvoInspector({
      apiKey: "test-key",
      env: AvoInspectorEnv.Staging,
      version: "1",
    });

    expect(inspector.isSpecValidationEnabled()).toBe(true);
  });

  test("validation is NOT active in prod environment", () => {
    inspector = new AvoInspector({
      apiKey: "test-key",
      env: AvoInspectorEnv.Prod,
      version: "1",
    });

    expect(inspector.isSpecValidationEnabled()).toBe(false);
  });

  test("cache miss triggers async fetch", async () => {
    inspector = new AvoInspector({
      apiKey: "test-key",
      env: AvoInspectorEnv.Dev,
      version: "1",
    });

    // Access the internal fetcher mock
    const fetcherInstance = (inspector as any).eventSpecFetcher;
    const cacheInstance = (inspector as any).eventSpecCache;

    // Cache miss
    cacheInstance.get.mockReturnValue(undefined);

    // Fetcher calls the callback
    fetcherInstance.fetch.mockImplementation(
      (
        _eventName: string,
        _streamId: string,
        callback: (result: EventSpecResponse | null) => void
      ) => {
        callback(specResponse);
      }
    );

    await inspector.fetchAndValidateAsync(
      "click",
      [{ propertyName: "target", propertyType: "string" }],
      "stream1"
    );

    expect(fetcherInstance.fetch).toHaveBeenCalledTimes(1);
    expect(cacheInstance.set).toHaveBeenCalled();
  });

  test("cache hit uses synchronous validation (no fetch)", async () => {
    inspector = new AvoInspector({
      apiKey: "test-key",
      env: AvoInspectorEnv.Dev,
      version: "1",
    });

    const cacheInstance = (inspector as any).eventSpecCache;
    const fetcherInstance = (inspector as any).eventSpecFetcher;

    // Cache hit
    cacheInstance.get.mockReturnValue(specResponse);

    await inspector.fetchAndValidateAsync(
      "click",
      [{ propertyName: "target", propertyType: "string" }],
      "stream1"
    );

    // Should NOT call fetch since cache had a hit
    expect(fetcherInstance.fetch).not.toHaveBeenCalled();
  });

  test("prod environment skips validation entirely", async () => {
    inspector = new AvoInspector({
      apiKey: "test-key",
      env: AvoInspectorEnv.Prod,
      version: "1",
    });

    // Should do nothing in prod
    await inspector.fetchAndValidateAsync(
      "click",
      [{ propertyName: "target", propertyType: "string" }],
      "stream1"
    );

    // No fetcher or cache should be created for prod
    expect((inspector as any).eventSpecFetcher).toBeUndefined();
  });
});
