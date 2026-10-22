ALTER TABLE "Ticket" ADD COLUMN "receiptEncrypted" TEXT;
CREATE TABLE "ComplaintConfirmation" (
 "id" TEXT NOT NULL, "ticketId" TEXT NOT NULL, "payloadEncrypted" TEXT NOT NULL, "recipientHash" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'QUEUED', "attempts" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "claimedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
 "providerMessageId" TEXT, "lastError" TEXT, "deliveredAt" TIMESTAMP(3), "readAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ComplaintConfirmation_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "ComplaintConfirmation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ComplaintConfirmation_ticketId_key" ON "ComplaintConfirmation"("ticketId");
CREATE UNIQUE INDEX "ComplaintConfirmation_providerMessageId_key" ON "ComplaintConfirmation"("providerMessageId");
CREATE INDEX "ComplaintConfirmation_status_nextAttemptAt_idx" ON "ComplaintConfirmation"("status","nextAttemptAt");
CREATE INDEX "ComplaintConfirmation_recipientHash_createdAt_idx" ON "ComplaintConfirmation"("recipientHash","createdAt");
