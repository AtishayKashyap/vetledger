## What & why
<!-- The problem and the change. Link the issue. -->

## How it was tested
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] New tenant table? RLS policy added + covered by a cross-tenant test
- [ ] New write endpoint? Goes through `tenantWrite` (idempotency + audit)
- [ ] UI change: screenshot attached

## Risk
<!-- Migrations (backwards compatible?), changes to auth, locking or RLS. -->
