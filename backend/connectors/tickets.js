// NinjaOne ticketing connector — the page's two ticket panels.
//
// Reads two ticket boards that already exist in NinjaOne, each filtered to
// one ticket form: the list panel's (e.g. "IT Support Requests") and the
// calendar panel's (e.g. "AV Support Requests"). Which boards, fields and
// titles is per department, from .env via ../lib/panels.js. Running a
// board returns the assignee's name, the requester's name and the board's
// custom-field columns in one paginated call per board.
//
// Each shown ticket also gets two extra calls — its details (primary and
// additional assignee IDs, every form field) and its log (comments, notes,
// status changes) — to work out the comment markers; see commentMarkers()
// for the rules. Closed calendar-panel tickets get the details call only.
// Calendar-panel tickets that fail the calendar check (missing or
// unreadable event details) also get a "needs info" marker; see
// ./calendarSync.js.
//
// Boards, fields and statuses are matched by their display names (set in
// .env, defaults below), so renaming one in NinjaOne means updating .env to
// match.

const ninja = require('../lib/ninja');
const calendarSync = require('./calendarSync');
const { isCheckComment } = require('../lib/calendarCheck');
const { isChecked, parseRecurringDays } = require('../lib/recurringDays');
const panels = require('../lib/panels');

// Order matters: tickets sort by this order, and the frontend colors by position.
const STATUSES = (process.env.NINJAONE_TICKET_STATUSES || 'New,In Progress,Added to Calendar')
  .split(',')
  .map((s) => s.trim());
// Calendar panel only: closed tickets stay on the calendar (shown brown).
// Only ones whose event falls in the calendar's range are kept, and they skip
// the log call since closed tickets show no markers.
const CLOSED_RANGE_PAD_DAYS = 7; // the grid spills up to 6 days into the neighboring months
// Form fields sent for each ticket (see ../lib/panels.js). These don't need
// to be board columns; anything the board lacks is read from the ticket's
// details. The calendar panel's event date is read separately: it must be a
// board column, for sorting and range filtering.
const { date: CALENDAR_DATE_FIELD, ...CALENDAR_FIELDS } = panels.calendar.fields;
const LIST_FIELDS = panels.list.fields;

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
// automatic status flip on an email reply can't hide the marker. The
// calendar sync's own "[Calendar check]" notes never count as comments.
function commentMarkers(log, assigneeId) {
  const comments = log.filter((e) => e.type === 'COMMENT' && !e.system && !isCheckComment(e));
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

// Open tickets: assignees + comment markers. Closed tickets (withMarkers
// false) only need the form fields, so they skip the log call.
async function ticketDetails(id, technicianNames, { withMarkers }) {
  const [detail, log] = await Promise.all([
    ninja.get(`/v2/ticketing/ticket/${id}`),
    withMarkers ? ninja.get(`/v2/ticketing/ticket/${id}/log-entry`) : null,
  ]);
  // Every field on the ticket's form, for fields the board has no column for.
  const attributeValues = detail.attributeValues || [];
  const assigneeId = detail.assignedAppUserId ?? null;
  // The board only names the assignee if it has an Assignee column (the
  // Maintenance boards don't); the details always have the ID.
  const assignee = assigneeId == null ? null : technicianNames.get(assigneeId) || `Technician #${assigneeId}`;
  if (!withMarkers) return { extras: { assignee }, attributeValues };
  return {
    extras: {
      assignee,
      unassigned: assigneeId == null,
      additionalAssignees: (detail.additionalAssignedTechnicianIds || [])
        .filter((tid) => tid !== assigneeId)
        .map((tid) => technicianNames.get(tid) || `Technician #${tid}`),
      ...commentMarkers(Array.isArray(log) ? log : [], assigneeId),
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
// ticket; empty names are fields the department doesn't use. `av` (the
// calendar panel) turns on the extras: event date, closed tickets, the weekly
// calendar's times, recurring days and attendees.
async function loadBoard(boards, technicianNames, boardName, { av = false, fieldNames = {}, allAttributes = [] } = {}) {
  const board = boards.find((b) => b.name === boardName);
  if (!board) {
    return { ok: false, error: `No NinjaOne board named "${boardName}" (check .env)` };
  }

  const { rows, attributes } = await ninja.runBoard(board.id);

  let eventDateId = null;
  if (av) {
    eventDateId = Object.keys(attributes).find((id) => attributes[id].name === CALENDAR_DATE_FIELD);
    if (!eventDateId) {
      return { ok: false, error: `Board "${boardName}" has no "${CALENDAR_DATE_FIELD}" column (check .env)` };
    }
  }
  const lookup = fieldLookup(attributes, allAttributes);
  const fields = Object.fromEntries(
    Object.entries(fieldNames)
      .filter(([, name]) => name) // not used by this department
      .map(([key, name]) => [key, lookup(name)])
  );
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
      const closed = av && statusName === panels.calendar.closedStatus;
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
    if (fields.neededBy) {
      const ms = Number(read(t, fields.neededBy));
      t.neededBy = ms ? new Date(ms).toISOString() : null;
    }
    if (av) {
      t.startTime = text(fields.startTime);
      t.endTime = text(fields.endTime);
      if (fields.attendees) t.attendees = text(fields.attendees);
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

// The page's titles, sent with every poll so the HTML has nothing
// department-specific in it.
function titles() {
  return {
    dashboard: panels.dashboardTitle,
    list: panels.list.title,
    calendar: panels.calendar.title,
    week: panels.calendar.weekTitle,
  };
}

async function getStats() {
  const [boards, technicians, allAttributes] = await Promise.all([
    ninja.get('/v2/ticketing/trigger/boards'),
    ninja.get('/v2/user/technicians'),
    // Field definitions, for fields that aren't board columns and for
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
  // `it` / `av` are the list and calendar panels (named for the first department).
  const [it, av] = await Promise.all([
    loadBoard(boards, technicianNames, panels.list.board, { fieldNames: LIST_FIELDS, allAttributes: attributeList }),
    loadBoard(boards, technicianNames, panels.calendar.board, { av: true, fieldNames: CALENDAR_FIELDS, allAttributes: attributeList }),
  ]);
  return { ok: true, statuses: STATUSES, labels: titles(), listScroll: panels.list.scroll, it, av };
}

module.exports = { getStats };
