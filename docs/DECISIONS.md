# Implementation decisions and pending inputs

## Decisions used for this local pilot

- Repository work in the user's empty workspace; no hosted-site plugin or public deployment. The presentation informs workflow/design but its simulated interactions were not copied as a database.
- Next.js 16.4.2, NestJS 11, Prisma 6.19/PostgreSQL, BullMQ, React and TypeScript. Prisma 6 is pinned and tested rather than adopting an untested major ORM migration. Vulnerable transitive ORM CLI dependencies are patched through npm overrides; sharp is patched to 0.35.5.
- Hand-authored accessible native form controls and HTML dialog, Lucide icons, custom CSS design tokens. Tailwind, shadcn, React Hook Form and 21st registry components were not needed for this first working pilot and were not silently claimed installed.
- Native private filesystem images for this local environment, not a pretend S3 integration. Production object-storage adapter is outstanding. Demo images have `CLEAN_DEMO`, which is never accepted when DEMO_MODE is off.
- Conservative PII access: complaint narrative and contact fields are available only to PII-authorized staff. Other roles see category/state/owners and permitted own notes. A dedicated staff-authored branch brief is now required on assignment, with phone/email/known-name checks, while original narratives and contacts retain PII authorization. Production privacy review remains required. No blanket expansion of narrative access was made.
- All five supplied restaurant identities are visible in demo. Burger Waqf is the only brand seeded ACTIVE; the others remain DRAFT. Demo-only branches across those brands are visibly synthetic and enabled only for local workflow testing.
- A local PostgreSQL instance under `/tmp/aliz-crm-pg` was used because the existing Docker keychain helper cancelled image pulls. No existing Docker credentials or other databases were modified. This database path is temporary; back it up before deleting temporary files if you want to preserve trial records.
- `WORKER_MODE=local` is a demo-only fallback; BullMQ is the normal deployment path and was not tested against a running Redis in this session.
- No phone system, ordering API, wallet, payment, outbound SMS, WhatsApp, or email integration was added.

## Business decisions

| ID  | Owner                    | Required before live rollout                                       | Current state                                   |
| --- | ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| D01 | Group operations         | Verified brand and branch directory                                | Pending; demo branches only                     |
| D02 | Facilities               | Branch names/codes and QR placements                               | Pending; local draft posters only               |
| D03 | Call-center manager / HR | Seven real agents, hours, break/rest rules, minimum coverage       | Pending; synthetic roster                       |
| D04 | Safety and operations    | P1 incident owner and staffed after-hours process                  | Pending; no 24/7 promise                        |
| D05 | Operations               | Approved SLA versions, business calendars and escalation map       | Proposed demo wall-clock values only            |
| D06 | Finance                  | Approval limits, finance scope, processor and independent verifier | Production decisions disabled                   |
| D07 | Legal / privacy officer  | Approved privacy notice, retention, region and rights workflows    | Live intake disabled                            |
| D08 | IT                       | Staff IdP, MFA claims, hosting/domain, backup/RPO/RTO              | No production credentials or deployment         |
| D09 | Communications           | Approved SMS/email/OTP provider                                    | External messages disabled                      |
| D10 | Marketing                | Formal brand names and corporate identity approval                 | Original supplied assets used; no logo invented |

## Approval-review event

Automatic approval review rejected an attempted removal of broad complaint-narrative redaction. The change was not applied. The implementation retained the existing role-restricted narrative/contact display and additionally restricts other staff members' free-text notes. No approval is required to try the local system with synthetic records. Future changes to actual PII visibility require a concrete, reviewed scope design.
