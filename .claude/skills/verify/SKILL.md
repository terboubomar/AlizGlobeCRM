---
name: verify
description: Run this repo's checks before saying a change is done or before committing/pushing. Use after any code change in apps/, packages/, tests/ or scripts/, when asked to "verify", "run the checks", "make CI green", or when a CI run of .github/workflows/ci.yml failed.
---

# Verify a change

Mirror `.github/workflows/ci.yml`. Run from the repo root. Stop at the first failure, fix it, then re-run from that step.

## One-time setup (fresh checkout)

```sh
npm ci
cp -n .env.example .env        # never overwrite an existing .env
npm run db:generate            # Prisma client; required before typecheck/tests
```

For local runs, `PII_KEY` and `PHONE_HASH_KEY` in `.env` must be two different `openssl rand -hex 32` values. Never commit `.env`.

## Fast checks (no database needed) — always run

```sh
npm run format:check   # fix with: npm run format
npm run lint
npm run typecheck      # root tsconfig + apps/web/tsconfig.json
npm test               # tests/*.test.ts (domain, reports, scheduling, ...)
npm run test:web       # apps/web/tests/*.test.tsx
```

## Slow checks — run when the change touches API, DB, worker or pages

Need PostgreSQL 17 on `127.0.0.1:54329` (user `aliz`, password `localdev`, db `aliz`), e.g. `docker compose up -d postgres redis`.

```sh
npm run test:integration   # tests/*.integration.ts
npm run test:e2e           # tests/browser/*.spec.ts, 4 viewports
npm run build
npm audit --audit-level=high
```

`scripts/test-isolated.ts` creates a throwaway `aliz_test_<uuid>` database, migrates it, starts its own API/web servers on free ports and drops the database afterwards. Do not point these suites at a database holding data you care about: history tables are append-only and cannot be cleaned up.

E2E needs Playwright's Chromium (`npx playwright install chromium` locally). If the environment already ships a Chromium, don't reinstall it.

## Which tests to touch

| Changed                   | Add/adjust tests in                                                          |
| ------------------------- | ---------------------------------------------------------------------------- |
| `packages/domain/src`     | `tests/domain.test.ts` or a matching `tests/*.test.ts`                       |
| `apps/api/src/*`          | matching `tests/*.integration.ts` (and `*.test.ts` for pure helpers)         |
| `apps/web/app/*`          | `apps/web/tests/*.test.tsx`; user flows in `tests/browser/workflows.spec.ts` |
| Prisma schema / migration | integration suite exercising the new column/table                            |

## Reporting

Say which commands ran and their result. If a slow check could not run (no Postgres, no Redis), say so plainly instead of implying it passed. Never skip, disable or `.only` a test to get green.
