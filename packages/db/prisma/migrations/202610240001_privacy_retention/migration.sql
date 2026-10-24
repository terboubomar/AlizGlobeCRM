-- Customer data requests and retention: a legal hold blocks erasure, and
-- erasedAt records when a case's personal data was removed.
ALTER TABLE "Ticket" ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Ticket" ADD COLUMN "erasedAt" TIMESTAMP(3);
CREATE INDEX "Ticket_state_closedAt_idx" ON "Ticket"("state", "closedAt");
-- An erased case stays erased: personal fields cannot be written again.
CREATE FUNCTION keep_erased() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."erasedAt" IS NOT NULL AND (
    NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt" OR
    NEW."customer" IS NOT NULL OR NEW."phoneHash" IS NOT NULL OR
    NEW."externalOrder" IS NOT NULL OR NEW."platform" IS NOT NULL OR
    NEW."receiptEncrypted" IS NOT NULL OR NEW."branchBrief" IS NOT NULL OR
    NEW."description" IS DISTINCT FROM OLD."description"
  ) THEN
    RAISE EXCEPTION 'Personal data of an erased case cannot be restored';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER erased_stays_erased BEFORE UPDATE ON "Ticket" FOR EACH ROW EXECUTE FUNCTION keep_erased();
