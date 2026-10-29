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
    unassigned: assigneeId == null,
    additionalAssignees: (detail.additionalAssignedTechnicianIds || [])
      .filter((tid) => tid !== assigneeId)
      .map((tid) => technicianNames.get(tid) || `Technician #${tid}`),
    ...commentMarkers(Array.isArray(log) ? log : [], assigneeId),
  };
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

async function loadBoard(boards, technicianNames, boardName, { eventDateField } = {}) {
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

  const tickets = rows
    .map((t) => ({ ...t, statusIndex: STATUSES.indexOf(t.status && t.status.displayName) }))
    .filter((t) => t.statusIndex !== -1)
    .map((t) => {
      const ticket = {
        id: t.id,
        statusIndex: t.statusIndex,
        subject: t.summary || '',
        assignee: t.assignedAppUser || null,
        // Within a status: soonest event first (AV), otherwise oldest ticket first.
        sortKey: t.createTime * 1000,
      };
      if (eventDateId) {
        const value = (t.attributeValues || []).find((v) => String(v.attributeId) === eventDateId);
        ticket.eventDate = value && value.value ? new Date(value.value).toISOString() : null;
        ticket.sortKey = value && value.value ? value.value : Infinity; // no date sorts last
      }
      return ticket;
    })
    .sort((a, b) => a.statusIndex - b.statusIndex || a.sortKey - b.sortKey);

  const extras = await mapLimit(tickets, DETAIL_CONCURRENCY, (t) => ticketExtras(t.id, technicianNames));
  tickets.forEach((t, i) => {
    delete t.sortKey;
    Object.assign(t, extras[i]);
  });
  return { ok: true, count: tickets.length, tickets };
}

async function getStats() {
  const [boards, technicians] = await Promise.all([
    ninja.get('/v2/ticketing/trigger/boards'),
    ninja.get('/v2/user/technicians'),
  ]);
  const technicianNames = new Map(
    technicians.map((t) => [t.id, [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email])
  );
  const [it, av] = await Promise.all([
    loadBoard(boards, technicianNames, IT_BOARD),
    loadBoard(boards, technicianNames, AV_BOARD, { eventDateField: AV_EVENT_DATE_FIELD }),
  ]);
  return { ok: true, statuses: STATUSES, it, av };
}

module.exports = { getStats };
