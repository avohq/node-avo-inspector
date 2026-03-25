import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";

import { defaultOptions } from "./constants";

describe("AvoNetworkCallsHandler", () => {
  let inspectorCallSpy: jest.SpyInstance<any, unknown[]>;
  let consoleLogSpy: jest.SpyInstance<any, unknown[]>;

  let inspector: AvoInspector;

  const { apiKey, env, version, appName } = defaultOptions;

  const eventName = "event name";
  const properties = {
    prop0: "",
    prop2: false,
    prop3: 0,
    prop4: 0.0,
  };

  const happyPathInspectorCall = () => {
    return Promise.resolve();
  };

  beforeAll(() => {
    inspector = new AvoInspector(defaultOptions);
    inspector.enableLogging(true);

    inspectorCallSpy = jest
      .spyOn(AvoNetworkCallsHandler.prototype as any, "callInspectorWithBatchBody");

    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  beforeEach(() => {
    inspectorCallSpy.mockImplementation(happyPathInspectorCall);
  })

  afterEach(() => {
    jest.clearAllMocks();
    // @ts-ignore
    inspector.avoDeduplicator._clearEvents();
  });

  test("trackSchemaFromEvent sends only event call (no sessionStarted)", async () => {
    await inspector.trackSchemaFromEvent(eventName, properties);

    // Should be called once (event only, no sessionStarted)
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(1);
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "event",
        apiKey: apiKey,
        appName: appName,
        appVersion: version,
        libVersion: expect.anything(),
        env: env,
        libPlatform: "node",
        messageId: expect.anything(),
        anonymousId: "",
        createdAt: expect.any(String),
        samplingRate: 1,
      }),
    ]);
  });

  test("trackSchemaFromEvent with streamId sets anonymousId to streamId", async () => {
    await inspector.trackSchemaFromEvent(eventName, properties, "user-stream-123");

    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(1);
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "event",
        anonymousId: "user-stream-123",
      }),
    ]);
  });

  test("trackSchemaFromEvent without streamId sets anonymousId to empty string", async () => {
    await inspector.trackSchemaFromEvent(eventName, properties);

    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(1);
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledWith([
      expect.objectContaining({
        anonymousId: "",
      }),
    ]);
  });

  test("trackSchemaFromEvent with streamId containing ':' logs warning", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await inspector.trackSchemaFromEvent(eventName, properties, "invalid:stream");

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[Avo Inspector] Warning: streamId contains ':' which is not supported"
    );

    consoleWarnSpy.mockRestore();
  });

  test("_avoFunctionTrackSchemaFromEvent sends only event call (no sessionStarted)", async () => {
    const eventId = "testId";
    const eventHash = "testHash";

    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent(
      eventName,
      properties,
      eventId,
      eventHash
    );

    // Should be called once (event only, no sessionStarted)
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(1);
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "event",
        apiKey: apiKey,
        appName: appName,
        appVersion: version,
        libVersion: expect.anything(),
        env: env,
        libPlatform: "node",
        messageId: expect.anything(),
        anonymousId: "",
        createdAt: expect.any(String),
      }),
    ]);
  });

  test("an error is logged if event schema call fails and AvoInspector.shouldLog is true", async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    inspectorCallSpy.mockRejectedValueOnce('Network error');

    await inspector.trackSchemaFromEvent(eventName, properties);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Avo Inspector: schema sending failed: Network error.');
    consoleErrorSpy.mockRestore();
  });

  test("_avoFunctionTrackSchemaFromEvent passes empty string as anonymousId", async () => {
    const eventId = "testId";
    const eventHash = "testHash";

    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent(
      eventName,
      properties,
      eventId,
      eventHash
    );

    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledWith([
      expect.objectContaining({
        anonymousId: "",
      }),
    ]);
  });

  test("trackSchemaFromEvent with streamId containing ':' still sends the event", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await inspector.trackSchemaFromEvent(eventName, properties, "bad:stream");

    // Warning is logged
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[Avo Inspector] Warning: streamId contains ':' which is not supported"
    );

    // Event is still sent despite the warning
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(1);
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "event",
        anonymousId: "bad:stream",
      }),
    ]);

    consoleWarnSpy.mockRestore();
  });

  test("trackSchemaFromEvent rejection contains the expected error string", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    // Force the catch block in trackSchemaFromEvent by making extractSchema throw
    jest.spyOn(inspector, "extractSchema").mockImplementation(() => {
      throw new Error("test explosion");
    });

    await expect(
      inspector.trackSchemaFromEvent(eventName, properties)
    ).rejects.toBe(
      "Avo Inspector: something went wrong. Please report to support@avo.app."
    );

    consoleErrorSpy.mockRestore();
    (inspector.extractSchema as jest.Mock).mockRestore();
  });
});
