# ALIZ GLOBE — CUSTOMER EXPERIENCE & OPERATIONS CRM
## Master Build Specification v3.0 — Codex / Claude Code / Engineering Team
**Date:** 2026-10-20  
**Status:** Build-ready product/technical specification; business rules marked PROPOSED require approval  
**Owner:** Aliz Globe Company  
**Pilot:** Burger Waqf (واقف)  
**Scope:** One Aliz Globe organization, multiple brands, multiple branches, seven initial call-center agents  
**Language:** Arabic (Saudi dialect for customer copy, Modern Standard Arabic for formal labels) first, English optional. Full RTL support.

---

# 0. BUILD DIRECTIVE — READ FIRST

You are the lead product engineer, senior UX designer, QA lead, and systems architect. Build a **real, deployable, secure, mobile-responsive multi-brand complaint and operations CRM** for Aliz Globe. Do not produce a mockup or a collection of placeholder pages. Implement functional database CRUD, permission checks, transactional workflows, background SLA jobs, public QR intake with secure image uploads, agent phone complaint entry, refund/cancellation approval tracking, role-scoped dashboards, scheduling, audit logs, tests, and documented deployment. Use the supplied assets without redrawing or replacing official logos. Never fabricate production customers, branch lists, order data, refund outcomes, or call statistics.

**Hard boundaries**:
- Existing cloud phone platform handles calls. CRM **does not** dial, answer, route, record, or sync calls. Agents open the CRM separately and **manually record customer complaints received by phone**.
- Existing external platform handles orders. CRM **does not** create, cancel, amend, or refund orders, process payments, or move wallet balances. Store manually entered external order ID/channel and externally verified refund proof.
- Upselling remains in the existing ordering/call-center workflow. **Do not build an upsell engine, menu, checkout, or commissions system**.
- WhatsApp is not a case database. During migration it may be used for alerts **without customer PII**; authoritative states and decisions reside in CRM.
- Group-level organizational scope is Aliz Globe. Make its brand/branch hierarchy rigorous; don't overengineer unrelated public SaaS billing or multi-tenant subscriptions.

**Definition of done:** Agents can create a complaint after a phone call in under ~90 seconds for a typical case; customer can scan branch QR, report issue with images, receive secure tracking; correct branch manager acknowledges; SLA tracks and escalates; refund request requires role-controlled approval plus verified external execution; management can distinguish genuine resolution from a WhatsApp claim; every relevant action audited; cross-brand/branch access isolation tested; app is operable on production-grade infrastructure.

---

# 1. EVIDENCE-BASED BUSINESS CONTEXT

## 1.1 Current WhatsApp failures documented by screenshots

**Screenshot A — delayed order, ad hoc branch communication**
- An agent relays a customer-reported order delay; coworkers ask whether the branch should prepare it; someone replies the branch was notified.
- **Observed:** branch notification in chat. **Not established:** branch acknowledgment, successful preparation, customer outcome, SLA deadline or closure. Do not assume it was never solved.
- CRM requirement: record distinct `assigned_at`, `acknowledged_at`, `action_completed_at`, `customer_confirmed_at`; set two owners: branch resolver and customer-communications owner.

**Screenshot B — order sent to wrong branch and wallet refund**
- An agent posts an order reference, says order is on wrong branch, asks to cancel/reimburse wallet, tags several people, and says the matter has been outstanding since Friday.
- **Observed:** a request for intervention and stated delay. **Not established:** whether the refund was actually executed.
- CRM requirement: specialized **Refund / Cancellation Case** linked to complaint, with approver, decision, processing owner, external transaction/proof, financial status and customer communication; prohibit marking `REFUNDED` on approval alone.

**Root failure mode:** information is passed among people but not converted into owned, timed, auditable, closed cases.

## 1.2 Users and goals
- **7 call-center agents** initially; employees take live calls in existing platform and enter cases in CRM.
- Customers can report directly through branch-specific QR codes using mobile website and attach photos.
- Branch managers act upon cases in their branch.
- Supervisors monitor queues, handoffs, escalation and quality.
- Brand managers and Aliz Globe group operations monitor trends, accountability and repeat problems.
- HR/operations schedules staff; financial approvers review exception requests; privacy officers manage subject rights.

## 1.3 Brands and supplied assets
Five user-supplied logos are present in the working environment and take precedence over web-indexed logos:

| Brand AR | Suggested code | Source asset | Status |
|---|---|---|---|
| واقف / Burger Waqf | `waqf` | `Waqf Logo.jpeg` | User supplied |
| كباب علوم | `kabab-uloom` | `kebab alom logo.png` | User supplied |
| بطاطسيون | `batatisyon` | `batatision.jpeg` | User supplied |
| مزمزيل | `mazmuzil` | `mazmuzil logo.webp` | User supplied |
| شاورمان | `shawarman` | `shawarman logo.webp` | User supplied |

Official site previously showed additional portfolio entries **كرملي** and **ثلاث بطات**; retain them as **pending brand activation and asset validation**, not hardcoded active brands. The holding-company logo also needs a verified approved asset (official site asset or provided file). **Logo filenames/codes do not establish formal legal spelling**; admin can edit names and aliases. Never auto-create branches from assumptions or geocoded guesses. Seed the five brands as draft/approved per organizational confirmation; bootstrap with Burger Waqf pilot only active.

**Asset instructions:** Copy original image files into the repository assets directory, preserve originals, use image optimization derivatives only for serving. Do not depend on a developer's `/mnt/data` path in deployment. Missing assets use a neutral brand initial placeholder, not fake logos.

---

# 2. PRODUCT MODULES / NON-GOALS

