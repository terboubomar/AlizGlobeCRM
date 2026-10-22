CREATE TABLE "TelegramConnection" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "accountEncrypted" TEXT,
  "chatHash" TEXT UNIQUE,
  "linkedAt" TIMESTAMP(3),
  "linkCodeHash" TEXT UNIQUE,
  "linkExpiresAt" TIMESTAMP(3),
  "pendingEncrypted" TEXT,
  "pendingHash" TEXT
);
CREATE TABLE "TelegramNotification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "ticketId" TEXT NOT NULL REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "connectionHash" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "messageId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TelegramNotification_status_nextAttemptAt_idx" ON "TelegramNotification"("status", "nextAttemptAt");
