import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Backup and restore rehearsal: builds a disposable database with demo data,
// backs it up with pg_dump, restores it into a second database and proves the
// copy is complete and usable. Run monthly against staging's tooling and on
// every CI run. Synthetic data only; both databases are dropped afterwards.
//
//   npm run backup:rehearse
//   PG_TOOLS_IMAGE=postgres:17-alpine npm run backup:rehearse   (pg_dump via Docker)

const root = resolve(__dirname, '..');
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const source = 'aliz_backup_src_' + id,
  restored = 'aliz_backup_dst_' + id;

function run(bin: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(bin, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  return new Promise<void>((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code) => (code === 0 ? done() : fail(new Error(`${bin} exited ${code}`))));
  });
}

/** pg_dump / pg_restore, locally or from a pinned Postgres image matching the server. */
function pgTool(tool: 'pg_dump' | 'pg_restore', args: string[], dir: string) {
  const image = process.env.PG_TOOLS_IMAGE;
  if (!image) return run(tool, args);
  const mapped = args.map((a) => a.replace(dir, '/backup'));
  return run('docker', [
    'run',
    '--rm',
    '--network',
    'host',
    '-v',
    `${dir}:/backup`,
    image,
    tool,
    ...mapped,
  ]);
}

const url = (base: URL, db: string) => {
  const u = new URL(base);
  u.pathname = '/' + db;
  u.searchParams.delete('schema');
  return u.toString();
};

async function fingerprint(db: PrismaClient) {
  const tables = await db.$queryRaw<{ name: string }[]>`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const result: Record<string, string> = {};
  for (const { name } of tables) {
    const [row] = await db.$queryRawUnsafe<{ rows: bigint; digest: string | null }[]>(
      `SELECT count(*) AS rows, md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest FROM "${name}" t`,
    );
    result[name] = `${row.rows}:${row.digest ?? '-'}`;
  }
  const triggers = await db.$queryRaw<{ name: string }[]>`
    SELECT tgrelid::regclass::text || '.' || tgname AS name FROM pg_trigger
    WHERE NOT tgisinternal ORDER BY 1`;
  result['(triggers)'] = triggers.map((t) => t.name).join(',');
  return result;
}

async function main() {
  const base = new URL(process.env.BACKUP_REHEARSAL_ADMIN_URL ?? process.env.DATABASE_URL ?? '');
  if (
    !process.env.BACKUP_REHEARSAL_ADMIN_URL &&
    !['127.0.0.1', 'localhost', 'postgres'].includes(base.hostname)
  )
    throw new Error(
      'Use a local server or an explicit BACKUP_REHEARSAL_ADMIN_URL (never production)',
    );
  const admin = new PrismaClient({ datasources: { db: { url: base.toString() } } });
  const dir = await mkdtemp(join(tmpdir(), 'aliz-backup-'));
  const dump = join(dir, 'aliz.dump');
  const env = {
    DATABASE_URL: url(base, source),
    PII_KEY: randomBytes(32).toString('hex'),
    PHONE_HASH_KEY: randomBytes(32).toString('hex'),
    DEMO_MODE: 'true',
    SEED_DEMO_USERS: 'true',
    SEED_DEMO_CASES: 'true',
  };
  let restoredDb: PrismaClient | undefined, sourceDb: PrismaClient | undefined;
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${source}"`);
    const prisma = ['node_modules/prisma/build/index.js'];
    const schema = ['--schema', 'packages/db/prisma/schema.prisma'];
    await run(process.execPath, [...prisma, 'migrate', 'deploy', ...schema], env);
    await run(process.execPath, ['--import', 'tsx', 'packages/db/seed.ts'], env);

    const started = Date.now();
    await pgTool(
      'pg_dump',
      ['--format=custom', '--no-owner', '--file', dump, env.DATABASE_URL],
      dir,
    );
    const size = (await stat(dump)).size;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${restored}"`);
    await pgTool(
      'pg_restore',
      ['--no-owner', '--exit-on-error', '--dbname', url(base, restored), dump],
      dir,
    );
    const restoreSeconds = (Date.now() - started) / 1000;

    sourceDb = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    restoredDb = new PrismaClient({ datasources: { db: { url: url(base, restored) } } });
    const [before, after] = [await fingerprint(sourceDb), await fingerprint(restoredDb)];
    const tickets = Number(before.Ticket?.split(':')[0] ?? 0);
    if (tickets === 0) throw new Error('Rehearsal needs data: the demo seed created no cases');
    const differing = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    if (differing.length) throw new Error('Restored copy differs in: ' + differing.join(', '));

    // The copy is usable: schema is current, history stays append-only, and
    // encrypted fields decrypt with the same key.
    await run(process.execPath, [...prisma, 'migrate', 'status', ...schema], {
      DATABASE_URL: url(base, restored),
    });
    const blocked = await restoredDb
      .$executeRawUnsafe(`UPDATE "Event" SET type = type`)
      .then(() => false)
      .catch(() => true);
    if (!blocked) throw new Error('Restored Event table accepted an update; triggers are missing');
    process.env.PII_KEY = env.PII_KEY;
    const { decrypt } = await import('../apps/api/src/crypto');
    const ticket = await restoredDb.ticket.findFirstOrThrow({ select: { description: true } });
    decrypt(ticket.description);

    console.log(
      JSON.stringify({
        event: 'backup_rehearsal',
        ok: true,
        tables: Object.keys(before).length - 1,
        tickets,
        dumpBytes: size,
        dumpAndRestoreSeconds: restoreSeconds,
      }),
    );
  } finally {
    await sourceDb?.$disconnect();
    await restoredDb?.$disconnect();
    for (const db of [restored, source])
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