## 2.1 Build
1. Group > brand > branch administration and branding.
2. Branch-specific QR generation, rotation, download-ready print templates and per-QR placement analytics.
3. Public mobile-first Arabic RTL complaint intake with photo upload and secure case tracking.
4. **Agent-assisted phone complaint entry**, customer lookup, repeat/duplicate detection, contact attempts, follow-up tasks.
5. Centralized complaint queue and triage, branch handoff/acknowledgment, threaded internal notes and attachments.
6. Configurable SLA engine, calendars, deadlines, warning thresholds, escalation, breach analytics.
7. Specialized wrong-branch, delayed-order, missing-item, food safety, refund and cancellation workflows.
8. Approval-gated refund/cancellation tracking, separate from real transactions in external platform.
9. Scoped RBAC, MFA/OIDC staff authentication, immutable operational/audit timeline.
10. Staff shifts, rotations, breaks, leave availability and supervisor coverage (not payroll).
11. Group/brand/branch/agent reports, filters, safe CSV/XLSX exports, QA and notifications.
12. Configurable taxonomy, branch operations calendars, public customer notices and legal retention.

## 2.2 Excluded
- PBX/call control/recordings/call statistics API, telephony webhooks or CDR import in current scope.
- POS/order platform sync, checkout, cancellation execution, wallet refund execution.
- Menu management, sales/upsell dashboard, commission calculations.
- Public WhatsApp messaging integration in MVP (may add outbound provider later with consent).
- AI auto-resolution of critical incidents; AI must not infer refund evidence or approve financial actions.
- Generic multi-organization SaaS/billing.

---

# 3. INFORMATION ARCHITECTURE AND UX

## 3.1 Internal navigation (desktop left sidebar, collapsible; Arabic right sidebar in RTL)
- **الرئيسية / Overview**: permission-scoped KPIs, actionable queues, SLA at risk.
- **الشكاوى / Complaints**: All tickets, New phone complaint, My cases, Waiting for branch, Breached, Reopened.
- **الاسترجاع والإلغاء / Refunds & Cancellations**: Awaiting approval, Awaiting external action, Verification, Completed, Rejected.
- **الفروع / Branches**: Directory, assigned cases, branch accountability, QR codes, posters.
- **العملاء / Customers**: role-filtered lookup and case history.
- **المهام والمتابعة / Follow-ups**: due callbacks/contact tasks; manually tick completed, no dialing.
- **الجدولة / Workforce**: weekly calendar, shift assignments, leave, daily coverage.
- **التقارير / Reports**: Group, brand, branch, categories, tickets, SLA, refunds, agents, export.
- **الجودة / QA**: manual case reviews, agent quality checklist, coach feedback.
- **الإعدادات / Settings**: company, brands, branches, users, roles, SLAs, categories, calendars, privacy, QR, notifications, audit.

## 3.2 Interfaces
**Agent desktop**: top search, brand/branch selectors restricted by membership, compact create-case form, right-hand customer context panel, clear owner/time/status; keyboard-friendly. One-screen quick capture for common complaint; advanced fields expandable. Preserve drafts locally only if they contain no sensitive data or secured session; prefer server-side private drafts with expiration.

**Branch portal**: mobile-first action inbox. Buttons **Acknowledge**, **Investigating**, **Action Completed** with required notes; never let branch manager unilaterally declare customer notified or refund paid.

**Public form**: Arabic RTL; brand logo/name and branch displayed prominently; issue category, description, optional external order reference/channel and incident date, phone/contact preference when desired, up to 3 photos (default 5MB each, configurable), privacy notice; progress, success receipt, secure token; accessible layout and low-bandwidth image handling. No account required. Prevent PII display on shared devices after submission.

**Public status**: generic non-sensitive status may be shown only after possessing a high-entropy case token; sensitive details and photos require OTP/verified contact. A ticket number alone is NOT authentication. Provide safe token recovery workflow.

**Design system**: minimalist enterprise SaaS, neutral shell, brand accent only on brand-scoped screens, no disruptive gradients or oversized charts. Arabic Cairo/Tajawal, English Inter, numeric tabular digits, responsive at 375/768/1280/1440 widths; contrast >= WCAG AA; state labels never rely on color alone. Every report has export and explicit filter context. Loading/success/empty/error/permission-denied states built fully, no dead buttons or fake stats.

---

# 4. TARGET ARCHITECTURE

```text
Customers scan QR                         Employees use separate calling/order apps
        |                                                 |
        v                                                 v
Public Next.js forms                            Staff Next.js CRM
        |                                                 |
        +---------------- HTTPS --------------------------+
                                  |
                  NestJS modular-monolith API
                                  |
    +-----------------------------+-------------------------------+
    |               |                |              |             |
 Ticket Core   SLA/Outbox     Refund Workflow  Role/Scope   Workforce/BI
    |               |                |              |             |
    +---------------+----------------+--------------+-------------+
                                  |
                       PostgreSQL (primary)
                         |            |
                     Redis/BullMQ  Private Object Storage
                      SLA workers     quarantined photos
                         |
                Email/SMS only after provider approved
```

**Stack**: TypeScript, pnpm monorepo, Next.js App Router + Tailwind + shadcn/ui + React Hook Form/Zod; NestJS modules + Zod/class-validator; Prisma/PostgreSQL; Redis/BullMQ; private S3-compatible storage; staff OIDC + MFA; Postgres/Redis observability using OpenTelemetry, Sentry and centralized logs; Docker, GitHub Actions. Keep public intake isolated from privileged staff auth. Use database transactions and transactional outbox for state + events. Make every worker idempotent.

**Deployable apps**:
- `apps/web` staff dashboard and public pages (separate route groups/middleware; prefer separate subdomains for public and staff).
- `apps/api` single NestJS backend.
- `apps/worker` BullMQ task processor (same shared domain packages, separate process).
- `packages/db`, `packages/authz`, `packages/domain`, `packages/ui`, `packages/config`, `packages/validation`, `packages/i18n`.

