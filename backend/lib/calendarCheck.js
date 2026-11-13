// The AV calendar check, without any API calls (connectors/calendarSync.js
// does the I/O): validates a ticket's event fields, writes the private
// "[Calendar check]" notes, reads them back, and reads staff replies to the
// missing-info form.
//
// Each note ends in a "Ref: <kind>/<hash>" line so the sync can tell later
// what it last said: "approved" carries a hash of the exact days/times/
// location approved, "missing" a hash of the problems listed, "added" the
// approved hash that went on the calendar. If the ticket changes so the
// hash no longer matches, the note is stale and the ticket is checked again.

const crypto = require('crypto');
const { parseTimes, eventWindow, dayKey, zonedParts, zonedToUtc } = require('./eventTime');
const { isChecked, parseRecurringDays } = require('./recurringDays');

const TAG = '[Calendar check]';
const REF_RE = /^\s*Ref: (approved|missing|added)\/([0-9a-f]{8})\s*$/m;

// Shown under each problem in the form, and used to read replies.
const FORMATS = {
  date: 'pick the date in the side panel, or reply with a date like 12/2/2026',
  start: 'a time with am/pm; put the setup time in brackets, e.g. 6pm (5pm setup)',
  end: 'a time with am/pm, e.g. 7:30pm',
  location: 'one of the location options, e.g. Main Library - Auditorium',
  recurringDays: 'month:day separated by commas, e.g. 11:4, 11:16, 12:13',
  recurring: 'yes or no',
};

// Short names staff can use in replies besides the exact field names.
const ALIASES = {
  date: ['date', 'event date'],
  start: ['start', 'start time'],
  end: ['end', 'end time'],
  location: ['location'],
  recurring: ['recurring', 'reoccurring', 'recurring event'],
  recurringDays: ['recurring days', 'reoccurring days', 'days'],
};

const hash = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 8);
const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function isCheckComment(entry) {
  return String(entry.body || '').trimStart().startsWith(TAG);
}

