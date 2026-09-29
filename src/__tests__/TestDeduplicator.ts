import { AvoDeduplicator } from "../AvoDeduplicator";
import { deepEquals } from "../utils";
import { AvoInspector } from "../AvoInspector";
import { AvoNetworkCallsHandler } from "../AvoNetworkCallsHandler";
import { AvoEventSpecFetcher } from "../eventSpec/AvoEventSpecFetcher";
import { defaultOptions } from "./constants";

jest
  .useFakeTimers()
  .setSystemTime(new Date('2020-01-01'));

describe("Deduplicator", () => {
  const deduplicator = new AvoDeduplicator();

  // Keep the Inspector-level tests off the real network: a 200 send and no event spec.
  beforeAll(() => {
    jest
      .spyOn(AvoNetworkCallsHandler.prototype, "callInspectorWithBatchBody")
      .mockImplementation(() => Promise.resolve(200));
    jest
      .spyOn(AvoEventSpecFetcher.prototype, "fetch")
      .mockImplementation((_eventName, _streamId, callback) => callback(null));
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  const testObject = {
    "0": "some string",
    "1": [1, 2, 3],
    2: [["str", true]],
    3: { avo: [1.1, 2.2, 3.3] },
  };

  test(`AvoDeduplicator.deepEqual tests`, () => {
    const secondObject = {
      "0": "some string",
      "1": [1, 2, 3],
      2: [["str", true]],
      3: { avo: [1.1, 2.2, 3.3] },
    };

    expect(deepEquals(testObject, secondObject)).toBe(true);

    expect(deepEquals(testObject, { ...secondObject, "4": "4" })).toBe(false);

    expect(
      deepEquals(testObject, {
        ...secondObject,
        3: { ...secondObject[3], avo: [1.1] },
      })
    ).toBe(false);

    expect(deepEquals(testObject, { ...secondObject, 0: "other string" })).toBe(
      false
    );
  });

  test(`Detects duplications when track in avo and then manually`, () => {
    const shouldRegisterFromAvo = deduplicator.shouldRegisterEvent(
      "Test",
      testObject,
      true
    );
    const shouldRegisterManual = deduplicator.shouldRegisterEvent(
      "Test",
      testObject,
      false
    );

    expect(shouldRegisterFromAvo).toBe(true);
    expect(shouldRegisterManual).toBe(false);
  });

  test(`Detects duplications when track manually and then in avo`, () => {
    const shouldRegisterManual = deduplicator.shouldRegisterEvent(
      "Test",
      testObject,
      false
    );
    const shouldRegisterFromAvo = deduplicator.shouldRegisterEvent(
      "Test",
      testObject,
      true
    );

    expect(shouldRegisterManual).toBe(true);
    expect(shouldRegisterFromAvo).toBe(false);
  });

  test(`Inspector deduplicates only one event when track manually, in avo and then manually again`, async () => {
    const inspector = new AvoInspector(defaultOptions);
    inspector.enableLogging(false);

    const manuallyTrackedSchema = await inspector.trackSchemaFromEvent(
      "test",
      testObject
    );
    // @ts-ignore
    const avoTrackedSchema = await inspector._avoFunctionTrackSchemaFromEvent(
      "test",
      testObject,
      "eventId",
      "eventhash"
    );
    const manuallyTrackedSchemaAgain = await inspector.trackSchemaFromEvent(
      "test",
      testObject
    );

    expect(manuallyTrackedSchema.length).toBe(4);
    expect(manuallyTrackedSchema.length + avoTrackedSchema.length + manuallyTrackedSchemaAgain.length).toBe(8);
  });

  test(`Inspector deduplicates only one event when track in avo, manually and then in avo again`, async () => {
    const inspector = new AvoInspector(defaultOptions);
    inspector.enableLogging(false);

    // @ts-ignore
    const avoTrackedSchema = await inspector._avoFunctionTrackSchemaFromEvent(
      "test",
      testObject,
      "eventId",
      "eventhash"
    );
    const manuallyTrackedSchema = await inspector.trackSchemaFromEvent(
      "test",
      testObject
    );
    // @ts-ignore
    const avoTrackedSchemaAgain = await inspector._avoFunctionTrackSchemaFromEvent(
      "test",
      testObject,
      "eventId",
      "eventhash"
    );

    expect(avoTrackedSchema.length).toBe(4);
    expect(manuallyTrackedSchema.length).toBe(0);
    expect(avoTrackedSchemaAgain.length).toBe(4);
  });

  test(`Allows two same manual events in a row`, async () => {
    const inspector = new AvoInspector(defaultOptions);
    inspector.enableLogging(false);

    const manuallyTrackedSchema = await inspector.trackSchemaFromEvent(
      "test",
      testObject
    );
    const manuallyTrackedSchemaAgain = await inspector.trackSchemaFromEvent(
      "test",
      testObject
    );

    expect(manuallyTrackedSchema.length).toBe(4);
    expect(manuallyTrackedSchemaAgain.length).toBe(4);
  });

  test(`Allows two same avo events in a row`, async () => {
    const inspector = new AvoInspector(defaultOptions);
    inspector.enableLogging(false);

    // @ts-ignore
    const avoTrackedSchema = await inspector._avoFunctionTrackSchemaFromEvent(
      "test",
      testObject,
      "eventId",
      "eventhash"
    );
    // @ts-ignore
    const avoTrackedSchemaAgain = await inspector._avoFunctionTrackSchemaFromEvent(
      "test",
      testObject,
      "eventId",
      "eventhash"
    );

    expect(avoTrackedSchema.length).toBe(4);
    expect(avoTrackedSchemaAgain.length).toBe(4);
  });

  describe("expiry keeps the params of a newer registration of the same key", () => {
    const start = new Date("2020-01-01").getTime();
    afterEach(() => jest.setSystemTime(new Date("2020-01-01")));

    test.each([
      ["Codegen", true],
      ["manual", false],
    ])("%s at 0 ms and 400 ms, then the other kind at 600 ms, is a duplicate", (_kind, first) => {
      const dedup = new AvoDeduplicator();
      jest.setSystemTime(start);
      expect(dedup.shouldRegisterEvent("A", { a: 1 }, first, "s")).toBe(true);
      jest.setSystemTime(start + 400);
      expect(dedup.shouldRegisterEvent("A", { a: 1 }, first, "s")).toBe(true);

      // The 0 ms registration expires here; the 400 ms one is still inside the window.
      jest.setSystemTime(start + 600);
      expect(dedup.shouldRegisterEvent("A", { a: 1 }, !first, "s")).toBe(false);
    });

    test("a lone registration older than 500 ms still expires", () => {
      const dedup = new AvoDeduplicator();
      jest.setSystemTime(start);
      dedup.shouldRegisterEvent("A", { a: 1 }, true, "s");

      jest.setSystemTime(start + 600);
      expect(dedup.shouldRegisterEvent("A", { a: 1 }, false, "s")).toBe(true);
    });

    test("a newer registration with different params replaces the older one's", () => {
      const dedup = new AvoDeduplicator();
      jest.setSystemTime(start);
      dedup.shouldRegisterEvent("A", { a: 1 }, true, "s");
      jest.setSystemTime(start + 400);
      dedup.shouldRegisterEvent("A", { a: 2 }, true, "s");

      jest.setSystemTime(start + 600);
      expect(dedup.shouldRegisterEvent("A", { a: 1 }, false, "s")).toBe(true);
      expect(dedup.shouldRegisterEvent("A", { a: 2 }, false, "s")).toBe(false);
    });
  });

  test(`Does not deduplicate if more than 500ms pass`, () => {
    const shouldRegisterFromAvo = deduplicator.shouldRegisterEvent(
      "Test",
      testObject,
      true
    );
    const now = new Date();
    const dateNowSpy = jest
      .spyOn(Date, "now")
      .mockImplementation(() =>
        now.setMilliseconds(now.getMilliseconds() + 501)
      );
    const shouldRegisterManual = deduplicator.shouldRegisterEvent(
      "Test",
      testObject,
      false
    );

    expect(shouldRegisterFromAvo).toBe(true);
    expect(shouldRegisterManual).toBe(true);

    dateNowSpy.mockRestore();
  });
});
