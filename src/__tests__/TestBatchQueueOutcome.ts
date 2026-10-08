import { AvoBatchQueue } from "../AvoBatchQueue";

// bufferedBatchOutcome(): the outcome of whichever batch swaps out the events buffered now.

const event = (name: string): any => ({ eventName: name });

const queue = (batchSize: number, disableBatchTimer = true) => {
  const sent: string[][] = [];
  const q = new AvoBatchQueue<string>(
    { batchSize, batchFlushSeconds: 0.01, maxQueueSize: 100, disableBatchTimer },
    (batch) => {
      sent.push(batch.map((e: any) => e.eventName));
      return Promise.resolve("sent:" + batch.length);
    },
    "dropped"
  );
  return { q, sent };
};

test("is null for an empty buffer", () => {
  expect(queue(10).q.bufferedBatchOutcome()).toBeNull();
});

test("follows the size-triggered drain that takes the buffer", async () => {
  const { q, sent } = queue(2);
  q.enqueue(event("A"));
  const outcome = q.bufferedBatchOutcome()!;
  q.enqueue(event("B")); // size trigger

  await expect(outcome).resolves.toBe("sent:2");
  expect(sent).toEqual([["A", "B"]]);
});

test("follows the timer drain", async () => {
  const { q } = queue(10, false);
  q.enqueue(event("A"));

  await expect(q.bufferedBatchOutcome()).resolves.toBe("sent:1");
});

test("is shared by every event in the same buffer, and a later buffer gets a new one", async () => {
  const { q } = queue(10);
  q.enqueue(event("A"));
  const first = q.bufferedBatchOutcome();
  q.enqueue(event("B"));
  expect(q.bufferedBatchOutcome()).toBe(first);
  q.drain();
  q.enqueue(event("C"));
  const second = q.bufferedBatchOutcome();
  q.drain();

  expect(second).not.toBe(first);
  await expect(first).resolves.toBe("sent:2");
  await expect(second).resolves.toBe("sent:1");
});

test("settles as dropped when clear() discards the buffer", async () => {
  const { q, sent } = queue(10);
  q.enqueue(event("A"));
  const outcome = q.bufferedBatchOutcome();
  q.clear();

  await expect(outcome).resolves.toBe("dropped");
  expect(sent).toEqual([]);
});
