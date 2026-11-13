// One pass of the calendar sync, for testing, without starting the dashboard.
//
//   npm run sync-once                    dry run, every AV ticket
//   npm run sync-once -- 1234            dry run, ticket #1234 only
//   npm run sync-once -- --live 1234     really do it, ticket #1234 only
//
// A live run must name its tickets, so a test never touches real requests.
// Run it a few times to walk a ticket through: check → (reply) → approved →
// set "Added to Calendar" in NinjaOne → added. Notes are at most one per
// ticket per 2 minutes, per run of this script.

const args = process.argv.slice(2);
const live = args.includes('--live');
const ids = args.filter((a) => /^\d+$/.test(a));

if (live && !ids.length) {
  console.error('A live run needs ticket IDs: npm run sync-once -- --live 1234');
  process.exit(1);
}
process.env.CALENDAR_SYNC_DRY_RUN = live ? 'false' : 'true';
if (ids.length) process.env.CALENDAR_SYNC_ONLY_TICKETS = ids.join(',');

const { getStats } = require('../connectors/calendarSync');

getStats().then((result) => {
  const { alert, ...rest } = result;
  console.log(JSON.stringify(rest, null, 2));
  if (alert) console.log(`\nBANNER: ${alert.reason} — ${alert.action}\n  ${alert.detail}`);
  process.exit(result.ok && !(result.errors || []).length ? 0 : 1);
});
