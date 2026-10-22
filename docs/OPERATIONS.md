# Operator guide

## Local demo roles

Open the app and select a demo user. Settings allows switching the current demo role. These are local test identities, not production credentials.

- **مشرف التجربة**: create/triage/assign/contact/close cases; follow-ups and QA.
- **موظف تجريبي 1–7**: phone intake, contact notes and follow-ups within assigned brands; no financial approval.
- **مدير الفرع التجريبي**: only Burger Waqf branch A; acknowledge, investigate and document branch corrective action. Contact details and full customer narrative remain hidden.
- **الموافق المالي التجريبي**: review and approve/reject another user's refund request.
- **مسؤول التنفيذ التجريبي**: record externally performed action with reference and proof; cannot approve it.
- **المتحقق المالي التجريبي**: independent evidence verification.
- **مسؤول النظام التجريبي**: branch/QR and audit administration; no default customer-data or finance permissions.
- **مسؤول الجدولة التجريبي**: roster/leave administration.
- **مدير العمليات التجريبي**: aggregated reports and masked export.

## Phone complaint

Choose **تسجيل شكوى هاتفية**. Select brand and branch (or unknown-branch reason), issue, priority and a description. Customer name/phone/order number are optional. Save to obtain the case number. The phone/order applications remain separate.

A supervisor opens the case and chooses **توجيه للفرع**, supplies the branch, communications owner, a non-personal operational brief for the branch, and the action note. The branch role acknowledges, starts investigation and records corrective action in separate steps. The communications owner records the customer contact attempt. The contact owner explicitly records the customer’s confirmation after the corrective action and follow-up attempt. A supervisor closes only after that confirmation and after any linked financial requests complete or are rejected. Reopening appends history.

Do not enter real personal data in this demo.

## QR complaint

Switch to the administrator, open **رموز الفروع QR**, select a branch and **إدارة QR**. Choose a placement and generate. Save the PNG or use the print poster, and open the preview form. The original secret URL is shown only when created; the database stores a hash. Generate a new code if it is lost. Rotating/revoking invalidates the old link while preserving ticket history.

On the form, provide synthetic issue details and up to three test images. On submission, save the private tracking link. The status link shows only a case number/state/creation time, without contact data or images. Without an approved OTP service, sensitive retrieval/recovery is unavailable.

## Financial tracking

Open the independent **الاسترجاع والإلغاء** section. An agent records the brand, branch, external order/platform and optional verified amount. Linking an existing complaint is optional; a standalone refund never creates a complaint. A different finance approver reviews and approves. The processor uses the external platform outside this CRM, uploads proof to the case and records the external reference. An independent verifier checks the evidence. The processor records customer notification and then completes. The CRM never performs a financial transaction.

## Follow-ups, shifts, reports

Add a due task and owner from the case's follow-up tab; complete it from the task queue. In Workforce, select the scheduler role, add shifts/breaks, and approve/reject leave. Conflict detection rejects overlapping shifts and approved leave. No coverage assumption is implied when no operating hours are configured.

The Reports page filters by brand and shows source/category counts. CSV exports exclude contacts and narratives and respect server scope. All dates display Asia/Riyadh; CSV timestamps explicitly use UTC. Reports currently reflect loaded pilot records (up to 500); full date/branch/paged reports remain outstanding.

## Backup local trial data

Native PostgreSQL on the delivery machine is at `127.0.0.1:54329`, database/user `aliz`; its isolated data directory is `/tmp/aliz-crm-pg`. A local `.env` contains demo encryption keys: preserve it securely with an encrypted database backup or the encrypted narratives cannot be read after a reset. Never reuse those example keys in production.

```sh
pg_dump -h 127.0.0.1 -p 54329 -U aliz -Fc aliz > aliz-demo.dump
# Stop this isolated native instance only when done using the app:
pg_ctl -D /tmp/aliz-crm-pg stop
```

Keep private `apps/api/.data/uploads/` with backups when running the npm development server (the Compose image uses `/app/.data/uploads/`). Do not commit dumps, `.env`, uploads or customer data. Restore into a separate empty database and verify before replacing any instance. A production restore rehearsal has not been performed.

## Complaint workflow workspace

**الشكاوى** opens a five-stage work board: intake, routing, processing, customer follow-up, closed. Cards expose branch name, brand, QR/phone source, receipt time, elapsed age, accountable owner, deadline and next action. Filter by source, branch, assignee/unassigned or overdue; use **السجل والتوقيت** for a timestamped register. Opening a card shows actual milestone timestamps and role-guided actions. Status changes are saved through the API; the board is not a simulated presentation.

## Brand and branch directory

The administrator uses **العلامات والفروع** to create/edit brands, create a branch with a selected parent brand, and edit/relink an unused branch. Official supplied logos remain available; new identities can use a clearly neutral placeholder. A branch with historical complaints, refunds or QR codes cannot be reassigned to another brand. Create a new branch under the destination brand to preserve history. Creating a brand adds it only to the creating administrator’s configuration scope; staff membership is not silently widened.
