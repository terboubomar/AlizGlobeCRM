import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { templatePayload, validWhatsAppSignature, whatsappConfig } from '../apps/api/src/whatsapp';
import { receiptText, ComplaintReceipt } from '../packages/domain/src/complaint-receipt';
const receipt: ComplaintReceipt = {
  number: 'AG-2026-123456',
  brand: 'واقف',
  branch: 'فرع الرياض',
  receivedAt: '2026-10-22T09:00:00Z',
  category: 'تأخر الطلب',
  description: 'تفاصيل خاصة بالعميل فقط',
  customerName: 'عميل تجريبي',
  externalOrder: 'ORDER-123',
  platform: 'استلام',
  source: 'QR',
  trackingPath: '/track/synthetic-token',
};
test('confirmation template includes named fields and private tracking link without phone in body', () => {
  const old = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = 'https://crm.example.test';
  try {
    const payload = templatePayload('confirmation-id', '966500000001', receipt);
    assert.equal(payload.to, '966500000001');
    assert.equal(payload.biz_opaque_callback_data, 'confirmation-id');
    const fields = Object.fromEntries(
      payload.template.components[0].parameters.map((p) => [p.parameter_name, p.text]),
    );
    assert.equal(fields.number, receipt.number);
    assert.equal(fields.branch, receipt.branch);
    assert.equal(fields.tracking_url, 'https://crm.example.test/track/synthetic-token');
    assert.ok(!JSON.stringify(fields).includes('966500000001'));
    assert.ok(!/[٠-٩]/.test(fields.received_at));
    const full = receiptText(receipt, 'https://crm.example.test');
    assert.ok(full.includes(receipt.description));
    assert.ok(full.includes(receipt.externalOrder));
    assert.ok(!full.includes('SYSTEM'));
  } finally {
    if (old === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = old;
  }
});
test('webhook signatures require matching exact raw body and configured secret', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}'),
    secret = 'synthetic-secret';
  const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(validWhatsAppSignature(raw, signature, secret), true);
  assert.equal(validWhatsAppSignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(validWhatsAppSignature(raw, signature, ''), false);
  assert.equal(validWhatsAppSignature(raw, 'invalid', secret), false);
});
test('unconnected or disabled WhatsApp never reports itself as ready', () => {
  const old = process.env.WHATSAPP_ENABLED;
  process.env.WHATSAPP_ENABLED = 'false';
  try {
    assert.equal(whatsappConfig().ready, false);
  } finally {
    if (old === undefined) delete process.env.WHATSAPP_ENABLED;
    else process.env.WHATSAPP_ENABLED = old;
  }
});
