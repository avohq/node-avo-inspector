import { AvoLog } from "./AvoLog";
import { InspectorBody } from "./AvoNetworkCallsHandler";

// setTimeout fires almost at once for delays above this (2^31 - 1 ms, about 24.8 days).
export const MAX_TIMER_MS = 2_147_483_647;

// Batch sends in flight at once. Batches swapped out beyond this wait for a free slot, so
// a fast producer or a slow endpoint cannot open an unbounded number of requests.
export const MAX_IN_FLIGHT_SENDS = 4;

// Events that may wait for a send slot, across all waiting batches. Separate from
// maxQueueSize, which bounds only the unsent buffer; past this the oldest waiting events
// are dropped.
export const MAX_WAITING_EVENTS = 10_000;

// Backpressure: from this many events waiting for a send slot, an awaited track waits until
// fewer wait (see whenBelowBackpressure), so awaited loops slow to the speed of the sends.
export const BACKPRESSURE_WAITING_EVENTS = 1_000;

// The longest a track waits on backpressure: one request timeout.
export const BACKPRESSURE_MAX_WAIT_MS = 10_000;

export interface AvoBatchOptions {
  batchSize: number;
  batchFlushSeconds: number;
  maxQueueSize: number;
  disableBatchTimer: boolean;
}

// A swapped-out batch waiting for a send slot, and the settle function of its promise.
interface WaitingBatch<T> {
  events: Array<InspectorBody>;
  settle: (outcome: T) => void;
}

/**
 * In-memory pending batch buffer. Node runs this on a single thread, so appending and
 * the swap-and-clear in drain() are atomic without a lock; the send itself happens in
 * the dispatch callback, after the buffer has been swapped out. At most
 * MAX_IN_FLIGHT_SENDS dispatches run at once; later batches wait in order.
 */
export class AvoBatchQueue<T> {
  private buffer: Array<InspectorBody> = [];
  private waiting: Array<WaitingBatch<T>> = [];
  private waitingEvents = 0;
  private inFlight = 0;
  private inFlightEventCount = 0;
  // Resolved once fewer than BACKPRESSURE_WAITING_EVENTS events wait, when the backlog
  // overflows, when the wait timer fires, or by clear().
  private capacityWaiters: Array<() => void> = [];
  // Ref'd while there are waiters: a stalled awaited loop is pending work, so "beforeExit"
  // does not fire in the middle of it. Fires after BACKPRESSURE_MAX_WAIT_MS at the latest.
  private capacityTimer: ReturnType<typeof setTimeout> | null = null;
  // Set when the backlog overflowed: an awaited loop stalls near BACKPRESSURE_WAITING_EVENTS,
  // so reaching the cap means the callers are not awaiting. No waiter is created until
  // the backlog is back under the threshold.
  private overflowed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Settled with the outcome of the batch that takes the current buffer, whichever drain
  // swaps it out (or `dropped` if clear() discards it). Created on demand.
  private bufferOutcome: { promise: Promise<T>; settle: (outcome: T | Promise<T>) => void } | null = null;

  /**
   * @param dispatch sends one batch; must not reject.
   * @param dropped the outcome for a batch discarded before it was sent.
   * @param track called with each batch's outcome promise as soon as it is swapped out.
   */
  constructor(
    private options: AvoBatchOptions,
    private dispatch: (batch: Array<InspectorBody>) => Promise<T>,
    private dropped: T,
    private track: (outcome: Promise<T>) => Promise<T> = (outcome) => outcome
  ) {}

  /** Events in the unsent buffer (bounded by maxQueueSize). */
  get length(): number {
    return this.buffer.length;
  }

  /** Events in batches waiting for a send slot (bounded by MAX_WAITING_EVENTS). */
  get waitingLength(): number {
    return this.waitingEvents;
  }

  /** Events in batches being sent. */
  get inFlightEvents(): number {
    return this.inFlightEventCount;
  }

  /**
   * Appends an event and evaluates the size trigger. Returns the send promise when
   * this call dispatched a batch, otherwise null.
   */
  enqueue(event: InspectorBody): Promise<T> | null {
    this.buffer.push(event);

    const overflow = this.buffer.length - this.options.maxQueueSize;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      AvoLog.dropped(overflow, "queue full");
    }

