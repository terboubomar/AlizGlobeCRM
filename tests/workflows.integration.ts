import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db } from '../packages/db/client';
import { reconcile } from '../apps/worker/src/main';
const base = (process.env.TEST_API_ORIGIN ?? 'http://127.0.0.1:4000') + '/api/';
async function login(id: string) {
  const res = await fetch(base + 'demo-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  assert.equal(res.status, 201);
  return res.headers.get('set-cookie')!.split(';')[0];
}
async function req(cookie: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(base + path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      Cookie: cookie,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const input = {
  brandId: 'waqf',
  branchId: 'demo-waqf-1',
  category: 'DELAY',
  priority: 'P2',
  description: 'حالة اختبار آلي اصطناعية للتحقق من سير العمل دون بيانات شخصية',
  externalOrder: 'TEST-' + randomUUID(),
  platform: 'TEST',
};
test(
  'database-backed operational acceptance',
  { skip: process.env.LOCAL_PASSWORD_AUTH === 'true' },
  async (t) => {
    const lead = await login('lead'),
      agent = await login('agent-1'),
      branch = await login('branch'),
      admin = await login('admin'),
      finance = await login('finance'),
      processor = await login('processor'),
      verifier = await login('verifier'),
      scheduler = await login('scheduler');
    let id: string, version: number;
    await t.test('anonymous cannot access staff records', async () =>
      assert.equal((await req('', 'bootstrap')).status, 401),
    );
    await t.test('admin has no implicit ticket or PII read', async () => {
      const r = await req(admin, 'bootstrap');
      assert.equal(r.body.tickets.length, 0);
      assert.equal((await req(admin, 'customers/search', { phone: '0500000000' })).status, 403);
    });
    await t.test('phone creation is atomic and idempotent', async () => {
      const key = randomUUID();
      const first = await req(agent, 'tickets/phone', input, key);
      assert.equal(first.status, 201);
      id = first.body.id;
      const again = await req(agent, 'tickets/phone', input, key);
      assert.equal(again.body.id, id);
      const saved = await db.ticket.findUniqueOrThrow({
        where: { id },
        include: { events: true, timers: true },
      });
      assert.equal(saved.events.length, 1);
      assert.equal(saved.timers.length, 2);
      assert.equal(saved.source, 'PHONE_AGENT');
      assert.ok(!saved.description.includes('حالة'));
      assert.equal(
        (
          await req(
            agent,
            'tickets/phone',
            { ...input, description: 'محتوى مختلف للاختبار فقط' },
            key,
          )
        ).status,
        409,
      );
    });
    await t.test('forged branch from another brand rejected', async () => {
      assert.equal(
        (await req(agent, 'tickets/phone', { ...input, branchId: 'demo-kabab-1' }, randomUUID()))
          .status,
        400,
      );
    });
    await t.test('cross-branch reads and joins denied', async () => {
      const other = await req(
        agent,
        'tickets/phone',
        { ...input, branchId: 'demo-waqf-2' },
        randomUUID(),
      );
      assert.equal((await req(branch, 'tickets/' + other.body.id)).status, 404);
      const joined = await req(branch, 'bootstrap');
      assert.ok(
        joined.body.tickets.every((x: { branchId: string }) => x.branchId === 'demo-waqf-1'),
      );
    });
    await t.test('branch cannot forge brand scope on create', async () => {
      const limited = await db.user.upsert({
        where: { id: 'test-limited' },
        create: {
          id: 'test-limited',
          name: 'حساب اختبار نطاق',
          role: 'AGENT',
          brandIds: ['waqf'],
          branchIds: [],
        },
        update: {},
      });
      const cookie = await login(limited.id);
      assert.equal(
        (
          await req(
            cookie,
            'tickets/phone',
            { ...input, brandId: 'kabab', branchId: 'demo-kabab-1' },
            randomUUID(),
          )
        ).status,
        403,
      );
    });
    await t.test('concurrent updates reject stale version', async () => {
      const results = await Promise.all([
        req(lead, `tickets/${id}/actions/triage`, { version: 1, note: 'فرز الحالة التجريبية' }),
        req(lead, `tickets/${id}/actions/triage`, { version: 1, note: 'محاولة فرز متزامنة' }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      version = 2;
    });
    await t.test('support handoff, acknowledgment and action are distinct', async () => {
      assert.equal(
        (
          await req(lead, `tickets/${id}/actions/assign`, {
            version,
            note: 'محاولة إسناد إلى مدير الفرع بدلاً من الدعم',
            resolutionOwner: 'branch',
            branchId: 'demo-waqf-1',
            owner: 'agent-1',
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await req(lead, `tickets/${id}/actions/assign`, {
            version,
            note: 'محاولة تضمين بيانات اتصال',
            branchBrief: 'يرجى الاتصال على 0500000000 لمعالجة الشكوى.',
            branchId: 'demo-waqf-1',
            owner: 'agent-1',
          })
        ).status,
        400,
      );

      const r = await req(lead, `tickets/${id}/actions/assign`, {
        version,
        note: 'توجيه للفرع التجريبي',
        resolutionOwner: 'agent-1',
        branchBrief: 'تأخر الطلب ويحتاج الفرع إلى التحقيق وتوثيق المعالجة.',
        branchId: 'demo-waqf-1',
        owner: 'agent-1',
      });
      assert.equal(r.status, 201);
      const branchView = await req(branch, 'tickets/' + id);
      assert.equal(
        branchView.body.branchBrief,
        'تأخر الطلب ويحتاج الفرع إلى التحقيق وتوثيق المعالجة.',
      );
      assert.equal(branchView.body.customer, null);
      assert.equal(branchView.body.description, 'تفاصيل العميل محجوبة حسب الصلاحية');
      version++;
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/resolve`, {
            version,
            note: 'محاولة تجاوز الاستلام',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/acknowledge`, {
            version,
            note: 'تم استلام الحالة التجريبية',
          })
        ).status,
        201,
      );
      version++;
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/investigate`, {
            version,
            note: 'بدأت مراجعة الحالة',
          })
        ).status,
        201,
      );
      version++;
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/resolve`, {
            version,
            note: 'دليل معالجة اصطناعي للاختبار',
          })
        ).status,
        201,
      );
      version++;
    });
    await t.test('resolution cannot close without customer contact', async () => {
      assert.equal(
        (await req(lead, `tickets/${id}/actions/close`, { version, note: 'محاولة إغلاق مبكر' }))
          .status,
        409,
      );
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/contact`, {
            version,
            note: 'محاولة تواصل اصطناعية موثقة',
          })
        ).status,
        201,
      );
      version++;
      assert.equal(
        (
          await req(lead, `tickets/${id}/actions/close`, {
            version,
            note: 'محاولة تواصل لا تكفي لتأكيد الحل',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/confirm`, {
            version,
            note: 'أكد العميل التجريبي أن المعالجة حلت المشكلة',
          })
        ).status,
        201,
      );
      version++;
      assert.equal(
        (
          await req(lead, `tickets/${id}/actions/close`, {
            version,
            note: 'المعالجة والمتابعة موثقتان',
          })
        ).status,
        201,
      );
      version++;
    });
    await t.test('history and original intake cannot be altered in database', async () => {
      await assert.rejects(db.ticket.update({ where: { id }, data: { source: 'PUBLIC_QR' } }));
      const event = await db.event.findFirstOrThrow({ where: { ticketId: id } });
      await assert.rejects(db.event.update({ where: { id: event.id }, data: { type: 'FORGED' } }));
      const audit = await db.audit.findFirstOrThrow();
      await assert.rejects(db.audit.delete({ where: { id: audit.id } }));
    });
    let qrCode: string, qrId: string, publicId: string, tracking: string;
    await t.test(
      'QR enforces encoded branch and exposes only the customer receipt through its private token',
      async () => {
        const qr = await req(admin, 'qrs', {
          branchId: 'demo-waqf-1',
          placement: 'موضع اختبار آلي',
        });
        assert.equal(qr.status, 201);
        qrCode = qr.body.url.split('/').pop();
        qrId = qr.body.id;
        const r = await req(
          '',
          `public/q/${qrCode}`,
          {
            description: 'بلاغ عام اصطناعي لاختبار نطاق الرمز',
            category: 'MISSING',
            consent: true,
            brandId: 'kabab',
            branchId: 'demo-kabab-2',
          },
          randomUUID(),
        );
        assert.equal(r.status, 201);
        publicId = r.body.id;
        tracking = r.body.trackingToken;
        const saved = await db.ticket.findUniqueOrThrow({ where: { id: publicId } });
        assert.equal(saved.brandId, 'waqf');
        assert.equal(saved.branchId, 'demo-waqf-1');
        const status = await req('', `public/status/${tracking}`);
        assert.equal(status.status, 200);
        assert.deepEqual(Object.keys(status.body).sort(), [
          'confirmationStatus',
          'createdAt',
          'number',
          'receipt',
          'state',
        ]);
        assert.equal(status.body.receipt.description, 'بلاغ عام اصطناعي لاختبار نطاق الرمز');
        assert.ok(!JSON.stringify(status.body).includes('communicationsOwner'));
        assert.equal((await req('', `public/status/${r.body.number}`)).status, 404);
        assert.equal((await req('', `public/status/${randomUUID()}`)).status, 404);
      },
    );
    await t.test('follow-up preserves PUBLIC_QR intake', async () => {
      assert.equal(
        (
          await req(agent, `tickets/${publicId}/actions/contact`, {
            version: 1,
            note: 'محاولة تواصل قبل الإسناد',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req(lead, `tickets/${publicId}/actions/assign`, {
            version: 1,
            note: 'إسناد متابعة البلاغ العام',
            resolutionOwner: 'agent-1',
            branchBrief: 'راجع نقص الأصناف ووثق الإجراء التصحيحي للفرع.',
            branchId: 'demo-waqf-1',
            owner: 'agent-1',
          })
        ).status,
        201,
      );

      assert.equal(
        (
          await req(agent, `tickets/${publicId}/actions/contact`, {
            version: 2,
            note: 'تواصل هاتفي لاحق على البلاغ العام',
          })
        ).status,
        201,
      );
      assert.equal(
        (await db.ticket.findUniqueOrThrow({ where: { id: publicId } })).source,
        'PUBLIC_QR',
      );
    });
    await t.test('revocation and rotation invalidate old code', async () => {
      const r = await req(admin, `qrs/${qrId}/rotate`, {});
      assert.equal(r.status, 201);
      assert.notEqual(r.body.url.split('/').pop(), qrCode);
      assert.equal((await req('', `public/q/${qrCode}`)).status, 404);
      await db.access.update({
        where: { hash: (await import('../apps/api/src/crypto')).hash(tracking) },
        data: { expiresAt: new Date(0) },
      });
      assert.equal((await req('', `public/status/${tracking}`)).status, 404);
    });
    await t.test('SLA retries produce only one breach per milestone', async () => {
      const ticket = await db.ticket.findUniqueOrThrow({ where: { id: publicId } });
      await db.timer.updateMany({
        where: { ticketId: ticket.id },
        data: { dueAt: new Date(Date.now() - 60000), warningAt: new Date(Date.now() - 120000) },
      });
      await reconcile();
      await reconcile();
      const breached = await db.event.count({
        where: { ticketId: publicId, type: 'SLA_BREACHED' },
      });
      const timers = await db.timer.count({
        where: { ticketId: publicId, breachedAt: { not: null } },
      });
      assert.equal(breached, timers);
      assert.ok(breached > 0);
    });
    let refundId: string, refundTicket: string;
    await t.test('refund cannot be completed on approval alone', async () => {
      const c = await req(
        agent,
        'tickets/phone',
        { ...input, externalOrder: 'REFUND-' + randomUUID() },
        randomUUID(),
      );
      refundTicket = c.body.id;
      const r = await req(agent, 'refunds', {
        ticketId: refundTicket,
        kind: 'REFUND',
        reason: 'طلب مالي اصطناعي للاختبار فقط',
        amountMinor: 100,
      });
      assert.equal(r.status, 201);
      refundId = r.body.id;
      assert.equal(
        (
          await req(agent, `refunds/${refundId}/approve`, {
            version: 1,
            note: 'موافقة غير مصرح بها',
          })
        ).status,
        403,
      );
      assert.equal(
        (await req(finance, `refunds/${refundId}/review`, { version: 1, note: 'مراجعة تجريبية' }))
          .status,
        201,
      );
      assert.equal(
        (
          await req(finance, `refunds/${refundId}/approve`, {
            version: 2,
            note: 'موافقة تجريبية دون حركة مالية',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await req(processor, `refunds/${refundId}/complete`, {
            version: 3,
            note: 'تجاوز الإثبات مرفوض',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await req(processor, `refunds/${refundId}/execute`, {
            version: 3,
            note: 'تنفيذ دون إثبات',
            reference: 'TEST-REF',
          })
        ).status,
        400,
      );
    });
    await t.test('safe upload, authorization, and refund proof verification', async () => {
      const fake = new FormData();
      fake.append('files', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
      assert.equal(
        (
          await fetch(base + `tickets/${refundTicket}/attachments`, {
            method: 'POST',
            headers: { Cookie: processor },
            body: fake,
          })
        ).status,
        400,
      );
      // Files over the 5 MB limit are refused with 413 and a size message.
      const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
      oversized.set([137, 80, 78, 71, 13, 10, 26, 10]);
      const big = new FormData();
      big.append('files', new Blob([oversized], { type: 'image/png' }), 'big.png');
      const tooLarge = await fetch(base + `tickets/${refundTicket}/attachments`, {
        method: 'POST',
        headers: { Cookie: processor },
        body: big,
      });
      assert.equal(tooLarge.status, 413);
      assert.equal((await tooLarge.json()).message, 'حجم الملف أكبر من المسموح');
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: '#fff' },
      })
        .png()
        .toBuffer();
      const form = new FormData();
      form.append(
        'files',
        new Blob([new Uint8Array(image)], { type: 'image/png' }),
        'synthetic.png',
      );
      assert.equal(
        (
          await fetch(base + `tickets/${refundTicket}/attachments`, {
            method: 'POST',
            headers: { Cookie: processor },
            body: form,
          })
        ).status,
        201,
      );
      const proof = await db.attachment.findFirstOrThrow({ where: { ticketId: refundTicket } });
      assert.ok(proof.status === 'CLEAN_DEMO');
      assert.equal((await fetch(base + 'attachments/' + proof.id)).status, 401);
      assert.equal(
        (
          await req(processor, `refunds/${refundId}/execute`, {
            version: 3,
            note: 'مرجع وإثبات اصطناعيان',
            reference: 'TEST-REF',
            proofId: proof.id,
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await req(verifier, `refunds/${refundId}/verify`, {
            version: 4,
            note: 'مراجعة مستقلة تجريبية',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await req(processor, `refunds/${refundId}/notify`, {
            version: 5,
            note: 'إبلاغ اصطناعي لا يتم إرساله فعلياً',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await req(processor, `refunds/${refundId}/complete`, {
            version: 6,
            note: 'اكتملت سلسلة التحقق التجريبية',
          })
        ).status,
        201,
      );
    });
    await t.test('scheduler detects conflicts, breaks and leave overlap', async () => {
      const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
        start = day + 'T08:00:00Z',
        end = day + 'T12:00:00Z';
      const b = {
        userId: 'agent-7',
        brandId: 'waqf',
        start,
        end,
        breakStart: day + 'T09:00:00Z',
        breakEnd: day + 'T09:30:00Z',
      };
      assert.equal((await req(agent, 'shifts', b)).status, 403);
      const existing = await db.shift.findFirst({
        where: { userId: 'agent-7', start: new Date(start) },
      });
      if (!existing) assert.equal((await req(scheduler, 'shifts', b)).status, 201);
      assert.equal((await req(scheduler, 'shifts', b)).status, 409);
      assert.equal(
        (await req(scheduler, 'shifts', { ...b, breakEnd: day + 'T13:00:00Z' })).status,
        400,
      );
    });
    await t.test('report export is scope filtered and excludes contact details', async () => {
      const group = await login('group');
      const res = await fetch(
        base +
          'reports/export?brandId=waqf&from=' +
          new Date().toISOString().slice(0, 10) +
          '&to=' +
          new Date().toISOString().slice(0, 10),
        { headers: { Cookie: group } },
      );
      assert.equal(res.status, 200);
      const csv = await res.text();
      assert.ok(csv.includes('واقف'));
      assert.ok(!csv.includes('كباب علوم'));
      assert.ok(!csv.includes('phone'));
      assert.ok(!csv.includes('description'));
      assert.equal(
        (await fetch(base + 'reports/export', { headers: { Cookie: branch } })).status,
        403,
      );
    });
    await t.test(
      'standalone refund has its own scope and timeline without manufacturing a complaint',
      async () => {
        const before = await db.ticket.count();
        const r = await req(agent, 'refunds', {
          brandId: 'waqf',
          branchId: 'demo-waqf-1',
          externalOrder: 'INDEPENDENT-' + randomUUID(),
          platform: 'TEST',
          kind: 'REFUND',
          reason: 'طلب مستقل اصطناعي لا يرتبط بشكوى',
          amountMinor: 1500,
        });
        assert.equal(r.status, 201);
        assert.equal(await db.ticket.count(), before);
        const saved = await db.refund.findUniqueOrThrow({
          where: { id: r.body.id },
          include: { events: true },
        });
        assert.equal(saved.ticketId, null);
        assert.equal(saved.events.length, 1);
        const bootstrap = await req(agent, 'bootstrap');
        assert.ok(
          bootstrap.body.refunds.some(
            (f: { id: string; number: string }) => f.id === saved.id && f.number.startsWith('RF-'),
          ),
        );
        assert.equal(
          (await req(finance, `refunds/${saved.id}/review`, { version: 1, note: 'مراجعة مستقلة' }))
            .status,
          201,
        );
        const image = await sharp({
          create: { width: 12, height: 12, channels: 3, background: '#eee' },
        })
          .png()
          .toBuffer();
        const form = new FormData();
        form.append(
          'files',
          new Blob([new Uint8Array(image)], { type: 'image/png' }),
          'financial-synthetic.png',
        );
        assert.equal(
          (
            await fetch(base + `refunds/${saved.id}/evidence/images`, {
              method: 'POST',
              headers: { Cookie: processor },
              body: form,
            })
          ).status,
          201,
        );
        const proof = await db.attachment.findFirstOrThrow({ where: { refundId: saved.id } });
        assert.equal(proof.ticketId, null);
        assert.equal(
          (
            await req(finance, `refunds/${saved.id}/approve`, {
              version: 2,
              note: 'موافقة اصطناعية',
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await req(processor, `refunds/${saved.id}/execute`, {
              version: 3,
              note: 'تنفيذ خارجي تجريبي',
              reference: 'SYNTHETIC-EXTERNAL',
              proofId: proof.id,
            })
          ).status,
          201,
        );
        assert.equal(
          (await req(verifier, `refunds/${saved.id}/verify`, { version: 4, note: 'تحقق مستقل' }))
            .status,
          201,
        );
        assert.equal(
          (
            await req(processor, `refunds/${saved.id}/notify`, {
              version: 5,
              note: 'توثيق إبلاغ تجريبي دون إرسال',
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await req(processor, `refunds/${saved.id}/complete`, {
              version: 6,
              note: 'إكمال مستقل موثق',
            })
          ).status,
          201,
        );
        const history = await db.refundEvent.findFirstOrThrow({ where: { refundId: saved.id } });
        await assert.rejects(db.refundEvent.delete({ where: { id: history.id } }));
      },
    );
    await t.test(
      'standalone financial scope and linked complaint scope cannot be forged',
      async () => {
        const limited = await login('test-limited');
        assert.equal(
          (
            await req(limited, 'refunds', {
              brandId: 'kabab',
              branchId: 'demo-kabab-1',
              externalOrder: randomUUID(),
              platform: 'TEST',
              kind: 'REFUND',
              reason: 'محاولة عبور نطاق',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await req(agent, 'refunds', {
              ticketId: id,
              brandId: 'kabab',
              branchId: 'demo-kabab-1',
              externalOrder: randomUUID(),
              platform: 'TEST',
              kind: 'REFUND',
              reason: 'محاولة تغيير علامة الشكوى',
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      'brand directory creates linked branches and preserves historical scope',
      async () => {
        const code = 'test-brand-' + randomUUID().slice(0, 8);
        assert.equal(
          (await req(agent, 'brands', { code, name: 'علامة غير مصرح بها' })).status,
          403,
        );
        const created = await req(admin, 'brands', {
          code,
          name: 'علامة اختبار اصطناعية',
          nameEn: 'Synthetic brand',
          color: '#885533',
          logo: 'neutral.svg',
        });
        assert.equal(created.status, 201);
        const b = await req(admin, 'branches', {
          brandId: code,
          name: 'فرع اصطناعي جديد',
          city: 'مدينة اختبار',
          code: 'TEST-' + randomUUID().slice(0, 8).toUpperCase(),
        });
        assert.equal(b.status, 201);
        assert.equal(
          (await db.branch.findUniqueOrThrow({ where: { id: b.body.id } })).brandId,
          code,
        );
        const moved = await req(admin, 'branches/' + b.body.id, {
          brandId: 'waqf',
          name: 'فرع اختبار معاد ربطه',
          city: 'مدينة اختبار',
          active: true,
        });
        assert.equal(moved.status, 201);
        assert.equal(
          (await db.branch.findUniqueOrThrow({ where: { id: b.body.id } })).brandId,
          'waqf',
        );
        assert.equal(
          (
            await req(admin, 'branches/demo-waqf-1', {
              brandId: code,
              name: 'فرع له تاريخ',
              city: 'مدينة اختبار',
              active: true,
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req(admin, 'brands/' + code, {
              name: 'علامة تجريبية معدلة',
              nameEn: 'Synthetic edited',
              logo: 'neutral.svg',
              color: '#775544',
            })
          ).status,
          201,
        );
        const saved = await req(admin, 'bootstrap');
        assert.ok(
          saved.body.brands.some(
            (brand: { id: string; name: string }) =>
              brand.id === code && brand.name === 'علامة تجريبية معدلة',
          ),
        );
      },
    );
    await db.$disconnect();
  },
);

test(
  'simple QSR complaint flow with named ownership and routed escalation',
  { skip: process.env.LOCAL_PASSWORD_AUTH === 'true' },
  async (t) => {
    const lead = await login('lead'),
      agent = await login('agent-1'),
      other = await login('agent-2'),
      group = await login('group');
    async function createAssigned() {
      const created = await req(
        agent,
        'tickets/phone',
        { ...input, externalOrder: 'SIMPLE-' + randomUUID() },
        randomUUID(),
      );
      assert.equal(created.status, 201);
      const id = created.body.id as string;
      const assignment = {
        version: 1,
        note: 'إسناد الشكوى إلى الموظف المختص',
        branchBrief: 'مراجعة تجهيز الطلب الناقص وتوثيق الحل مع الفرع.',
        branchId: input.branchId,
        owner: 'agent-1',
        resolutionOwner: 'agent-1',
      };
      assert.equal((await req(agent, `tickets/${id}/actions/assign`, assignment)).status, 403);
      assert.equal(
        (
          await req(lead, `tickets/${id}/actions/assign`, {
            ...assignment,
            resolutionOwner: 'finance',
          })
        ).status,
        400,
      );
      assert.equal((await req(lead, `tickets/${id}/actions/assign`, assignment)).status, 201);
      return id;
    }
    const id = await createAssigned();
    await t.test('only the named assignee or scoped supervisor can work a complaint', async () => {
      assert.equal(
        (
          await req(other, `tickets/${id}/actions/start`, {
            version: 2,
            note: 'محاولة بدء غير مصرح بها',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/start`, {
            version: 2,
            note: 'بدء معالجة الطلب الناقص',
          })
        ).status,
        201,
      );
      const record = await db.ticket.findUniqueOrThrow({
        where: { id },
        include: { timers: true },
      });
      assert.equal(record.state, 'IN_PROGRESS');
      assert.ok(record.acknowledgedAt);
      assert.ok(record.timers.find((x) => x.milestone === 'ACKNOWLEDGMENT')?.completedAt);
      assert.equal(
        (
          await req(other, `tickets/${id}/actions/resolve`, {
            version: 3,
            note: 'حل من موظف غير مسند',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req(agent, `tickets/${id}/actions/resolve`, {
            version: 3,
            note: 'تم تجهيز الصنف الناقص وتسليمه',
          })
        ).status,
        201,
      );
    });
    await t.test(
      'unreachable does not confirm or close; unresolved requires a valid supervisor',
      async () => {
        assert.equal(
          (
            await req(agent, `tickets/${id}/actions/followup`, {
              version: 4,
              note: 'تعذر الوصول في المحاولة الأولى',
              outcome: 'UNREACHABLE',
            })
          ).status,
          201,
        );
        const record = await db.ticket.findUniqueOrThrow({ where: { id } });
        assert.equal(record.state, 'RESOLVED');
        assert.equal(record.customerConfirmedAt, null);
        assert.equal(record.closedAt, null);
        assert.equal(
          (
            await req(agent, `tickets/${id}/actions/followup`, {
              version: 5,
              note: 'أفاد العميل باستمرار المشكلة',
              outcome: 'UNRESOLVED',
              resolutionOwner: 'agent-2',
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await req(agent, `tickets/${id}/actions/followup`, {
              version: 5,
              note: 'أفاد العميل باستمرار المشكلة',
              outcome: 'UNRESOLVED',
              resolutionOwner: 'group',
            })
          ).status,
          201,
        );
        const escalated = await db.ticket.findUniqueOrThrow({
          where: { id },
          include: { events: true },
        });
        assert.equal(escalated.state, 'ASSIGNED');
        assert.equal(escalated.resolutionOwner, 'group');
        assert.equal(escalated.escalated, true);
        assert.equal(escalated.actionCompletedAt, null);
        assert.ok(escalated.events.some((e) => e.type === 'ESCALATION_ROUTED'));
        assert.equal(
          (
            await req(agent, `tickets/${id}/actions/start`, {
              version: 6,
              note: 'محاولة العمل بعد نقل المسؤولية',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await req(group, `tickets/${id}/actions/start`, {
              version: 6,
              note: 'بدأ مدير العمليات المراجعة',
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await req(group, `tickets/${id}/actions/resolve`, {
              version: 7,
              note: 'تم توثيق الحل النهائي مع الفرع',
            })
          ).status,
          201,
        );
      },
    );
    await t.test(
      'one follow-up action records confirmation and closes only when solved',
      async () => {
        assert.equal(
          (
            await req(other, `tickets/${id}/actions/followup`, {
              version: 8,
              note: 'محاولة تواصل من موظف غير مسند',
              outcome: 'SATISFIED',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await req(agent, `tickets/${id}/actions/followup`, {
              version: 8,
              note: 'أكد العميل حل المشكلة ورضاه عن المعالجة',
              outcome: 'SATISFIED',
            })
          ).status,
          201,
        );
        const closed = await db.ticket.findUniqueOrThrow({
          where: { id },
          include: { events: true },
        });
        assert.equal(closed.state, 'CLOSED');
        assert.ok(closed.closedAt);
        assert.ok(closed.customerConfirmedAt);
        assert.ok(closed.events.some((e) => e.type === 'CONTACT_RECORDED'));
        assert.ok(closed.events.some((e) => e.type === 'CUSTOMER_CONFIRMED'));
        assert.ok(closed.events.some((e) => e.type === 'CLOSE'));
      },
    );
    await t.test('an active linked refund keeps a customer-confirmed complaint open', async () => {
      const linkedId = await createAssigned();
      const refund = await req(agent, 'refunds', {
        ticketId: linkedId,
        kind: 'REFUND',
        reason: 'طلب مالي تجريبي مرتبط بالحالة',
        amountMinor: 100,
      });
      assert.equal(refund.status, 201);
      assert.equal(
        (
          await req(agent, `tickets/${linkedId}/actions/start`, {
            version: 2,
            note: 'بدء معالجة الحالة المرتبطة',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await req(agent, `tickets/${linkedId}/actions/resolve`, {
            version: 3,
            note: 'تم توثيق الحل التشغيلي للشكوى',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await req(agent, `tickets/${linkedId}/actions/followup`, {
            version: 4,
            note: 'أكد العميل الحل التشغيلي وينتظر الاسترجاع',
            outcome: 'SATISFIED',
          })
        ).status,
        201,
      );
      const pending = await db.ticket.findUniqueOrThrow({ where: { id: linkedId } });
      assert.equal(pending.state, 'RESOLVED');
      assert.ok(pending.customerConfirmedAt);
      assert.equal(pending.closedAt, null);
    });
  },
);

test(
  'support owns routine complaints; area and operations receive escalations only',
  { skip: process.env.LOCAL_PASSWORD_AUTH === 'true' },
  async () => {
    const agent = await login('agent-1'),
      lead = await login('lead'),
      manager = await login('support-manager'),
      area = await login('area'),
      ops = await login('group'),
      branch = await login('branch');
    const created = await req(
      agent,
      'tickets/phone',
      { ...input, externalOrder: 'SUPPORT-ONLY-' + randomUUID() },
      randomUUID(),
    );
    assert.equal(created.status, 201);
    const id = created.body.id;
    const assignment = {
      version: 1,
      note: 'إسناد الشكوى إلى فريق خدمة العملاء',
      resolutionOwner: 'agent-1',
    };
    for (const actor of [agent, area, ops, branch])
      assert.equal((await req(actor, `tickets/${id}/actions/assign`, assignment)).status, 403);
    for (const resolutionOwner of ['branch', 'group', 'area'])
      assert.equal(
        (await req(lead, `tickets/${id}/actions/assign`, { ...assignment, resolutionOwner }))
          .status,
        400,
      );
    assert.equal(
      (await req(lead, `tickets/${id}/actions/assign`, { ...assignment, branchId: 'demo-waqf-2' }))
        .status,
      400,
    );
    assert.equal((await req(manager, `tickets/${id}/actions/assign`, assignment)).status, 201);
    let saved = await db.ticket.findUniqueOrThrow({ where: { id } });
    assert.equal(saved.branchId, input.branchId);
    assert.equal(saved.resolutionOwner, 'agent-1');
    assert.equal(saved.communicationsOwner, 'agent-1');
    assert.equal(
      (
        await req(ops, `tickets/${id}/actions/start`, {
          version: 2,
          note: 'محاولة التدخل في حالة دعم غير مصعدة',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await req(agent, `tickets/${id}/actions/start`, {
          version: 2,
          note: 'بدء المعالجة مع فريق خدمة العملاء',
        })
      ).status,
      201,
    );
    const escalation = {
      version: 3,
      note: 'تحتاج المشكلة إلى مراجعة مدير المنطقة',
      resolutionOwner: 'area',
    };
    assert.equal((await req(agent, `tickets/${id}/actions/escalate`, escalation)).status, 400);
    assert.equal(
      (
        await req(agent, `tickets/${id}/actions/escalate`, {
          ...escalation,
          branchBrief: 'يرجى مراجعة تكرار تأخر التجهيز وتحديد الإجراء التصحيحي.',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await req(area, `tickets/${id}/actions/start`, {
          version: 4,
          note: 'بدأت مراجعة التصعيد للمنطقة',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await req(area, `tickets/${id}/actions/resolve`, {
          version: 5,
          note: 'تمت مراجعة التجهيز واتخاذ الإجراء المطلوب',
        })
      ).status,
      201,
    );
    saved = await db.ticket.findUniqueOrThrow({ where: { id } });
    assert.equal(saved.state, 'RESOLVED');
    assert.equal(saved.closedAt, null);
    assert.equal(saved.communicationsOwner, 'agent-1');
    assert.equal(
      (
        await req(agent, `tickets/${id}/actions/followup`, {
          version: 6,
          note: 'تم التواصل وأكد العميل حل المشكلة',
          outcome: 'SATISFIED',
        })
      ).status,
      201,
    );
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id } })).state, 'CLOSED');
    const outside = await req(
      agent,
      'tickets/phone',
      {
        ...input,
        brandId: 'kabab',
        branchId: 'demo-kabab-1',
        externalOrder: 'AREA-SCOPE-' + randomUUID(),
      },
      randomUUID(),
    );
    assert.equal(outside.status, 201);
    assert.equal(
      (await req(lead, `tickets/${outside.body.id}/actions/assign`, assignment)).status,
      201,
    );
    assert.equal(
      (
        await req(agent, `tickets/${outside.body.id}/actions/escalate`, {
          ...escalation,
          version: 2,
          branchBrief: 'مراجعة تجهيز الطلب والتأكد من اكتمال الأصناف.',
        })
      ).status,
      400,
    );
  },
);

test(
  'support leads can add and link branches without global configuration rights',
  { skip: process.env.LOCAL_PASSWORD_AUTH === 'true' },
  async () => {
    const lead = await login('lead'),
      agent = await login('agent-1'),
      ops = await login('group');
    const code = 'LINK-' + randomUUID().slice(0, 8).toUpperCase();
    const data = { brandId: 'waqf', name: 'فرع اختبار إضافة وربط', code, city: 'الرياض' };
    for (const actor of [agent, ops])
      assert.equal((await req(actor, 'branches', data)).status, 403);
    const created = await req(lead, 'branches', data);
    assert.equal(created.status, 201);
    assert.equal(created.body.brandId, 'waqf');
    const bootstrap = await req(lead, 'bootstrap');
    assert.ok(bootstrap.body.permissions.includes('branches.manage'));
    assert.ok(!bootstrap.body.permissions.includes('configure'));
    assert.ok(
      bootstrap.body.brands
        .find((b: any) => b.id === 'waqf')
        .branches.some((b: any) => b.id === created.body.id),
    );
    assert.equal(
      (
        await req(lead, `branches/${created.body.id}`, {
          brandId: 'kabab',
          name: data.name,
          city: data.city,
        })
      ).status,
      201,
    );
    assert.equal(
      (await db.branch.findUniqueOrThrow({ where: { id: created.body.id } })).brandId,
      'kabab',
    );
    const limitedId = 'test-directory-scoped';
    await db.user.upsert({
      where: { id: limitedId },
      create: {
        id: limitedId,
        name: 'مشرف اختبار نطاق الفروع',
        role: 'SHIFT_LEAD',
        brandIds: ['waqf'],
        branchIds: [],
      },
      update: {},
    });
    const limited = await login(limitedId);
    assert.equal(
      (await req(limited, 'branches', { ...data, brandId: 'kabab', code: code + 'X' })).status,
      403,
    );
    assert.equal(
      (
        await req(limited, `branches/${created.body.id}`, {
          brandId: 'waqf',
          name: data.name,
          city: data.city,
        })
      ).status,
      404,
    );
  },
);

test(
  'brand and branch CRUD is scoped, audited and protects operational history',
  { skip: process.env.LOCAL_PASSWORD_AUTH === 'true' },
  async () => {
    const lead = await login('lead'),
      agent = await login('agent-1'),
      ops = await login('group');
    const code = 'crud-' + randomUUID().slice(0, 8);
    const name = 'علامة اختبار إضافة وتعديل وحذف';
    assert.equal((await req(agent, 'brands', { code, name })).status, 403);
    assert.equal((await req(ops, 'brands', { code, name })).status, 403);
    const created = await req(lead, 'brands', { code, name });
    assert.equal(created.status, 201);
    const brandName = name + ' محدثة';
    assert.equal(
      (
        await req(lead, `brands/${code}`, {
          name: brandName,
          nameEn: 'Synthetic CRUD brand',
          logo: 'neutral.svg',
          color: '#B62E30',
        })
      ).status,
      201,
    );
    const branch = await req(lead, 'branches', {
      brandId: code,
      name: 'فرع اختبار CRUD',
      code: 'CRUD-' + randomUUID().slice(0, 8).toUpperCase(),
      city: 'الرياض',
    });
    assert.equal(branch.status, 201);
    const branchId = branch.body.id;
    assert.equal((await req(lead, `brands/${code}/delete`, { name: brandName })).status, 409);
    const branchName = 'فرع اختبار CRUD محدث';
    const updatedCode = 'EDIT-' + randomUUID().slice(0, 8).toUpperCase();
    assert.equal(
      (
        await req(lead, `branches/${branchId}`, {
          brandId: code,
          name: branchName,
          city: 'جدة',
          code: updatedCode,
        })
      ).status,
      201,
    );
    assert.equal(
      (await db.branch.findUniqueOrThrow({ where: { id: branchId } })).code,
      updatedCode,
    );
    assert.equal(
      (await req(agent, `branches/${branchId}/delete`, { name: branchName })).status,
      403,
    );
    assert.equal(
      (await req(lead, `branches/${branchId}/delete`, { name: 'اسم قديم' })).status,
      409,
    );
    const limited = await login('test-directory-scoped');
    assert.equal(
      (await req(limited, `branches/${branchId}/delete`, { name: branchName })).status,
      404,
    );
    assert.equal((await req(limited, `brands/${code}/delete`, { name: brandName })).status, 404);
    assert.equal(
      (await req(lead, `branches/${branchId}/delete`, { name: branchName })).status,
      201,
    );
    assert.equal(await db.branch.findUnique({ where: { id: branchId } }), null);
    assert.equal((await req(lead, `brands/${code}/delete`, { name: brandName })).status, 201);
    assert.equal(await db.brand.findUnique({ where: { id: code } }), null);
    assert.ok(
      !(await db.user.findUniqueOrThrow({ where: { id: 'lead' } })).brandIds.includes(code),
    );
    const audit = await db.audit.findMany({ where: { entityId: { in: [code, branchId] } } });
    for (const action of [
      'BRAND_CREATED',
      'BRAND_UPDATED',
      'BRAND_DELETED',
      'BRANCH_CREATED',
      'BRANCH_UPDATED',
      'BRANCH_DELETED',
    ])
      assert.ok(audit.some((e) => e.action === action));
    const existing = await db.branch.findUniqueOrThrow({ where: { id: 'demo-waqf-1' } });
    assert.equal(
      (await req(lead, `branches/${existing.id}/delete`, { name: existing.name })).status,
      409,
    );
    assert.ok(await db.branch.findUnique({ where: { id: existing.id } }));
  },
);