Recommended routes: `crm.alizglobe.com` for staff; `support.alizglobe.com/q/{randomCode}` for QR. Actual domains depend on ownership/DNS approval.

---

# 5. DATA MODEL — POSTGRESQL

## 5.1 Conventions
- UUID primary keys, timestamptz UTC, server clocks only; display Asia/Riyadh.
- `organization_id`, `brand_id`, `branch_id` on scoped records, enforced via composite unique keys/FKs or triggers plus service authorization. No crossing ownership via changed request body.
- Monetary amounts in integer halalas (`amount_minor`) with `currency='SAR'` rather than floats.
- Sensitive PII encrypted using managed keys, search phone via keyed normalized blind index; never leak phone/full name into logs, errors, Slack/WhatsApp or analytics exports.
- Ticket numbers `AG-{YYYY}-{NNNNNN}` generated atomically (optionally brand-prefixed) with non-guessable tracking token separate.
- Immutable history and actor attribution. Soft-archive records subject to retention, legal hold and data-rights policies. Schema migrations checked in.

## 5.2 Entity inventory and key fields

| Entity | Key columns / responsibility |
|---|---|
| `organizations` | id, name, active |
| `brands` | organization_id, code, name_ar, name_en, logo_asset_id, palette, status |
| `branches` | brand_id, code, name_ar, address, city, timezone, operating_calendar_id, active |
| `brand_assets` | brand_id?, purpose, object_key, mime, checksum, approved_at |
| `branch_qr_codes` | branch_id, code_hash UNIQUE, placement, print_version, active_from, revoked_at, created_by |
| `public_form_versions` | brand_id, schema_json, privacy_notice_version, active_from/to |
| `users` | OIDC subject, display_name, enabled, status |
| `roles`, `permissions`, `role_permissions` | role catalog and verbs |
| `user_role_scopes` | user_id, role_id, organization_id, brand_id?, branch_id?, valid_from/to |
| `customers` | pii_encrypted_name/phone, phone_lookup_hmac, contact preference, created_at |
| `tickets` | ticket_no, org/brand/branch, source, category, priority, state, description, external_order_ref?, external_platform?, customer_id?, `communications_owner_id`, `resolution_owner_id`, creator_id?, intake_agent_id?, received_at, created_at, first_response_due_at, acknowledgment_due_at, resolution_due_at, policy_version_id, row_version, resolved_at, closed_at |
| `ticket_events` | ticket_id, old/new state, event_type, actor_id/system, occurred_at, payload schema version; append only |
| `ticket_assignments` | ticket_id, assignee_role/user/branch, assigned_at, acknowledged_at, released_at |
| `ticket_comments` | internal note, visibility, actor, timestamp; redact sensitive text before any alert |
| `ticket_attachments` | ticket_id, key, checksum, mime, size, scan_status, exif_stripped, uploader_kind, retention_until |
| `contact_events` | ticket_id, PHONE/OTHER, summary, actor, customer_response, happened_at; no actual call routing |
| `follow_up_tasks` | ticket_id, owner_id, due_at, outcome, completed_at |
| `sla_policy_versions` | scope and effective date, response/ack/resolution thresholds, operating-hours calendar, exception rule |
| `sla_timers` | ticket_id, milestone, due_at, current_state, warned_at, breached_at; uniqueness per milestone/version |
| `sla_events` | ticket_id, timer_id, type, occurred_at, actor, worker_run_id |
| `escalations` | ticket_id, tier, target_role/user, created_at, acknowledged_at, status |
| `refund_cases` | ticket_id, request_type, reason, channel, amount_minor?, requested_method (wallet/original/other), requester_id, assigned_approver_id, status, external_processing_owner_id, approved_at?, executed_at?, verified_at? |
| `refund_decisions` | refund_case_id, decision, actor, reason, approved_limit snapshot, created_at |
| `refund_evidence` | refund_case_id, external_reference, proof_asset_id, proof_kind, verified_by, verified_at |
| `shifts`, `shift_breaks` | user_id, starts_at, ends_at, lead_role, assigned_brands; break timing |
| `leave_requests` | user_id, type, from/to, approval_state, manager_id |
| `qa_reviews` | ticket_id, reviewer_id, checklist_version, scored_items, note |
| `notification_outbox` | event_type, payload_minimal, destination_role, idempotency_key, attempts, status |
| `audit_logs` | actor, permission, entity, entity_id, before/after **redacted**, timestamp, IP/device metadata with retention |
| `public_case_access` | token_hash, ticket_id, scope, expiry, revoked_at, verified_at |
| `report_export_jobs` | requester, filters, scope_snapshot, created_at, expires_at, downloadable_object_key |
| `idempotency_keys` | scope/route/key, request_hash, response_ref, expiry |

**Critical integrity invariants:**
- Same complaint can be created by QR (`PUBLIC_QR`) or manually by agent on call (`PHONE_AGENT`) and uses the identical ticket service.
- No missing owner disappears: unresolved unassigned cases remain in visible `UNASSIGNED` queue and trigger supervision.
- Original intake channel and creator are immutable; later phone follow-ups append `contact_events` instead of overwriting original QR source.
- Refund approval is not equivalent to processing; processing is not equivalent to verification/customer communication.
- State transition and associated event inserted atomically. Use optimistic concurrency (`row_version`) on concurrent edits.
- Restrict secrets, QR codes, temporary case tokens to hashed values where appropriate.
- Consider partitioning audit/events only if scale requires it; start simple.

