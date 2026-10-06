---
import:
  - src/AvoNetworkCallsHandler.cs.md
  - src/AvoInspector.cs.md
---
# AvoBatchQueue

In-memory batching buffer for Inspector events: collects events, forms a batch on a size trigger, a timer, or an explicit drain, and dispatches batches with bounded concurrency and a bounded wait list.

## Tech stack

- TypeScript on Node.js (single-threaded event loop; uses `setTimeout(...).unref()`).
- Uses `InspectorBody` from `AvoNetworkCallsHandler` and `AvoLog` for its always-on, rate-limited lines.

## Data

- Exported constants: `MAX_TIMER_MS = 2_147_483_647` (largest safe `setTimeout` delay), `MAX_IN_FLIGHT_SENDS = 4`, `MAX_WAITING_EVENTS = 10_000`.
- `AvoBatchOptions { batchSize; batchFlushSeconds; maxQueueSize; disableBatchTimer }`.
- `new AvoBatchQueue<T>(options, dispatch: (batch) => Promise<T> /* should not reject or throw */, dropped: T, track = identity)`.
- Getters: `length` (unsent buffer), `waitingLength` (events waiting for a send slot), `inFlightEvents` (events in batches being sent), `hasScheduledFlush`.

State: unsent `buffer`, FIFO `waiting` list of `{ events, settle }`, `waitingEvents` count, `inFlight` count, optional flush timer, and an optional `bufferOutcome` (the promise handed out by `bufferedBatchOutcome()` for the current buffer).

## Users and permissions

- Internal; owned by one `AvoInspector` instance. `AvoInspector` validates options (positive integers, finite positive seconds) before constructing it. No auth.

## Functional requirements

### `enqueue(event)`

1. Append `event` to the buffer.
2. If the buffer exceeds `maxQueueSize`, drop the oldest overflow events (FIFO) and report them with `AvoLog.dropped(count, "queue full")` (always on, rate-limited).
3. If the buffer now holds `>= batchSize` events, return `drain()`.
4. Otherwise schedule the flush timer (if not already scheduled) and return `null`.

### `bufferedBatchOutcome()`

- Empty buffer → `null`. Otherwise returns one promise per buffer generation (every caller for the same buffer gets the same promise): it settles with the outcome of the batch that swaps that buffer out, **whichever drain does it** (size trigger, timer, or an explicit `drain()`), or with `dropped` if `clear()` discards the buffer.

### `drain()`

1. Cancel the flush timer.
2. If the buffer is empty, return `null`.
3. Swap the buffer out as one batch (atomic on the event loop), append it to `waiting` with a fresh outcome promise, and add its size to `waitingEvents`. If `bufferedBatchOutcome()` handed out a promise for this buffer, settle it with this outcome and forget it.
4. Start sends (see below).
5. If `waitingEvents > MAX_WAITING_EVENTS`, drop the excess oldest waiting events (oldest batch first, trimming a batch partially if needed); every batch emptied this way settles with `dropped`. Report them with `AvoLog.dropped(count, "send backlog full")`.
6. Return `track(outcome)`. **IMPORTANT:** `track` is called as soon as the batch is swapped out, before it is sent, so the owner can treat waiting batches as in flight.

### Sending

- While `inFlight < MAX_IN_FLIGHT_SENDS` and batches are waiting, shift the oldest batch, subtract it from `waitingEvents`, increment `inFlight`, and call `dispatch(events)`.
- When a dispatch settles: decrement `inFlight`, settle the batch with the dispatch result, then start further sends.
- **IMPORTANT:** if `dispatch` throws synchronously or rejects, report it with `AvoLog.internal(error)` and `AvoLog.dropped(<batch size>, "internal error")` (both always on, rate-limited), and settle the batch with `dropped` (asynchronously, also for a synchronous throw): the slot is freed, the batch settles, and the next waiting batch starts.
- Batches are dispatched in the order they were formed.

### Flush timer

- Armed on `enqueue` when not already armed and `disableBatchTimer` is false; delay `min(batchFlushSeconds * 1000, MAX_TIMER_MS)`. It measures from the first event buffered since the last drain.
- On fire: clear the handle and `drain()`.
- The timer is `unref`'d: it never keeps the process alive.

### `clear()`

- Cancel the timer, discard the buffer (settling its `bufferedBatchOutcome()` promise, if any, with `dropped`), and settle every waiting batch with `dropped` without sending. In-flight dispatches are not affected and settle normally.

## Non-functional requirements

- Memory is bounded: buffer by `maxQueueSize`; waiting batches by `MAX_WAITING_EVENTS`; concurrent requests by `MAX_IN_FLIGHT_SENDS`.
- Every outcome promise settles exactly once: with the dispatch result, or with `dropped` if the whole batch was discarded (a waiting batch emptied by the send-backlog overflow, `clear()`, dispatch rejection, or a synchronous dispatch throw). Outcome promises never reject, and a failing dispatch never leaks a send slot.
- Dropping events does not settle anything by itself. When `enqueue()` drops the oldest buffered events past `maxQueueSize`, the `bufferedBatchOutcome()` promise keeps following the remaining buffer and settles with its eventual batch outcome. A waiting batch trimmed only partly by the backlog overflow settles with its dispatch result.
- Drops are always reported, whatever `AvoInspector.shouldLog` says, at most one line per reason per 10 s (see `AvoLog`).
- If `maxQueueSize < batchSize`, the size trigger never fires; events leave only via the timer or an explicit `drain()`.

## Examples

<example>
batchSize 3, 3 enqueues → the 3rd returns a promise and a batch of 3 is dispatched; the first two return `null`.
</example>
<example>
maxQueueSize 2, batchSize 5, enqueue a, b, c → buffer is [b, c]; `Avo Inspector: dropped 1 event(s) (queue full) in the last 10s.` is logged (if no queue-full line was printed in the last 10 s).
</example>
<example>
clear() with 2 batches waiting → both promises resolve with `dropped`; nothing further is dispatched.
</example>
<example>
batchSize 1, a dispatch that throws synchronously for the first 4 batches → each of those settles with `dropped`, and the internal error and `dropped 1 event(s) (internal error)` are logged (rate-limited: one line each per 10 s); batches 5 onward are dispatched normally (no slot is lost).
</example>
