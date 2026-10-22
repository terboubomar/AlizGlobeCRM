import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefundWorkspace } from '../app/refund-workspace';
import type { Data } from '../app/types';

function render(refunds: unknown) {
  const data = { permissions: [], refunds } as unknown as Data;
  return renderToStaticMarkup(
    <RefundWorkspace
      data={data}
      brand="all"
      busy={false}
      mutate={async () => undefined}
      reload={async () => undefined}
      onComplaint={() => undefined}
    />,
  );
}

test('legacy bootstrap without refunds renders recovery instead of crashing or claiming no requests', () => {
  for (const value of [undefined, null, {}]) {
    const html = render(value);
    assert.match(html, /إعادة تحميل الطلبات المالية/);
    assert.doesNotMatch(html, /لا توجد طلبات مالية مطابقة/);
  }
});

test('a loaded empty refund list renders the normal financial workspace', () => {
  const html = render([]);
  assert.match(html, /مساحة الاسترجاع والإلغاء/);
  assert.match(html, /لا توجد طلبات مالية مطابقة/);
  assert.doesNotMatch(html, /إعادة تحميل الطلبات المالية/);
});
