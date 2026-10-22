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

Distributed per-source rate limiting; correlation IDs and redacted centralized logs; OTel/Sentry; outbox recipient delivery; managed object-storage signed URLs; automated retention/legal holds and rights requests; actual IdP SSO; approved financial/SLA policy snapshots; business calendars and on-call coverage; secret/image/dependency scans; independent accessibility/security/UAT sign-off.
