# Contributing

1. Branch from `main` (`feat/…`, `fix/…`) and use [Conventional Commits](https://www.conventionalcommits.org/).
2. `pnpm lint && pnpm typecheck && pnpm test` must pass. Tests need Postgres and Redis; see `apps/api/test/env.ts`.
3. Open a PR using the template. CI must be green, and one approving review from CODEOWNERS is required.

## Rules of the codebase
- **New tenant table:** add `clinic_id uuid NOT NULL DEFAULT app_clinic_id()`, add it to the RLS loop in a new migration, and add a cross-tenant test.
- **New write endpoint:** go through `tenantWrite()` (tenant scope, idempotency, audit) and validate with a schema from `packages/shared`.
- **Never** connect the API as the owner role, and never edit an applied migration. The runner refuses changed checksums.
- **Locking:** take row locks in a deterministic order, and read ADR 0002 before reaching for `SKIP LOCKED`.

## Branch protection on `main` (recommended)
Require a PR, one approval, and passing `test`, `e2e` and `docker` checks, plus linear history.
