---
name: db-migration
description: How to change the PostgreSQL schema in packages/db safely. Use whenever editing packages/db/prisma/schema.prisma, adding a migration, adding a table/column/index/constraint/trigger, or changing packages/db/seed.ts.
---

# Database schema changes

Stack: Prisma 6.19 (pinned — do not upgrade casually), PostgreSQL 17. Schema: `packages/db/prisma/schema.prisma`. Migrations: `packages/db/prisma/migrations/<YYYYMMDDNNNN>_<snake_name>/migration.sql`. Deploy uses `prisma migrate deploy` (`npm run db:migrate`), so every change must be a committed SQL migration.

## Steps

1. Edit `schema.prisma`.
2. Create the next folder. Name = date + 4-digit counter for that day + short name, sorting after the latest one (check `ls packages/db/prisma/migrations`), e.g. `202610240001_ticket_tags`.
3. Generate the SQL against a database already at the current head:
   ```sh
   npx prisma migrate diff \
     --from-schema-datasource packages/db/prisma/schema.prisma \
     --to-schema-datamodel packages/db/prisma/schema.prisma \
     --script > packages/db/prisma/migrations/<folder>/migration.sql
   ```
   (Run `npm run db:migrate` first so the datasource is at head.) Then hand-edit the SQL: add CHECK constraints, triggers, backfills, partial indexes — Prisma cannot express those.
4. `npm run db:generate && npm run db:migrate` and confirm it applies cleanly.
5. Update `packages/db/seed.ts` if seeded data needs the new field. The seed must stay idempotent (`upsert`) and refuse to run unless `DEMO_MODE=true` and not production.
6. Run the `verify` skill, including `npm run test:integration`.

## Rules

- **Never edit an existing migration folder.** It may already be applied somewhere. Fix forward with a new migration.
- **Append-only history.** `Event`, `Audit` and `RefundEvent` have `BEFORE UPDATE OR DELETE` triggers (`prevent_history_mutation`), and `Ticket` intake attribution is protected by `preserve_intake`. Do not drop or weaken these. Corrections are new rows, not updates.
- New status/role/duty columns get a SQL `CHECK` constraint with the allowed values (see `valid_finance_duty` in `202610220003_review_fixes`), mirrored in `packages/domain/src`.
- Adding a NOT NULL column to an existing table needs a `DEFAULT` or a backfill in the same migration.
- Customer contact data (names, phones, emails) is stored encrypted via `encrypt()` from `apps/api/src/crypto.ts`; phone lookups use the keyed `phoneHash()` column. Never add a plaintext PII column. See the `security-guardrails` skill.
- Brand/branch integrity uses the composite `@@unique([id, brandId])` relation — keep branch FKs composite so a ticket's branch cannot belong to another brand.
- Destructive changes (dropping columns/tables, narrowing types) need the user's explicit OK first.
