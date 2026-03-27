import { AvoGuid } from "../AvoGuid";
import { AvoNetworkCallsHandler, BaseBody } from "../AvoNetworkCallsHandler";

import {
  defaultOptions,
  mockedReturns,
} from "./constants";

const inspectorVersion = process.env.npm_package_version || "";

describe("NetworkCallsHandler", () => {
  const { apiKey, env, version } = defaultOptions;
  const appName = "";

  let networkHandler: AvoNetworkCallsHandler;
  let baseBody: BaseBody;

  const now = new Date();

  beforeAll(() => {
    // @ts-ignore
    jest.spyOn(global, "Date").mockImplementation(() => now);

    jest
      .spyOn(AvoGuid as any, "newGuid")
      .mockImplementation(() => mockedReturns.GUID);

    networkHandler = new AvoNetworkCallsHandler(
      apiKey,
      env,
      "",
      version,
      inspectorVersion
    );

    baseBody = {
      apiKey,
      appName,
      appVersion: version,
      libVersion: inspectorVersion,
      env,
      libPlatform: "node",
      messageId: mockedReturns.GUID,
      trackingId: "",
      sessionId: "",
      anonymousId: "",
      createdAt: new Date().toISOString(),
      samplingRate: 1.0,
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("bodyForEventSchemaCall returns base body + event schema used for event sending from non Codegen", () => {
    const eventName = "event name";
    const eventProperties = [{ propertyName: "prop0", propertyType: "string" }];

    const body = networkHandler.bodyForEventSchemaCall(
      "",
      eventName,
      eventProperties,
      null,
      null
    );

    expect(body).toEqual({
      ...baseBody,
      anonymousId: "",
      type: "event",
      eventName,
      eventProperties,
      avoFunction: false,
      eventId: null,
      eventHash: null,
    });
  });

  test("bodyForEventSchemaCall returns base body + event schema used for event sending from Codegen", () => {
    const eventName = "event name";
    const eventId = "event id";
    const eventHash = "event hash";
    const eventProperties = [{ propertyName: "prop0", propertyType: "string" }];

    const body = networkHandler.bodyForEventSchemaCall(
      "",
      eventName,
      eventProperties,
      eventId,
      eventHash
    );

    expect(body).toEqual({
      ...baseBody,
      anonymousId: "",
      type: "event",
      eventName,
      eventProperties,
      avoFunction: true,
      eventId,
      eventHash,
    });
  });

  test("bodyForEventSchemaCall uses streamId as anonymousId", () => {
    const eventName = "event name";
    const streamId = "user-123";
    const eventProperties = [{ propertyName: "prop0", propertyType: "string" }];

    const body = networkHandler.bodyForEventSchemaCall(
      streamId,
      eventName,
      eventProperties,
      null,
      null
    );

    expect(body.anonymousId).toBe("user-123");
  });

  test("bodyForEventSchemaCall with rawEventProperties passes them through (no encryption in dev without key)", () => {
    const eventName = "event name";
    const eventProperties = [{ propertyName: "prop0", propertyType: "string" }];
    const rawEventProperties = { prop0: "hello" };

    const body = networkHandler.bodyForEventSchemaCall(
      "",
      eventName,
      eventProperties,
      null,
      null,
      rawEventProperties
    );

    // Without a publicEncryptionKey, encryption is not triggered,
    // so eventProperties should be the plain schema (not encrypted)
    expect(body.eventProperties).toEqual(eventProperties);
    expect(body.type).toBe("event");
    expect(body.eventName).toBe(eventName);
  });

  test("base body includes publicEncryptionKey when handler is constructed with one", () => {
    const handlerWithKey = new AvoNetworkCallsHandler(
      apiKey,
      env,
      "",
      version,
      inspectorVersion,
      "test-public-key-abc"
    );

    const eventName = "event name";
    const eventProperties = [{ propertyName: "prop0", propertyType: "string" }];

    const body = handlerWithKey.bodyForEventSchemaCall(
      "",
      eventName,
      eventProperties,
      null,
      null
    );

    expect(body.publicEncryptionKey).toBe("test-public-key-abc");
  });

  test("base body does not include publicEncryptionKey when handler is constructed without one", () => {
    const eventName = "event name";
    const eventProperties = [{ propertyName: "prop0", propertyType: "string" }];

    const body = networkHandler.bodyForEventSchemaCall(
      "",
      eventName,
      eventProperties,
      null,
      null
    );

    expect(body.publicEncryptionKey).toBeUndefined();
  });
});
