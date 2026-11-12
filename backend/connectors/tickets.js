// NinjaOne ticketing connector — open IT and AV support requests.
//
// Reads two ticket boards that already exist in NinjaOne, each filtered to
// one ticket form ("IT Support Request" / "AV Support Request"). Running a
// board returns the assignee's name, the requester's name and the board's
// custom-field columns in one paginated call per board.
//
// Each shown ticket also gets two extra calls — its details (primary and
// additional assignee IDs, every form field) and its log (comments, notes,
// status changes) — to work out the comment markers; see commentMarkers()
// for the rules. Closed AV tickets get the details call only.
// AV tickets the calendar sync couldn't schedule (unreadable event times)
// also get a "needs info" marker; see ./calendarSync.js.
//
// Boards, fields and statuses are matched by their display names (set in
// .env, defaults below), so renaming one in NinjaOne means updating .env to
// match.

const ninja = require('../lib/ninja');
const calendarSync = require('./calendarSync');
const { isChecked, parseRecurringDays } = require('../lib/recurringDays');

const IT_BOARD = process.env.NINJAONE_IT_BOARD || 'IT Support Requests';
const AV_BOARD = process.env.NINJAONE_AV_BOARD || 'AV Support Requests';
const AV_EVENT_DATE_FIELD = process.env.NINJAONE_AV_EVENT_DATE_FIELD || 'Date of Event / Program';
// Order matters: tickets sort by this order, and the frontend colors by position.
const STATUSES = (process.env.NINJAONE_TICKET_STATUSES || 'New,In Progress,Added to Calendar')
  .split(',')
  .map((s) => s.trim());
// AV only: closed tickets stay on the calendar (shown brown). Only ones whose
// event falls in the calendar's range are kept, and they skip the log call
// since closed tickets show no markers.
const AV_CLOSED_STATUS = process.env.NINJAONE_AV_CLOSED_STATUS || 'Closed';
const CLOSED_RANGE_PAD_DAYS = 7; // the grid spills up to 6 days into the neighboring months
// AV form fields shown on the weekly calendar. These don't need to be board
// columns; anything the board lacks is read from the ticket's details.
const AV_FIELDS = {
  startTime: process.env.NINJAONE_AV_START_TIME_FIELD || 'Event Start Time',
  endTime: process.env.NINJAONE_AV_END_TIME_FIELD || 'End Time',
  location: process.env.NINJAONE_AV_LOCATION_FIELD || 'Location(IT)',
  // Recurring events: a checkbox, and a text list of extra days ("11:4, 11:16").
  recurring: process.env.NINJAONE_AV_RECURRING_FIELD || 'Reoccurring Event',
  recurringDays: process.env.NINJAONE_AV_RECURRING_DAYS_FIELD || 'Reoccurring Days',
};
// IT form fields shown on the IT list.
const IT_FIELDS = {
  location: process.env.NINJAONE_IT_LOCATION_FIELD || 'Location(IT)',
};

