# Telegram staff notifications

## Flow

- A new QR or phone complaint queues an alert for each enabled, linked **SUPER_ADMIN**.
- The alert contains complaint number, brand, branch, Riyadh intake time, category, priority and source. Its button opens the actual complaint in the CRM, where the superadmin assigns it using the existing support-team permissions.
- A new assignment queues a private alert for the assigned support employee. Reassignments notify the new employee; obsolete queued notifications are cancelled at delivery. Reassigning to the same employee does not send another alert.
- Telegram does not grant CRM access. All complaint details and assignment actions require an authenticated CRM session and the existing role/scope permissions. Customer names, phones, full descriptions, internal notes, attachments and public customer tracking tokens are not sent to Telegram.

## Configure

1. Create your company bot using the official [@BotFather](https://t.me/BotFather). Store the token in the server environment as `TELEGRAM_BOT_TOKEN`; set `TELEGRAM_BOT_USERNAME` without `@`. Never put the token in source control, screenshots or chat.
2. Generate a random secret of at least 32 characters containing letters, numbers, `_` or `-`; store it as `TELEGRAM_WEBHOOK_SECRET`. Set `APP_ORIGIN` to the public HTTPS CRM origin.
3. Register the webhook at `https://YOUR_CRM/api/integrations/telegram/webhook` using Telegram's `setWebhook`, with that secret as `secret_token` and `allowed_updates: ["message"]`. Telegram sends the secret in `X-Telegram-Bot-Api-Secret-Token`; unsigned requests are rejected. Use `getMe` to verify the bot username matches, and `getWebhookInfo` to verify the configured URL and absence of errors. A configured environment alone does not prove the webhook is working.
4. Set `TELEGRAM_ENABLED=true` and restart the API and worker. Settings → تنبيهات تيليجرام shows configuration, notification counts and staff connection status.
5. Each person opens the top profile icon → **تنبيهات تيليجرام** → **ربط حسابي بتيليجرام**. Open the bot, press **Start**, return to the CRM and confirm the displayed Telegram identity. Links are one-time and expire after 10 minutes. The identity is not active until confirmed in the signed-in CRM. One private Telegram account can belong to one CRM user.
6. Superadmins can also link their own account in Settings. Both the superadmin and assigned employee must finish linking to receive their respective alerts.

Webhook registration can be performed from a trusted server using the environment variables, without printing the token:

```js
const response = await fetch(
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: new URL('/api/integrations/telegram/webhook', process.env.APP_ORIGIN).toString(),
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
    }),
  },
);
const result = await response.json();
if (!response.ok || !result.ok) throw new Error('Webhook registration failed');
```

## Delivery and privacy

- Notification creation shares the complaint/assignment transaction, with a unique key per event and recipient. No historical complaint backfill is performed. Unlinked users do not get a delayed backlog when they link later.
- The worker checks every 10 seconds. Jobs expire after 24 hours. A successful `sendMessage` marks **SENT**; Telegram does not provide customer-style read/delivery receipts for this flow.
- Only explicit rate-limit failures retry, at Telegram's `retry_after` interval, for at most 3 attempts. Timeouts, ambiguous success responses and server failures are marked **UNKNOWN** and not automatically resent. There is no exactly-once delivery guarantee across Telegram and the database.
- Account IDs and display labels are encrypted at rest. Tokens, message bodies and provider error bodies are not logged. Error codes are retained for diagnosis. Notifications exclude customer personal details and use `protect_content` and disabled link previews.
- Private chats only: group chats, forwarded commands and unrelated bot messages cannot link accounts. CRM confirmation prevents someone who obtains an unused link from silently changing the recipient.
- Delivery rechecks enabled state, current role, brand/branch scope, current assignment and the confirmed Telegram connection. Disconnection cancels queued alerts. Blocking the bot disables the connection on Telegram's explicit 403 response.
- There is a small unavoidable race if access is revoked after the worker's final authorization check while an external send is already in flight. Previously sent Telegram messages are not recalled.

## Verification

Automated tests use mock Telegram responses and transactions that always roll back. No real bot messages or persistent test complaints are needed. After connecting a real bot, test with accounts you own and a deliberately created test complaint, then verify the admin alert, assignment alert and role checks.

Official references: [Bot API](https://core.telegram.org/bots/api#sendmessage), [webhook registration](https://core.telegram.org/bots/api#setwebhook), [account-link deep links](https://core.telegram.org/bots/features#deep-linking).
