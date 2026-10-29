// AV ticket → events calendar sync. Runs on the aggregator's timer.
//
// For every AV Support Request still in "New":
//   1. read its event date and free-text start/end times (../lib/eventTime);
//   2. put it on the shared events calendar (Microsoft Graph), starting at
//      the setup time when one is given;
//   3. set the ticket to "Added to Calendar" and assign it by the event's
//      weekday: Mon–Wed and Thu–Sun each go to one technician (.env).
// Tickets whose times can't be read stay in "New", get the "needs info"
// marker on the dashboard, and are retried every CALENDAR_SYNC_RETRY_HOURS.
//
// CALENDAR_SYNC_DRY_RUN (default true) logs what would happen without
// touching the calendar or tickets, and needs only the read-only credentials.
//
// Safe to re-run after a failure: each event carries its ticket ID, so a
// ticket whose update failed finds its existing event next time instead of
// creating a second one. After each update the ticket is read back; if its
// custom fields didn't survive, the sync stops until restarted.

const fs = require('fs');
const path = require('path');
const ninja = require('../lib/ninja');
const ninjaWebAuth = require('../lib/ninjaWebAuth');
const graph = require('../lib/graph');
const { eventWindow } = require('../lib/eventTime');

const AV_BOARD = process.env.NINJAONE_AV_BOARD || 'AV Support Requests';
const DATE_FIELD = process.env.NINJAONE_AV_EVENT_DATE_FIELD || 'Date of Event / Program';
const START_FIELD = process.env.NINJAONE_AV_START_TIME_FIELD || 'Event Start Time';
const END_FIELD = process.env.NINJAONE_AV_END_TIME_FIELD || 'End Time';
const LOCATION_FIELD = process.env.NINJAONE_AV_LOCATION_FIELD || 'Location(IT)';
const FROM_STATUS = process.env.CALENDAR_SYNC_FROM_STATUS || 'New';
const TO_STATUS = process.env.CALENDAR_SYNC_TO_STATUS || 'Added to Calendar';
const ASSIGNEE_MON_WED = Number(process.env.CALENDAR_SYNC_ASSIGNEE_MON_WED) || null; // NinjaOne technician ID
const ASSIGNEE_THU_SUN = Number(process.env.CALENDAR_SYNC_ASSIGNEE_THU_SUN) || null;
const MAILBOX = process.env.CALENDAR_MAILBOX;
const TIME_ZONE = process.env.CALENDAR_TIME_ZONE || 'America/New_York';
const RETRY_MS = (Number(process.env.CALENDAR_SYNC_RETRY_HOURS) || 24) * 3_600_000;
const DRY_RUN = process.env.CALENDAR_SYNC_DRY_RUN !== 'false';
const INSTANCE_URL = process.env.NINJAONE_INSTANCE_URL;

// Custom property stamped on each event so it can be found by ticket ID.
const TICKET_PROP = 'String {6f1c2d8e-3b7a-4c55-9e0f-a1d4b2c39e71} Name NinjaOneTicketId';
const SYNCED_KEEP_MS = 60 * 24 * 3_600_000; // forget synced tickets after 60 days

const STATE_FILE = path.join(__dirname, '..', 'data', 'calendar-sync.json');
// needsInfo: ticketId -> { reason, since, nextAttemptAt }
// synced:    ticketId -> { at, eventId }   (at = when the sync changed its status)
const state = loadState();