const DETAIL_CONCURRENCY = 5; // parallel per-ticket lookups
// A status change saved together with a comment can be logged a moment
// before it; treat anything this close as "at the same time".
const SAME_SAVE_SECONDS = 5;
// The calendar sync's own status change is logged as the technician who
// signed it in; ignore status changes this close to when it ran.
const SYNC_STATUS_WINDOW_SECONDS = 120;

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
// automatic status flip on an email reply can't hide the marker. Neither
// does the calendar sync's change (syncedAt, epoch seconds), since no one
// has read the comment yet.
function commentMarkers(log, assigneeId, syncedAt) {
  const comments = log.filter((e) => e.type === 'COMMENT' && !e.system);
  const latest = (entries) => entries.reduce((max, e) => Math.max(max, e.createTime), -Infinity);
  const isAssignee = (e) => assigneeId != null && e.appUserContactType === 'TECHNICIAN' && e.appUserContactId === assigneeId;

  const lastStatusChange = latest(
    log.filter(
      (e) =>
        e.changeDiff &&
        e.changeDiff.status &&
        e.appUserContactType === 'TECHNICIAN' &&
        !e.automation &&
        !(syncedAt != null && Math.abs(e.createTime - syncedAt) <= SYNC_STATUS_WINDOW_SECONDS)
    )
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

// Open tickets: assignees + comment markers. Closed tickets (withMarkers
// false) only need the form fields, so they skip the log call.
async function ticketDetails(id, technicianNames, { withMarkers }) {
  const [detail, log] = await Promise.all([
    ninja.get(`/v2/ticketing/ticket/${id}`),
    withMarkers ? ninja.get(`/v2/ticketing/ticket/${id}/log-entry`) : null,
  ]);
  // Every field on the ticket's form, for fields the board has no column for.
  const attributeValues = detail.attributeValues || [];
  if (!withMarkers) return { extras: {}, attributeValues };
  const assigneeId = detail.assignedAppUserId ?? null;
  return {
    extras: {
      unassigned: assigneeId == null,
      additionalAssignees: (detail.additionalAssignedTechnicianIds || [])
        .filter((tid) => tid !== assigneeId)
        .map((tid) => technicianNames.get(tid) || `Technician #${tid}`),
      ...commentMarkers(Array.isArray(log) ? log : [], assigneeId, calendarSync.syncedAt(id)),
    },
    attributeValues,
  };
}

// undefined = the field isn't in these values at all (vs. present but empty).
function attributeValue(values, attributeId) {
  if (attributeId == null) return undefined;
  const entry = (values || []).find((v) => String(v.attributeId) === String(attributeId));
  return entry ? entry.value : undefined;
}

// Looks a form field up by name: its ID, plus a text formatter that turns a
// dropdown's option ID into the option's name (board runs already return the
// name; ticket details return the ID).
function fieldLookup(boardAttributes, allAttributes) {
  return (name) => {
    const boardId = Object.keys(boardAttributes).find((id) => boardAttributes[id].name === name);
    const def = allAttributes.find((a) => a.name === name);
    const id = boardId ?? (def && def.id);
    if (id == null) return null;
    const options = new Map(((def && def.content && def.content.values) || []).map((o) => [o.id, o.name]));
    return {
      id,
      text: (value) => (value === undefined || value === null || value === '' ? null : options.get(value) ?? String(value)),
    };
  };
}

const warnedMissingFields = new Set(); // log each missing field once, not every poll

// The current month padded by a week each side, as epoch ms [start, end).
function calendarRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1 - CLOSED_RANGE_PAD_DAYS);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1 + CLOSED_RANGE_PAD_DAYS);
  return [start.getTime(), end.getTime()];
}

