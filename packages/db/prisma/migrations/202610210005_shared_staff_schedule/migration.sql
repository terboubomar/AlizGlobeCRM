ALTER TABLE "Shift" ALTER COLUMN "brandId" DROP NOT NULL, ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "cancelledAt" TIMESTAMP(3);
UPDATE "Shift" SET "brandId" = NULL;
CREATE INDEX "Shift_userId_start_end_idx" ON "Shift" ("userId", "start", "end");
