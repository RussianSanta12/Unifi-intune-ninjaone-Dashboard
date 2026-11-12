// AV ticket → events calendar sync. Runs on the aggregator's timer.
//
// For every AV Support Request still in "New":
//   1. read its event date, free-text start/end times (../lib/eventTime) and,
//      if "Reoccurring Event" is ticked, the extra days in "Reoccurring Days"
//      (../lib/recurringDays);
//   2. put each of those days from today on onto the shared events calendar
//      (Microsoft Graph) as its own event, starting at the setup time when
//      one is given. Past days are skipped; a ticket with no days left is
//      left alone;
//   3. set the ticket to "Added to Calendar" and assign it by the main event
//      date's weekday: Mon–Wed and Thu–Sun each go to one technician (.env).
//      If a recurring day falls in the other half of the week, that
//      technician is added as an additional assignee.
// Tickets whose times or recurring days can't be read stay in "New", get the
// "needs info" marker on the dashboard, and are retried every
// CALENDAR_SYNC_RETRY_HOURS.
//
// Once a ticket is "Added to Calendar" the sync never looks at it again, so
// later edits (new days, changed times) are up to staff — see PLAN.md.
//
// CALENDAR_SYNC_DRY_RUN (default true) logs what would happen without
// touching the calendar or tickets, and needs only the read-only credentials.
//
// Safe to re-run after a failure: each event carries its ticket ID and day,
// so a ticket whose update failed finds its existing events next time
// instead of creating second ones. After each update the ticket is read
// back; if its custom fields didn't survive, the sync stops until restarted.

const fs = require('fs');
const path = require('path');
const ninja = require('../lib/ninja');
const ninjaWebAuth = require('../lib/ninjaWebAuth');
const graph = require('../lib/graph');
const { eventWindow, dayKey } = require('../lib/eventTime');
const { isChecked, parseRecurringDays } = require('../lib/recurringDays');

const AV_BOARD = process.env.NINJAONE_AV_BOARD || 'AV Support Requests';
const DATE_FIELD = process.env.NINJAONE_AV_EVENT_DATE_FIELD || 'Date of Event / Program';
const START_FIELD = process.env.NINJAONE_AV_START_TIME_FIELD || 'Event Start Time';
const END_FIELD = process.env.NINJAONE_AV_END_TIME_FIELD || 'End Time';
const LOCATION_FIELD = process.env.NINJAONE_AV_LOCATION_FIELD || 'Location(IT)';
const RECURRING_FIELD = process.env.NINJAONE_AV_RECURRING_FIELD || 'Reoccurring Event';
const RECURRING_DAYS_FIELD = process.env.NINJAONE_AV_RECURRING_DAYS_FIELD || 'Reoccurring Days';
const FROM_STATUS = process.env.CALENDAR_SYNC_FROM_STATUS || 'New';
const TO_STATUS = process.env.CALENDAR_SYNC_TO_STATUS || 'Added to Calendar';
const ASSIGNEE_MON_WED = Number(process.env.CALENDAR_SYNC_ASSIGNEE_MON_WED) || null; // NinjaOne technician ID
const ASSIGNEE_THU_SUN = Number(process.env.CALENDAR_SYNC_ASSIGNEE_THU_SUN) || null;
const MAILBOX = process.env.CALENDAR_MAILBOX;
const TIME_ZONE = process.env.CALENDAR_TIME_ZONE || 'America/New_York';
const RETRY_MS = (Number(process.env.CALENDAR_SYNC_RETRY_HOURS) || 24) * 3_600_000;
const DRY_RUN = process.env.CALENDAR_SYNC_DRY_RUN !== 'false';
const INSTANCE_URL = process.env.NINJAONE_INSTANCE_URL;

// Custom property stamped on each event ("<ticket id>:<YYYY-MM-DD>") so it
// can be found again by ticket and day.
const TICKET_PROP = 'String {6f1c2d8e-3b7a-4c55-9e0f-a1d4b2c39e71} Name NinjaOneTicketDay';
const SYNCED_KEEP_MS = 60 * 24 * 3_600_000; // forget synced tickets after 60 days

const STATE_FILE = path.join(__dirname, '..', 'data', 'calendar-sync.json');
// needsInfo: ticketId -> { reason, since, nextAttemptAt }
// synced:    ticketId -> { at, eventIds }   (at = when the sync changed its status)
const state = loadState();

