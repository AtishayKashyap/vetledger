# ADR 0002: FEFO dispensing and lock ordering

**Status:** accepted

## Context
Drugs and vaccines are tracked per lot, each with an expiry date. Good practice (and regulation) is first-expiry-first-out: use the batch closest to expiry first, and never dispense expired stock. Several staff dispense at the same time, and the classic bug is two transactions both reading "1 left" and both decrementing it.

## Decision
- `allocateFefo()` is a **pure function**: it filters out expired and empty batches, sorts by `(expires_on, id)`, and fills the request greedily. It is unit-tested on its own.
- `dispenseFefo()` locks the candidate rows with `SELECT … FOR UPDATE ORDER BY expires_on, id`, applies the pure allocation, and decrements each batch, all inside the caller's transaction (the same transaction that writes the prescription, the allocations, the audit entry and the idempotency key).
- **Deterministic lock order.** Every transaction locks the same rows in the same order, so concurrent dispenses queue up instead of deadlocking. Under READ COMMITTED, a waiting transaction re-evaluates `quantity > 0` against the committed row once it gets the lock.
- **Why not `SKIP LOCKED`?** It would make a transaction skip a batch another transaction is currently using and report "insufficient stock" while the stock still exists. `SKIP LOCKED` is the right tool for *work queues*, where any free item will do; ADR 0005 uses it there. It is the wrong tool for *exact accounting*.
- `CHECK (quantity >= 0)` is the backstop: even a buggy allocator cannot drive stock negative.
- `dispense_allocations` records which lots each prescription and vaccination drew from. That powers the recall trace: "which animals received lot L24A?"

## Consequences
The concurrency test fires 20 dispenses at 10 units and gets exactly 10 successes, with stock at 0 and allocations summing to 10. The trade-off is that dispenses of the *same product* serialise on its first batch's lock. That's fine at clinic scale; at very high volume, stock could be sharded into multiple rows.