let running = false;
let halted = null; // set when an update damaged a ticket; stops all writes
let lastResult = { ok: false, error: 'Not yet run' };
const announced = new Map(); // ticketId -> last dry-run plan logged, to keep the log quiet

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { needsInfo: saved.needsInfo || {}, synced: saved.synced || {} };
  } catch {
    return { needsInfo: {}, synced: {} };
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// For the ticket panels: tickets showing the "needs info" marker, and when
// the sync changed a ticket's status (so that change doesn't clear its
// comment markers).
function needsInfoIds() {
  return new Set(Object.keys(state.needsInfo).map(Number));
}

function syncedAt(ticketId) {
  const entry = state.synced[ticketId];
  return entry ? entry.at : null;
}

function assigneeFor(weekday) {
  return weekday >= 1 && weekday <= 3 ? ASSIGNEE_MON_WED : ASSIGNEE_THU_SUN; // 0 = Sunday
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function displayValue(attr, value) {
  if (value === null || value === undefined || value === '') return null;
  switch (attr.attributeType) {
    case 'DROPDOWN': {
      const option = (attr.content.values || []).find((v) => v.id === value);
      return option ? option.name : String(value);
    }
    case 'CHECKBOX':
      return value ? 'Yes' : 'No';
    case 'DATE':
      return new Date(value).toLocaleDateString('en-US', { timeZone: TIME_ZONE, dateStyle: 'full' });
    default:
      return String(value);
  }
}

// The ticket's custom fields as [{ name, raw, text }], in form order.
function ticketFields(detail, attrsById) {
  return (detail.attributeValues || [])
    .map((v) => {
      const attr = attrsById.get(v.attributeId);
      return attr ? { name: attr.name, raw: v.value, text: displayValue(attr, v.value) } : null;
    })
    .filter(Boolean);
}

function buildEvent(detail, fields, window, assigneeName) {
  const field = (name) => fields.find((f) => f.name === name);
  const location = field(LOCATION_FIELD);
  const ticketUrl = `${INSTANCE_URL}/#/ticketing/ticket/${detail.id}`;
  const rows = fields
    .filter((f) => f.text !== null)
    .map((f) => `<tr><td><b>${escapeHtml(f.name)}</b></td><td>${escapeHtml(f.text)}</td></tr>`)
    .join('');
  return {
    subject: detail.subject,
    start: { dateTime: window.start.toISOString().replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: window.end.toISOString().replace('Z', ''), timeZone: 'UTC' },
    location: location && location.text ? { displayName: location.text } : undefined,
    body: {
      contentType: 'HTML',
      content:
        `<p><a href="${escapeHtml(ticketUrl)}">NinjaOne ticket #${detail.id}</a> — assigned to ${escapeHtml(assigneeName)}</p>` +
        `<table>${rows}</table>`,
    },
    transactionId: `ninjaone-ticket-${detail.id}`,
    singleValueExtendedProperties: [{ id: TICKET_PROP, value: String(detail.id) }],
  };
}

async function findEvent(ticketId) {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${TICKET_PROP}' and ep/value eq '${ticketId}')`;
  const res = await graph.get(
    `/users/${encodeURIComponent(MAILBOX)}/events?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`
  );
  return (res.value || [])[0] || null;
}

// UpdateTicket requires the full ticket plus its current version; sending
// the custom fields back unchanged keeps the update from clearing them.
function updateBody(detail, statusId, assigneeId) {
  return {
    version: detail.version,
    clientId: detail.clientId,
    ticketFormId: detail.ticketFormId,
    locationId: detail.locationId,
    nodeId: detail.nodeId,
    subject: detail.subject,
    status: String(statusId),
    type: detail.type,
    cc: detail.ccList,
    assignedAppUserId: assigneeId,
    requesterUid: detail.requesterUid,
    severity: detail.severity,
    priority: detail.priority,
    parentTicketId: detail.parentTicketId,
    tags: detail.tags,
    attributes: (detail.attributeValues || []).map(({ id, attributeId, value }) => ({ id, attributeId, value })),
    additionalAssignedTechnicianIds: detail.additionalAssignedTechnicianIds,
    followupTime: detail.followupTime,
  };
}

// Read the ticket back: status and assignee changed, custom fields intact.
async function verifyUpdate(before, statusId, assigneeId) {
  const after = await ninja.get(`/v2/ticketing/ticket/${before.id}`);
  const problems = [];
  if (!after.status || after.status.statusId !== statusId) problems.push('status did not change');
  if (after.assignedAppUserId !== assigneeId) problems.push('assignee did not change');
  const afterValues = new Map((after.attributeValues || []).map((v) => [v.attributeId, v.value]));
  for (const v of before.attributeValues || []) {
    if (v.value !== null && String(afterValues.get(v.attributeId)) !== String(v.value)) {
      problems.push(`custom field ${v.attributeId} changed from ${JSON.stringify(v.value)} to ${JSON.stringify(afterValues.get(v.attributeId))}`);
    }
  }
  return problems;
}

function configError() {
  if (DRY_RUN) return null;
  if (halted) return halted;
  const missing = [];
  if (!graph.isConfigured()) missing.push('CALENDAR_TENANT_ID / CALENDAR_CLIENT_ID / CALENDAR_CLIENT_SECRET');
  if (!MAILBOX) missing.push('CALENDAR_MAILBOX');
  if (!ASSIGNEE_MON_WED || !ASSIGNEE_THU_SUN) missing.push('CALENDAR_SYNC_ASSIGNEE_MON_WED / _THU_SUN');
  if (!ninjaWebAuth.isConfigured()) missing.push('NINJAONE_WEB_CLIENT_ID / NINJAONE_WEB_CLIENT_SECRET');
  if (missing.length) return `Calendar sync not configured: ${missing.join(', ')} (check .env)`;
  if (!ninjaWebAuth.isConnected()) {
    return `NinjaOne write access not connected — open http://localhost:${process.env.PORT || 3000}/auth/ninjaone/start on the server`;
  }
  return null;
}

async function syncTicket(row, ctx, result) {
  const id = row.id;
  const waiting = state.needsInfo[id];
  if (waiting && Date.now() < waiting.nextAttemptAt) return;

  const detail = await ninja.get(`/v2/ticketing/ticket/${id}`);
  const fields = ticketFields(detail, ctx.attrsById);
  const raw = (name) => {
    const f = fields.find((x) => x.name === name);
    return f ? f.raw : null;
  };
  const window = eventWindow({
    dateMs: Number(raw(DATE_FIELD)) || NaN,
    startText: raw(START_FIELD),
    endText: raw(END_FIELD),
    timeZone: TIME_ZONE,
  });

  if (!window.ok) {
    state.needsInfo[id] = { reason: window.reason, since: waiting ? waiting.since : Date.now(), nextAttemptAt: Date.now() + RETRY_MS };
    ctx.changed = true;
    console.log(`[calendarSync] #${id} needs info: ${window.reason} (retrying in ${RETRY_MS / 3_600_000}h)`);
    return;
  }
  if (waiting) {
    delete state.needsInfo[id];
    ctx.changed = true;
  }

  const assigneeId = assigneeFor(window.weekday);
  const assigneeName = ctx.technicianNames.get(assigneeId) || (assigneeId ? `Technician #${assigneeId}` : 'nobody (set CALENDAR_SYNC_ASSIGNEE_*)');
  const plan = {
    id,
    subject: detail.subject,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    assignee: assigneeName,
  };

  if (DRY_RUN) {
    result.planned.push(plan);
    const signature = JSON.stringify(plan);
    if (announced.get(id) !== signature) {
      announced.set(id, signature);
      const when = (d) => new Date(d).toLocaleString('en-US', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });
      console.log(`[calendarSync] DRY RUN #${id} "${detail.subject}": would add ${when(plan.start)} – ${when(plan.end)}, assign ${assigneeName}, set "${TO_STATUS}"`);
    }
    return;
  }

  const existing = await findEvent(id);
  const event = existing || (await graph.post(`/users/${encodeURIComponent(MAILBOX)}/events`, buildEvent(detail, fields, window, assigneeName)));

  await ninja.write.put(`/v2/ticketing/ticket/${id}`, updateBody(detail, ctx.toStatusId, assigneeId));
  state.synced[id] = { at: Date.now() / 1000, eventId: event.id };
  ctx.changed = true;

  const problems = await verifyUpdate(detail, ctx.toStatusId, assigneeId);
  if (problems.length) {
    halted = `Calendar sync stopped after updating ticket #${id}: ${problems.join('; ')}. Check the ticket in NinjaOne, then restart the backend.`;
    throw new Error(halted);
  }
  result.synced.push(plan);
  console.log(`[calendarSync] #${id} added to calendar${existing ? ' (event already existed)' : ''}, assigned ${assigneeName}`);
}

async function run() {
  const error = configError();
  if (error) return { ok: false, error };

  const [boards, statuses, attributes, technicians] = await Promise.all([
    ninja.get('/v2/ticketing/trigger/boards'),
    ninja.get('/v2/ticketing/statuses'),
    ninja.get('/v2/ticketing/attributes'),
    ninja.get('/v2/user/technicians'),
  ]);

  const board = boards.find((b) => b.name === AV_BOARD);
  if (!board) return { ok: false, error: `No NinjaOne board named "${AV_BOARD}" (check .env)` };
  const toStatus = statuses.find((s) => s.displayName === TO_STATUS);
  if (!toStatus) return { ok: false, error: `No NinjaOne status named "${TO_STATUS}" (check .env)` };

  const ctx = {
    toStatusId: toStatus.statusId,
    attrsById: new Map(attributes.map((a) => [a.id, a])),
    technicianNames: new Map(technicians.map((t) => [t.id, [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email])),
    changed: false,
  };

  const { rows } = await ninja.runBoard(board.id);
  const candidates = rows.filter((t) => t.status && t.status.displayName === FROM_STATUS);

  // Tickets handled by hand (or deleted) no longer need the marker or retries.
  const candidateIds = new Set(candidates.map((t) => String(t.id)));
  for (const id of Object.keys(state.needsInfo)) {
    if (!candidateIds.has(id)) {
      delete state.needsInfo[id];
      ctx.changed = true;
    }
  }
  for (const [id, entry] of Object.entries(state.synced)) {
    if (Date.now() / 1000 - entry.at > SYNCED_KEEP_MS / 1000) {
      delete state.synced[id];
      ctx.changed = true;
    }
  }

  const result = { ok: true, dryRun: DRY_RUN, planned: [], synced: [], errors: [] };
  try {
    // One at a time: there are only a few new AV tickets, and a failure
    // partway should leave as little half-done as possible.
    for (const row of candidates) {
      try {
        await syncTicket(row, ctx, result);
      } catch (err) {
        if (halted) throw err;
        result.errors.push({ id: row.id, error: err.message });
        console.error(`[calendarSync] #${row.id} failed: ${err.message}`);
      }
    }
  } finally {
    if (ctx.changed) saveState();
  }

  result.needsInfo = Object.entries(state.needsInfo).map(([id, v]) => ({
    id: Number(id),
    reason: v.reason,
    nextAttemptAt: new Date(v.nextAttemptAt).toISOString(),
  }));
  return result;
}

async function getStats() {
  if (running) return lastResult; // previous run still going — don't double-book
  running = true;
  try {
    lastResult = { ...(await run()), lastRunAt: new Date().toISOString() };
  } finally {
    running = false;
  }
  return lastResult;
}

module.exports = { getStats, needsInfoIds, syncedAt };