    if (this.buffer.length >= this.options.batchSize) {
      return this.drain();
    }
    this.scheduleFlush();
    return null;
  }

  /**
   * The outcome of the batch that will carry the events buffered now, whichever drain (size
   * trigger, timer, flush) swaps them out. Null when the buffer is empty.
   */
  bufferedBatchOutcome(): Promise<T> | null {
    if (this.buffer.length === 0) {
      return null;
    }
    if (this.bufferOutcome === null) {
      let settle!: (outcome: T | Promise<T>) => void;
      const promise = new Promise<T>((resolve) => (settle = resolve));
      this.bufferOutcome = { promise, settle };
    }
    return this.bufferOutcome.promise;
  }

  /** Swaps out every buffered event and dispatches them as one batch. */
  drain(): Promise<T> | null {
    this.clearTimer();
    if (this.buffer.length === 0) {
      return null;
    }
    const batch = this.buffer;
    this.buffer = [];
    const outcome = new Promise<T>((settle) => {
      this.waiting.push({ events: batch, settle });
    });
    if (this.bufferOutcome !== null) {
      this.bufferOutcome.settle(outcome);
      this.bufferOutcome = null;
    }
    this.waitingEvents += batch.length;
    this.startSends();
    const excess = this.waitingEvents - MAX_WAITING_EVENTS;
    if (excess > 0) {
      this.dropOldestWaiting(excess);
      AvoLog.dropped(excess, "send backlog full");
      this.overflowed = true;
      this.releaseCapacityWaiters(true);
    }
    return this.track(outcome);
  }

  /**
   * Resolves once fewer than BACKPRESSURE_WAITING_EVENTS events wait for a send slot (at
   * once if they already do, or if the backlog has overflowed), and at the latest after
   * BACKPRESSURE_MAX_WAIT_MS. clear() resolves it too.
   */
  whenBelowBackpressure(): Promise<void> {
    if (this.waitingEvents < BACKPRESSURE_WAITING_EVENTS || this.overflowed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.capacityWaiters.push(resolve);
      if (this.capacityTimer === null) {
        this.capacityTimer = setTimeout(() => {
          this.capacityTimer = null;
          this.releaseCapacityWaiters(true);
        }, BACKPRESSURE_MAX_WAIT_MS);
      }
    });
  }

  /** Tracks waiting on backpressure. */
  get capacityWaiterCount(): number {
    return this.capacityWaiters.length;
  }

  private releaseCapacityWaiters(all: boolean = false): void {
    if (this.waitingEvents < BACKPRESSURE_WAITING_EVENTS) {
      this.overflowed = false;
    }
    if (!all && this.waitingEvents >= BACKPRESSURE_WAITING_EVENTS) {
      return;
    }
    if (this.capacityTimer !== null) {
      clearTimeout(this.capacityTimer);
      this.capacityTimer = null;
    }
    const waiters = this.capacityWaiters;
    this.capacityWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Discards every buffered or waiting event unsent and cancels the scheduled flush. */
  clear(): void {
    this.clearTimer();
    this.buffer = [];
    if (this.bufferOutcome !== null) {
      this.bufferOutcome.settle(this.dropped);
      this.bufferOutcome = null;
    }
    const discarded = this.waiting;
    this.waiting = [];
    this.waitingEvents = 0;
    discarded.forEach((batch) => batch.settle(this.dropped));
    this.releaseCapacityWaiters(true);
  }

  private startSends(): void {
    while (this.inFlight < MAX_IN_FLIGHT_SENDS && this.waiting.length > 0) {
      const batch = this.waiting.shift()!;
      this.waitingEvents -= batch.events.length;
      this.inFlight++;
      this.inFlightEventCount += batch.events.length;
      const done = (outcome: T) => {
        this.inFlight--;
        this.inFlightEventCount -= batch.events.length;
        batch.settle(outcome);
        this.startSends();
      };
      // A dispatch that throws or rejects is an internal error: its events are lost, so both
      // are reported. The slot is still freed and the batch still settles.
      const failedInternally = (err: unknown) => {
        AvoLog.internal(err);
        AvoLog.dropped(batch.events.length, "internal error");
        done(this.dropped);
      };
      let sent: Promise<T>;
      try {
        sent = this.dispatch(batch.events);
      } catch (err) {
        // Settled asynchronously, like any other dispatch outcome.
        sent = Promise.reject(err);
      }
      sent.then(done, failedInternally);
    }
    this.releaseCapacityWaiters();
  }

  private dropOldestWaiting(count: number): void {
    while (count > 0 && this.waiting.length > 0) {
      const batch = this.waiting[0];
      const removed = batch.events.splice(0, Math.min(count, batch.events.length)).length;
      this.waitingEvents -= removed;
      count -= removed;
      if (batch.events.length === 0) {
        this.waiting.shift();
        batch.settle(this.dropped);
      }
    }
  }

  // Fires once the oldest buffered event is batchFlushSeconds old. Unref'd so it never
  // holds the process open.
  private scheduleFlush(): void {
    if (this.options.disableBatchTimer || this.flushTimer !== null) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.drain();
    }, Math.min(this.options.batchFlushSeconds * 1000, MAX_TIMER_MS));
    this.flushTimer.unref();
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  get hasScheduledFlush(): boolean {
    return this.flushTimer !== null;
  }
}
