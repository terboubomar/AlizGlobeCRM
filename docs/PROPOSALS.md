# Proposed business decisions (for owner sign-off)

Drafted 2026-10-25 by engineering as consultant. Each proposal is ready to accept as written, or to change. Nothing here is switched on until the named owner approves it and the setting is applied in production. Facts only the business holds (real branches, staff, brand names) are not invented: those sections are templates.

## D04 — Urgent (P1) cases after hours · owner: Safety & operations

**Proposal**

- P1 means a food-safety, health or physical-safety report (category `SAFETY`, or any case a supervisor marks P1).
- One **on-call duty manager** per day, 24/7, on a weekly rota published in the Workforce page. A deputy covers when the duty manager does not acknowledge in 15 minutes.
- The CRM alerts the assigned supervisor and in-scope shift leads on Telegram for every urgent intake (already live). The duty manager links Telegram on day one of each rota.
- The duty manager calls the customer within 15 minutes, tells the branch manager to remove the affected product, and records both steps on the case.
- Any suspected illness or injury goes to the group food-safety lead the same day; regulator notification follows the group's existing SFDA procedure.

**To apply:** add the rota in Workforce; engineering adds the duty-manager role to urgent alerts once the rota exists.

## D05 — Response deadlines · owner: Operations

**Proposal** (wall-clock minutes; the app applies them per priority):

| Priority                        | First customer contact | Branch acknowledges | Branch remedy recorded |
| ------------------------------- | ---------------------- | ------------------- | ---------------------- |
| P1 urgent (safety)              | 15                     | 30                  | — (handled live)       |
| P2 high (wrong/missing order)   | 60                     | 120                 | 1440 (24 h)            |
| P3 normal (service, delay, etc) | 240                    | 480                 | 4320 (3 days)          |

- Warning at 80% of each deadline; breach alerts go to the owner and the supervisors covering the branch (already live).
- Escalation: breach → shift lead; second breach on the same case or any P1 breach → operations manager.
- Version this as `SLA-2026-11-V1`. Business-hours calendars come in a later version once branch opening hours are confirmed (D01).

**To apply:** `SLA_POLICY_VERSION=SLA-2026-11-V1`, `SLA_P1_FIRST_MINUTES=15`, `SLA_P1_ACK_MINUTES=30`, `SLA_P2_FIRST_MINUTES=60`, `SLA_P2_ACK_MINUTES=120`, `SLA_P2_REMEDY_MINUTES=1440`, `SLA_P3_FIRST_MINUTES=240`, `SLA_P3_ACK_MINUTES=480`, `SLA_P3_REMEDY_MINUTES=4320`, then `SLA_POLICY_APPROVED=true`.

## D06 — Refunds and cancellations · owner: Finance

**Proposal**

- Every refund has four different people: requester (support), approver (finance), processor (does it on the ordering platform), verifier (checks the proof). The app already blocks anyone holding two of these roles on one request.
- Approval limit per approver: **SAR 500** per request. Larger refunds are refused in the CRM and go through Finance's existing approval outside it.
- Approvers: two named people in Finance; processors: the platform-operations team; verifier: one named person in internal audit or Finance control, not in the approvers' line.
- Proof required for every completed refund: the platform's refund reference and a screenshot or statement line.

**To apply:** `FINANCE_APPROVAL_LIMIT_MINOR=50000` (halalas), assign the roles to named users, then `FINANCE_POLICY_APPROVED=true`.

## D07 — Privacy notice, retention and data requests · owner: Legal / privacy officer

**Proposal**

- **Region:** all customer data stays in Saudi Arabia (see `docs/IT_PLAN.md`); no transfer abroad.
- **Retention:** a closed case's personal data (name, phone, description, photos) is erased **2 years** after closure. The anonymous record (brand, branch, category, dates) stays for statistics. Cases on legal hold or with an open refund are never erased. Legal to confirm whether refund evidence must be kept longer for accounting purposes.
- **Requests:** the privacy officer handles see-my-data and delete-my-data requests with `npm run privacy` and replies within 30 days, after confirming the requester controls the phone number.
- **Notice on the QR form** (Arabic, to approve):

  > نستخدم بياناتك (الاسم ورقم الجوال وتفاصيل الشكوى والصور) لمعالجة شكواك والتواصل معك بشأنها فقط. تُحفظ بياناتك داخل المملكة العربية السعودية، ويطّلع عليها الموظفون المختصون فقط، وتُحذف بعد سنتين من إغلاق الشكوى. يمكنك طلب الاطلاع على بياناتك أو حذفها عبر التواصل مع خدمة العملاء.

**To apply:** `RETENTION_CLOSED_CASE_DAYS=730`, `RETENTION_POLICY_APPROVED=true`, publish the notice, then `PUBLIC_INTAKE_ENABLED=true`.

## D09 — Customer messages · owner: Communications

**Proposal**

- **WhatsApp** (Meta WhatsApp Business Platform) for complaint receipts, using the integration already built (`docs/WHATSAPP_CONFIRMATIONS.md`). One verified business number per group; message templates in Arabic, approved by Meta.
- **SMS** for one-time codes through a CST-licensed Saudi SMS provider, with a registered sender name. Selection by Communications and IT on price and delivery reports.
- No marketing messages from the CRM.

**To apply:** WhatsApp number and Meta business verification, template approval, then `WHATSAPP_ENABLED=true`.

## D01, D02, D03, D10 — facts the business provides

Templates to fill in; engineering imports them.

- **D01 branches:** brand, branch name (Arabic), branch code, city, opening hours, branch manager's work email.
- **D02 QR posters:** branch code, placement (counter, table, delivery bag insert), number of posters.
- **D03 agents:** name, work email, brands covered, shift pattern, minimum agents per hour.
- **D10 brands:** formal Arabic and English names, approved logo files (SVG).
