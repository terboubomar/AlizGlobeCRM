import 'dotenv/config';
import { db } from '../packages/db/client';
import {
  eraseCase,
  exportCases,
  findCases,
  retentionDays,
  retentionSweep,
  setLegalHold,
  type CaseRef,
} from '../apps/api/src/privacy';

// Operator command for customer data requests and retention. Run it on a
// trusted server; every action is written to the audit log.
//
//   npm run privacy -- export --phone 05XXXXXXXX
//   npm run privacy -- export --case AG-2026-000123
//   npm run privacy -- erase  --phone 05XXXXXXXX            (lists what would be erased)
//   npm run privacy -- erase  --phone 05XXXXXXXX --confirm  (erases)
//   npm run privacy -- hold   --case AG-2026-000123 on|off
//   npm run privacy -- retention                             (lists what is due)
//   npm run privacy -- retention --confirm                   (erases what is due)

const usage = `Usage:
  privacy export --phone <number> | --case <AG-YYYY-NNNNNN>
  privacy erase  --phone <number> | --case <AG-YYYY-NNNNNN> [--confirm]
  privacy hold   --case <AG-YYYY-NNNNNN> on|off
  privacy retention [--confirm]`;

function arg(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function ref(args: string[]): CaseRef {
  const phone = arg(args, '--phone'),
    caseNumber = arg(args, '--case');
  if (!!phone === !!caseNumber) throw new Error('Give exactly one of --phone or --case');
  return { phone, caseNumber };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const actor = 'OPERATOR:' + (process.env.PRIVACY_OPERATOR ?? process.env.USER ?? 'unknown');
  const confirm = args.includes('--confirm');

  if (command === 'export') {
    const cases = await findCases(ref(args));
    console.log(
      JSON.stringify(
        await exportCases(
          cases.map((c) => c.id),
          actor,
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'erase') {
    const cases = await findCases(ref(args));
    if (!cases.length) return console.error('No cases match.');
    if (!confirm) {
      console.error(`${cases.length} case(s) would be erased. Run again with --confirm to erase.`);
      return;
    }
    for (const c of cases) {
      const r = await eraseCase(c.id, actor);
      console.error(
        r.result === 'erased' ? `${r.number}: erased` : `${r.number}: skipped (${r.reason})`,
      );
    }
    return;
  }
  if (command === 'hold') {
    const on = args[args.length - 1];
    if (on !== 'on' && on !== 'off') throw new Error('End with on or off');
    const cases = await findCases({ caseNumber: arg(args, '--case') });
    if (cases.length !== 1) throw new Error('Case not found');
    await setLegalHold(cases[0].id, on === 'on', actor);
    console.error(`Legal hold ${on === 'on' ? 'set' : 'released'}.`);
    return;
  }
  if (command === 'retention') {
    const days = retentionDays();
    if (days === null)
      throw new Error('Retention is off. Set RETENTION_CLOSED_CASE_DAYS to switch it on.');
    const r = await retentionSweep(days, { dryRun: !confirm });
    console.error(
      confirm
        ? `Retention (${days} days): ${r.erased} erased, ${r.skipped} skipped of ${r.due} due.`
        : `Retention (${days} days): ${r.due} closed case(s) due. Run again with --confirm to erase.`,
    );
    return;
  }
  console.error(usage);
  process.exitCode = 2;
}

main()
  .catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