let running = false;
let halted = null; // set when an update damaged a ticket; stops all writes
let lastResult = { ok: false, error: 'Not yet run' };
const announced = new Map(); // ticketId -> last dry-run plan / skip logged, to keep the log quiet

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

const formatDay = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' });
const formatWhen = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' });

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

// One event per day; `days` is every day being scheduled, for the body.
function buildEvent(detail, fields, window, days, assigneeNames) {
  const field = (name) => fields.find((f) => f.name === name);
  const location = field(LOCATION_FIELD);
  const ticketUrl = `${INSTANCE_URL}/#/ticketing/ticket/${detail.id}`;
  const rows = fields
    .filter((f) => f.text !== null)
    .map((f) => `<tr><td><b>${escapeHtml(f.name)}</b></td><td>${escapeHtml(f.text)}</td></tr>`)
    .join('');
  const series =
    days.length > 1
      ? `<p>Recurring event — day ${days.indexOf(window) + 1} of ${days.length}: ${days.map((d) => escapeHtml(formatDay(d.start))).join(', ')}</p>`
      : '';
  return {
    subject: detail.subject,
    start: { dateTime: window.start.toISOString().replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: window.end.toISOString().replace('Z', ''), timeZone: 'UTC' },
    location: location && location.text ? { displayName: location.text } : undefined,
    body: {
      contentType: 'HTML',
      content:
        `<p><a href="${escapeHtml(ticketUrl)}">NinjaOne ticket #${detail.id}</a> — assigned to ${escapeHtml(assigneeNames)}</p>` +
        series +
        `<table>${rows}</table>`,
    },
    transactionId: `ninjaone-ticket-${detail.id}-${window.day}`,
    singleValueExtendedProperties: [{ id: TICKET_PROP, value: `${detail.id}:${window.day}` }],
  };
}

async function findEvent(ticketId, day) {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${TICKET_PROP}' and ep/value eq '${ticketId}:${day}')`;
  const res = await graph.get(
    `/users/${encodeURIComponent(MAILBOX)}/events?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`
  );
  return (res.value || [])[0] || null;
}

// UpdateTicket requires the full ticket plus its current version; sending
// the custom fields back unchanged keeps the update from clearing them.
function updateBody(detail, statusId, assigneeId, additionalIds) {
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
    additionalAssignedTechnicianIds: additionalIds,
    followupTime: detail.followupTime,
  };
}

