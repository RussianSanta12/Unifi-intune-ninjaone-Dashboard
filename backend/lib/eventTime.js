// Turns the AV form's event fields into a calendar block. The date is a real
// DATE field, but start/end times are free text typed by requesters
// ("6pm (5pm setup)", "7:15pm", "10-11:30am"), so this is deliberately
// lenient about format and strict about meaning:
// - the block starts at the EARLIEST time in the start field, so a setup
//   time ("5pm setup") wins over the event time;
// - it ends at the LATEST time in the end field;
// - a time with no am/pm takes it from a neighbour in the same field
//   ("5-6pm"), or else whichever reading gives the shorter event against
//   the other field ("6:00" → "7:15pm" means 6pm). 24-hour times ("18:00")
//   are taken as-is;
// - anything still unclear returns { ok: false, reason } instead of a guess.

const MAX_EVENT_MINUTES = 16 * 60;

// noon/midnight | h[:mm] am/pm | h:mm | bare h directly before a range ("5-6pm")
const TOKEN_RE =
  /\b(noon|midnight)\b|\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?(?![a-z])|\b(\d{1,2}):(\d{2})\b|\b(\d{1,2})(?=\s*(?:-|–|—|to)\s*\d)/gi;

function tokens(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TOKEN_RE)) {
    if (m[1]) {
      out.push({ minutes: m[1].toLowerCase() === 'noon' ? 12 * 60 : 0 });
    } else if (m[2]) {
      const hour = Number(m[2]);
      const minute = Number(m[3] || 0);
      if (hour < 1 || hour > 12 || minute > 59) continue;
      out.push({ minutes: (hour % 12) * 60 + minute + (m[4].toLowerCase() === 'p' ? 12 * 60 : 0) });
    } else if (m[5]) {
      const hour = Number(m[5]);
      const minute = Number(m[6]);
      if (hour > 23 || minute > 59) continue;
      // "18:00" or "09:00" is clearly 24-hour; "7:15" could be either.
      if (hour >= 13 || hour === 0 || m[5].length === 2 && m[5][0] === '0') out.push({ minutes: hour * 60 + minute });
      else out.push({ hour, minute });
    } else if (m[7]) {
      const hour = Number(m[7]);
      if (hour >= 1 && hour <= 12) out.push({ hour, minute: 0 });
    }
  }
  return out;
}

// Both readings of an am/pm-less 1–12 hour.
function readings({ hour, minute }) {
  return [(hour % 12) * 60 + minute, (hour % 12) * 60 + minute + 12 * 60];
}

// Fill in am/pm from the nearest token in the same field that has one —
// preferring the next one, since ranges put am/pm last ("5-6pm", "11-1pm").
function resolveWithinField(list) {
  return list.map((t, i) => {
    if (t.minutes !== undefined) return t;
    const next = list.slice(i + 1).find((o) => o.minutes !== undefined);
    const prev = list.slice(0, i).reverse().find((o) => o.minutes !== undefined);
    const [am, pm] = readings(t);
    if (next) return { minutes: pm <= next.minutes && next.minutes - pm < 12 * 60 ? pm : am };
    if (prev) return { minutes: pm >= prev.minutes ? pm : am };
    return t;
  });
}

// Pick the reading for each still-ambiguous token that gives the shortest
// valid event against the other field's known times.
function resolveAgainst(list, anchor, isStart) {
  return list.map((t) => {
    if (t.minutes !== undefined || anchor === undefined) return t;
    const valid = readings(t).filter((m) => (isStart ? m < anchor : m > anchor));
    if (!valid.length) return t;
    return { minutes: isStart ? Math.max(...valid) : Math.min(...valid) };
  });
}

function known(list) {
  return list.filter((t) => t.minutes !== undefined).map((t) => t.minutes);
}

function parseTimes(startText, endText) {
  let start = resolveWithinField(tokens(startText));
  let end = resolveWithinField(tokens(endText));
  if (!start.length) return { ok: false, reason: `Can't read a start time from "${startText || ''}"` };
  if (!end.length) return { ok: false, reason: `Can't read an end time from "${endText || ''}"` };

  const startKnown = known(start);
  const endKnown = known(end);
  start = resolveAgainst(start, endKnown.length ? Math.max(...endKnown) : undefined, true);
  end = resolveAgainst(end, startKnown.length ? Math.min(...startKnown) : undefined, false);

  if (start.some((t) => t.minutes === undefined)) return { ok: false, reason: `Start time "${startText}" needs am/pm` };
  if (end.some((t) => t.minutes === undefined)) return { ok: false, reason: `End time "${endText}" needs am/pm` };

  const startMinutes = Math.min(...known(start));
  const endMinutes = Math.max(...known(end));
  if (endMinutes <= startMinutes) return { ok: false, reason: `End time "${endText}" isn't after start "${startText}"` };
  if (endMinutes - startMinutes > MAX_EVENT_MINUTES) {
    return { ok: false, reason: `"${startText}" to "${endText}" is longer than ${MAX_EVENT_MINUTES / 60} hours` };
  }
  return { ok: true, startMinutes, endMinutes };
}

// Wall-clock parts of an instant in a time zone.
function zonedParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: get('weekday'),
  };
}

// The UTC instant for a wall-clock time on a date in a time zone (DST-safe).
function zonedToUtc({ year, month, day }, minutes, timeZone) {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const offsetAt = (ms) => {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc); // second pass in case the guess crossed a DST change
  return utc;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// dateMs is the DATE field's value (epoch ms); the calendar day is read in
// timeZone. Returns UTC start/end instants plus the event's weekday (0 = Sun).
function eventWindow({ dateMs, startText, endText, timeZone }) {
  if (!Number.isFinite(dateMs)) return { ok: false, reason: 'No event date' };
  const times = parseTimes(startText, endText);
  if (!times.ok) return times;
  const date = zonedParts(dateMs, timeZone);
  return {
    ok: true,
    weekday: WEEKDAYS.indexOf(date.weekday),
    start: new Date(zonedToUtc(date, times.startMinutes, timeZone)),
    end: new Date(zonedToUtc(date, times.endMinutes, timeZone)),
  };
}

module.exports = { parseTimes, eventWindow };
