---
import:
  - src/AvoNetworkCallsHandler.cs.md
  - src/AvoInspector.cs.md
---
# AvoBatchQueue

In-memory batching buffer for Inspector events: collects events, forms a batch on a size trigger, a timer, or an explicit drain, and dispatches batches with bounded concurrency and a bounded wait list.

## Tech stack

- TypeScript on Node.js (single-threaded event loop; uses `setTimeout(...).unref()`).
- Uses `InspectorBody` from `AvoNetworkCallsHandler`, the static `AvoInspector.shouldLog` flag, and the internal `INTERNAL_ERROR_MESSAGE` from `AvoInspector`.

## Data

- Exported constants: `MAX_TIMER_MS = 2_147_483_647` (largest safe `setTimeout` delay), `MAX_IN_FLIGHT_SENDS = 4`, `MAX_WAITING_EVENTS = 10_000`.
- `AvoBatchOptions { batchSize; batchFlushSeconds; maxQueueSize; disableBatchTimer }`.
- `new AvoBatchQueue<T>(options, dispatch: (batch) => Promise<T> /* should not reject or throw */, dropped: T, track = identity)`.
- Getters: `length` (unsent buffer), `waitingLength` (events waiting for a send slot), `hasScheduledFlush`.

State: unsent `buffer`, FIFO `waiting` list of `{ events, settle }`, `waitingEvents` count, `inFlight` count, optional flush timer.

## Users and permissions

- Internal; owned by one `AvoInspector` instance. `AvoInspector` validates options (positive integers, finite positive seconds) before constructing it. No auth.

## Functional requirements

### `enqueue(event)`

1. Append `event` to the buffer.
2. If the buffer exceeds `maxQueueSize`, drop the oldest overflow events (FIFO) and, when `shouldLog`, warn with the count.
3. If the buffer now holds `>= batchSize` events, return `drain()`.
4. Otherwise schedule the flush timer (if not already scheduled) and return `null`.

### `drain()`

1. Cancel the flush timer.
2. If the buffer is empty, return `null`.
3. Swap the buffer out as one batch (atomic on the event loop), append it to `waiting` with a fresh outcome promise, and add its size to `waitingEvents`.
4. Start sends (see below).
5. If `waitingEvents > MAX_WAITING_EVENTS`, drop the excess oldest waiting events (oldest batch first, trimming a batch partially if needed); every batch emptied this way settles with `dropped`. When `shouldLog`, warn with the count.
6. Return `track(outcome)`. **IMPORTANT:** `track` is called as soon as the batch is swapped out, before it is sent, so the owner can treat waiting batches as in flight.

### Sending

- While `inFlight < MAX_IN_FLIGHT_SENDS` and batches are waiting, shift the oldest batch, subtract it from `waitingEvents`, increment `inFlight`, and call `dispatch(events)`.
- When a dispatch settles: decrement `inFlight`, settle the batch with the dispatch result (or `dropped` if it rejected), then start further sends.
- **IMPORTANT:** if `dispatch` throws synchronously, log `console.error(INTERNAL_ERROR_MESSAGE, error)` (always, whatever `shouldLog`) and treat it as a dispatch that settled with `dropped`: the slot is freed, the batch settles, and the next waiting batch starts.
- Batches are dispatched in the order they were formed.

### Flush timer

- Armed on `enqueue` when not already armed and `disableBatchTimer` is false; delay `min(batchFlushSeconds * 1000, MAX_TIMER_MS)`. It measures from the first event buffered since the last drain.
- On fire: clear the handle and `drain()`.
- The timer is `unref`'d: it never keeps the process alive.

### `clear()`

- Cancel the timer, discard the buffer, and settle every waiting batch with `dropped` without sending. In-flight dispatches are not affected and settle normally.

## Non-functional requirements

- Memory is bounded: buffer by `maxQueueSize`; waiting batches by `MAX_WAITING_EVENTS`; concurrent requests by `MAX_IN_FLIGHT_SENDS`.
- Every outcome promise settles exactly once: with the dispatch result, or with `dropped` if the batch was discarded (overflow, `clear()`, dispatch rejection, or a synchronous dispatch throw). Outcome promises never reject, and a failing dispatch never leaks a send slot.
- Drops are silent unless `AvoInspector.shouldLog` is on.
- If `maxQueueSize < batchSize`, the size trigger never fires; events leave only via the timer or an explicit `drain()`.

## Examples

<example>
batchSize 3, 3 enqueues → the 3rd returns a promise and a batch of 3 is dispatched; the first two return `null`.
</example>
<example>
maxQueueSize 2, batchSize 5, enqueue a, b, c → buffer is [b, c]; "dropped 1 oldest event(s)" is logged.
</example>
<example>
clear() with 2 batches waiting → both promises resolve with `dropped`; nothing further is dispatched.
</example>
<example>
batchSize 1, a dispatch that throws synchronously for the first 4 batches → each of those settles with `dropped` and logs the internal error; batches 5 onward are dispatched normally (no slot is lost).
</example>
