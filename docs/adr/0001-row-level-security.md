# ADR 0001: Tenant isolation with PostgreSQL row-level security

**Status:** accepted

## Context
Every table holds data for many clinics. The usual approach is "remember to add `WHERE clinic_id = ?` everywhere", through an ORM hook or middleware. One forgotten filter, in a new endpoint, a report query or a GraphQL resolver, leaks another clinic's patients. Code review is the only safety net.

## Decision
Enforce isolation **in the database**:

- Every tenant table has `clinic_id` and the policy
  `USING (clinic_id = app_clinic_id()) WITH CHECK (clinic_id = app_clinic_id())`.
- `app_clinic_id()` reads `current_setting('app.clinic_id', true)`. If the setting is missing, the result is NULL, which matches no rows, so access **fails closed**.
- The API connects as `vetledger_app`. That role owns nothing and is not `BYPASSRLS`. Migrations run as a separate owner role.
- Every tenant query runs inside `withTenant(db, clinicId, fn)`, which starts a transaction and calls `set_config('app.clinic_id', $1, true)`. The `true` makes the setting transaction-local, so it can never leak to the next request that reuses the pooled connection.
- `clinic_id` defaults to `app_clinic_id()`, so inserts don't even pass it.
- Login happens *before* the tenant is known. It goes through narrow `SECURITY DEFINER` functions (`auth_find_user`, `auth_user_by_id`, `claim_due_reminders`), with a pinned `search_path` and `EXECUTE` revoked from `PUBLIC`.

## Consequences
- Security no longer depends on every developer remembering the filter. A test proves that a query *without* a tenant filter still only sees its own clinic, and that test fails if RLS is disabled.
- Error semantics improve too. A cross-tenant ID is simply "not found" (404), which doesn't confirm the row exists. A foreign key to another tenant's owner returns 422.
- Every query pays the cost of a transaction plus `set_config`, about one extra round trip. This is mitigated for GraphQL by ADR 0006.
- Policies are evaluated per row. They stay cheap because `clinic_id` leads the composite indexes.
- Operational requirement: the runtime role must never be a table owner or superuser. This is documented in `deploy/init.sql` and enforced by the grants in `migrate.ts`.