## 5.3 Lifecycle state machines
Complaint: `NEW -> TRIAGED -> ASSIGNED -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED -> CLOSED`. Branch and customer waiting are orthogonal **hold reasons** not excuses to stop the SLA; `ESCALATED` is an escalation flag/event instead of losing base state. `REOPENED` returns to in-progress with a new event and policy-defined secondary response milestone. Transitions require authorized actor and validated fields.

Refund case: `REQUESTED -> UNDER_REVIEW -> APPROVED | REJECTED -> AWAITING_EXTERNAL_EXECUTION -> EXECUTED_UNVERIFIED -> VERIFIED -> CUSTOMER_NOTIFIED -> COMPLETED`; cancel/failed/disputed paths strictly governed. Define rejection and re-request rules. `APPROVED` **cannot** transition directly to `COMPLETED`.

---

# 6. BRANCH QR SYSTEM AND CUSTOMER COMPLAINT FLOW

1. Admin registers brand and verified branch, chooses approved logo and palette.
2. System generates cryptographically random, stable QR URL `https://support.alizglobe.com/q/{opaque-code}`; QR encoded with compliant library, download SVG/PNG/PDF if feasible; printable Arabic/English poster shows **brand + branch text** so customer knows destination. QR ID points to server-side branch record, never exposed sequential UUID as sole trust mechanism.
3. Scan -> public responsive page shows brand name, branch, complaint category and privacy notice.
4. Form: category; description; optional incident/order date, external order platform/ref; optionally name and verified phone for response; evidence upload max **3 images, 5MB each** default; privacy acknowledgment.
5. Upload via short-lived signed URL to quarantine. Server validates declared MIME **and magic bytes**, image dimensions/size, strips EXIF/GPS, converts to safe image format and malware-scans; only `CLEAN` attachments can be viewed.
6. Rate-limit by QR/IP/device signals, anti-abuse challenge as needed, throttling, canonical request schema; never block food-safety complaints solely through simplistic spam heuristics (offer safe manual channel).
7. Submit transaction creates ticket + immutable event + selected SLA snapshot + routing outbox. Show case number plus bearer tracking link; track token high entropy and expiration. Customer may use OTP to retrieve sensitive details if approved provider is configured; without one, keep status details minimal.
8. Server ignores any supplied `brand_id/branch_id`; resolves these from QR token. Revoked QR shows safe retired page or controlled replacement redirect. Rotation supported without losing historical attribution.
9. Source remains `PUBLIC_QR`; subsequent agent contact events don't duplicate ticket.
10. Customer can upload more proof via time-limited one-case verified evidence invitation; link never grants broad ticket access.

**Public form copy examples**: `كيف نقدر نساعدك؟` / `شاركنا تفاصيل المشكلة` / `أرفق صورة للطلب (اختياري)` / `رقم الطلب (اختياري)` / `تم استلام بلاغك، رقم المتابعة ...` / `راح يتم التواصل معك حسب بيانات التواصل اللي قدمتها.` Do not promise guaranteed quick refunds or times not approved under operating SLA.

---

# 7. AGENT-ASSISTED PHONE COMPLAINTS — REQUIRED MVP

**Workflow:** Agent answers in existing cloud calling software; navigates to CRM; presses `تسجيل شكوى هاتفية`; searches phone/customer (authorized scoped lookup), checks for matching open complaint, selects brand + branch (or explicit `BRANCH_UNKNOWN` queue), category/priority, enters customer description and external order reference if available; clicks **Create**; CRM displays ticket #, owner and due time; agent reads case reference, creates follow-up task and optionally sends customer an evidence-upload invitation through an approved channel.

**Required intake data:** brand, branch or unknown reason, complaint category, narrative, authenticated creator, source `PHONE_AGENT`, original received time if reliably known. Order ID and external call ID **not mandatory**. Use `created_at` for audit and `received_at` for declared real-world occurrence; if edited, preserve edit history and evidence; never backdate the audit event.

**Agent case screen:** status, SLA countdown, category, customer details (role restricted), brand/branch, external channel & number, two owners, branch acknowledgment indicator, case timeline, photo evidence, comments, follow-up task, duplicate cases, permitted actions.

**Quality safeguards**: allow quick capture in <90 seconds for basic issue; autosave private draft where feasible; duplicate warning not blocking food safety; close requires evidence of corrective action and recorded attempt at customer follow-up; shift handoff assigns new communication owner without resetting SLA.

---

# 8. SLA ENGINE, ROUTING, ESCALATION

## 8.1 Milestones and initial proposed targets (need operations sign-off)

| Priority | Example | First human action | Branch acknowledgment | Action/remedy target | Final closure |
|---|---|---|---|---|---|
| P1 CRITICAL | Safety/illness, severe misconduct | Immediate, target <=5 minutes | Immediate | Safety containment & investigation under incident protocol | No artificial 30-minute closure |
| P2 HIGH | Missing/wrong order, significant delay | <=5 minutes | <=5 minutes after assignment | <=30 minutes for actionable remedy where operationally feasible | After verification |
| P3 STANDARD | Minor issue, service feedback | <=15 minutes in staffed hours | <=30 minutes in staffed hours | <=4 operating hours | After follow-up |

Important: first action, branch ack, remedy, and actual closure are distinct timers. Public QR outside support hours uses a prominently disclosed policy (P1 immediate escalation if staffed incident response exists; otherwise enforce verified operational process before launching QR). Never promise around-the-clock support unless staffed.

