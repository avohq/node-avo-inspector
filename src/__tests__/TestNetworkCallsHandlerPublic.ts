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
    inspector.avoNetworkCallsHandler["samplingRate"] = 0.1;
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

  test("handleTrackSchema is called on trackSchemaFromEvent", async () => {
    await inspector.trackSchemaFromEvent(eventName, properties);

    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(2);
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "sessionStarted",
        apiKey: apiKey,
        appName: appName,
        appVersion: version,
        libVersion: expect.anything(),
        env: env,
        libPlatform: "node",
        messageId: expect.anything(),
        trackingId: "",
        createdAt: expect.any(String),
        sessionId: expect.anything(),
        samplingRate: 1,
      }),
    ]
    );
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
        trackingId: "",
        createdAt: expect.anything(),
        sessionId: expect.anything(),
        samplingRate: 0.1,
      }),
    ]);
  });

  test("handleTrackSchema is called on _avoFunctionTrackSchemaFromEvent", async () => {
    const eventId = "testId";
    const eventHash = "testHash";

    // @ts-ignore
    await inspector._avoFunctionTrackSchemaFromEvent(
      eventName,
      properties,
      eventId,
      eventHash
    );

    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(2);
    expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toBeCalledWith([
      expect.objectContaining({
        type: "sessionStarted",
        apiKey: apiKey,
        appName: appName,
        appVersion: version,
        libVersion: expect.anything(),
        env: env,
        libPlatform: "node",
        messageId: expect.anything(),
        trackingId: "",
        createdAt: expect.anything(),
        sessionId: expect.anything(),
        samplingRate: 0.1,
      })
    ]
    );
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
        trackingId: "",
        createdAt: expect.anything(),
        sessionId: expect.anything(),
        samplingRate: 0.1,
      }),
    ]);
  });

  test("an error is logged if event schema call fails and AvoInspector.shouldLog is true", async () => {
    inspectorCallSpy.mockImplementationOnce(happyPathInspectorCall);
    inspectorCallSpy.mockRejectedValueOnce('Network error');

    await inspector.trackSchemaFromEvent(eventName, properties);

    expect(consoleLogSpy).toHaveBeenCalledWith('Avo Inspector: schema sending failed: Network error.');
  });
});
