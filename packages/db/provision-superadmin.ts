import 'dotenv/config';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { db } from './client';
import { hashPassword } from '../../apps/api/src/password';
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('This provisioning command is restricted to the local database');
  const email = z.string().trim().toLowerCase().email().parse(process.argv[2]);
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdout.write('Password: ');
  }
  const lines = createInterface({ input: process.stdin, terminal: false });
  const interrupt = (chunk: Buffer) => {
    if (chunk.includes(3)) lines.close();
  };
  process.stdin.on('data', interrupt);
  let password: string;
  try {
    password = await new Promise<string>((resolve, reject) => {
      lines.once('line', resolve);
      lines.once('close', () => reject(new Error('Password input required')));
    });
  } finally {
    lines.close();
    process.stdin.removeListener('data', interrupt);
    process.stdin.pause();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(!!wasRaw);
      process.stdout.write('\n');
    }
  }
  const passwordHash = await hashPassword(password);
  const brandIds = (await db.brand.findMany({ select: { id: true } })).map((b) => b.id);
  await db.user.upsert({
    where: { email },
    create: {
      id: randomUUID(),
      email,
      passwordHash,
      name: 'Superadmin',
      role: 'SUPER_ADMIN',
      brandIds,
      branchIds: [],
      enabled: true,
    },
    update: { passwordHash, role: 'SUPER_ADMIN', enabled: true, sessionVersion: { increment: 1 } },
  });
  let settings = await readFile('.env', 'utf8');
  settings =
    settings.replace(/^LOCAL_PASSWORD_AUTH=.*\n?/gm, '').trimEnd() + '\nLOCAL_PASSWORD_AUTH=true\n';
  if (!/^AUTH_SESSION_KEY=[a-f0-9]{64}\r?$/im.test(settings))
    settings =
      settings.replace(/^AUTH_SESSION_KEY=.*\n?/gm, '') +
      'AUTH_SESSION_KEY=' +
      randomBytes(32).toString('hex') +
      '\n';
  await writeFile('.env', settings);
  await chmod('.env', 0o600);
  console.log(
    'Superadmin account provisioned. Password stored as a scrypt hash; local password sign-in enabled.',
  );
}
main()
  .catch(() => {
    console.error('Provisioning failed. Check the email, password length and local database.');
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
