// NinjaOne ticketing connector — open IT and AV support requests.
//
// Reads two ticket boards that already exist in NinjaOne, each filtered to
// one ticket form ("IT Support Request" / "AV Support Request"). Running a
// board returns the assignee's name and the board's custom-field columns, so
// one paginated call per board gets everything — no per-ticket lookups.
//
// Each shown ticket also gets two extra calls — its details (primary and
// additional assignee IDs) and its log (comments, notes, status changes) —
// to work out the comment markers; see commentMarkers() for the rules.
//
// Boards, the event-date field and statuses are matched by their display
// names (set in .env, defaults below), so renaming one in NinjaOne means
// updating .env to match.

const ninja = require('../lib/ninja');

const IT_BOARD = process.env.NINJAONE_IT_BOARD || 'IT Support Requests';
const AV_BOARD = process.env.NINJAONE_AV_BOARD || 'AV Support Requests';
const AV_EVENT_DATE_FIELD = process.env.NINJAONE_AV_EVENT_DATE_FIELD || 'Date of Event / Program';
// Order matters: tickets sort by this order, and the frontend colors by position.
const STATUSES = (process.env.NINJAONE_TICKET_STATUSES || 'New,In Progress,Added to Calendar')
  .split(',')
  .map((s) => s.trim());
// AV only: closed tickets stay on the calendar (shown brown). Only ones whose
// event falls in the calendar's range are kept, and they skip the extra
// per-ticket calls since closed tickets show no markers.
const AV_CLOSED_STATUS = process.env.NINJAONE_AV_CLOSED_STATUS || 'Closed';
const CLOSED_RANGE_PAD_DAYS = 7; // the grid spills up to 6 days into the neighboring months
// AV recurring events: a checkbox, and a text list of extra days ("11:4, 11:16").
const AV_RECURRING_FIELD = process.env.NINJAONE_AV_RECURRING_FIELD || 'Reocurring Event';
const AV_RECURRING_DAYS_FIELD = process.env.NINJAONE_AV_RECURRING_DAYS_FIELD || 'Reocurring Days';

const PAGE_SIZE = 200;
const DETAIL_CONCURRENCY = 5; // parallel per-ticket lookups
// A status change saved together with a comment can be logged a moment
// before it; treat anything this close as "at the same time".
const SAME_SAVE_SECONDS = 5;

// Runs fn over items with at most `limit` calls in flight.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Marker rules, from the ticket's log entries:
// - public (yellow): the latest public comment by anyone other than the
//   primary assignee, until the assignee comments publicly after it.
// - private (red): the latest private note by anyone, assignee included.
// Either one also clears when a technician changes the status at or after
// it. Status changes by requesters or automation don't count, so an
// automatic status flip on an email reply can't hide the marker.
function commentMarkers(log, assigneeId) {
  const comments = log.filter((e) => e.type === 'COMMENT' && !e.system);
  const latest = (entries) => entries.reduce((max, e) => Math.max(max, e.createTime), -Infinity);
  const isAssignee = (e) => assigneeId != null && e.appUserContactType === 'TECHNICIAN' && e.appUserContactId === assigneeId;

  const lastStatusChange = latest(
    log.filter((e) => e.changeDiff && e.changeDiff.status && e.appUserContactType === 'TECHNICIAN' && !e.automation)
  );
  const clearedByStatus = (time) => lastStatusChange >= time - SAME_SAVE_SECONDS;

  const publicComments = comments.filter((e) => e.publicEntry);
  const lastOther = latest(publicComments.filter((e) => !isAssignee(e)));
  const lastAssigneeReply = latest(publicComments.filter(isAssignee));
  const lastPrivate = latest(comments.filter((e) => !e.publicEntry));

  return {
    publicMarker: lastOther > -Infinity && lastAssigneeReply < lastOther && !clearedByStatus(lastOther),
    privateMarker: lastPrivate > -Infinity && !clearedByStatus(lastPrivate),
  };
}

