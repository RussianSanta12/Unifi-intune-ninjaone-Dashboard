// NinjaOne ticketing connector — open IT and AV support requests.
//
// Reads two ticket boards that already exist in NinjaOne, each filtered to
// one ticket form ("IT Support Request" / "AV Support Request"). Running a
// board returns the assignee's name and the board's custom-field columns, so
// one paginated call per board gets everything — no per-ticket lookups.
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

async function loadBoard(boards, boardName, { eventDateField } = {}) {
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

  tickets.forEach((t) => delete t.sortKey);
  return { ok: true, count: tickets.length, tickets };
}

async function getStats() {
  const boards = await ninja.get('/v2/ticketing/trigger/boards');
  const [it, av] = await Promise.all([
    loadBoard(boards, IT_BOARD),
    loadBoard(boards, AV_BOARD, { eventDateField: AV_EVENT_DATE_FIELD }),
  ]);
  return { ok: true, statuses: STATUSES, it, av };
}

module.exports = { getStats };
