// The AV form's "Reoccurring Days" field: a text list of extra event days,
// written month:day ("11:4, 11:16, 12:13"). Shared by the ticket panels,
// which just skip bad entries, and the calendar sync, which won't schedule
// a ticket until every entry reads.

const isChecked = (value) => value === true || value === 'true' || value === 1 || value === '1';

// -> { days: sorted epoch ms at local noon (like the event date field),
//      bad: entries that didn't parse or don't exist, e.g. "every Tue", "2:30" }
// No year is given, so each day takes whichever year puts it closest to the
// ticket's event date (or today, if it has none).
function parseRecurringDays(text, baseMs) {
  const base = baseMs != null && Number.isFinite(baseMs) ? baseMs : Date.now();
  const baseYear = new Date(base).getFullYear();
  const days = new Set();
  const bad = [];
  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = part.match(/^(\d{1,2})\s*[:/]\s*(\d{1,2})$/);
    const month = match ? Number(match[1]) - 1 : NaN;
    const day = match ? Number(match[2]) : NaN;
    const candidates = match
      ? [baseYear - 1, baseYear, baseYear + 1]
          .map((year) => new Date(year, month, day, 12))
          .filter((d) => d.getMonth() === month && d.getDate() === day)
      : [];
    if (!candidates.length) {
      bad.push(part);
      continue;
    }
    const nearest = candidates.reduce((a, b) => (Math.abs(a - base) <= Math.abs(b - base) ? a : b));
    days.add(nearest.getTime());
  }
  return { days: [...days].sort((a, b) => a - b), bad };
}

module.exports = { isChecked, parseRecurringDays };
