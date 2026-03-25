import { AvoStreamId } from "../AvoStreamId";

describe("AvoStreamId", () => {
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("streamId getter returns empty string by default", () => {
    const avoStreamId = new AvoStreamId();
    expect(avoStreamId.streamId).toBe("");
  });

  test("streamId getter returns the value passed to constructor", () => {
    const avoStreamId = new AvoStreamId("my-stream-id");
    expect(avoStreamId.streamId).toBe("my-stream-id");
  });

  test("streamId containing ':' logs a warning", () => {
    const avoStreamId = new AvoStreamId("invalid:stream:id");
    const id = avoStreamId.streamId;

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[Avo Inspector] Warning: streamId contains ':' which is not supported"
    );
    expect(id).toBe("invalid:stream:id");
  });

  test("streamId without ':' does not log a warning", () => {
    const avoStreamId = new AvoStreamId("valid-stream-id");
    const id = avoStreamId.streamId;

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(id).toBe("valid-stream-id");
  });

  test("empty streamId does not log a warning", () => {
    const avoStreamId = new AvoStreamId("");
    const id = avoStreamId.streamId;

    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(id).toBe("");
  });
});
