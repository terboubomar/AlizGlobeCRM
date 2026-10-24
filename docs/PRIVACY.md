# Customer data requests and retention

Tools for answering "send me my data" and "delete my data" requests, legal holds, and automatic retention. Every action is written to the audit log. The retention period itself is a decision for Legal (D07 in [DECISIONS.md](DECISIONS.md)); until it is set, retention stays off.

## What erasing does

Erasing a case removes everything that identifies or describes the customer and keeps the anonymous record (brand, branch, category, source, priority, state and timestamps) so reports stay correct.

| Removed or blanked                                       | Kept                                                |
| -------------------------------------------------------- | --------------------------------------------------- |
| Complaint description, name and phone, phone lookup hash | Brand, branch, category, source, priority, state    |
| Order number, platform, receipt, branch brief            | Received, acknowledged, closed and other timestamps |
| Follow-up task notes and QA review notes                 | Case number, owners, timeline steps                 |
| Private tracking links (the link stops working)          | Audit log entries                                   |
| WhatsApp confirmation payload and recipient              | Refund records (financial evidence)                 |
| Photo files (deleted from storage; record marked erased) | Staff timeline notes (see below)                    |
| Cached retry responses for the original request          |                                                     |

A database trigger stops anyone writing personal data back into an erased case.

Erasing is refused, and reported as skipped, when the case is on **legal hold** or has a **refund still in progress**. Finish or reject the refund first.

**Staff timeline notes are kept.** The timeline is append-only by design so nobody can rewrite case history. Its notes are written by staff, encrypted, and visible only to staff with customer-data access. If Legal requires those notes to be erased too, that needs a reviewed change to the history protection.

## Commands

Run on a trusted server with the production environment loaded. Set `PRIVACY_OPERATOR` to your name so the audit log shows who acted.

```sh
npm run privacy -- export --phone 05XXXXXXXX          # JSON copy of the customer's cases
npm run privacy -- export --case AG-2026-000123
npm run privacy -- erase --phone 05XXXXXXXX           # lists how many cases would be erased
npm run privacy -- erase --phone 05XXXXXXXX --confirm # erases them
npm run privacy -- hold --case AG-2026-000123 on      # legal hold; "off" releases it
npm run privacy -- retention                          # lists closed cases due for retention
npm run privacy -- retention --confirm                # erases them now
```

With Docker Compose, run them in the toolchain container, which mounts the photo volume:

```sh
docker compose --profile app run --rm setup npm run privacy -- export --case AG-2026-000123
```

Verify the requester's identity before exporting or erasing. The export contains personal data; send it only through an approved channel.

## Automatic retention

Set `RETENTION_CLOSED_CASE_DAYS` (whole days, at least 30) to erase closed cases that many days after they closed. The worker runs the sweep once a day. Cases on legal hold are never included. In production the worker also requires `RETENTION_POLICY_APPROVED=true`, set once Legal has approved the period; without it the worker refuses to start. Leave `RETENTION_CLOSED_CASE_DAYS` empty to keep retention off.

Run `npm run privacy -- retention` first to see how many cases the period would affect.