// A log entry's text, one line per line. NinjaOne's plain `body` turns line
// breaks into spaces, so the HTML version is read when there is one.
function entryText(entry) {
  if (!entry.htmlBody) return String(entry.body || '');
  return String(entry.htmlBody)
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

// { kind, hash } for one of the sync's own notes, else null.
function readCheckComment(entry) {
  if (!isCheckComment(entry)) return null;
  const match = entryText(entry).match(REF_RE);
  return match ? { kind: match[1], hash: match[2], time: entry.createTime } : null;
}

// cfg: { labels: { role: field name }, timeZone, locationOptions: [{ id, name }] }
function makeChecker(cfg) {
  const { labels, timeZone } = cfg;
  const locationName = (id) => {
    const option = (cfg.locationOptions || []).find((o) => o.id === id);
    return option ? option.name : id ? String(id) : null;
  };
  const dayText = (w) =>
    `${new Date(w.start).toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' })}, ` +
    `${new Date(w.start).toLocaleTimeString('en-US', { timeZone, timeStyle: 'short' })} – ` +
    `${new Date(w.end).toLocaleTimeString('en-US', { timeZone, timeStyle: 'short' })}`;

  // values: { role: raw field value }. -> { ok, problems, main, days, fingerprint, signature }
  function validate(values, now = Date.now()) {
    const problems = [];
    const add = (role, problem) => problems.push({ role, problem });
    const dateMs = Number(values.date) || NaN;
    if (!Number.isFinite(dateMs)) add('date', 'empty');

    const times = parseTimes(values.start, values.end);
    if (!times.ok) for (const p of times.problems) add(p.field, p.reason);

    let extra = [];
    if (isChecked(values.recurring)) {
      const parsed = parseRecurringDays(values.recurringDays, Number.isFinite(dateMs) ? dateMs : null);
      if (parsed.bad.length) add('recurringDays', `can't read ${parsed.bad.map((b) => `"${b}"`).join(', ')}`);
      else if (!parsed.days.length) add('recurringDays', `empty, but "${labels.recurring}" is ticked`);
      extra = parsed.days;
    }

    const location = locationName(values.location);
    if (!location) add('location', 'empty');

    if (problems.length) {
      return { ok: false, problems, signature: hash(problems.map((p) => [p.role, p.problem])) };
    }

    const window = (ms) => eventWindow({ dateMs: ms, startText: values.start, endText: values.end, timeZone });
    const main = window(dateMs);
    const byDay = new Map();
    for (const w of [main, ...extra.map(window)]) byDay.set(w.day, w);
    const today = dayKey(now, timeZone);
    const all = [...byDay.values()].sort((a, b) => a.start - b.start);
    const days = all.filter((w) => w.day >= today);
    if (!days.length) {
      const problem = extra.length ? 'the event date and every recurring day are in the past' : 'the event date is in the past';
      return { ok: false, problems: [{ role: 'date', problem }], signature: hash([['date', problem]]) };
    }
    return {
      ok: true,
      main,
      days,
      skippedPastDays: all.length - days.length,
      location,
      // Over every day, not just upcoming ones, so it doesn't change as days pass.
      fingerprint: hash({ days: all.map((w) => [w.start.toISOString(), w.end.toISOString()]), location }),
    };
  }

  function approvalNote(check, assigneeNames) {
    return [
      `${TAG} Approved to be added to calendar.`,
      `Set the status to "Added to Calendar" to put it on the events calendar.`,
      '',
      ...check.days.map(dayText),
      ...(check.skippedPastDays ? [`(${check.skippedPastDays} past day(s) left off)`] : []),
      `Location: ${check.location}`,
      `Assigned: ${assigneeNames}`,
      '',
      `Ref: approved/${check.fingerprint}`,
    ].join('\n');
  }

  // notes: lines about reply values that couldn't be used.
  function missingNote(check, notes = []) {
    const lines = [`${TAG} Missing info — not ready for the calendar yet.`, ''];
    for (const p of check.problems) {
      lines.push(`• ${labels[p.role]}: ${p.problem}`, `  Format: ${FORMATS[p.role]}`);
    }
    lines.push('', 'Reply with these lines filled in, or update the fields in the side panel:');
    const roles = [...new Set(check.problems.map((p) => p.role))];
    for (const role of roles) lines.push(`${labels[role]}: `);
    if (notes.length) lines.push('', ...notes);
    lines.push('', `Ref: missing/${check.signature}`);
    return lines.join('\n');
  }

  function addedNote(check, created) {
    return [
      `${TAG} Added to the events calendar: ${check.days.length} event(s)${created < check.days.length ? ` (${check.days.length - created} already there)` : ''}.`,
      '',
      ...check.days.map(dayText),
      '',
      `Ref: added/${check.fingerprint}`,
    ].join('\n');
  }

  // "Field: value" lines in a reply -> { role: text }. Lines quoted from the
  // form (">") and blank values are ignored.
  const roleByName = new Map();
  for (const [role, label] of Object.entries(labels)) {
    for (const name of [label, ...(ALIASES[role] || [])]) roleByName.set(normalize(name), role);
  }
  function readReply(text) {
    const found = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (/^\s*>/.test(raw)) continue;
      const line = raw.replace(/^\s*[•*-]\s*/, '');
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const role = roleByName.get(normalize(line.slice(0, idx)));
      const value = line.slice(idx + 1).trim();
      if (role && value) found[role] = value;
    }
    return found;
  }

  // A reply's text for one field -> { value } to store in the ticket, or { error }.
  function replyValue(role, text, now = Date.now()) {
    switch (role) {
      case 'date': {
        const ms = parseDate(text, now);
        return ms == null ? { error: `couldn't read "${text}" as a date (${FORMATS.date})` } : { value: ms };
      }
      case 'recurring': {
        if (/^(y|yes|true|x|checked|ticked)$/i.test(text)) return { value: true };
        if (/^(n|no|false|unchecked)$/i.test(text)) return { value: false };
        return { error: `"${text}" should be yes or no` };
      }
      case 'location': {
        const options = cfg.locationOptions || [];
        const exact = options.find((o) => normalize(o.name) === normalize(text));
        const partial = options.filter((o) => normalize(o.name).includes(normalize(text)));
        const option = exact || (partial.length === 1 ? partial[0] : null);
        if (option) return { value: option.id };
        return { error: partial.length ? `"${text}" matches more than one location — use the full name` : `"${text}" isn't one of the location options` };
      }
      default:
        return { value: text }; // free-text fields: checked like any other value
    }
  }

  // "12/2/2026", "12/2" (nearest upcoming), "2026-12-02", "Dec 2, 2026" -> ms at noon in timeZone.
  function parseDate(text, now) {
    let y;
    let m;
    let d;
    let match;
    const today = zonedParts(now, timeZone);
    if ((match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = match.map(Number);
    else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) {
      [m, d] = [Number(match[1]), Number(match[2])];
      y = match[3] ? Number(match[3]) + (match[3].length === 2 ? 2000 : 0) : today.year;
      if (!match[3] && (m < today.month || (m === today.month && d < today.day))) y += 1; // "1/5" in December = next year
    } else {
      const parsed = new Date(/\d{4}/.test(text) ? text : `${text} ${today.year}`);
      if (Number.isNaN(parsed.getTime())) return null;
      [y, m, d] = [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()];
    }
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
    return zonedToUtc({ year: y, month: m, day: d }, 12 * 60, timeZone);
  }

  return { validate, approvalNote, missingNote, addedNote, readReply, replyValue, dayText };
}

module.exports = { TAG, isCheckComment, entryText, readCheckComment, makeChecker };
