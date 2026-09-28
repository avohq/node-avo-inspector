import { AvoInspector } from "./AvoInspector";
import { InspectorBody } from "./AvoNetworkCallsHandler";

export interface AvoBatchOptions {
  batchSize: number;
  batchFlushSeconds: number;
  maxQueueSize: number;
  disableBatchTimer: boolean;
}

/**
 * In-memory pending batch buffer. Node runs this on a single thread, so appending and
 * the swap-and-clear in drain() are atomic without a lock; the send itself happens in
 * the dispatch callback, after the buffer has been swapped out.
 */
export class AvoBatchQueue<T> {
  private buffer: Array<InspectorBody> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private options: AvoBatchOptions,
    private dispatch: (batch: Array<InspectorBody>) => Promise<T>
  ) {}

  get length(): number {
    return this.buffer.length;
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
      if (AvoInspector.shouldLog) {
        console.warn(
          "Avo Inspector: pending batch is full (maxQueueSize " +
            this.options.maxQueueSize + "), dropped " + overflow + " oldest event(s)."
        );
      }
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
    return this.dispatch(batch);
  }

  /** Discards every buffered event unsent and cancels the scheduled flush. */
  clear(): void {
    this.clearTimer();
    this.buffer = [];
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
    }, Math.min(this.options.batchFlushSeconds * 1000, 2_147_483_647));
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
