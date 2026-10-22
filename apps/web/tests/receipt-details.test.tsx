import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReceiptDetails, confirmationLabels } from '../app/receipt-details';
test('receipt shows all submitted details and escapes customer input', () => {
  const html = renderToStaticMarkup(
    <ReceiptDetails
      receipt={{
        number: 'AG-2026-1',
        brand: 'واقف',
        branch: 'الرياض',
        receivedAt: '2026-10-22T09:00:00Z',
        category: 'تأخر الطلب',
        description: '<script>private</script>',
        customerName: 'عميل',
        externalOrder: 'ORDER-123',
        platform: 'استلام',
        source: 'QR',
        trackingPath: '/track/private-token',
      }}
    />,
  );
  assert.ok(html.includes('ORDER-123'));
  assert.ok(html.includes('الرياض'));
  assert.ok(html.includes('حفظ التأكيد'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.doesNotMatch(html, /[٠-٩]/);
  assert.notEqual(confirmationLabels.ACCEPTED, confirmationLabels.DELIVERED);
});
