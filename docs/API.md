# API reference (local pilot)

Base path `/api`. All staff data/actions are authenticated and scope checked on the server. Demo uses the HttpOnly session cookie from `POST /demo-login`; non-demo requires an OIDC JWT bearer token with validated issuer/audience/MFA and a mapped enabled DB user. The browser uses Next's same-origin proxy. External calls or order/refund execution are absent.

Creation returns HTTP 201; reads return 200. Errors are stable JSON `{code,message}` with 400 validation, 401 authentication, 403 permission, 404 unavailable scoped record, 409 workflow/version conflict, 429 rate limit. Internal error contents are not exposed.

| Method | Route                          | Contract                                                                                                                                                                |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                      | PostgreSQL readiness and environment mode                                                                                                                               |
| GET    | `/session`                     | Current actor                                                                                                                                                           |
| GET    | `/demo-users`                  | Local demo only                                                                                                                                                         |
| POST   | `/demo-login`                  | Local demo only, `{id}`                                                                                                                                                 |
| POST   | `/logout`                      | Clear demo session                                                                                                                                                      |
| GET    | `/bootstrap`                   | Scoped brands/branches/users/cases/independent refunds/tasks/roster/permissions; at most 500 recent cases and explicit total count                                      |
| POST   | `/tickets/phone`               | Phone input, required `Idempotency-Key` header                                                                                                                          |
| GET    | `/tickets/:id`                 | Scoped case detail, PII restricted                                                                                                                                      |
| POST   | `/tickets/:id/actions/:action` | `{version,note,owner?,resolutionOwner?,branchId?,branchBrief?,outcome?}`; assign, start, resolve, followup, escalate, comment; legacy granular actions remain supported |
| POST   | `/customers/search`            | `{phone}`; normalized keyed lookup, scoped and audited; phone never placed in URL                                                                                       |
| POST   | `/tasks`                       | `{ticketId,owner,dueAt,note}`                                                                                                                                           |
| POST   | `/tasks/:id/complete`          | Owned scoped task completion                                                                                                                                            |
| POST   | `/branches`                    | Branch manager permission `branches.manage`: `{brandId,name,code,city}`; brand scope checked; live branches created inactive                                            |
| POST   | `/refunds`                     | `{brandId,branchId?,externalOrder,platform,kind,reason,amountMinor?,ticketId?}`; optional complaint link, kind REFUND or CANCELLATION; integer halalas                  |
| POST   | `/refunds/:id/:action`         | `{version,note,reference?,proofId?}`; review, approve, reject, execute, verify, notify, complete                                                                        |
| GET    | `/qrs`                         | Admin scoped metadata, never secret code/hash                                                                                                                           |
| POST   | `/qrs`                         | `{branchId,placement}`; one-time secret URL returned                                                                                                                    |
| POST   | `/qrs/:id/rotate`              | Revoke old; create new one-time secret URL                                                                                                                              |
| POST   | `/qrs/:id/revoke`              | Invalidate secret URL                                                                                                                                                   |
| POST   | `/shifts`                      | `{userId,brandId,start,end,breakStart?,breakEnd?,lead?}`; dates ISO UTC                                                                                                 |
| POST   | `/leave`                       | Own `{start,end}`                                                                                                                                                       |
| POST   | `/leave/:id/approve`           | Scheduler; conflict validation                                                                                                                                          |
| POST   | `/leave/:id/reject`            | Scheduler                                                                                                                                                               |
| POST   | `/qa`                          | `{ticketId,score,note}`, score integer 0–100                                                                                                                            |
| GET    | `/audit`                       | Administrator, latest 200 metadata-only actions                                                                                                                         |
| GET    | `/reports/export?brandId=`     | Authorized CSV without PII/narratives; scope intersected with brand filter                                                                                              |
| POST   | `/tickets/:id/attachments`     | Multipart `files`, maximum 3 × 5 MB                                                                                                                                     |
| GET    | `/attachments/:id`             | Authenticated scoped safe WebP bytes                                                                                                                                    |
| GET    | `/public/q/:code`              | Active QR's public brand/branch identity                                                                                                                                |
| POST   | `/public/q/:code`              | Public input + `consent:true`; required Idempotency-Key. Client brand/branch is ignored                                                                                 |
| POST   | `/public/attachments/:id`      | Multipart files, `X-Case-Token`; initial 10-minute intake attachment window only                                                                                        |
| GET    | `/public/status/:token`        | Number, state, creation time only; high-entropy expiring token required                                                                                                 |

