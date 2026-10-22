import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ticket } from '@prisma/client';
import { telegramConfig, telegramMessage, validTelegramSecret } from '../apps/api/src/telegram';
test('Telegram alerts contain operational metadata and an authenticated CRM link, without customer data', () => {
  const before = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://crm.example.test';
  try {
    const ticket = {
      id: 'synthetic-id',
      sequence: 123,
      createdAt: new Date('2026-10-22T09:00:00Z'),
      receivedAt: new Date('2026-10-22T09:00:00Z'),
      brand: { name: 'واقف' },
      branch: { name: 'الرياض' },
      category: 'SERVICE',
      priority: 'P2',
      source: 'PUBLIC_QR',
      description: 'private description',
      customer: 'private customer',
      receiptEncrypted: 'private receipt',
    } as unknown as Ticket & { brand: { name: string }; branch: { name: string } };
    const payload = telegramMessage(ticket, 'NEW_COMPLAINT', '1234');
    const json = JSON.stringify(payload);
    assert.ok(payload.text.includes('AG-2026-000123'));
    assert.ok(payload.text.includes('واقف'));
    assert.ok(payload.text.includes('الرياض'));
    assert.ok(!json.includes('private'));
    assert.ok(!json.includes('/track/'));
    assert.ok(!/[٠-٩]/.test(json));
    assert.equal('parse_mode' in payload, false); // plain text: brand names cannot inject Telegram markup
    assert.equal(payload.link_preview_options.is_disabled, true);
    const url = new URL(payload.reply_markup.inline_keyboard[0][0].url);
    assert.equal(url.searchParams.get('ticket'), ticket.id);
  } finally {
    if (before === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = before;
  }
});
test('Telegram configuration fails closed and webhook secrets must match exactly', () => {
  const before = process.env.TELEGRAM_WEBHOOK_SECRET,
    enabled = process.env.TELEGRAM_ENABLED;
  try {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret-with-at-least-32-characters';
    process.env.TELEGRAM_ENABLED = 'false';
    assert.equal(telegramConfig().ready, false);
    assert.equal(validTelegramSecret(process.env.TELEGRAM_WEBHOOK_SECRET), true);
    assert.equal(validTelegramSecret('wrong'), false);
    assert.equal(validTelegramSecret(process.env.TELEGRAM_WEBHOOK_SECRET + ' '), false);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    assert.equal(validTelegramSecret(''), false);
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = before;
    if (enabled === undefined) delete process.env.TELEGRAM_ENABLED;
    else process.env.TELEGRAM_ENABLED = enabled;
  }
});
