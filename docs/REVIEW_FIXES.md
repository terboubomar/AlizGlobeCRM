# Review fixes and production configuration

The eight code-review findings have implementation fixes and regression coverage. This does not activate external services or constitute production deployment approval.

## Authentication

Local password login remains available in nonproduction only. Production uses the complete OpenID Connect authorization-code browser flow with PKCE S256, state, nonce, signed ID-token verification, MFA verification and revocable HttpOnly CRM sessions. Provider tokens are not exposed to browser JavaScript. Logout clears the CRM session cookie; it does not sign the user out of their identity provider.

Set `APP_ORIGIN` to the real public HTTPS CRM origin and configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, optional `OIDC_CLIENT_SECRET`, and a unique 32-byte hex `AUTH_SESSION_KEY`. Register `https://YOUR_CRM/api/auth/oidc/callback` as a query-mode redirect URI at the provider. The provider must support PKCE S256 and publish HTTPS discovery/JWKS endpoints. For confidential clients, `OIDC_TOKEN_AUTH_METHOD` defaults to `client_secret_basic`; `client_secret_post` is supported explicitly.

The ID token must attest MFA via `amr` containing `mfa`. If your provider uses `acr`, configure only its documented MFA assurance values in `OIDC_MFA_ACR_VALUES`; optionally request them using `OIDC_ACR_VALUES`. Missing MFA evidence is rejected. Use the actual provider subject (`sub`), not an email guess, when mapping staff identities. Signing in does not automatically create staff accounts or roles.

Bootstrap the first production superadmin with a trusted server command after verifying the provider identity:

```sh
npx tsx packages/db/provision-oidc-superadmin.ts ADMIN_EMAIL VERIFIED_PROVIDER_SUBJECT
```

This command grants global access, records an audit event and invalidates previous sessions for an updated account. It must be run only by the deployment administrator. Other users are provisioned in the CRM's user management screen. Neither this command nor deployment has been run against a production service by this change.

## Financial permissions and private evidence

The seven role choices remain. Superadmin can additionally give a user exactly one financial duty: approval, processing/customer notification, or independent verification. These duties do not grant user administration or customer PII access. Ordinary agents without a financial duty continue to see only their own refund requests. Financial duties remain brand/branch scoped, and operations managers remain restricted to linked assigned escalations.

Requester self-approval, approver execution, and verification by the requester/approver/processor remain prohibited. Financial-duty configuration is not an instruction to grant it to all staff. Existing users default to no added duty.

Complaint images require customer-PII permission. Refund evidence requires evidence-view permission; financial processors can attach execution proof without becoming superadmins. Hidden evidence is also removed from bootstrap/detail payloads.

A rejected refund can be resubmitted by its original requester with a corrected reason/amount. It reuses the original request and keeps the rejection, prior reason/amount and resubmission in its event history. A version check and order lock prevent stale updates and duplicate open requests. Completed refunds cannot be resubmitted.

## Approved SLA policy

Production does not silently use demonstration deadlines. Configure `SLA_POLICY_APPROVED=true`, a version string in `SLA_POLICY_VERSION`, and positive integer durations (1–10080 minutes) for every `SLA_*_MINUTES` variable in `.env.example`. Intake is rejected explicitly if the production policy is incomplete, rather than silently saving an unmonitored complaint.

Intake records the approved policy snapshot, version and timers in the same transaction. Later assignment uses that snapshot even after environment policy changes. P1 safety complaints retain first-response/acknowledgment timers without an artificial resolution deadline. This implements elapsed wall-clock minutes; working-day calendars/holidays and an approved incident/on-call rota still require separate business configuration.

## Directory activation

Superadmin can activate or suspend brands and branches under العلامات والفروع. Brand activation is required before branch activation. Status changes are audited and stale changes are rejected. Suspending a brand stops its public QR intake without deleting branch history. No existing brand or branch is activated automatically by the migration.

## Proxy and rate limiting

In production, configure `TRUSTED_PROXY_CIDRS` with the actual controlled proxy addresses/CIDRs. Never use an Internet-wide trust range or a blanket `true`. Your public ingress must overwrite incoming forwarding headers with the real client socket address, and the web/API origin servers must be reachable only through that ingress. After configuring it, set `PROXY_HEADERS_SANITIZED=true`; production startup rejects missing proxy readiness configuration.

See `deploy/nginx.conf.example`. If another load balancer precedes Nginx, configure its trusted real-IP handling at the ingress; do not trust arbitrary public headers. Suppress query strings in access logs so OIDC codes and private tracking tokens are not logged.

Customer, staff, authentication, WhatsApp-webhook and Telegram-webhook request buckets are separate. Production counters use Redis atomically across API instances and fail closed with a temporary service error if Redis is unavailable. Set `REDIS_URL` to the shared, protected Redis service. Local development uses a bounded in-memory limiter.

## Checks and safe test data

- `npm test`: domain/security and mocked OIDC flow checks.
- `npm run test:web`: component checks.
- `npm run test:integration`: creates a uniquely named disposable database, migrates/seeds synthetic staff there, runs both authentication modes on isolated ports, then drops only that database.
- `npm run test:e2e`: the same isolation for browser tests, including password login/logout, phone intake, QR receipt tracking and admin controls at four viewport sizes.

The test database user needs permission to create/drop databases. Do not run the raw test files against the live CRM database. The harness disables WhatsApp/Telegram and uses unique synthetic keys. It never disables append-only triggers or deletes live history. The CI workflow runs formatting, lint, type checking, unit/component/integration/browser checks, dependency audit and build.

Live SSO/WhatsApp/Telegram provider configuration, approved business policy values, production backup restoration, retention policy and staging acceptance remain deployment tasks.

References: [OpenID Connect code flow](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth), [PKCE](https://www.rfc-editor.org/rfc/rfc7636).
