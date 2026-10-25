# Staging and production integration runbook

The checked-in Compose configuration is a **local demo**. It publishes only localhost ports and uses demo credentials/data. Do not expose it externally.

## Staging preparation

1. Complete owner decisions in DECISIONS.md and technical work in IMPLEMENTATION_STATUS.md. Select authorized hosting/storage regions, domains and operators.
2. Provision separate PostgreSQL, Redis, image storage, TLS, managed encryption keys and secret store for staging. Generate independent PII/HMAC keys; never copy `.env.example` values. Bind the API privately and proxy `/api` through the staff/public edge.
3. Disable demo mode. Provision enabled DB users with actual OIDC subjects and scoped memberships through an audited operator process. Configure OIDC issuer/audience/JWKS and an authenticated browser gateway that injects the user's validated access token into the private API request. API verifies the token again and requires `amr` containing `mfa`. This gateway/IdP flow must be tested; it is not supplied as a fake login.
4. Build web with the private API_URL at build time; Next rewrites use that value. Build API and worker. Configure Redis, private image storage, scanner, approved provider integrations and telemetry.
5. Take database and private-file backups. Run `npm run db:migrate` before rollout. Do not run demo seed in staging or production. Create approved brand/branch records with reviewed scope data; do not invent names or branch codes.
6. Run scoped API/browser tests, upload scanner checks, branch ownership and financial denial tests. Reconcile SLA worker/outbox and monitoring. Verify backup restoration in a separate database and perform the rollout/rollback rehearsal.
7. Only after policy implementation and sign-off, enable public intake with approved privacy/operating notices and financial workflow with actual authorized limits. Keep outbound providers disabled until approved. Flags alone are insufficient.

## Release and rollback

Deploy immutable container revisions behind a TLS gateway. Retain the last known good image. Apply backward-compatible migrations before switching traffic; use an explicit maintenance plan for incompatible changes. Verify `/api/health`, authenticated scoped reads, a synthetic nonproduction case, image access denial and worker reconciliation before promoting. Restore/rollback requires preserving both encrypted database content and the corresponding keys/private evidence objects. A previous application image does not undo a migration.

## Production controls still required

Central log collection and alerting on the platform IT chooses, plus optional tracing (OpenTelemetry/Sentry); notification acknowledgement and on-call routing; automated retention/legal holds and rights requests; actual IdP SSO; approved financial/SLA policy snapshots; business calendars and on-call coverage; independent accessibility/security/UAT sign-off.

Already in place: structured JSON logs (below), Redis-backed per-source rate limiting across API instances (fails closed), request IDs on every API response and in error logs, secret scanning of full history, `npm audit` and Dependabot for dependencies, a CI container smoke test, a Trivy scan of the shipped images, app-encrypted photo storage on any S3-compatible bucket (`STORAGE_DRIVER=s3`) and ClamAV upload scanning (`MALWARE_SCANNER=tcp://…:3310`; freshclam must be able to reach `database.clamav.net`, or a mirror, to keep signatures current).

## Logs and alerts

The API and worker write one JSON object per line: `info` to stdout, `warn` and `error` to stderr. Point the platform's log collector at the containers' output; no agent or SDK is needed. Every line has `time`, `service` (`api` or `worker`), `level` and `event`. Lines never contain URLs, query strings, request or response bodies, error messages, names, phone numbers or tokens.

| `event`           | Fields                                                         | Meaning                                                              |
| ----------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `request`         | `requestId`, `method`, `route` (pattern), `status`, `ms`       | One per API request. Healthy `/api/health` checks are skipped.       |
| `unhandled_error` | `ref` (= request ID), `route`, `status`, `error`, `code`, `at` | A 5xx. The `ref` is shown to the user, so support can find the line. |
| `job_failed`      | `job`, `error`, `code`                                         | A worker job failed; it retries on its next schedule.                |
| `retention_run`   | `days`, `due`, `erased`, `skipped`                             | Daily retention result (only when retention is on).                  |
| `startup_failed`  | `error`, `code`                                                | The API or worker could not start.                                   |

The edge proxy's `$request_id` is reused as `requestId`, so one request can be followed from the proxy access log to the API. Set `LOG_REQUESTS=false` to turn off the per-request lines.

Suggested alerts: any `startup_failed`; `unhandled_error` above a few per minute; `job_failed` for the same `job` three times in a row; `request` lines with `status` 429 rising sharply (rate limiting under attack); p95 `ms` on `/api/bootstrap` above an agreed budget.
