import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { hashPassword } from '../apps/api/src/password';
const base = (process.env.TEST_API_ORIGIN ?? 'http://127.0.0.1:4000') + '/api/';
test(
  'password login, protected session, throttling and disabled demo bypass',
  { skip: process.env.LOCAL_PASSWORD_AUTH !== 'true' },
  async () => {
    const email = `auth-${randomUUID()}@example.invalid`,
      password = 'Synthetic-Auth-Test-Only-2026';
    const hash = await hashPassword(password);
    const before = { tickets: await db.ticket.count(), refunds: await db.refund.count() };
    const user = await db.user.create({
      data: {
        id: randomUUID(),
        name: 'Synthetic authentication test',
        email,
        passwordHash: hash,
        role: 'SUPER_ADMIN',
        brandIds: [],
        branchIds: [],
      },
    });
    async function post(path: string, data: unknown, cookie?: string) {
      return fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(data),
      });
    }
    try {
      assert.equal((await fetch(base + 'bootstrap')).status, 401);
      assert.equal((await fetch(base + 'demo-users')).status, 404);
      assert.equal((await post('demo-login', { id: 'lead' })).status, 403);
      assert.equal((await post('demo-login', { id: user.id })).status, 403);
      assert.equal(
        (await post('login', { email, password: 'Wrong-Synthetic-Password' })).status,
        401,
      );
      const login = await post('login', { email: email.toUpperCase(), password });
      assert.equal(login.status, 201);
      const header = login.headers.get('set-cookie')!;
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Strict/i);
      const cookie = header.split(';')[0];
      const session = await fetch(base + 'session', { headers: { Cookie: cookie } });
      assert.equal(session.status, 200);
      const text = await session.text();
      assert.ok(!text.includes('passwordHash'));
      assert.ok(!text.includes(hash));
      assert.equal(JSON.parse(text).me.role, 'SUPER_ADMIN');
      const bootstrap = await fetch(base + 'bootstrap', { headers: { Cookie: cookie } });
      assert.equal(bootstrap.status, 200);
      const payload = await bootstrap.text();
      assert.ok(!payload.includes('passwordHash'));
      assert.ok(!payload.includes(hash));
      const data = JSON.parse(payload);
      assert.equal(data.authMode, 'password');
      assert.ok(data.permissions.includes('brands.manage'));
      assert.ok(data.permissions.includes('users.manage'));
      assert.equal(data.brands.length, await db.brand.count());
      // Logout revokes the session server-side: a copied cookie stops working.
      const logout = await post('logout', {}, cookie);
      assert.equal(logout.status, 201);
      assert.match(logout.headers.get('set-cookie')!, /Expires=/i);
      assert.equal((await fetch(base + 'session', { headers: { Cookie: cookie } })).status, 401);
      assert.equal(await db.audit.count({ where: { actor: user.id, action: 'SIGNED_OUT' } }), 1);
      // Logging out again with the revoked cookie is harmless.
      assert.equal((await post('logout', {}, cookie)).status, 201);
      const relogin = await post('login', { email, password });
      assert.equal(relogin.status, 201);
      const fresh = relogin.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await fetch(base + 'session', { headers: { Cookie: fresh } })).status, 200);
      await db.user.update({ where: { id: user.id }, data: { enabled: false } });
      assert.equal((await fetch(base + 'session', { headers: { Cookie: fresh } })).status, 401);
      const unknown = `throttle-${randomUUID()}@example.invalid`;
      for (let i = 0; i < 5; i++)
        assert.equal((await post('login', { email: unknown, password })).status, 401);
      assert.equal((await post('login', { email: unknown, password })).status, 429);
      assert.deepEqual(
        { tickets: await db.ticket.count(), refunds: await db.refund.count() },
        before,
      );
    } finally {
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  },
);
