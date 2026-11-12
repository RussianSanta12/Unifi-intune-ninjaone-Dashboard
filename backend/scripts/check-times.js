// Checks the calendar sync's parsing of the AV form's free-text times and
// recurring days against real-world examples. Run with: npm run check-times
// Add a case here whenever a ticket's times are read wrong.

const { parseTimes } = require('../lib/eventTime');
const { parseRecurringDays } = require('../lib/recurringDays');

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

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