Phone input: `brandId`, `branchId` or `unknownReason`, `category`, `priority`, `description` (10–4000 characters), optional `name`, Saudi `phone`, `externalOrder`, `platform`, `receivedAt` (ISO UTC, at most 30 days old). Category SAFETY always becomes P1. Allowed categories: DELAY, MISSING, WRONG_BRANCH, QUALITY, SAFETY, SERVICE, OTHER. Server never changes authoritative created-at/source/creator/brand attribution after intake.

Public input: category, description, optional contact and external order/platform, consent. Scope and priority are resolved server-side. Tracking token possession alone cannot retrieve contact, narrative or images.

This is the implemented contract, not a claim that all reference endpoints from the supplied spec exist. A generated OpenAPI schema, pagination endpoints, private drafts, role administration, OTP and large export jobs remain future work.

Refund records have their own RF number, branch/brand scope, evidence and append-only timeline. Existing linked records were migrated without losing links. Post-remedy customer contact and a separate confirmation are required before a complaint can close.

Assignment requires a non-personal staff-authored branchBrief (10–1000 characters). Contact and customer confirmation by AGENT require that agent to be the assigned communications owner; supervisors retain scoped override. Original complaint narratives/contact records remain protected by the existing PII permissions.

Complaint actions used by the simple QSR interface:

- `assign`: a support team lead or CUSTOMER_SERVICE_MANAGER supplies one `resolutionOwner` (AGENT / SHIFT_LEAD / CUSTOMER_SERVICE_MANAGER). Both work and customer communication are assigned to that person. No branch selector or branch brief is required. A supplied branchId cannot change the recorded branch; a different communications owner is rejected.
- `start`: assigned support personnel start processing in one action. Area/operations managers can start/resolve only a case escalated and assigned to them, within scope.
- `resolve`: records the operational action and moves to the customer-contact stage; it does not display final resolution.
- `followup`: records SATISFIED / UNREACHABLE / UNRESOLVED. SATISFIED closes only after linked financial work is complete. UNREACHABLE stays pending. UNRESOLVED routes to a named support supervisor, AREA_MANAGER or operations manager, with a nonpersonal escalation brief required if none exists.
- `escalate`: requires reason, scoped recipient and a nonpersonal escalation brief if absent. Ownership transfers for escalation work; the customer support communications owner stays unchanged. No external notification is sent.

Branch managers cannot work or receive assignments. Area and operations managers cannot perform routine assignment or customer closure. Legacy granular start/contact actions retain their lifecycle checks, with the revised ownership and role restrictions.

Branch management is available to support leads, customer-service managers and system administrators through `branches.manage`, without granting global `configure`. Both creation and brand linking enforce scope; historical branches retain their original brand.

Directory CRUD uses scoped `brands.manage` and `branches.manage` permissions for support leads, customer-service managers and system administrators. Brand editing includes name, English name, color and approved logo; branch editing includes name, city, code, active flag and valid brand link.

`POST /brands/:id/delete` and `POST /branches/:id/delete` require `{name}` matching the current entry name. Deletion is permanent and audited. A brand must have no linked branches, complaints, refunds, shifts or outbox records. A branch must have no linked complaints, refunds, QR codes or outbox records. Used entries return 409 and stay intact. Deleted brand IDs are removed from user brand scopes so reusing an ID cannot revive stale access. The UI requires typing the exact name before confirmation.

Local password sign-in:

- `POST /login` accepts `{email,password}` when LOCAL_PASSWORD_AUTH=true in a nonproduction environment. Email is normalized; passwords use salted scrypt hashes. Success sets a four-hour HttpOnly, SameSite=Strict session cookie signed with the private persistent AUTH_SESSION_KEY. Profiles never expose password hashes.
- Invalid or disabled credentials use a generic 401 response. Five failed attempts per email or thirty per IP in fifteen minutes return 429. Unknown accounts perform the same password derivation work.
- Password mode disables `/demo-users`, `/demo-login` and UI role switching. Credential-bearing/SUPER_ADMIN accounts cannot use demo login even outside password mode.
- SUPER_ADMIN has every known CRM permission and global brand/branch scope, including newly added brands. Existing ADMIN and other staff roles retain their original permissions. Financial separation-of-duties checks remain enforced.
- Production OIDC/MFA behavior remains unchanged; this password sign-in setup is for the local CRM.
