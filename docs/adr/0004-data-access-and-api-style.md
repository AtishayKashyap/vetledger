# ADR 0004: Kysely + SQL migrations; REST for writes, GraphQL for reads

**Status:** accepted (supersedes the initial plan to use Prisma)

## Data access
The design leans on PostgreSQL features: RLS policies, transaction-local `set_config`, `FOR UPDATE` and `SKIP LOCKED`, triggers, `SECURITY DEFINER` functions, partial indexes, and `FILTER (WHERE …)` aggregates. An ORM would hide most of that behind raw-SQL escape hatches, and at the time Prisma's latest release was a major-version release candidate with a changed client architecture.

**Kysely** gives type-safe SQL that reads like the query it emits, with no generated engine or binary. Migrations are **plain `.sql` files**, so reviewers see exactly what runs. The runner applies them in order, each in its own transaction, records a checksum (and refuses migrations that were edited after being applied), and takes a Postgres advisory lock so that two instances booting at once can't race.

## API style
- **REST for writes.** HTTP semantics fit them: `Idempotency-Key`, `If-Match`/`ETag`, `201`/`409`/`428` status codes, and RFC 9457 problem details. The OpenAPI document is generated from the shared Zod schemas.
- **GraphQL for reads** that the dashboard composes. One round trip fetches exactly what the screen renders. DataLoader prevents N+1 queries, a validation rule caps query depth, introspection is off in production, and Apollo's CSRF protection stays on.
- **Shared Zod schemas** (`packages/shared`) validate requests on the server and forms on the client, so the two can't drift. A test caught one subtle issue here: `.partial()` keeps `.default()` values, so update schemas override them.
