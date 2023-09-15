import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";

import { defaultOptions } from "./constants";

describe("AvoNetworkCallsHandler", () => {
  let inspectorCallSpy: jest.SpyInstance<any, unknown[]>;

  let inspector: AvoInspector;

  let inspectorCallResolvedCount = 0;

  const { apiKey, env, version, appName } = defaultOptions;

  beforeAll(() => {
    inspector = new AvoInspector(defaultOptions);
    inspector.enableLogging(false);

    inspectorCallSpy = jest
      .spyOn(AvoNetworkCallsHandler.prototype as any, "callInspectorWithBatchBody");

    inspectorCallSpy.mockImplementation(() => {
        inspector.avoNetworkCallsHandler["samplingRate"] = 0.1;
        return new Promise<void>((resolve) => process.nextTick(() => {
          inspectorCallResolvedCount += 1;
          resolve();
        }))
      });
  });

  afterEach(() => {
    inspectorCallResolvedCount = 0;
    jest.clearAllMocks();
    // @ts-ignore
    inspector.avoDeduplicator._clearEvents();
  });

  test("callInspectorWithBatchBody is called for sessionStarted and event types on trackSchemaFromEvent", async () => {
    const eventName = "event name";
    const properties = {
      prop0: "",
      prop2: false,
      prop3: 0,
      prop4: 0.0,
    };

    await inspector.trackSchemaFromEvent(eventName, properties);

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

    expect(inspectorCallResolvedCount).toEqual(2);
  });

  test("handleTrackSchema is called on _avoFunctionTrackSchemaFromEvent", async () => {
    const eventName = "event name";
    const properties = {
      prop0: "",
      prop2: false,
      prop3: 0,
      prop4: 0.0,
    };
    const eventId = "testId";
    const eventHash = "testHash";

    const schema = inspector.extractSchema(properties);

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
});
