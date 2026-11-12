// Checks the calendar sync's rules against real-world examples: the AV
// form's free-text times, recurring days, and the calendar check (missing-
// info form, replies, approval). Run with: npm run check-calendar
// Add a case here whenever a ticket is read wrong.

const { parseTimes } = require('../lib/eventTime');
const { parseRecurringDays } = require('../lib/recurringDays');
const { makeChecker, readCheckComment, isCheckComment } = require('../lib/calendarCheck');

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// [start text, end text, expected "HH:MM-HH:MM" or null for needs-info]
const TIME_CASES = [
  ['6pm (5pm setup)', '7:15pm', '17:00-19:15'],
  ['4pm (setup 3pm)', '6pm', '15:00-18:00'],
  ['2:30pm (2:15 setup)', '4:30pm', '14:15-16:30'],
  ['12:30pm (11:45 setup)', '2pm', '11:45-14:00'],
  ['Setup at 4:30, event 5pm', '6:30pm', '16:30-18:30'],
  ['2 pm', '4 pm', '14:00-16:00'],
  ['6:00', '7:15pm', '18:00-19:15'],
  ['10-11:30am', '12pm', '10:00-12:00'],
  ['11-1pm', '2pm', '11:00-14:00'],
  ['5-6pm', '8 p.m.', '17:00-20:00'],
  ['18:00', '20:30', '18:00-20:30'],
  ['noon', '1:30', '12:00-13:30'],
  ['Doors 6:30 PM', '9:00 PM', '18:30-21:00'],
  ['7:15', '8:30', null],
  ['TBD', 'TBD', null],
  ['8pm', '1am', null],
  ['', '7pm', null],
];

// [text, expected "M/D" days, expected bad entries]; base date Nov 12, 2026
const DAY_CASES = [
  ['11:7, 11:14, 11:21, 12:5', ['11/7', '11/14', '11/21', '12/5'], []],
  ['12:31, 1:2', ['12/31', '1/2'], []],
  ['1:3; 2/14', ['1/3', '2/14'], []],
  ['2:30, 11:20', ['11/20'], ['2:30']],
  ['every Tuesday', [], ['every Tuesday']],
];

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

for (const [start, end, want] of TIME_CASES) {
  const r = parseTimes(start, end);
  const got = r.ok ? `${fmt(r.startMinutes)}-${fmt(r.endMinutes)}` : null;
  check(got === want, `${JSON.stringify(start)} → ${JSON.stringify(end)}: ${got || `needs info (${r.reason})`}`);
}

const base = new Date(2026, 10, 12, 12).getTime();
for (const [text, wantDays, wantBad] of DAY_CASES) {
  const r = parseRecurringDays(text, base);
  const days = r.days.map((ms) => `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()}`);
  const ok = JSON.stringify(days) === JSON.stringify(wantDays) && JSON.stringify(r.bad) === JSON.stringify(wantBad);
  check(ok, `${JSON.stringify(text)}: days ${days.join(', ') || '-'}; bad ${JSON.stringify(r.bad)}`);
}

// The calendar check, on a made-up ticket (now = Nov 12, 2026).
const checker = makeChecker({
  labels: {
    date: 'Date of Event / Program',
    start: 'Event Start Time',
    end: 'End Time',
    location: 'Location(IT)',
    recurring: 'Reoccurring Event',
    recurringDays: 'Reoccurring Days',
  },
  timeZone: 'America/New_York',
  locationOptions: [
    { id: 'a1', name: 'Main Library - Auditorium' },
    { id: 'b2', name: 'Main Library - Third Floor Board Room' },
  ],
});
const now = Date.UTC(2026, 10, 12, 17);
const ticket = {
  date: Date.UTC(2026, 11, 2, 17),
  start: '7:15',
  end: '8:30',
  location: null,
  recurring: true,
  recurringDays: '12:9, every Tuesday',
};
const failed = checker.validate(ticket, now);
const roles = (failed.problems || []).map((p) => p.role).join(',');
check(!failed.ok && roles === 'start,end,recurringDays,location', `missing info found: ${roles}`);

const form = checker.missingNote(failed);
check(isCheckComment({ body: form }) && readCheckComment({ body: form }).kind === 'missing', 'missing-info form reads back as the sync\'s own note');

const reply = checker.readReply(
  ['Thanks!', 'Event Start Time: 7:15pm', 'end: 8:30pm', 'Location: auditorium', 'Reoccurring Days: 12:9, 12:16', '> End Time: '].join('\n')
);
check(Object.keys(reply).join(',') === 'start,end,location,recurringDays', `reply lines read: ${JSON.stringify(reply)}`);

const fixed = { ...ticket };
for (const [role, text] of Object.entries(reply)) fixed[role] = checker.replyValue(role, text, now).value;
const passed = checker.validate(fixed, now);
check(passed.ok && passed.days.length === 3 && passed.location === 'Main Library - Auditorium', 'after the reply it passes: 3 days at the auditorium');

const ref = readCheckComment({ body: checker.approvalNote(passed, 'Technician A') });
check(ref.kind === 'approved' && ref.hash === passed.fingerprint, 'approval note reads back with its fingerprint');
check(checker.validate(fixed, Date.UTC(2026, 11, 10, 17)).fingerprint === passed.fingerprint, 'fingerprint stays the same as days pass');
check(Boolean(checker.replyValue('location', 'main library', now).error), 'ambiguous location reply is refused');
const past = checker.validate({ date: Date.UTC(2026, 10, 1, 17), start: '2pm', end: '4pm', location: 'a1' }, now);
check(!past.ok && past.problems[0].role === 'date', 'an event in the past is not approved');

// The dashboard banner: each real error message gets the right reason.
const { alertFor } = require('../connectors/calendarSync');
const ALERT_CASES = [
  ['NinjaOne write access not connected — open http://localhost:3000/auth/ninjaone/start on the server', 'error', "isn't signed in"],
  ['NinjaOne web-app token request failed: 400 Bad Request {"error":"invalid_grant"}', 'error', 'sign-in was rejected'],
  ['Calendar/Azure AD token request failed: 401 Unauthorized', 'error', 'client secret expired'],
  ['Graph request failed (POST /users/x/events): 403 Forbidden ErrorAccessDenied', 'error', 'No permission'],
  ['Calendar sync stopped after updating ticket #1135: field 15 changed', 'error', 'stopped itself'],
  ['Calendar sync not configured: CALENDAR_MAILBOX (check .env)', 'error', 'settings are missing'],
  ['No ticket field named "End Time" (check .env)', 'error', 'no longer matches'],
  ['something nobody expected', 'error', 'Calendar sync error'],
];
for (const [message, level, words] of ALERT_CASES) {
  const a = alertFor({ ok: false, error: message });
  check(a.level === level && a.reason.includes(words) && a.detail === message, `banner for "${message.slice(0, 45)}…": ${a.reason}`);
}
const ticketAlert = alertFor({ ok: true, errors: [{ id: 1135, error: 'Graph request failed (POST /users/x/events): 500 Internal Server Error' }] });
check(ticketAlert.level === 'warn' && ticketAlert.detail.startsWith('#1135'), `banner for a failed ticket: ${ticketAlert.reason}`);
check(alertFor({ ok: true, errors: [] }) === null, 'no banner when all is well');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
