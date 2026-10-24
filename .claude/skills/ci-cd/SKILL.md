---
name: ci-cd
description: This repo's CI pipeline and release/deploy model. Use when changing .github/workflows/ci.yml, the Dockerfile or docker-compose.yml, when a CI run fails, when adding a job or check, or when asked about staging/production rollout, migrations-on-deploy or rollback.
---

# CI/CD for Aliz Globe CRM

One GitHub Actions workflow, `.github/workflows/ci.yml`, runs on every push and pull request with two jobs: `verify` (the checks below) and `secrets` (gitleaks over full history, config in `.gitleaks.toml`). The workflow has `permissions: contents: read`, actions pinned to commit SHAs (with a `# vX.Y.Z` comment), and `persist-credentials: false` on checkout. Keep all three when editing it. Dependabot (`.github/dependabot.yml`) opens weekly update PRs for npm and the pinned actions. There is no deploy pipeline in the repo — release is manual and documented in `docs/DEPLOYMENT.md`.

## The CI job (keep steps in this order)

Runner: `ubuntu-latest`, Node 22, npm cache. A `postgres:17-alpine` service is published on host port `54329` with user/password/db `aliz`/`localdev`/`aliz` — matching `.env.example`'s `DATABASE_URL`. There is no Redis service, so CI runs the worker's local fallback, not BullMQ.

Steps: `npm ci` → `cp .env.example .env` → `npm run db:generate` → `format:check` → `lint` → `typecheck` → `npm test` → `test:web` → `npm audit --audit-level=high` → `test:integration` → `npx playwright install --with-deps chromium --only-shell` → `test:e2e` → `build`. On failure it uploads `test-results/` and `playwright-report/`.

Mirror this order when adding checks, and keep local verification aligned with the `verify` skill. A new check that needs a service (e.g. Redis) must add it under `services:` with a healthcheck, as `postgres` is.

## Rules

- **Keep CI green before merge.** Reproduce a failing step locally with the same command before pushing a fix; see the `verify` skill. Never `.only`, skip or delete a test to pass.
- `npm audit --audit-level=high` is a gate — resolve high/critical advisories (bump, override, or justified exception), don't silence the step.
- Keep `.env.example` the source CI copies to `.env`; any new required variable with a CI-safe default goes there, secrets stay empty. See `security-guardrails`.
- Dependencies are pinned via `package-lock.json`; CI uses `npm ci`. Commit lockfile changes with the code that needs them.
- Playwright's Chromium is installed by CI's own step. Locally, install it once; in this cloud sandbox it is pre-installed — don't reinstall.
- When you add security scanning to CI, prefer the in-repo security skills: `implementing-secrets-scanning-in-ci-cd`, `integrating-sast-into-github-actions-pipeline`, `scanning-containers-with-trivy-in-cicd`, and `securing-github-actions-workflows` (pin actions to a commit SHA, least-privilege `permissions:`).

## Containers and release

- `Dockerfile` targets: `build` (full toolchain; compose `setup` runs migrations and the demo seed with it), `server` (API and worker: compiled JS, root production deps and the generated Prisma client; no source), `web` (Next standalone server, the default target). Runtime images run as the non-root `node` user. `API_URL` is a build arg baked in at web build time (Next rewrites proxy `/api`), so set it for the target environment when building `web`.
- CI job `containers` builds all images and boots `docker compose --profile app`, then smoke-tests the web page, `/api/health` through the web proxy, the worker and the setup exit code. It then scans the shipped `api` and `web` images with Trivy (version and SHA-256 pinned in the job; never use 0.69.4 or the `trivy-action`/`setup-trivy` actions, which were compromised) and fails on HIGH/CRITICAL vulnerabilities that have a fix. Fix by updating the base image or dependency; record a justified exception in `.trivyignore` only with a reason, owner and review date. Run it locally the same way before changing the Dockerfile or compose file.
- Unexpected API errors (5xx) are logged to stderr as one JSON line without message text or request data (`apps/api/src/error-log.ts`); the client gets the same `ref` to quote to support. That `ref` is the request ID (`X-Request-Id` on every API response, `apps/api/src/request-id.ts`), reused from nginx's `$request_id` when the edge sends one, so a report can be traced from the access log to the error line.
- `docker-compose.yml` is **local demo only** (localhost ports, demo credentials, `--profile app` runs migrate + demo seed before API/web/worker). Never present it as production hosting, and never run `db:seed:demo` against staging or production.
- Release model (`docs/DEPLOYMENT.md`): deploy immutable image revisions behind a TLS gateway, keep the last known-good image, run `npm run db:migrate` with backward-compatible migrations **before** switching traffic, verify `/api/health` and a scoped read, and keep a rollback image. A previous image does not undo a migration — see the `db-migration` skill for backward-compatible changes.
- Production requires real managed Postgres/Redis/storage, independent `PII_KEY`/`PHONE_HASH_KEY`, OIDC+MFA, and the open controls in `docs/DEPLOYMENT.md`; flags alone are not sign-off.
