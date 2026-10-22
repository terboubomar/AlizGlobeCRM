import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { db } from '../packages/db/client';
import { saveUser, listUsers, userStatus } from '../apps/api/src/users';
import { actor, passwordSession } from '../apps/api/src/auth';
import { hashPassword, verifyPassword } from '../apps/api/src/password';
import { Actor, can, canWorkComplaint } from '../packages/domain/src';
test(
  'user access is superadmin-only, scoped, versioned and revokes previous sessions',
  { skip: process.env.LOCAL_PASSWORD_AUTH !== 'true' },
  async () => {
    const id = 'users-test-' + randomUUID(),
      password = 'Synthetic-Access-Check-2026';
    const a: Actor = {
      id,
      name: 'Synthetic user manager',
      role: 'SUPER_ADMIN',
      brandIds: [id],
      branchIds: [],
    };
    const before = { tickets: await db.ticket.count(), refunds: await db.refund.count() };
    await db.user.create({
      data: {
        id,
        name: a.name,
        email: id + '@example.invalid',
        role: a.role,
        brandIds: [],
        branchIds: [],
        passwordHash: await hashPassword(password),
      },
    });
    await db.brand.create({
      data: {
        id,
        name: 'Temporary role test',
        nameEn: 'Temporary role test',
        logo: 'neutral.svg',
        color: '#aa2222',
      },
    });
    const branch = await db.branch.create({
      data: { brandId: id, name: 'Temporary branch', city: 'Local test', code: id, active: true },
    });
    let targetId: string | undefined;
    const body = {
      name: 'Synthetic support user',
      email: 'staff-' + id + '@example.invalid',
      role: 'AGENT' as const,
      brandIds: [id],
      branchIds: [branch.id],
      branchMode: 'selected' as const,
      enabled: true,
      password,
    };
    try {
      for (const role of [
        'ADMIN',
        'AGENT',
        'SHIFT_LEAD',
        'CUSTOMER_SERVICE_MANAGER',
        'AREA_MANAGER',
      ]) {
        await assert.rejects(listUsers({ ...a, role }), { status: 403 });
        await assert.rejects(saveUser({ ...a, role }, body), { status: 403 });
      }
      await assert.rejects(saveUser(a, { ...body, brandIds: [] }), { status: 400 });
      await assert.rejects(saveUser(a, { ...body, branchIds: [] }), { status: 400 });
      await assert.rejects(saveUser(a, { ...body, branchIds: ['outside'] }), { status: 400 });
      await assert.rejects(saveUser(a, { ...body, branchMode: 'all' }), { status: 400 });
      const created = await saveUser(a, body);
      targetId = created.id;
      const stored = await db.user.findUniqueOrThrow({ where: { id: targetId } });
      assert.ok(await verifyPassword(password, stored.passwordHash!));
      assert.deepEqual(stored.branchIds, [branch.id]);
      const directory = await listUsers(a);
      assert.deepEqual(
        directory.roles.map((r) => r.id),
        [
          'SUPER_ADMIN',
          'MARKETING_MANAGER',
          'SHIFT_LEAD',
          'AGENT',
          'OPERATIONS_MANAGER',
          'CEO',
          'OWNER',
        ],
      );
      await assert.rejects(saveUser(a, { ...body, role: 'AREA_MANAGER' }));
      const text = JSON.stringify(directory);
      assert.ok(!text.includes(stored.passwordHash!));
      assert.ok(!text.includes(password));
      assert.ok(
        directory.roles.find((r) => r.id === 'SUPER_ADMIN')?.permissions.includes('users.manage'),
      );
      assert.ok(
        directory.roles
          .filter((r) => r.id !== 'SUPER_ADMIN')
          .every((r) => !r.permissions.includes('users.manage')),
      );
      const token = await passwordSession({ email: body.email, password }, 'user-access-test');
      const request = { cookies: { aliz_session: token }, headers: {} } as unknown as Request;
      const support = await actor(request);
      assert.equal(support.role, 'AGENT');
      assert.ok(can(support, 'create'));
      assert.ok(!can(support, 'assign'));
      const edited = { ...body, role: 'OPERATIONS_MANAGER', password: undefined, version: 0 };
      await saveUser(a, edited, targetId);
      await assert.rejects(actor(request), { status: 401 });
      await assert.rejects(saveUser(a, edited, targetId), { status: 409 });
      const operationsToken = await passwordSession(
        { email: body.email, password },
        'user-access-test',
      );
      const operationsRequest = {
        cookies: { aliz_session: operationsToken },
        headers: {},
      } as unknown as Request;
      const operations = await actor(operationsRequest);
      assert.ok(!can(operations, 'assign'));
      assert.ok(!can(operations, 'pii'));
      assert.ok(
        !canWorkComplaint(operations, {
          brandId: id,
          branchId: branch.id,
          resolutionOwner: targetId,
          escalated: false,
        }),
      );
      assert.ok(
        canWorkComplaint(operations, {
          brandId: id,
          branchId: branch.id,
          resolutionOwner: targetId,
          escalated: true,
        }),
      );
      await userStatus(a, targetId, { enabled: false, version: 1 });
      await assert.rejects(actor(operationsRequest), { status: 401 });
      await assert.rejects(passwordSession({ email: body.email, password }, 'user-access-test'), {
        status: 401,
      });
      await userStatus(a, targetId, { enabled: true, version: 2 });
      await assert.rejects(actor(operationsRequest), { status: 401 });
      await assert.rejects(userStatus(a, a.id, { enabled: false, version: 0 }), { status: 409 });
      await assert.rejects(
        saveUser(a, { ...body, email: id + '@example.invalid', role: 'AGENT', version: 0 }, a.id),
        { status: 409 },
      );
      await db.user.update({ where: { id: a.id }, data: { enabled: false } });
      await assert.rejects(saveUser(a, body), { status: 403 });
      assert.deepEqual(
        { tickets: await db.ticket.count(), refunds: await db.refund.count() },
        before,
      );
    } finally {
      if (targetId) await db.user.delete({ where: { id: targetId } });
      await db.user.delete({ where: { id: a.id } });
      await db.branch.delete({ where: { id: branch.id } });
      await db.brand.delete({ where: { id } });
      await db.$disconnect();
    }
  },
);