## 8.2 Rules
- Pick policy: org baseline -> brand override -> approved branch exception; store immutable policy version/snapshot at ticket creation.
- Operating calendars per brand/branch and escalation recipient; clocks in UTC, Asia/Riyadh presentation; configurable business-hour vs wall-clock policies and holiday handling.
- SLA **starts from authoritative intake**; agent late entry captured as data-entry lag rather than pretending instant registration. QR clock starts when submission accepted.
- Warning thresholds configurable (e.g., 50%, 80%, 100% of allowance, not universal fixed dates). Idempotent worker schedules warnings and breaches; restart/retry must not double-count.
- Reassignment, `AWAITING_BRANCH`, absence of notification, and approver leave **never silently reset or pause** an SLA. Any pause requires explicit approved policy reason, actor and audit; immutable original due time retained.
- P1 safety case: immediately notify incident responder and isolate case confidentiality; no automated unreviewed dismissal.
- Branch rejection must give reason and route to supervisor/triage; case remains owned until accepted by another resolver.
- On breach: persist breach event first, then queue scoped notification; notifications are side effects, not sources of truth.
- Provide breach replay/reconciliation job to repair missed worker events.

## 8.3 Simplified routing pseudocode
```ts
async function createComplaint(input, actorOrQrContext) {
  const scope = resolveTrustedScope(actorOrQrContext, input); // NOT browser-provided IDs
  await authorizeIntake(scope, actorOrQrContext);
  return db.$transaction(async tx => {
    const policy = await selectActiveSlaVersion(tx, scope, input.category, input.priority);
    const ticket = await tx.ticket.create({ data: normalizeValidatedTicket(input, scope, policy) });
    await tx.ticketEvent.create({ data: initialCreatedEvent(ticket, actorOrQrContext) });
    await tx.slaTimer.createMany({ data: computeMilestones(ticket, policy) });
    await tx.outboxEvent.create({ data: ticketCreatedEvent(ticket.id) });
    return ticket;
  });
}
```
This is pseudocode; production code must enforce uniqueness, idempotency, reference generation, and safe transaction retry.

---

# 9. REFUND / CANCELLATION TRACKING (EXTERNAL EXECUTION ONLY)

**Motivation:** Screenshot showed wrong-branch order with a pending wallet refund request and several coworkers tagged. Implement disciplined case ownership rather than recreating the wallet.

1. Agent creates/links complaint; picks `REFUND_REQUEST` or `CANCELLATION_REQUEST`, reason `WRONG_BRANCH` etc., order ID, source platform, amount/method **if verified**, requested amount not a completed financial transaction.
2. Route to policy-defined financial approver; show age and SLA, require decision with reason. Approval limits, segregation of duties and exceptional overrides configurable and **must be supplied by authorized Finance/Operations**, not invented.
3. On approval, assign `external_processing_owner_id`. That person uses the **existing** order/wallet/payment system outside CRM.
4. Processor manually records external transaction ID/status and, where allowed, supporting evidence. Require separate verification by permitted role for refunds above configured threshold.
5. Contact owner informs customer with accurate confirmed outcome; mark `CUSTOMER_NOTIFIED` then `COMPLETED` only with proof and journal.
6. If rejected/cancelled/failed, record reason and next action. Do not misrepresent platform processing time as internal approval time.
7. Detect repeated reimbursement requests for same brand + platform + order reference + refund reason, across overlapping cases. Do not auto-merge distinct customer incidents.

**Stages measured independently**: intake acknowledgment, approval decision, external action pending, financial verification, customer notification. **Example** first decision <=30 minutes during approver coverage, notification <=15 minutes after verified action; the actual processing SLA is external/provider dependent. Finance must approve these before enabling contractual reporting.

**Security**: no refund execution button; no stored full payment credentials; no automated transaction state inference from chat; dual control on approvals per configured financial policy; encrypted evidence and audit with restricted export.

---

# 10. AUTHORIZATION — ROLE + SCOPE + PERMISSION

| Role | Authorized scope | Core rights |
|---|---|---|
| `AGENT` | Explicit assigned brands/queues | Create phone tickets, read/update assigned tickets, log follow-up; no refund approve |
| `SHIFT_LEAD` | Assigned team/brands | Triage, reassign, monitor SLAs, escalate, review QA; limited remedy approval only if authorized |
| `BRANCH_MANAGER` | Explicit branches | Acknowledge, investigate, add branch proof, mark branch corrective action; no financial proof fabrication |
| `BRAND_OPERATIONS_MANAGER` | Assigned brand | Monitor all brand branches; approved escalations, routing and policy recommendations |
| `GROUP_OPERATIONS_MANAGER` | Aliz Globe group | Cross-brand aggregated reports, cross-brand incidents, approved exception workflows |
| `FINANCE_APPROVER` | Assigned brands/financial policy | Approve/reject refund requests within thresholds, review proof |
| `REFUND_PROCESSOR` | Assigned brands/platforms | Record external action after approval; no self-approval by default |
| `QA_REVIEWER` | Assigned queues/brands | Review cases, score handling; PII masked unless justified |
| `SCHEDULER` | Authorized team | Edit shifts and leave approvals only |
| `ADMIN` | System config | Manage brands, roles, SLAs, QR; **no default unrestricted customer PII or financial approvals** |
| `PRIVACY_OFFICER` | Approved privacy workflows | Subject requests, retention/legal hold with audit |
| `PUBLIC_CUSTOMER` | Own verified case only | Submit and securely track/upload per token/OTP assurance |

**Enforcement:** deny by default; authorization on every API action, search, joined read, export and attachment signed-download; scoped memberships have effective dates; reject cross-brand input IDs; use database RLS as optional defense-in-depth, never only frontend gating. Permission checks logged for sensitive export/PII access. Session expiration/MFA, CSRF protection where cookies used, strong HTTP security headers.

---

# 11. WORKFORCE SCHEDULING — 7 AGENTS

Build shift calendar but **do not hardcode a roster as fact**. Set call-center hours, contract hours, rest breaks, local labor compliance and actual hourly arrivals through admin input. With no telephony integration, dashboard must not pretend to know actual calls/agent occupancy. Accept manager-supplied staffing assumptions or approved manual imports, labeled as such.

