# ADR 0005: Reminder worker on a free tier

**Status:** accepted

## Context
The project must run at zero cost. Free web services (Render) sleep when idle, and running a separate worker service would double the free-instance count.

## Decision
- The BullMQ worker runs **inside the API process** when `RUN_WORKER=true` (the default). It can be split into its own service with no code change.
- Scans are scheduled with BullMQ's **job scheduler** (`upsertJobScheduler`), whose state lives in Redis (Upstash free tier), rather than `setInterval`. With N instances, exactly one scan fires per interval. After a sleeping instance wakes, the overdue scan runs immediately.
- Claiming uses `claim_due_reminders()`: an `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`. Concurrent scanners claim **disjoint** rows. (Contrast with ADR 0002, where `SKIP LOCKED` would be wrong.)
- Every send job has `jobId = reminder-<id>`, so even overlapping scans enqueue a reminder only once. Sending is idempotent: a reminder already `sent` is skipped, and the webhook receives the reminder ID as an `idempotency-key`.
- Retries: 5 attempts with exponential backoff starting at 30 seconds. After the last attempt the reminder is marked `failed` (the dead-letter state) and the BullMQ failed job is kept. An admin can retry it from the UI.

## Known gap
If the process crashes between the claim (status `queued`) and the enqueue, that reminder stays `queued`. The fix is an outbox, or a sweeper that requeues `queued` reminders older than N minutes. It is listed as the next improvement.
