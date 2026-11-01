# vetledger: interview walkthrough

Know these answers cold. Every claim here is backed by a test or a measured number in the repo.

## 30-second pitch
> "vetledger is a multi-tenant platform for veterinary clinics: patient records, lot-tracked inventory and automated vaccination reminders. It's built with TypeScript, Express, GraphQL, Postgres, Redis and React. The interesting parts are correctness under concurrency and security. Tenant isolation is enforced by Postgres row-level security, so even a buggy query can't leak another clinic's data. Dispensing is first-expiry-first-out with row locks, and I prove it's race-free with a test that fires 20 concurrent requests at 10 units of stock. And I profiled the GraphQL dashboard under load and got 33% more throughput by fixing connection-pool contention."

## Resume bullets (numbers come from tests and benchmarks in this repo)
- Built **vetledger**, a multi-tenant veterinary platform (TypeScript, Express 5, Apollo GraphQL, PostgreSQL 16, Redis/BullMQ, React 19), deployable entirely on free tiers.
- Enforced tenant isolation with **PostgreSQL row-level security** and transaction-scoped tenant context, verified by tests that also **fail when RLS is disabled**.
- Implemented race-free **FEFO inventory dispensing** with ordered row locks and DB constraints: 20 concurrent requests against 10 units yield exactly 10 successes and zero oversell. Added idempotency keys and optimistic concurrency (`If-Match`).
- Raised GraphQL dashboard throughput **33% and cut p99 latency 26%** (load-tested with autocannon) by replacing per-resolver transactions with one read-only transaction per request. DataLoader plus window functions keep it at **4 queries regardless of page size**.
- Secured auth with argon2id, in-memory access tokens and **rotating refresh tokens with reuse detection**. Added a Redis-backed rate limiter, an append-only audit log enforced by a trigger, and RFC 9457 errors.
- **55 unit/integration tests** against real Postgres and Redis (88% coverage), **Playwright end-to-end tests**, and a GitHub Actions pipeline with Docker Compose smoke tests and Trivy scans. Also includes OpenTelemetry tracing, Prometheus metrics and a Grafana dashboard.

## Walk through a request: `POST /api/prescriptions`
1. **pino-http** assigns or propagates `x-request-id`, and a metrics middleware starts a timer (it records the route *template* later).
2. The **Redis rate limiter** runs, then **`requireAuth`** verifies the JWT (algorithm pinned) and sets `req.auth`. Then **`requireRole("vet")`**.
3. The **Zod** schema from `packages/shared` parses the body; a failure becomes a 400 problem+json with field paths.
4. **`tenantWrite`** opens a transaction and calls `set_config('app.clinic_id', …, true)`. If an Idempotency-Key was seen before, it replays the stored response.
5. **`dispenseFefo`** runs `SELECT … FOR UPDATE ORDER BY expires_on, id`, the pure `allocateFefo()`, then `UPDATE batches SET quantity = quantity - n`.
6. Insert the prescription and allocation rows, insert the audit row, store the idempotency response, and **COMMIT**. Everything above happens in one atomic unit.
7. The error handler maps known Postgres codes (`23505`, `23514`, `42501`) to 409/422/403, and anything unknown to a generic 500 that never echoes SQL.

## Likely questions

**Why RLS instead of a WHERE clause in a repository layer?**
Defence in depth. The database is the last line, and it protects every access path: REST, GraphQL, ad-hoc reports, a future developer's raw query. It fails closed when the tenant isn't set. Costs: an extra round trip for `set_config`, more care with connection pooling (that's why the setting is transaction-local), and you must never run the app as the table owner.

**What happens with PgBouncer in transaction mode?**
It still works, because `set_config(..., true)` is transaction-local and every tenant query runs inside an explicit transaction. Session-level `SET` would break.

**Why not `SKIP LOCKED` for inventory?**
`SKIP LOCKED` says "give me any row nobody else is using". That's right for a work queue (my reminder claim uses it) and wrong for accounting. A transaction would skip a batch that's locked but still has stock, and wrongly report "out of stock".

**How do you avoid deadlocks?**
Every dispense locks batches in the same order (`expires_on, id`). Deadlocks need a cycle in lock acquisition, and a consistent order prevents cycles.

**Walk me through the concurrency test.**
20 `Promise.all` HTTP requests, each for 1 unit, against two batches totalling 10. Assertions: exactly 10×201 and 10×409, both batches at 0, and allocations summing to 10. That last one proves rolled-back transactions left nothing behind.

**How does the idempotency-key race work?**
Both requests see no stored key and both run the handler. Both try to INSERT the key, the primary key lets only one commit, and the loser's *whole transaction* rolls back, including its dispense. So the side effect happens exactly once, and the loser gets a 409 telling it to retry. The retry then replays the stored response.

**Refresh-token reuse detection, why?**
If an attacker steals a refresh token and uses it, the real user's next refresh presents the *old* token, which has already been rotated. That signals theft, so the whole family is revoked. The client funnels refreshes through one promise, so two tabs can't trigger a false positive.

**What did profiling show?**
The dashboard was 3× slower than REST reads. Each GraphQL resolver opened its own transaction, so one request held up to 7 pooled connections, and under 20 concurrent clients requests queued for the pool of 10. One read-only transaction per request gave +33% throughput and −26% p99, and made GraphQL unable to write.

**Something the tests caught?**
Zod's `.partial()` keeps `.default()` values. My update schema was `create.partial()`, so a PATCH that only changed weight silently reset the animal's `sex` to "unknown". A shared-schema test caught it, and I added an API-level regression test.

**What would you do next?**
1. An outbox, or a sweeper for reminders stuck in `queued` (ADR 0005 names this gap).
2. Per-tenant rate limits.
3. Partitioning `audit_log` by month.
4. OIDC SSO for clinic chains.
5. Read replicas for GraphQL. Its transaction is already read-only, so routing it to a replica is easy.

## Be ready to do live
- Run `EXPLAIN ANALYZE` on the animals keyset query and point out the index it uses.
- Add a new tenant table with its RLS policy and a cross-tenant test (CONTRIBUTING.md lists the steps).
- Disable RLS on one table and show which tests fail.