Features: recurring shift templates, drag/drop shift assign, designated shift lead, approved days off, break staggering, leave/conflict detection, minimum coverage by time block, late shift handover, escalation duty schedule, weekly fairness report and shift swap approval. Staff can view own schedule; supervisors edit assigned teams. Validate overlapping shifts/leave, maximum scheduled hours rules configured by HR, and uncovered windows. Keep breaks from counting as available agents. Export printable roster/PDF/CSV when supported.

**Critical case handoff** at shift change: queue of open cases requiring handoff, current communications owner, next owner, branch status, next SLA, mandatory acknowledgment, audit.

---

# 12. MANAGEMENT ANALYTICS AND EXPORTS

## 12.1 Dashboard widgets
- Group: new/open/closed complaints, resolution within SLA, first-action compliance, breached/at-risk tickets, reopening rate, average/median/P90 resolution, aging by bucket, refund pipeline (requests, approved, executed unverified, verified), counts by brand.
- Brand: branches ranked by complaint volume, severity, category, response delays, acknowledged/unacknowledged, P1 trend, QR vs phone.
- Branch: time-to-acknowledge, time-in-branch queue, reason distribution, repeated problems, resolution evidence quality.
- Agent: complaint registration lag, case ownership, follow-up compliance, quality audits; **not** call totals, sales or upsell revenue absent integrated data.
- Refunds: approval backlog and age, externally processed verified, pending proof, repeated wrong-branch causes.
- Scheduling: planned agents by hour, uncovered windows, lead-on-duty coverage, leave, shift fairness.
- QR: scans (subject to anonymous aggregated analytics and consent/privacy), successful submissions, completion/abandonment where instrumented and lawful, branch association.

**Metric rules**: `within_sla` from frozen per-ticket milestone due timestamp; keep P1 special handling. Normalize complaint rate per 1,000 orders **only if trustworthy branch-period external order count is manually imported and clearly labeled**; otherwise omit denominator metrics. Never rank branches solely on raw complaint counts. Report timezone and cutoff, source/channel segmentation, and exclusions. Do not infer customer satisfaction from low complaint count.

## 12.2 Exports
Each report: date range, brand, branch, source, status, priority, category, owner; CSV/XLSX export respecting caller permissions, redact/mask PII by default, asynchronously generate large files, download with short-lived scoped URL, audit exports and expire them. Unit tests reconcile export rows to dashboard filters and authorized scope.

---

# 13. API CONTRACT — REFERENCE ENDPOINTS

**Public unauthenticated + abuse controls**
```http
GET    /api/public/q/:opaqueCode
POST   /api/public/upload-sessions
POST   /api/public/complaints
GET    /api/public/cases/:opaqueTrackingToken/status
POST   /api/public/cases/:token/verify-otp       # only if provider configured
POST   /api/public/cases/:token/evidence-session
```
**Authenticated staff (all scoped, audited, typed)**
```http
GET    /api/v1/me
GET    /api/v1/brands
GET    /api/v1/branches?brandId=
GET    /api/v1/customers/search?phone=
GET    /api/v1/tickets?filters=
POST   /api/v1/tickets/phone
GET    /api/v1/tickets/:id
POST   /api/v1/tickets/:id/transition
POST   /api/v1/tickets/:id/assign
POST   /api/v1/tickets/:id/acknowledge
POST   /api/v1/tickets/:id/comments
POST   /api/v1/tickets/:id/contact-events
POST   /api/v1/tickets/:id/evidence-invitations
POST   /api/v1/tickets/:id/link-duplicate
GET    /api/v1/tickets/:id/timeline
POST   /api/v1/refund-cases
POST   /api/v1/refund-cases/:id/decision
POST   /api/v1/refund-cases/:id/record-external-action
POST   /api/v1/refund-cases/:id/verify
POST   /api/v1/refund-cases/:id/customer-notified
GET    /api/v1/qr-codes
POST   /api/v1/qr-codes
POST   /api/v1/qr-codes/:id/rotate
POST   /api/v1/qr-codes/:id/revoke
GET    /api/v1/shifts
POST   /api/v1/shifts
POST   /api/v1/leave-requests
GET    /api/v1/reports/:reportName
POST   /api/v1/exports
GET    /api/v1/exports/:id
GET    /api/v1/audit-logs
```
Use Zod/OpenAPI schemas, explicit paging/filter whitelists, stable error codes, idempotency keys on create/action endpoints and ETags or row versions for concurrent editing. Don't expose raw object storage paths or encrypted fields.

---

# 14. ALERTS AND NOTIFICATIONS

In-app bell/toasts/action inbox in MVP; configurable email/SMS only when approved provider and consent/legal basis available. Alert types: new unassigned QR P1, branch acknowledgment overdue, approaching SLA, SLA breach, financial approval overdue, refund awaiting external execution, verified outcome awaiting customer notification, on-duty coverage gap, suspected duplicate/abuse requiring review. Rate-limit duplicates and acknowledge/snooze only with controlled reasons. Notifications should carry case ID, brand/branch and urgency **without phone numbers or sensitive descriptions**. WhatsApp alerts optional phase 2, not a source of truth.

---

# 15. SECURITY, PRIVACY AND COMPLIANCE

- Saudi PDPL assessment with legal counsel, appropriate hosting/data-transfer review, Arabic privacy notice, approved processing notices, consent only where legally applicable, retention schedule, subject-rights workflow and vendor contracts **before production**.
- HTTPS/HSTS, managed secrets, encrypted database backups/object storage, restricted object ACLs, signed expiring GET/PUT, upload quarantine, malware scan, image re-encoding/EXIF stripping.
- OIDC/MFA for staff; purpose-scoped PII; encryption and normalized search HMAC; access audit and suspected access anomaly signals.
- Token entropy >=128 bits, rotate/revoke, no plaintext token storage. OTP rate limits and lockouts if enabled.
- Rate-limits and abuse prevention on QR creation, complaints, search, login, upload; CSRF/XSS/SQL injection defenses. No sensitive data in third-party analytics or error telemetry.
- Backups with documented RPO/RTO targets set with operations, **tested** restoration. Retention/deletion jobs respect litigation hold and subject access requirements.
- Accessibility WCAG 2.2 AA where practicable; Arabic/English error and consent copy; incident response and disaster recovery runbooks.

