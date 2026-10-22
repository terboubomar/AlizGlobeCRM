CREATE FUNCTION prevent_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Operational history is append-only'; END;
$$;
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON "Event" FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON "Audit" FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
CREATE FUNCTION preserve_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."source" IS DISTINCT FROM OLD."source" OR NEW."creator" IS DISTINCT FROM OLD."creator" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."brandId" IS DISTINCT FROM OLD."brandId" THEN
 RAISE EXCEPTION 'Intake attribution is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_intake BEFORE UPDATE ON "Ticket" FOR EACH ROW EXECUTE FUNCTION preserve_intake();
ALTER TABLE "Ticket" ADD CONSTRAINT valid_source CHECK ("source" IN ('PHONE_AGENT','PUBLIC_QR'));
ALTER TABLE "Ticket" ADD CONSTRAINT valid_priority CHECK ("priority" IN ('P1','P2','P3'));
ALTER TABLE "Ticket" ADD CONSTRAINT valid_state CHECK ("state" IN ('NEW','TRIAGED','ASSIGNED','ACKNOWLEDGED','IN_PROGRESS','RESOLVED','CLOSED'));
ALTER TABLE "Refund" ADD CONSTRAINT positive_amount CHECK ("amountMinor" IS NULL OR "amountMinor" > 0);
ALTER TABLE "Shift" ADD CONSTRAINT valid_shift CHECK ("start" < "end");
ALTER TABLE "Shift" ADD CONSTRAINT valid_break CHECK (("breakStart" IS NULL AND "breakEnd" IS NULL) OR ("breakStart" >= "start" AND "breakEnd" <= "end" AND "breakStart" < "breakEnd"));