async function ticketExtras(id, technicianNames) {
  const [detail, log] = await Promise.all([
    ninja.get(`/v2/ticketing/ticket/${id}`),
    ninja.get(`/v2/ticketing/ticket/${id}/log-entry`),
  ]);
  const assigneeId = detail.assignedAppUserId ?? null;
  return {
    extras: {
      unassigned: assigneeId == null,
      additionalAssignees: (detail.additionalAssignedTechnicianIds || [])
        .filter((tid) => tid !== assigneeId)
        .map((tid) => technicianNames.get(tid) || `Technician #${tid}`),
      ...commentMarkers(Array.isArray(log) ? log : [], assigneeId),
    },
    // Every field on the ticket's form, for fields the board has no column for.
    attributeValues: detail.attributeValues || [],
  };
}

// undefined = the field isn't in these values at all (vs. present but empty).
function attributeValue(values, attributeId) {
  if (attributeId == null) return undefined;
  const entry = (values || []).find((v) => String(v.attributeId) === String(attributeId));
  return entry ? entry.value : undefined;
}

const isChecked = (value) => value === true || value === 'true' || value === 1 || value === '1';

// "11:4, 11:16, 12:13" (month:day) -> sorted epoch ms at local noon, like
// the event date field. No year is given, so each day takes whichever year
// puts it closest to the ticket's event date (or today, if it has none).
// Entries that don't parse or don't exist (e.g. 2:30) are skipped.
function parseRecurringDays(text, baseMs) {
  const base = baseMs != null && Number.isFinite(baseMs) ? baseMs : Date.now();
  const baseYear = new Date(base).getFullYear();
  const days = new Set();
  for (const part of String(text || '').split(/[,;\n]+/)) {
    const match = part.trim().match(/^(\d{1,2})\s*[:/]\s*(\d{1,2})$/);
    if (!match) continue;
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    const candidates = [baseYear - 1, baseYear, baseYear + 1]
      .map((year) => new Date(year, month, day, 12))
      .filter((d) => d.getMonth() === month && d.getDate() === day);
    if (!candidates.length) continue;
    const nearest = candidates.reduce((a, b) => (Math.abs(a - base) <= Math.abs(b - base) ? a : b));
    days.add(nearest.getTime());
  }
  return [...days].sort((a, b) => a - b);
}

let warnedMissingRecurring = false; // log a missing recurring field once, not every poll

function recurringDates(values, ids, baseMs) {
  const checked = attributeValue(values, ids.checkbox);
  if (checked === undefined) return undefined;
  return isChecked(checked) ? parseRecurringDays(attributeValue(values, ids.days), baseMs) : [];
}

// Board runs page with lastCursorId; a short page means we've seen them all.
async function runBoard(boardId) {
  const rows = [];
  let attributes = {};
  let cursor;
  for (;;) {
    const page = await ninja.post(`/v2/ticketing/trigger/board/${boardId}/run`, {
      pageSize: PAGE_SIZE,
      ...(cursor !== undefined ? { lastCursorId: cursor } : {}),
    });
    const data = page.data || [];
    rows.push(...data);
    attributes = (page.metadata && page.metadata.attributes) || attributes;
    if (data.length < PAGE_SIZE) break;
    cursor = page.metadata.lastCursorId;
  }
  return { rows, attributes };
}

// The current month padded by a week each side, as epoch ms [start, end).
function calendarRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1 - CLOSED_RANGE_PAD_DAYS);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1 + CLOSED_RANGE_PAD_DAYS);
  return [start.getTime(), end.getTime()];
}