---

# 16. DEV REPO, CI/CD AND DEPLOYMENT

Proposed repository:
```text
aliz-globe-crm/
  apps/
    web/                 # public QR pages + staff app, isolated contexts
    api/                 # NestJS modular monolith
    worker/              # BullMQ SLA/outbox jobs
  packages/
    db/                  # Prisma schema, migrations, seed
    domain/              # state machines, SLA policy evaluation
    authz/               # scoped RBAC policies
    ui/                  # shared components/theme
    validation/          # public and staff DTOs
    i18n/                # AR/EN translation
    config/
  assets/
    brand-logos/         # user-provided images, approved originals
  infra/
    docker/
    terraform/           # optional after infra decision
  docs/
    adr/                 # architecture decisions
    runbooks/
    policy-approvals/
  tests/
    e2e/
    security/
  .github/workflows/
  docker-compose.yml
  .env.example
  README.md
```

`docker compose up` starts local Postgres, Redis, MinIO-compatible dev object storage, worker, API and frontend with non-production demo users/brands clearly labeled. Provide `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm db:migrate`, `pnpm db:seed:demo`, `pnpm build`. No demo data in production. Avoid writing real image asset filenames into DB as inaccessible absolute system paths.

**GitHub Actions required green**: formatting/lint; TypeScript; migration validation; unit tests for state machine/permissions/SLA; Postgres + Redis integration tests; Playwright RTL/mobile E2E; dependency and secret scans; container image scan; build artifacts; staging deploy; smoke tests; manual production gate. Use scoped cloud secrets/short-lived OIDC deployment credentials and rollback-capable container releases. Production host/region chosen only after Saudi legal and security review.

## Production operational requirements
Health/readiness endpoints, structured logs and traces, correlation IDs linking ticket actions, queue depth, SLA reconciliation, failing upload scans, error rate alerting; migrate DB before deploying incompatible versions, no destructive schema release without backup and forward-only migration strategy. Monitor role privilege modifications and exports. Separate development/staging/production secrets and buckets.

---

# 17. BUILD PHASES & EXIT GATES

## Phase 0 — Requirements, assets and design system
- Confirm Aliz Globe authority and brand directory; import user-supplied logos; obtain approved corporate logo; branch codes/list and operating calendars.
- Confirm functional SLA durations, P1 on-call owner, finance approval thresholds, privacy policy, retention, working hours, responsibilities.
- Deliver low/high-fidelity responsive RTL screens, navigation and clickable UAT flows before heavy implementation.
**Exit:** signed decision register; no fake production branches.

## Phase 1 — Foundation and shared ticket core
- Monorepo, authentication, RBAC, schema, seed, audit, group/brand/branch admin, dashboard shell, full complaint service and transitions.
- Agent-assisted phone ticket entry, duplicate prompts, branch queue, acknowledgment and customer follow-up.
**Exit:** scoped authenticated agent can create phone ticket; branch can acknowledge; history complete; tests green.

## Phase 2 — Public QR and evidence
- QR admin/generation/rotation and posters; Arabic responsive public form; secure upload/quarantine; tracking token; privacy and abuse controls.
**Exit:** two different branches produce correctly scoped cases under adversarial request tests; accessible uploaded photo only to authorized users.

## Phase 3 — SLA/escalation and refunds
- Versioned policies, timers/outbox, worker retries/reconciliation, escalation board; financial approval + external action tracking + verification.
**Exit:** simulated missed acknowledgment escalates once; approved refund cannot be labeled completed without external proof and permission check.

## Phase 4 — Schedules, intelligence and QA
- Seven-agent roster, shifts/breaks/leave; reports/exports; case QA; branch trends and filters.
**Exit:** rosters flag coverage gaps, dashboards reconcile to DB, exports honor scope.

## Phase 5 — UAT, production hardening, rollout
- Security/privacy review, disaster recovery test, RTL/mobile/a11y, penetration testing, performance testing, change management.
- Pilot two Burger Waqf branches and seven agents; train branch managers and supervisors; shadow WhatsApp temporarily; progressively make CRM the official system of record.
- Onboard additional approved brands via admin workflow, without code duplication.
**Exit:** sign-off and monitored go-live with escalation fallback plan.

---

# 18. MANDATORY ACCEPTANCE TESTS

**Cross-scope security**
1. Branch manager A cannot search/list/view/export/download branch B tickets, attachments, PII or reports.
2. Brand A agent cannot manually select Brand B branch, even by forged IDs or endpoint params.
3. Group dashboard sees authorized aggregate only; admin does not automatically read all PII.
4. Customer cannot enumerate other tickets via case numbers; expired token cannot view photos.

**QR & uploads**
5. QR X always creates ticket on encoded branch even if posted body tries another branch.
6. QR revoked/rotated behaves safely, original attribution retained.
7. Mobile public intake accepts safe jpg/png/webp and rejects oversized/spoofed/malware content; EXIF/GPS stripped.
8. Duplicate submissions detected and rate-limited without silent deletion of valid P1 reports.

**Phone intake**
9. Agent enters ticket from separate call platform **without** PBX, order API or external call ID.
10. Agent can select branch/unknown branch, optional external order ID and customer search.
11. Follow-up phone call on QR ticket adds event while preserving original `PUBLIC_QR` source.
12. Ticket creation atomic: a DB failure cannot leave a ticket without its creation event or SLA timers.

