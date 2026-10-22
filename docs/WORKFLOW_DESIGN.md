# Complaint workflow design

The goal is a focused restaurant complaint operation: **customer QR intake and agent-recorded phone complaints, feeding the same case service**. No dialing, order handling, payment execution or additional complaint channel was introduced.

## Market patterns adapted

- [Zendesk’s official ticket lifecycle](https://support.zendesk.com/hc/en-us/articles/8263915942938-About-the-ticket-lifecycle-and-ticket-statuses) distinguishes new/open work, waiting states, solution and final closure. We adopt the resolution-versus-closure distinction. We do not copy its automatic closure intervals: those are product/business rules rather than universally appropriate restaurant policy.
- [Salesforce’s official case-management guide](https://trailhead.salesforce.com/content/learn/modules/service_lex/service_lex_case_manage) describes queues, assignment and escalation. We adopt actionable queues, named ownership and deadline visibility. Actual notification recipients and approved escalation calendars remain organizational decisions.

These are established reference patterns, not a claim that one vendor or this implementation is objectively the “best CRM.” The adaptation prioritizes Aliz Globe’s actual two-channel workflow.

## Operational flow

The visible order is exactly **استقبال الشكوى → الإسناد → جارٍ العمل → التواصل مع العميل → تم الحل**.

1. **Receive:** QR intake identifies the brand and branch; phone intake records the same context. The branch is complaint information, never an assignment target.
2. **Assign:** a support team lead or customer service manager selects one support person. The same person handles the complaint and customer communication. Assignment cannot alter the branch and cannot target branch, area or operations managers.
3. **Work:** the support assignee starts work and records the operational action before moving to customer contact. This does not mark the complaint finally solved.
4. **Customer contact:** support records the actual outcome. Unreachable remains here for another attempt. An unresolved issue routes to a named support supervisor, area manager or operations manager. A dedicated nonpersonal escalation brief preserves the separation from restricted customer narrative and contact details.
5. **Solved:** customer confirmation and completion of linked financial work allow final closure. Pending financial work stays in Customer contact, with the confirmation preserved.

Area and operations managers can act only on escalated cases explicitly assigned to them within their brand/branch scope. They cannot perform routine support assignment or customer closure. Once they document the action, the original support owner handles customer follow-up. Branch managers have no complaint work or assignment permission. The CRM records routed escalation and history; external notification delivery is not implied.

The existing internal RESOLVED status means ready for customer contact; only CLOSED is displayed as تم الحل. Historical branch-owned active records are shown as awaiting support assignment, preserving their original history until a support lead assigns them. Existing privacy restrictions and append-only history remain intact.

## Separate financial workspace

Refund/cancellation requests have their own RF identifier, brand/branch scope, external order context, evidence and append-only timeline. An optional complaint link supports traceability; it is not required to submit a financial request. They do not appear as an editing tab inside complaint detail. Approval, external execution, independent verification, customer notification and completion stay separate. Existing linked financial records were migrated, not deleted.

## Directory integrity

Support leads, customer-service managers and system administrators can create/edit brands through brands.manage. Support leads, customer-service managers and administrators can add a branch under a selected brand or manage its link through a separate branches.manage permission. The directory offers a global add button and a per-brand shortcut with the brand preselected. A branch with no operational history can be reassigned. Once there is complaint, refund or QR history, reassignment is rejected to preserve original attribution. Staff scope is checked for both the existing and destination brand; creating a brand does not automatically grant all staff access to it.

Directory entries can be permanently deleted only when unused, with name confirmation and an audit event. Existing complaints, refunds, QR records and other operational history block deletion. Branch codes are editable, with uniqueness enforced.
