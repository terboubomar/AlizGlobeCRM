# Aliz Globe CRM

Arabic-first customer experience and branch operations CRM built from the supplied v3 specification, interactive presentation, DESIGN.md, and six original logos.

**Current delivery: working local pilot, not production acceptance of the full v3 specification.** The application uses a real NestJS API and PostgreSQL database. All seeded branches, employees, orders, cases and financial amounts are explicitly synthetic. No actual customer data is included. Calls, orders and financial transactions remain in existing external systems.

## Start locally

Requires Node.js 22.22+, PostgreSQL 17, and Redis 7 for the BullMQ worker.

```sh
cp .env.example .env
npm ci
npm run db:generate
docker compose up -d postgres redis
npm run db:migrate
npm run db:seed:demo
node --import tsx packages/db/provision-superadmin.ts your-email@example.com
npm run dev
```

Before starting, set `PII_KEY` and `PHONE_HASH_KEY` in `.env` to separate values generated with `openssl rand -hex 32`. Keep these keys private and stable for existing encrypted data. Actual `.env` files are excluded from Git; `.env.example` documents configuration without secrets.

Open [the CRM](http://localhost:3000) and sign in with your email and password. The local provisioning command reads a hidden password from standard input, stores a salted scrypt hash and enables local password authentication with a private persistent session key. Demo account selection and role switching are disabled in this mode. The API listens on 127.0.0.1:4000; the web app listens on 127.0.0.1:3000. The browser must use `localhost` or `127.0.0.1` consistently for cookies.

`pnpm` can run the same package scripts; the committed reproducible dependency lockfile is npm's `package-lock.json`. Use `npm ci` for CI. No global CLI or external font request is required.

An all-container local demo is provided:

```sh
docker compose --profile app up --build -d
```

It runs migrations and demo seed before API/web/worker startup. Do not use this development compose configuration as production hosting. CI's `containers` job builds every image and boots this stack on each push, checking the web page, the API through the web proxy, the worker and the setup step. The Dockerfile has three targets: `build` (full toolchain, used by `setup` for migrations and the demo seed), `server` (API and worker: compiled JavaScript and production dependencies only) and `web` (the Next.js standalone server). Runtime images contain no source code or dev tooling and run as the non-root `node` user.

For development without Redis, set `WORKER_MODE=local` with `DEMO_MODE=true`. The same idempotent reconciliation runs every minute in a local process. Production cannot use this fallback.

## What works

- Responsive Arabic RTL navigation, locally bundled Cairo, group branding and all five restaurant logos, without modifying original image bytes.
- PostgreSQL persistence, encrypted contact details, keyed phone lookup, scoped server permissions, synthetic demo sessions and an OIDC/MFA bearer-token verifier for a future authenticated gateway.
- Phone complaint intake, unknown-branch queue, category/priority, optional external order details, duplicate customer lookup, stable retry key, case numbers and creation events in one transaction.
- Support-only assignment, one-click start, customer contact before final resolution, named area/operations escalation, reopening and closure guards. Conflicting edits fail with HTTP 409.
- Server-generated branch QR codes, rotation/revocation, PNG download, printable poster, public branch-bound intake, photos, and expiring high-entropy status tokens. QR/body scope forgery is tested.
- Up to three 5 MB JPG/PNG/WebP images, magic-byte checks, pixel limits, re-encoding and EXIF stripping; private filesystem storage and authenticated scoped downloads. Demo images explicitly show that malware scanning was not performed. Non-demo uploads fail closed without a configured scanner.
- Independent refund workspace (optional complaint link), separate request, review/approval, external execution reference + proof, independent verification, customer notification and completion. No payment/refund execution exists. Production financial actions are disabled by default.
- Proposed demo SLA milestones, warnings and breaches, a BullMQ worker and a reconciler that tolerates retries without duplicate breaches. Original deadlines survive reassignment.
- Manual follow-ups, a weekly shift grid, breaks, lead designation, leave requests and overlap checks serialized per employee.
- Brand-scoped complaint/source/category reports, masked CSV export with formula-injection protection, manual QA scores, append-only case and audit history.

See [implementation status](docs/IMPLEMENTATION_STATUS.md) for limitations, [decisions](docs/DECISIONS.md) for pending approvals, and [operator guide](docs/OPERATIONS.md) for workflows.

## Verify

```sh
npm run lint
npm run typecheck
npm test
# API and database must already be running, seeded in demo mode:
npm run test:integration
npm run build
npm run format:check
```

10 domain tests and 21 API/database acceptance checks passed in the initial delivery pass. The integration suite adds labeled synthetic cases, images and shifts; it intentionally cannot delete append-only history. Use a separate disposable demo database for repeated CI runs. Browser checks were performed through Codex's browser against phone intake, QR intake/status, role navigation and responsive layouts; A Playwright regression suite is included for those workflows at four viewport sizes (`npm run test:e2e` after installing its Chromium browser). That standalone suite was authored but not executed here; the actual browser checks used Codex’s browser tooling.

## Source layout

```text
apps/web/                 Next.js staff UI + public QR/status routes
apps/api/                 NestJS API, authorization, upload pipeline
apps/worker/              BullMQ and local demo SLA reconciliation
packages/db/              Prisma/Postgres schema, SQL migrations, demo seed
packages/domain/          Permissions, state transitions, validation, SLA and CSV rules
tests/                    Domain and real database/API acceptance checks
docs/                     Runbooks, decisions, implementation status and original spec
```

## Production boundary

Production code now includes OIDC/PKCE browser sign-in with MFA verification, configurable approved SLA snapshots/timers, audited directory activation, separate financial duties and Redis-backed rate limits. Before collecting live customer data, configure the real identity provider and trusted HTTPS ingress, approve SLA/financial policy values, map real staff scopes, and complete staging acceptance. Managed storage, retention/legal-hold jobs, incident coverage, observability and backup restoration remain rollout work. See `docs/REVIEW_FIXES.md` and `docs/IMPLEMENTATION_STATUS.md`.

`NODE_ENV=production` rejects `DEMO_MODE=true`. Public intake and financial decisions are disabled by default. Merely setting flags is not production approval. Production rollout requires completing the open technical work and the owners' decisions; the attached documents do not authorize external deployment or approve financial/legal policy.

## Workflow revision

**الشكاوى** now opens an actionable complaint lifecycle board and timestamped register. The only complaint intake channels remain customer QR and manual call-center phone entry. Case details show actual stage timestamps, branch, owners, and guided next actions. Closure now requires an explicitly recorded customer confirmation after corrective action and follow-up.

Refunds have their own identifiers, scope, evidence, audit timeline and workspace. They can be requested without creating a complaint. The **العلامات والفروع** directory supports brand create/edit and branch-to-brand linking; branches with history cannot be moved between brands.

See [workflow rationale and sources](docs/WORKFLOW_DESIGN.md).

Demo setup seeds directory records only. Sample staff require `SEED_DEMO_USERS=true`; sample complaints also require `SEED_DEMO_CASES=true`. Normal setup does not recreate demo accounts, complaints, or refunds.

Password-mode authentication tests use a temporary synthetic user and leave complaint/refund counts unchanged. Legacy demo workflow integration suites skip in password mode because demo impersonation is deliberately disabled; run those against a separate demo test instance. No account password is embedded in source files or the example environment file.
