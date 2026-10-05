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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.waitingEvents += batch.length;
    this.startSends();
    const excess = this.waitingEvents - MAX_WAITING_EVENTS;
    if (excess > 0) {
      this.dropOldestWaiting(excess);
      AvoLog.dropped(excess, "send backlog full");
    }
    return this.track(outcome);
  }

  /** Discards every buffered or waiting event unsent and cancels the scheduled flush. */
  clear(): void {
    this.clearTimer();
    this.buffer = [];
    const discarded = this.waiting;
    this.waiting = [];
    this.waitingEvents = 0;
    discarded.forEach((batch) => batch.settle(this.dropped));
  }

  private startSends(): void {
    while (this.inFlight < MAX_IN_FLIGHT_SENDS && this.waiting.length > 0) {
      const batch = this.waiting.shift()!;
      this.waitingEvents -= batch.events.length;
      this.inFlight++;
      const done = (outcome: T) => {
        this.inFlight--;
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
