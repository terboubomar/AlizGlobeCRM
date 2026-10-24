import { test, expect, type Page } from '@playwright/test';

async function signIn(page: Page, email: string) {
  expect(
    process.env.TEST_WEB_ORIGIN,
    'Run browser checks through the isolated harness',
  ).toBeTruthy();
  await page.goto('/');
  await page.getByRole('textbox', { name: 'البريد الإلكتروني', exact: true }).fill(email);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(process.env.TEST_LOGIN_PASSWORD!);
  await page.getByRole('button', { name: 'الدخول إلى مساحة العمل', exact: true }).click();
  await expect(page.getByRole('button', { name: 'قائمة الحساب', exact: true })).toBeVisible();
}
async function fits(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
}
// DESIGN.md: 44×44px touch targets and 12px minimum text. Table cells and the
// dev-only Next.js overlay are excluded.
async function readable(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea')) {
      if (!visible(el) || el.closest('td, nextjs-portal, label')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44)
        out.push(
          `target ${el.getAttribute('aria-label') ?? el.textContent?.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
    }
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || el.closest('nextjs-portal, .sr-only')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (own && parseFloat(getComputedStyle(el).fontSize) < 12)
        out.push(`text ${el.textContent?.trim().slice(0, 20)} ${getComputedStyle(el).fontSize}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
}
test('password sign-in, phone complaint persistence, and top-profile logout', async ({ page }) => {
  await signIn(page, 'lead@example.invalid');
  await page.getByRole('button', { name: 'تسجيل شكوى هاتفية', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('combobox', { name: 'العلامة التجارية', exact: true })
    .selectOption('waqf');
  await dialog.getByRole('combobox', { name: 'الفرع', exact: true }).selectOption('demo-waqf-1');
  const detail = 'حالة اختبار متصفح اصطناعية للتحقق من حفظ شكوى هاتفية.';
  await dialog.getByRole('textbox', { name: 'تفاصيل المشكلة', exact: true }).fill(detail);
  await dialog.getByRole('button', { name: 'تسجيل الشكوى', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName(/^AG-/);
  const number = await page
    .getByRole('dialog')
    .getByRole('heading', { level: 2, name: /^AG-/ })
    .innerText();
  await expect(page.getByRole('dialog').getByText(detail, { exact: true })).toBeVisible();
  await fits(page);
  await page.getByRole('dialog').getByRole('button', { name: 'إغلاق', exact: true }).click();
  await page.goto('/?view=tickets');
  await expect(page.getByText(number, { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'قائمة الحساب', exact: true }).click();
  await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول', exact: true })).toBeVisible();
  expect((await page.request.get('/api/session')).status()).toBe(401);
});
test('manager overview with cases in scope fits the screen', async ({ page }) => {
  await signIn(page, 'lead@example.invalid');
  const created = await page.request.post('/api/tickets/phone', {
    headers: { 'idempotency-key': `browser-fit-${Date.now()}-${Math.random()}` },
    data: {
      brandId: 'waqf',
      branchId: 'demo-waqf-1',
      category: 'DELAY',
      priority: 'P2',
      description: 'حالة اختبار متصفح اصطناعية لعرض قائمة الأولوية.',
    },
  });
  expect(created.ok()).toBeTruthy();
  await page.context().clearCookies();
  await signIn(page, 'support-manager@example.invalid');
  // The priority table holds a visually hidden header label; it must stay inside the
  // table's scroll box instead of widening the page on phones.
  await expect(page.locator('.priority-panel table')).toBeVisible();
  await fits(page);
  await readable(page);
});
test('QR complaint is branch-bound and private tracking contains the customer receipt', async ({
  page,
}) => {
  await signIn(page, 'admin@example.invalid');
  const qr = await page.request.post('/api/qrs', { data: { branchId: 'demo-waqf-1' } });
  expect(qr.ok()).toBeTruthy();
  const { url } = await qr.json();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'كيف نقدر نساعدك؟', exact: true })).toBeVisible();
  const detail = 'بلاغ اختبار متصفح اصطناعي للعميل عبر رمز الفرع.';
  await page.getByRole('textbox', { name: 'شاركنا تفاصيل المشكلة', exact: true }).fill(detail);
  await page.getByRole('checkbox').check();
  await fits(page);
  await readable(page);
  await page.getByRole('button', { name: 'إرسال البلاغ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'تم استلام بلاغك', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'متابعة حالة البلاغ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'استقبال الشكوى', exact: true })).toBeVisible();
  await expect(page.getByText(detail, { exact: true })).toBeVisible();
  await expect(page.getByText('فرع تجريبي أ', { exact: true })).toBeVisible();
  await fits(page);
});
test('superadmin settings and finance duties remain available on every screen size', async ({
  page,
}, info) => {
  await signIn(page, 'root@example.invalid');
  await page.goto('/?view=settings');
  await page.getByRole('tab', { name: 'التكاملات', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'تأكيد الشكاوى عبر واتساب', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'تيليجرام تنبيهات المسؤول والفريق', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'تنبيهات تيليجرام', exact: true })).toBeVisible();
  await fits(page);
  if (info.project.name === 'desktop')
    await page.screenshot({ path: 'output/review-fixes-settings.png', fullPage: true });
  await page.goto('/?view=users');
  await page.getByRole('button', { name: 'إضافة مستخدم', exact: true }).click();
  const duty = page.getByRole('combobox', { name: 'المهمة المالية', exact: true });
  await expect(duty).toBeVisible();
  await duty.selectOption('PROCESSOR');
  await expect(duty).toHaveValue('PROCESSOR');
  if (info.project.name === 'desktop')
    await page.screenshot({ path: 'output/review-finance-duty.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'إغلاق', exact: true }).click();
  await fits(page);
});
