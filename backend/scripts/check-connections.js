// Read-only check of the calendar sync's connections, using the real
// credentials in .env. Run with: npm run check-connections
//   - Graph can open the events calendar (CALENDAR_MAILBOX) and edit it;
//   - Graph is REFUSED for any other mailbox (the Exchange access policy);
//   - the NinjaOne write sign-in works.
// Pass other mailboxes to test as arguments:
//   npm run check-connections -- someone@example.org
// Nothing is written. The NinjaOne check uses only the write sign-in, so it
// doesn't log the running dashboard's read client out.

const graph = require('../lib/graph');
const ninja = require('../lib/ninja');
const webAuth = require('../lib/ninjaWebAuth');

const MAILBOX = process.env.CALENDAR_MAILBOX;
const others = process.argv.slice(2);

let problems = 0;
const report = (status, label, detail) => {
  if (status !== 'OK') problems++;
  console.log(`${status.padEnd(5)} ${label}${detail ? ` → ${detail}` : ''}`);
};

async function main() {
  console.log('--- Microsoft Graph (events calendar)');
  if (!graph.isConfigured() || !MAILBOX) {
    report('FAIL', 'CALENDAR_TENANT_ID / CALENDAR_CLIENT_ID / CALENDAR_CLIENT_SECRET / CALENDAR_MAILBOX', 'not all set in .env');
  } else {
    try {
      const cal = await graph.get(`/users/${encodeURIComponent(MAILBOX)}/calendar?$select=name,canEdit`);
      report(cal.canEdit ? 'OK' : 'FAIL', `open ${MAILBOX}`, `calendar "${cal.name}", canEdit=${cal.canEdit}`);
    } catch (err) {
      report('FAIL', `open ${MAILBOX}`, err.message.slice(0, 200));
    }

    // Some mailbox that isn't the events calendar: the signed-in admin's own
    // is a good default, plus any given on the command line.
    const targets = others.length ? others : [process.env.CALENDAR_CHECK_OTHER_MAILBOX || 'someone@example.org'];
    for (const other of targets) {
      try {
        await graph.get(`/users/${encodeURIComponent(other)}/calendar?$select=name`);
        report('WARN', `open ${other}`, 'ALLOWED — the restriction is not in effect (new policies can take up to an hour)');
      } catch (err) {
        const denied = /403|AccessDenied/i.test(err.message);
        report(denied ? 'OK' : 'FAIL', `open ${other}`, denied ? 'refused, as it should be' : err.message.slice(0, 200));
      }
    }
  }

  console.log('--- NinjaOne write sign-in');
  if (!webAuth.isConfigured()) {
    report('FAIL', 'NINJAONE_WEB_CLIENT_ID / NINJAONE_WEB_CLIENT_SECRET', 'not set in .env');
  } else if (!webAuth.isConnected()) {
    report('FAIL', 'signed in', `no — open http://localhost:${process.env.PORT || 3000}/auth/ninjaone/start on this machine`);
  } else {
    try {
      const statuses = await ninja.write.get('/v2/ticketing/statuses');
      report('OK', 'refresh sign-in and read', `${statuses.length} ticket statuses`);
    } catch (err) {
      report('FAIL', 'refresh sign-in and read', err.message.slice(0, 200));
    }
  }

  console.log(problems ? `\n${problems} problem(s) — keep CALENDAR_SYNC_DRY_RUN=true` : '\nall good');
  process.exit(problems ? 1 : 0);
}

main();