**SLA & ownership**
13. Same priority/category QR and phone tickets use correct effective policy; difference in support hour is explicit and audited.
14. Reassignment does not silently reset due times; escalation once despite retries/worker restart.
15. Branch `ACKNOWLEDGED` separate from `ACTION_COMPLETED`; customer closure requires verified outcome and follow-up record.
16. Missing branch owner stays visible in unassigned queue, escalation occurs even on shift turnover.

**Refunds**
17. Wrong-branch order request follows approval -> authorized external action -> proof -> verification -> customer notice -> completion.
18. Agent cannot approve own request, unauthorized manager cannot mark external refund completed, missing proof blocks completion.
19. A pending Friday complaint remains aged and escalated; notifications cannot falsely report paid refund.

**Scheduling/reporting**
20. Shift coverage gaps and break overlap correctly highlighted; seven agents can have different authorized brand assignments.
21. Dashboard source totals reconcile to tickets; QR vs phone and P1/P2/P3 correctly segmented.
22. Report exports only contain permitted data and mask PII by default; export actions audited.

**Ops**
23. End-to-end Arabic RTL workflows on mobile and desktop, keyboard and screen reader checks.
24. `pnpm` tasks run on fresh clone; Docker local boot; green CI; staging migration; restore from backup; test reversible deploy path.
25. No actual phones, ordering, wallet or upselling execution inside CRM.

---

# 19. OPEN DECISIONS (DO NOT GUESS)

| ID | Decision owner | Required input | Default until approved |
|---|---|---|---|
| D01 | Group Operations | Verified brand and branch list | Only Burger Waqf pilot activation |
| D02 | Brand + Facilities | Each branch name/code/QR placement | Draft QR, not printed |
| D03 | Call-center Manager | Team hours, breaks, seven-agent contract and shifts | Configurable templates, no claimed real coverage |
| D04 | Ops + Safety | P1 on-call owner and after-hours coverage | No unverified 24/7 promise |
| D05 | Operations | P1/P2/P3 deadlines and escalation map | Proposed values marked draft |
| D06 | Finance + Operations | Refund thresholds/approval chain and external verifier | Request/approval implementation; policies disabled pending approval |
| D07 | Legal / DPO | Privacy notice, retention, legal basis, storage region | Staging only, no live customer collection |
| D08 | IT | Hosting/provider, staff identity, backups, domain | Local/staging setup first |
| D09 | IT / Communications | Optional SMS/email/OTP provider | In-app only; external notifications off |
| D10 | Group Brand Team | Official corporate logo and missing brand logos | Neutral placeholders for unapproved brands |

---

# 20. INSTRUCTIONS TO CODING AGENT

1. Read the full document and existing repository; create `/docs/IMPLEMENTATION_PLAN.md` with ordered milestones, dependencies, acceptance tests and ADRs.
2. Do not silently replace this specification with a scaffold or frontend-only prototype. Start with robust domain model and migrations, then prove phone intake workflow end-to-end.
3. Implement every feature with backend scope enforcement, coherent UI states, typed schemas, tests and error handling. Use mock providers only behind explicit interfaces; distinguish local demo from production.
4. Build small increments and run checks after each. Keep `README.md`, OpenAPI, environment reference, deployment/runbooks and migration guides current.
5. Never commit credentials/PII. Do not invent production branch data, refunds, transaction proofs or marketing KPIs. Seed realistic **clearly labeled synthetic** demo data only in dev.
6. Keep all CI checks green before calling a phase complete. Where an input requires business approval, implement configuration but mark it `PENDING_APPROVAL` and disable affected real-world promises/actions.
7. Record risks and any deviations in `docs/DECISIONS.md`; ask for approval on organizational decisions, do not guess financial or legal policy.
8. Deliver full working source tree, tests, Docker dev run, staging deploy instructions, admin setup and operator guides. Show a concise delivery summary listing what is functional, what is stubbed/disabled, test output, unresolved blockers and next tasks.

**Priority order: functional phone/QR complaint ticketing -> branch ownership -> SLA -> refund controls -> workforce -> analytics -> polish.**

---

## APPENDIX A — Suggested Arabic status labels
`NEW` جديد · `TRIAGED` قيد الفرز · `ASSIGNED` تم التوجيه · `ACKNOWLEDGED` تم استلام البلاغ · `IN_PROGRESS` جاري المعالجة · `RESOLVED` تمت المعالجة · `CLOSED` مغلق · `REOPENED` أعيد فتحه · `OVERDUE` متجاوز للمهلة · `AWAITING_APPROVAL` بانتظار الموافقة · `AWAITING_EXTERNAL_EXECUTION` بانتظار التنفيذ على النظام الخارجي · `VERIFIED` تم التحقق · `CUSTOMER_NOTIFIED` تم إبلاغ العميل.

## APPENDIX B — Sample agent phone intake script
> حياك الله، وأعتذر لك عن المشكلة. أبشر، بسجّل بلاغك الآن عشان نتابعه مع الفرع. ممكن تأكد لي الفرع ورقم الطلب إذا كان متوفر؟ ... تم تسجيل البلاغ برقم [رقم البلاغ]. راح نتابع مع الجهة المختصة ونتواصل معك حسب بيانات التواصل اللي سجلناها. 

Do not guarantee unapproved refund times or resolution times.

## APPENDIX C — Source/asset caveat
This specification reflects the user's provided brand logos and **two shared WhatsApp screenshots**, plus prior conversations on the intended workflow. It is not a certified audit of company operations, legal brand ownership, phone infrastructure or actual refund status. Obtain authorized sign-off before enabling live complaint intake.