async function loadBoard(boards, technicianNames, boardName, { eventDateField, closedStatus, recurring, allAttributes = [] } = {}) {
  const board = boards.find((b) => b.name === boardName);
  if (!board) {
    return { ok: false, error: `No NinjaOne board named "${boardName}" (check .env)` };
  }

  const { rows, attributes } = await runBoard(board.id);

  let eventDateId = null;
  if (eventDateField) {
    eventDateId = Object.keys(attributes).find((id) => attributes[id].name === eventDateField);
    if (!eventDateId) {
      return { ok: false, error: `Board "${boardName}" has no "${eventDateField}" column (check .env)` };
    }
  }

  // Recurring fields don't need to be board columns: if they aren't, open
  // tickets read them from their details instead (closed tickets can't, as
  // they skip the detail call).
  const fieldId = (name) =>
    Object.keys(attributes).find((id) => attributes[id].name === name) ??
    (allAttributes.find((a) => a.name === name) || {}).id;
  const recurringIds = recurring ? { checkbox: fieldId(recurring.checkboxField), days: fieldId(recurring.daysField) } : null;
  if (recurring && (recurringIds.checkbox == null || recurringIds.days == null) && !warnedMissingRecurring) {
    warnedMissingRecurring = true;
    console.warn(`[tickets] No "${recurring.checkboxField}" / "${recurring.daysField}" fields found; recurring days are ignored`);
  }
  const recurringFor = (values, ticket) =>
    recurringIds ? recurringDates(values, recurringIds, ticket.eventDate ? Date.parse(ticket.eventDate) : null) : [];

  const [rangeStart, rangeEnd] = calendarRange();
  const inRange = (ms) => ms >= rangeStart && ms < rangeEnd;
  const tickets = rows
    .map((t) => {
      const statusName = t.status && t.status.displayName;
      return { ...t, closed: !!closedStatus && statusName === closedStatus, statusIndex: STATUSES.indexOf(statusName) };
    })
    .filter((t) => t.statusIndex !== -1 || t.closed)
    .map((t) => {
      const ticket = {
        id: t.id,
        statusIndex: t.closed ? null : t.statusIndex,
        subject: t.summary || '',
        assignee: t.assignedAppUser || null,
        // Within a status: soonest event first (AV), otherwise oldest ticket first.
        sortKey: t.createTime * 1000,
      };
      if (t.closed) ticket.closed = true;
      if (eventDateId) {
        const value = (t.attributeValues || []).find((v) => String(v.attributeId) === eventDateId);
        ticket.eventDate = value && value.value ? new Date(value.value).toISOString() : null;
        ticket.sortKey = value && value.value ? value.value : Infinity; // no date sorts last
      }
      if (recurringIds) ticket.recurringMs = recurringFor(t.attributeValues, ticket); // undefined = not on the board
      return ticket;
    })
    // Closed tickets only matter if one of their days is on the calendar.
    .filter((t) => !t.closed || inRange(t.sortKey) || (t.recurringMs || []).some(inRange))
    .sort((a, b) => !!a.closed - !!b.closed || a.statusIndex - b.statusIndex || a.sortKey - b.sortKey);

  const open = tickets.filter((t) => !t.closed);
  const details = await mapLimit(open, DETAIL_CONCURRENCY, (t) => ticketExtras(t.id, technicianNames));
  open.forEach((t, i) => {
    Object.assign(t, details[i].extras);
    if (recurringIds && t.recurringMs === undefined) t.recurringMs = recurringFor(details[i].attributeValues, t);
  });
  tickets.forEach((t) => {
    delete t.sortKey;
    if (recurringIds) {
      // Extra days besides the event date itself.
      const eventMs = t.eventDate ? Date.parse(t.eventDate) : null;
      t.recurringDates = (t.recurringMs || []).filter((ms) => ms !== eventMs).map((ms) => new Date(ms).toISOString());
      delete t.recurringMs;
    }
  });
  return { ok: true, count: open.length, tickets };
}

async function getStats() {
  const [boards, technicians, allAttributes] = await Promise.all([
    ninja.get('/v2/ticketing/trigger/boards'),
    ninja.get('/v2/user/technicians'),
    // Only used to find the recurring fields' IDs; not fatal if it fails.
    ninja.get('/v2/ticketing/attributes').catch((err) => {
      console.warn(`[tickets] Could not list ticket fields: ${err.message}`);
      return [];
    }),
  ]);
  const technicianNames = new Map(
    technicians.map((t) => [t.id, [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email])
  );
  const [it, av] = await Promise.all([
    loadBoard(boards, technicianNames, IT_BOARD),
    loadBoard(boards, technicianNames, AV_BOARD, {
      eventDateField: AV_EVENT_DATE_FIELD,
      closedStatus: AV_CLOSED_STATUS,
      recurring: { checkboxField: AV_RECURRING_FIELD, daysField: AV_RECURRING_DAYS_FIELD },
      allAttributes: Array.isArray(allAttributes) ? allAttributes : [],
    }),
  ]);
  return { ok: true, statuses: STATUSES, it, av };
}

module.exports = { getStats };
