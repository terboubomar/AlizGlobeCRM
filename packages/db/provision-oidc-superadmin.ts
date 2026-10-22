import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from './client';
async function main() {
  const email = z.email().parse(process.argv[2]).toLowerCase(),
    subject = z.string().min(1).max(200).parse(process.argv[3]);
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID)
    throw new Error('Configure the identity provider first');
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('aliz-user-management'))`;
    const user = await tx.user.upsert({
      where: { email },
      create: {
        id: randomUUID(),
        email,
        subject,
        name: 'Superadmin',
        role: 'SUPER_ADMIN',
        brandIds: [],
        branchIds: [],
        enabled: true,
      },
      update: { subject, role: 'SUPER_ADMIN', enabled: true, sessionVersion: { increment: 1 } },
    });
    await tx.audit.create({
      data: { actor: 'PROVISIONING', action: 'OIDC_SUPERADMIN_PROVISIONED', entityId: user.id },
    });
  });
  console.log('OIDC superadmin provisioned. Existing sessions were invalidated.');
}
main()
  .catch(() => {
    console.error('Provisioning failed. Verify the identity mapping and database configuration.');
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
