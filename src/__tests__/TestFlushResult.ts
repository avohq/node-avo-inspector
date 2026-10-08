import { AvoInspector } from "../AvoInspector";

// flush() resolves true when the instance has drained (nothing buffered, waiting or in
// flight), and false when the timeout won. It never rejects.

afterEach(() => {
  jest.restoreAllMocks();
});

const staging = () =>
  new AvoInspector({ apiKey: "k", env: "staging", version: "1.0.0", batchSize: 30, disableBatchTimer: true });

// Sends that stay in flight until released.
function hungSends(inspector: AvoInspector) {
  const releases: Array<(status: number) => void> = [];
  jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody")
    .mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
  return () => releases.splice(0).forEach((release) => release(200));
}

test("an empty instance has drained", async () => {
  const inspector = staging();
  await expect(inspector.flush()).resolves.toBe(true);
  inspector.destroy();
});

test("a normal send drains", async () => {
  const inspector = staging();
  const send = jest.spyOn(inspector.avoNetworkCallsHandler, "callInspectorWithBatchBody").mockResolvedValue(200);
  await inspector.trackSchemaFromEvent({ eventName: "E", eventProperties: { a: 1 } });

  await expect(inspector.flush()).resolves.toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  inspector.destroy();
});

test("a hung send makes a short flush report false; once it completes, flush reports true", async () => {
  const inspector = staging();
  const release = hungSends(inspector);
  await inspector.trackSchemaFromEvent({ eventName: "E", eventProperties: { a: 1 } });

  await expect(inspector.flush(100)).resolves.toBe(false);

  release();
  await expect(inspector.flush()).resolves.toBe(true);
  inspector.destroy();
});

test("flush(0) starts the sends and reports false while they are in flight", async () => {
  const inspector = staging();
  const release = hungSends(inspector);
  await inspector.trackSchemaFromEvent({ eventName: "E", eventProperties: { a: 1 } });

  await expect(inspector.flush(0)).resolves.toBe(false);
  expect(inspector.avoNetworkCallsHandler.callInspectorWithBatchBody).toHaveBeenCalledTimes(1);

  release();
  await expect(inspector.flush(0)).resolves.toBe(true);
  inspector.destroy();
});

test("a destroyed instance has nothing pending", async () => {
  const inspector = staging();
  hungSends(inspector);
  await inspector.trackSchemaFromEvent({ eventName: "E", eventProperties: { a: 1 } });
  inspector.flush(0);

  inspector.destroy();
  await expect(inspector.flush()).resolves.toBe(true);
});