// `fieldNames` ({ key: field name }) are the form fields to send for each
// ticket. `av` turns on the AV extras: event date, closed tickets, the weekly
// calendar's times and recurring days.
async function loadBoard(boards, technicianNames, boardName, { av = false, fieldNames = {}, allAttributes = [] } = {}) {
  const board = boards.find((b) => b.name === boardName);
  if (!board) {
    return { ok: false, error: `No NinjaOne board named "${boardName}" (check .env)` };
  }

  const { rows, attributes } = await ninja.runBoard(board.id);

  let eventDateId = null;
  if (av) {
    eventDateId = Object.keys(attributes).find((id) => attributes[id].name === AV_EVENT_DATE_FIELD);
    if (!eventDateId) {
      return { ok: false, error: `Board "${boardName}" has no "${AV_EVENT_DATE_FIELD}" column (check .env)` };
    }
  }
  const lookup = fieldLookup(attributes, allAttributes);
  const fields = Object.fromEntries(Object.entries(fieldNames).map(([key, name]) => [key, lookup(name)]));
  for (const [key, field] of Object.entries(fields)) {
    if (!field && !warnedMissingFields.has(fieldNames[key])) {
      warnedMissingFields.add(fieldNames[key]);
      console.warn(`[tickets] No ticket field named "${fieldNames[key]}" (check .env); it won't be shown`);
    }
  }

  // A field's value from the board row, else from the ticket's details.
  // undefined = not in either (yet).
  const read = (ticket, field) => {
    if (!field) return undefined;
    const fromBoard = attributeValue(ticket.boardValues, field.id);
    return fromBoard !== undefined ? fromBoard : attributeValue(ticket.detailValues, field.id);
  };
  const recurringMs = (ticket) => {
    const checked = read(ticket, fields.recurring);
    if (checked === undefined) return undefined;
    return isChecked(checked) ? parseRecurringDays(read(ticket, fields.recurringDays), ticket.sortKey).days : [];
  };

  const [rangeStart, rangeEnd] = calendarRange();
  const inRange = (ms) => ms >= rangeStart && ms < rangeEnd;
  const tickets = rows
    .map((t) => {
      const statusName = t.status && t.status.displayName;
      const closed = av && statusName === AV_CLOSED_STATUS;
      return { row: t, closed, statusIndex: STATUSES.indexOf(statusName) };
    })
    .filter((t) => t.statusIndex !== -1 || t.closed)
    .map(({ row, closed, statusIndex }) => {
      const ticket = {
        id: row.id,
        statusIndex: closed ? null : statusIndex,
        subject: row.summary || '',
        assignee: row.assignedAppUser || null,
        // Within a status: soonest event first (AV), otherwise oldest ticket first.
        sortKey: row.createTime * 1000,
        boardValues: row.attributeValues || [],
      };
      if (closed) ticket.closed = true;
      if (av) {
        const value = attributeValue(row.attributeValues, eventDateId);
        ticket.eventDate = value ? new Date(value).toISOString() : null;
        ticket.sortKey = value || Infinity; // no date sorts last
        ticket.requester = row.requester || null;
      }
      return ticket;
    })
    // Closed tickets only matter if one of their days is on the calendar
    // (recurring days only count here if the board has those columns).
    .filter((t) => !t.closed || inRange(t.sortKey) || (recurringMs(t) || []).some(inRange))
    .sort((a, b) => !!a.closed - !!b.closed || a.statusIndex - b.statusIndex || a.sortKey - b.sortKey);

  const details = await mapLimit(tickets, DETAIL_CONCURRENCY, (t) =>
    ticketDetails(t.id, technicianNames, { withMarkers: !t.closed })
  );
  const needsInfo = av ? calendarSync.needsInfoIds() : new Set();
  tickets.forEach((t, i) => {
    Object.assign(t, details[i].extras);
    t.detailValues = details[i].attributeValues;
    const text = (field) => (field ? field.text(read(t, field)) : null);
    t.location = text(fields.location);
    if (av) {
      t.startTime = text(fields.startTime);
      t.endTime = text(fields.endTime);
      // Extra days besides the event date itself.
      const eventMs = t.eventDate ? Date.parse(t.eventDate) : null;
      t.recurringDates = (recurringMs(t) || []).filter((ms) => ms !== eventMs).map((ms) => new Date(ms).toISOString());
    }
    delete t.boardValues;
    delete t.detailValues;
    delete t.sortKey;
    if (av) t.needsInfoMarker = needsInfo.has(t.id);
  });
  return { ok: true, count: tickets.filter((t) => !t.closed).length, tickets };
}

async function getStats() {
  const [boards, technicians, allAttributes] = await Promise.all([
    ninja.get('/v2/ticketing/trigger/boards'),
    ninja.get('/v2/user/technicians'),
    // Field definitions, for AV fields that aren't board columns and for
    // dropdown option names; not fatal if it fails.
    ninja.get('/v2/ticketing/attributes').catch((err) => {
      console.warn(`[tickets] Could not list ticket fields: ${err.message}`);
      return [];
    }),
  ]);
  const technicianNames = new Map(
    technicians.map((t) => [t.id, [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email])
  );
  const attributeList = Array.isArray(allAttributes) ? allAttributes : [];
  const [it, av] = await Promise.all([
    loadBoard(boards, technicianNames, IT_BOARD, { fieldNames: IT_FIELDS, allAttributes: attributeList }),
    loadBoard(boards, technicianNames, AV_BOARD, { av: true, fieldNames: AV_FIELDS, allAttributes: attributeList }),
  ]);
  return { ok: true, statuses: STATUSES, it, av };
}

module.exports = { getStats };