// Read the ticket back: status and assignees changed, custom fields intact.
async function verifyUpdate(before, statusId, assigneeId, additionalIds) {
  const after = await ninja.get(`/v2/ticketing/ticket/${before.id}`);
  const problems = [];
  if (!after.status || after.status.statusId !== statusId) problems.push('status did not change');
  if (after.assignedAppUserId !== assigneeId) problems.push('assignee did not change');
  const afterAdditional = new Set(after.additionalAssignedTechnicianIds || []);
  if (additionalIds.some((tid) => !afterAdditional.has(tid))) problems.push('additional assignees did not change');
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

// Every day to schedule, as eventWindow results, or { problem } when the
// times or recurring days can't be read.
function eventDays(fields) {
  const raw = (name) => {
    const f = fields.find((x) => x.name === name);
    return f ? f.raw : null;
  };
  const times = { startText: raw(START_FIELD), endText: raw(END_FIELD), timeZone: TIME_ZONE };
  const dateMs = Number(raw(DATE_FIELD)) || NaN;
  const main = eventWindow({ dateMs, ...times });
  if (!main.ok) return { problem: main.reason };

  let extra = [];
  if (isChecked(raw(RECURRING_FIELD))) {
    const parsed = parseRecurringDays(raw(RECURRING_DAYS_FIELD), dateMs);
    if (parsed.bad.length) {
      return { problem: `Can't read recurring day(s) ${parsed.bad.map((b) => `"${b}"`).join(', ')} — use month:day, e.g. "11:4, 11:16"` };
    }
    if (!parsed.days.length) return { problem: `"${RECURRING_FIELD}" is ticked but "${RECURRING_DAYS_FIELD}" is empty` };
    extra = parsed.days.map((ms) => eventWindow({ dateMs: ms, ...times }));
  }

  const byDay = new Map();
  for (const w of [main, ...extra]) byDay.set(w.day, w);
  return { main, days: [...byDay.values()].sort((a, b) => a.start - b.start) };
}

async function syncTicket(row, ctx, result) {
  const id = row.id;
  const waiting = state.needsInfo[id];
  if (waiting && Date.now() < waiting.nextAttemptAt) return;

  const detail = await ninja.get(`/v2/ticketing/ticket/${id}`);
  const fields = ticketFields(detail, ctx.attrsById);
  const parsed = eventDays(fields);

  if (parsed.problem) {
    state.needsInfo[id] = { reason: parsed.problem, since: waiting ? waiting.since : Date.now(), nextAttemptAt: Date.now() + RETRY_MS };
    ctx.changed = true;
    console.log(`[calendarSync] #${id} needs info: ${parsed.problem} (retrying in ${RETRY_MS / 3_600_000}h)`);
    return;
  }
  if (waiting) {
    delete state.needsInfo[id];
    ctx.changed = true;
  }

  const today = dayKey(Date.now(), TIME_ZONE);
  const days = parsed.days.filter((w) => w.day >= today);
  if (!days.length) {
    result.skipped.push({ id, reason: 'every event day is in the past' });
    if (announced.get(id) !== 'past') {
      announced.set(id, 'past');
      console.log(`[calendarSync] #${id} "${detail.subject}": every event day is in the past — leaving it alone`);
    }
    return;
  }

  // Primary by the main date; anyone covering another day joins as additional.
  const assigneeId = assigneeFor(parsed.main.weekday);
  const additionalIds = [
    ...new Set([...(detail.additionalAssignedTechnicianIds || []), ...days.map((w) => assigneeFor(w.weekday))]),
  ].filter((tid) => tid && tid !== assigneeId);
  const nameOf = (tid) => ctx.technicianNames.get(tid) || (tid ? `Technician #${tid}` : 'nobody (set CALENDAR_SYNC_ASSIGNEE_*)');
  const assigneeNames = [assigneeId, ...additionalIds].map(nameOf).join(' + ');
  const plan = {
    id,
    subject: detail.subject,
    days: days.map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() })),
    skippedPastDays: parsed.days.length - days.length,
    assignee: nameOf(assigneeId),
    additionalAssignees: additionalIds.map(nameOf),
  };

  if (DRY_RUN) {
    result.planned.push(plan);
    const signature = JSON.stringify(plan);
    if (announced.get(id) !== signature) {
      announced.set(id, signature);
      const when = days.map((w) => `${formatWhen(w.start)} – ${new Date(w.end).toLocaleTimeString('en-US', { timeZone: TIME_ZONE, timeStyle: 'short' })}`);
      const past = plan.skippedPastDays ? ` (skipping ${plan.skippedPastDays} past day(s))` : '';
      console.log(
        `[calendarSync] DRY RUN #${id} "${detail.subject}": would add ${days.length} event(s)${past}: ${when.join('; ')}; assign ${assigneeNames}; set "${TO_STATUS}"`
      );
    }
    return;
  }

  const eventIds = [];
  let created = 0;
  for (const w of days) {
    const existing = await findEvent(id, w.day);
    const event =
      existing ||
      (await graph.post(`/users/${encodeURIComponent(MAILBOX)}/events`, buildEvent(detail, fields, w, days, assigneeNames)));
    if (!existing) created++;
    eventIds.push(event.id);
  }

  await ninja.write.put(`/v2/ticketing/ticket/${id}`, updateBody(detail, ctx.toStatusId, assigneeId, additionalIds));
  state.synced[id] = { at: Date.now() / 1000, eventIds };
  ctx.changed = true;

  const problems = await verifyUpdate(detail, ctx.toStatusId, assigneeId, additionalIds);
  if (problems.length) {
    halted = `Calendar sync stopped after updating ticket #${id}: ${problems.join('; ')}. Check the ticket in NinjaOne, then restart the backend.`;
    throw new Error(halted);
  }
  result.synced.push(plan);
  console.log(`[calendarSync] #${id} added to calendar (${created} new of ${days.length} event(s)), assigned ${assigneeNames}`);
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

  const result = { ok: true, dryRun: DRY_RUN, planned: [], synced: [], skipped: [], errors: [] };
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
