import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { hashPassword } from '../apps/api/src/password';
const mode = process.argv[2] ?? 'integration';
const root = resolve(__dirname, '..');
const children: ChildProcess[] = [];
let admin: PrismaClient | undefined,
  created = false;
let originalNextEnv: string | undefined;
const name = 'aliz_test_' + randomUUID().replaceAll('-', '');
const env: NodeJS.ProcessEnv = { ...process.env };
async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const number = (server.address() as { port: number }).port;
  await new Promise<void>((done, error) => server.close((e) => (e ? error(e) : done())));
  return number;
}
function command(bin: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(bin, args, { cwd: root, env: { ...env, ...extra }, stdio: 'inherit' });
  return new Promise<void>((done, error) => {
    child.once('error', error);
    child.once('exit', (code) => (code === 0 ? done() : error(new Error(`${bin} exited ${code}`))));
  });
}
function server(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  children.push(child);
  let log = '';
  child.stdout?.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-20000);
  });
  child.stderr?.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-20000);
  });
  return { child, log: () => log };
}
async function stop() {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      /* already stopped */
    }
    await Promise.race([
      new Promise((done) => child.once('exit', done)),
      new Promise((done) => setTimeout(done, 3000)),
    ]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
  }
}
async function ready(url: string, instance: ReturnType<typeof server>) {
  for (let i = 0; i < 180; i++) {
    if (instance.child.exitCode !== null)
      throw new Error('Isolated server stopped: ' + instance.log());
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* already stopped */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('Isolated server did not become ready: ' + instance.log());
}
async function main() {
  if (!['integration', 'browser'].includes(mode)) throw new Error('Choose integration or browser');
  const base = new URL(process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? '');
  if (
    !process.env.TEST_DATABASE_ADMIN_URL &&
    !['127.0.0.1', 'localhost', 'postgres'].includes(base.hostname)
  )
    throw new Error('Use a local test server or an explicit TEST_DATABASE_ADMIN_URL');
  admin = new PrismaClient({ datasources: { db: { url: base.toString() } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  created = true;
  base.pathname = '/' + name;
  base.searchParams.delete('schema');
  const apiPort = await port(),
    webPort = await port();
  Object.assign(env, {
    DATABASE_URL: base.toString(),
    DEMO_MODE: 'true',
    NODE_ENV: 'test',
    LOCAL_PASSWORD_AUTH: 'false',
    SEED_DEMO_USERS: 'true',
    SEED_DEMO_CASES: 'false',
    PII_KEY: randomBytes(32).toString('hex'),
    PHONE_HASH_KEY: randomBytes(32).toString('hex'),
    AUTH_SESSION_KEY: randomBytes(32).toString('hex'),
    TELEGRAM_ENABLED: 'false',
    WHATSAPP_ENABLED: 'false',
    PUBLIC_INTAKE_ENABLED: 'true',
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    API_URL: `http://127.0.0.1:${apiPort}`,
    TEST_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    APP_ORIGIN: `http://localhost:${webPort}`,
    TEST_WEB_ORIGIN: `http://localhost:${webPort}`,
    NEXT_TEST_OUTPUT: 'true',
    TRUSTED_PROXY_CIDRS: 'loopback',
    UPLOAD_DIR: resolve('/tmp', name + '-uploads'),
  });
  console.log('Preparing a fresh isolated test database.');
  await command(process.execPath, [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--schema',
    'packages/db/prisma/schema.prisma',
  ]);
  await command(process.execPath, ['--import', 'tsx', 'packages/db/seed.ts']);
  if (mode === 'integration') {
    const files = (await readdir(resolve(root, 'tests')))
      .filter((f) => f.endsWith('.integration.ts'))
      .map((f) => 'tests/' + f);
    for (const authMode of ['demo', 'password']) {
      env.LOCAL_PASSWORD_AUTH = String(authMode === 'password');
      const api = server(['--import', 'tsx', 'apps/api/src/main.ts']);
      await ready(env.API_URL + '/api/health', api);
      console.log('Integration checks: ' + authMode + ' authentication.');
      await command(process.execPath, [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        ...files,
      ]);
      await stop();
    }
  } else {
    env.LOCAL_PASSWORD_AUTH = 'true';
    env.TEST_LOGIN_PASSWORD = 'Isolated-Browser-Check-' + randomUUID();
    const fixtureDb = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL! } } });
    try {
      const passwordHash = await hashPassword(env.TEST_LOGIN_PASSWORD);
      for (const id of ['lead', 'admin', 'support-manager'])
        await fixtureDb.user.update({
          where: { id },
          data: { email: `${id}@example.invalid`, passwordHash },
        });
      await fixtureDb.user.create({
        data: {
          id: 'browser-superadmin',
          name: 'Browser Superadmin',
          email: 'root@example.invalid',
          passwordHash,
          role: 'SUPER_ADMIN',
          brandIds: [],
          branchIds: [],
        },
      });
    } finally {
      await fixtureDb.$disconnect();
    }
    const api = server(['--import', 'tsx', 'apps/api/src/main.ts']);
    await ready(env.API_URL + '/api/health', api);
    originalNextEnv = await readFile(resolve(root, 'apps/web/next-env.d.ts'), 'utf8').catch(
      () => undefined,
    );
    const web = server([
      'node_modules/next/dist/bin/next',
      'dev',
      'apps/web',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ]);
    await ready(env.TEST_WEB_ORIGIN + '/', web);
    await command(process.execPath, [
      'node_modules/@playwright/test/cli.js',
      'test',
      ...process.argv.slice(3),
    ]);
  }
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stop();
    if (admin && created) {
      // This database was created above for this run; no live database or append-only history is altered.
      await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => {
        console.error('Could not remove isolated database ' + name);
        process.exitCode = 1;
      });
    }
    await admin?.$disconnect();
    if (originalNextEnv !== undefined) {
      const path = resolve(root, 'apps/web/next-env.d.ts');
      if ((await readFile(path, 'utf8')).includes('.next-test'))
        await writeFile(path, originalNextEnv);
    }
    if (created) await rm(resolve('/tmp', name + '-uploads'), { recursive: true, force: true });
  });
