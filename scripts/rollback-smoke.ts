// Rollback rehearsal check: run against the PREVIOUS release's API after the
// NEW release's migrations have been applied. If this passes, rolling back
// the image without rolling back the database is safe.
//
//   API_URL=http://127.0.0.1:4000 tsx scripts/rollback-smoke.ts

const api = process.env.API_URL ?? 'http://127.0.0.1:4000';
const appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:3000';

async function ok(path: string, init: RequestInit = {}) {
  const res = await fetch(api + path, {
    ...init,
    headers: { origin: appOrigin, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}`);
  return res;
}

async function main() {
  for (let i = 0; ; i++) {
    try {
      await ok('/api/health');
      break;
    } catch (e) {
      if (i >= 90) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const login = await ok('/api/demo-login', {
    method: 'POST',
    body: JSON.stringify({ id: process.env.ROLLBACK_USER ?? 'lead' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) throw new Error('No session cookie from demo login');
  // Scoped reads the previous release serves from the migrated schema.
  const boot = (await (await ok('/api/bootstrap', { headers: { cookie } })).json()) as {
    tickets?: { id: string }[];
  };
  if (!Array.isArray(boot.tickets) || boot.tickets.length === 0)
    throw new Error('Previous release returned no cases from the migrated database');
  await ok('/api/tickets/' + boot.tickets[0].id, { headers: { cookie } });
  console.log(
    JSON.stringify({ event: 'rollback_rehearsal', ok: true, cases: boot.tickets.length }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
