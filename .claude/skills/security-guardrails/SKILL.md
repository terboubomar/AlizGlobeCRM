---
name: security-guardrails
description: Security and privacy rules for this CRM. Use when touching auth, sessions, permissions/scopes, customer contact data, uploads, refunds/finance, public QR intake, webhooks (WhatsApp/Telegram), exports, environment flags, or seed/demo data.
---

# Security guardrails

This system will hold customer complaints and refund decisions for a restaurant group. Treat every change in these areas as security-sensitive.

## Data

- **No real customer data** anywhere in the repo: seeds, tests, fixtures, screenshots, docs. Synthetic data must look synthetic (e.g. `فرع تجريبي`, `DEMO-` codes, `demo: true`).
- Customer name/phone/email are encrypted with AES-256-GCM via `encrypt()`/`decrypt()` in `apps/api/src/crypto.ts` (`PII_KEY`). Phone lookup uses `phoneHash()` (HMAC, `PHONE_HASH_KEY`). Never store, log, or return plaintext PII beyond what the caller's role needs; mask it in lists and exports.
- CSV exports go through `safeCell()` (formula-injection protection) in `packages/domain/src`.
- Never commit `.env` or secrets. New config goes into `.env.example` with an empty value and a comment.

## Authorization

- Every API handler that reads or changes a case/refund/branch must call `authorize(actor, action, scope)` / `inScope()` from `packages/domain/src` with the record's real `brandId`/`branchId` (see `apps/api/src/ticket-scope.ts`). Take scope from the stored record, not from the request body.
- Finance duties are separated (`APPROVER`, `PROCESSOR`, `VERIFIER`): one person must not approve and verify the same refund.
- UI checks in `apps/web/app/access.ts` are cosmetic; the server is the gate.
- Add an integration test proving an out-of-scope user gets 403 for any new endpoint.

## Environment flags (keep defaults safe)

- `DEMO_MODE=true` is rejected when `NODE_ENV=production` (`apps/api/src/main.ts`). Keep that guard. Demo-only code paths must check `isDemo()`.
- `PUBLIC_INTAKE_ENABLED`, `FINANCE_POLICY_APPROVED`, `SLA_POLICY_APPROVED`, `WHATSAPP_ENABLED`, `TELEGRAM_ENABLED` default to `false`. Never flip a default to `true` or add a silent production fallback.
- `LOCAL_PASSWORD_AUTH` is non-production only; production requires OIDC with MFA (`amr=mfa` or an approved `acr`).
- The CRM does **not** execute payments or refunds. Do not add payment-provider calls; refunds record an external reference and evidence only.

## Inputs

- Validate request bodies with zod schemas (see `ticketInput`).
- Uploads: max 3 images, 5 MB, JPG/PNG/WebP, magic-byte check, pixel limits, re-encode and strip EXIF (`apps/api/src/uploads.ts`). Non-demo uploads fail closed without `MALWARE_SCANNER`.
- Webhooks (WhatsApp, Telegram) verify their signature/secret before doing anything.
- Public status tokens are high-entropy (`token()`) and expiring; never use sequential IDs in public URLs.
- Rate limits use `TRUSTED_PROXY_CIDRS`; don't trust `X-Forwarded-For` from anywhere else.

## Before finishing

Run the `verify` skill. For larger changes in these areas, also run `/security-review`. Anything that needs a business/legal decision (SLA values, finance limits, retention) goes to the user — record it in `docs/DECISIONS.md` rather than picking a value.
