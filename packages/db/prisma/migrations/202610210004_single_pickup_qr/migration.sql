-- Keep the newest reusable active code per branch and retain the rest as history.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "branchId" ORDER BY ("codeEncrypted" IS NOT NULL) DESC, "createdAt" DESC, "id" DESC
  ) AS position
  FROM "Qr" WHERE "active" = true
)
UPDATE "Qr" SET "active" = false, "revokedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);
UPDATE "Qr" SET "placement" = 'استلام الطلبات' WHERE "active" = true;
CREATE UNIQUE INDEX "Qr_one_active_per_branch" ON "Qr" ("branchId") WHERE "active" = true;
