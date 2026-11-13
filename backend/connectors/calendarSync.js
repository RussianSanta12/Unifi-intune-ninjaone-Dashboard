// AV ticket → events calendar: check, approve, then add. Runs on the
// aggregator's timer. The rules live in ../lib/calendarCheck.js; this file
// does the reading and writing.
//
// AV tickets in CALENDAR_SYNC_CHECK_STATUSES (New, In Progress) are checked
// for everything the calendar needs: event date, start/end times with am/pm,
// location, valid recurring days if "Reoccurring Event" is ticked, and at
// least one day from today on.
//   - All there: the sync posts a private "[Calendar check] Approved to be
//     added to calendar" note and assigns the ticket by the main event date's
//     weekday (Mon–Wed / Thu–Sun technicians in .env; whoever covers another
//     recurring day is added as an additional assignee).
//   - Anything missing: it posts a private "Missing info" form listing each
//     problem and the format it needs, and the ticket gets the dashboard's
//     "needs info" marker. Staff fix it in the side panel, or reply with
//     "Field: value" lines, which the sync copies into the ticket's fields.
//     Either way the ticket is checked again and, once it passes, approved.
// When staff set a ticket to CALENDAR_SYNC_ADD_STATUS ("Added to Calendar"),
// it is checked once more; if it passes (re-approving it if it changed since
// the approval) each day goes on the calendar as its own event and an
// "Added to the events calendar" note is posted. Tickets the sync never
// commented on (made before it ran) are left alone, as are ones it already
// added: later edits are up to staff (see PLAN.md, "revisit later").
//
// All state lives in those notes ("Ref:" line, see lib/calendarCheck.js), so
// a restart loses nothing and every step is visible in NinjaOne.
//
// CALENDAR_SYNC_DRY_RUN (default true) logs what would happen without
// writing anything, and needs only the read-only credentials.
//
// Safety: events are tagged with ticket ID + day, so retries never
// double-book; every ticket update is read back, and every note is checked to
// be readable afterwards (else the sync would post it again each poll) — on
// any surprise the sync stops until the backend is restarted.

const ninja = require('../lib/ninja');
const ninjaWebAuth = require('../lib/ninjaWebAuth');
const graph = require('../lib/graph');
const { isChecked } = require('../lib/recurringDays');
const { zonedParts } = require('../lib/eventTime');
const { isCheckComment, entryText, readCheckComment, makeChecker } = require('../lib/calendarCheck');
const panels = require('../lib/panels');

// The calendar panel's board and fields (../lib/panels.js), so the sync and
// the page always agree.
const AV_BOARD = panels.calendar.board;
const FIELD_NAMES = {
  date: panels.calendar.fields.date,
  start: panels.calendar.fields.startTime,
  end: panels.calendar.fields.endTime,
  location: panels.calendar.fields.location,
  recurring: panels.calendar.fields.recurring,
  recurringDays: panels.calendar.fields.recurringDays,
};
const CHECK_STATUSES = (process.env.CALENDAR_SYNC_CHECK_STATUSES || 'New,In Progress').split(',').map((s) => s.trim());
const ADD_STATUS = process.env.CALENDAR_SYNC_ADD_STATUS || 'Added to Calendar';
const ASSIGNEE_MON_WED = Number(process.env.CALENDAR_SYNC_ASSIGNEE_MON_WED) || null; // NinjaOne technician ID
const ASSIGNEE_THU_SUN = Number(process.env.CALENDAR_SYNC_ASSIGNEE_THU_SUN) || null;
const MAILBOX = process.env.CALENDAR_MAILBOX;
const TIME_ZONE = process.env.CALENDAR_TIME_ZONE || 'America/New_York';
const DRY_RUN = process.env.CALENDAR_SYNC_DRY_RUN !== 'false';
const INSTANCE_URL = process.env.NINJAONE_INSTANCE_URL;
// For testing: only these ticket IDs are checked/added (empty = all).
const ONLY_TICKETS = (process.env.CALENDAR_SYNC_ONLY_TICKETS || '').split(',').map(Number).filter(Boolean);

// Custom property stamped on each event ("<ticket id>:<YYYY-MM-DD>") so it
// can be found again by ticket and day.
const TICKET_PROP = 'String {6f1c2d8e-3b7a-4c55-9e0f-a1d4b2c39e71} Name NinjaOneTicketDay';
// Never post more than one note per ticket in this window, whatever happens.
const MIN_NOTE_INTERVAL_MS = 2 * 60_000;

let running = false;
let halted = null; // set on any surprise after a write; stops all writes
let lastResult = { ok: false, error: 'Not yet run' };
let needsInfo = new Set(); // ticket IDs whose check failed on the last run
const settled = new Map(); // ticketId -> status it was settled in (added / never checked), to skip re-reading
const lastNoteAt = new Map(); // ticketId -> ms
const announced = new Map(); // ticketId -> last dry-run line logged, to keep the log quiet

// For the ticket panels: tickets showing the "needs info" marker.
function needsInfoIds() {
  return needsInfo;
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
      return isChecked(value) ? 'Yes' : 'No';
    case 'DATE':
      return new Date(value).toLocaleDateString('en-US', { timeZone: TIME_ZONE, dateStyle: 'full' });
    default:
      return String(value);
  }
}

// The event's details, in this order, as [field name, label]. The recurring
// rows only show for recurring events; any other filled-in field follows
// (except the date, which the calendar already shows).
const EVENT_ROWS = [
  ['Number of Microphones Needed'],
  ['Check if you need IT present for entire time'],
  ['Check if you need the Event Recorded'],
  [FIELD_NAMES.location, 'Location'],
  [FIELD_NAMES.start],
  [FIELD_NAMES.end],
  [FIELD_NAMES.recurring],
  [FIELD_NAMES.recurringDays],
  ['Day of Event Contact Name'],
];

// Outlook names for CALENDAR_TIME_ZONE, so events carry the local zone (sent
// as UTC, the AV Events mailbox showed a 2:30 PM event at 7:30 PM).
const WINDOWS_ZONES = {
  'America/New_York': 'Eastern Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Phoenix': 'US Mountain Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
};

// A Graph dateTimeTimeZone: the wall-clock time in CALENDAR_TIME_ZONE.
function graphTime(date) {
  const p = zonedParts(date.getTime(), TIME_ZONE);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    dateTime: `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00`,
    timeZone: WINDOWS_ZONES[TIME_ZONE] || TIME_ZONE,
  };
}

// The ticket's description: its latest DESCRIPTION log entry.
function descriptionOf(log) {
  const entries = (Array.isArray(log) ? log : []).filter((e) => e.type === 'DESCRIPTION').sort((a, b) => a.createTime - b.createTime);
  return entries.length ? entryText(entries[entries.length - 1]).trim() : '';
}

function buildEvent(detail, ctx, window, check, assigneeNames, description) {
  const ticketUrl = `${INSTANCE_URL}/#/ticketing/ticket/${detail.id}`;
  const valueByName = new Map();
  for (const v of detail.attributeValues || []) {
    const attr = ctx.attrsById.get(v.attributeId);
    const text = attr ? displayValue(attr, v.value) : null;
    if (text !== null) valueByName.set(attr.name, text);
  }
  const recurring = isChecked((detail.attributeValues || []).find((v) => ctx.attrsByRole.recurring && v.attributeId === ctx.attrsByRole.recurring.id)?.value);
  const hidden = new Set([FIELD_NAMES.date, ...(recurring ? [] : [FIELD_NAMES.recurring, FIELD_NAMES.recurringDays])]);
  const listed = new Set(EVENT_ROWS.map(([name]) => name));
  const rows = [...EVENT_ROWS, ...[...valueByName.keys()].filter((name) => !listed.has(name)).map((name) => [name])]
    .filter(([name]) => name && !hidden.has(name) && valueByName.has(name))
    .map(([name, label]) => `<tr><td><b>${escapeHtml(label || name)}</b></td><td>${escapeHtml(valueByName.get(name))}</td></tr>`)
    .join('');
  const series =
    check.days.length > 1
      ? `<p>Recurring event — day ${check.days.indexOf(window) + 1} of ${check.days.length}: ${check.days.map((d) => escapeHtml(ctx.checker.dayText(d))).join('; ')}</p>`
      : '';
  const descriptionHtml = description
    ? `<p><b>Description:</b><br>${escapeHtml(description).replace(/\n/g, '<br>')}</p>`
    : '';
  return {
    subject: detail.subject,
    start: graphTime(window.start),
    end: graphTime(window.end),
    location: { displayName: check.location },
    body: {
      contentType: 'HTML',
      content:
        `<p><a href="${escapeHtml(ticketUrl)}">NinjaOne ticket #${detail.id}</a> — assigned to ${escapeHtml(assigneeNames)}</p>` +
        series +
        `<table>${rows}</table>` +
        descriptionHtml,
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

// The ticket's event fields by role, from its details.
function currentValues(detail, ctx) {
  const values = {};
  for (const [role, attr] of Object.entries(ctx.attrsByRole)) {
    const entry = attr && (detail.attributeValues || []).find((v) => v.attributeId === attr.id);
    values[role] = entry ? entry.value : null;
  }
  return values;
}

// UpdateTicket requires the full ticket plus its current version; custom
// fields are sent back unchanged except for `fieldUpdates` ({ attributeId: value }).
function updateBody(detail, { fieldUpdates = {}, assigneeId, additionalIds }) {
  const attributes = (detail.attributeValues || []).map(({ id, attributeId, value }) => ({
    id,
    attributeId,
    value: attributeId in fieldUpdates ? fieldUpdates[attributeId] : value,
  }));
  for (const [attributeId, value] of Object.entries(fieldUpdates)) {
    if (!attributes.some((a) => String(a.attributeId) === attributeId)) attributes.push({ attributeId: Number(attributeId), value });
  }
  return {
    version: detail.version,
    clientId: detail.clientId,
    ticketFormId: detail.ticketFormId,
    locationId: detail.locationId,
    nodeId: detail.nodeId,
    subject: detail.subject,
    status: String(detail.status.statusId),
    type: detail.type,
    cc: detail.ccList,
    assignedAppUserId: assigneeId !== undefined ? assigneeId : detail.assignedAppUserId,
    requesterUid: detail.requesterUid,
    severity: detail.severity,
    priority: detail.priority,
    parentTicketId: detail.parentTicketId,
    tags: detail.tags,
    attributes,
    additionalAssignedTechnicianIds: additionalIds !== undefined ? additionalIds : detail.additionalAssignedTechnicianIds,
    followupTime: detail.followupTime,
  };
}

// Write and read back: the intended changes landed, nothing else moved.
async function updateTicket(detail, changes) {
  await ninja.write.put(`/v2/ticketing/ticket/${detail.id}`, updateBody(detail, changes));
  const after = await ninja.get(`/v2/ticketing/ticket/${detail.id}`);
  const problems = [];
  const fieldUpdates = changes.fieldUpdates || {};
  if (!after.status || after.status.statusId !== detail.status.statusId) problems.push('status changed');
  if (changes.assigneeId !== undefined && after.assignedAppUserId !== changes.assigneeId) problems.push('assignee did not change');
  const afterAdditional = new Set(after.additionalAssignedTechnicianIds || []);
  if ((changes.additionalIds || []).some((tid) => !afterAdditional.has(tid))) problems.push('additional assignees did not change');
  const afterValues = new Map((after.attributeValues || []).map((v) => [String(v.attributeId), v.value]));
  for (const v of detail.attributeValues || []) {
    const id = String(v.attributeId);
    if (id in fieldUpdates || v.value === null) continue;
    if (String(afterValues.get(id)) !== String(v.value)) problems.push(`field ${id} changed from ${JSON.stringify(v.value)} to ${JSON.stringify(afterValues.get(id))}`);
  }
  for (const [id, value] of Object.entries(fieldUpdates)) {
    if (String(afterValues.get(id)) !== String(value)) problems.push(`field ${id} was not set to ${JSON.stringify(value)}`);
  }
  if (problems.length) {
    halted = `Calendar sync stopped after updating ticket #${detail.id}: ${problems.join('; ')}. Check the ticket in NinjaOne, then restart the backend.`;
    throw new Error(halted);
  }
  return after;
}

// Post a private note, then make sure the sync can read it back — otherwise
// it would post the same note again on every poll.
async function postNote(ticketId, body) {
  const last = lastNoteAt.get(ticketId);
  if (last && Date.now() - last < MIN_NOTE_INTERVAL_MS) {
    throw new Error(`#${ticketId}: already posted a note in the last ${MIN_NOTE_INTERVAL_MS / 60_000} minutes — skipping`);
  }
  lastNoteAt.set(ticketId, Date.now());
  await ninja.write.comment(ticketId, { body, isPublic: false });
  const ref = body.match(/Ref: \S+/)[0];
  let found = false;
  for (let attempt = 0; attempt < 3 && !found; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000)); // give the log a moment
    const log = await ninja.get(`/v2/ticketing/ticket/${ticketId}/log-entry`);
    found = (Array.isArray(log) ? log : []).some((e) => e.type === 'COMMENT' && readCheckComment(e) && entryText(e).includes(ref));
  }
  if (!found) {
    halted = `Calendar sync stopped: its note on ticket #${ticketId} can't be read back (looked for "${ref}"). Check the ticket's notes, then restart the backend.`;
    throw new Error(halted);
  }
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

function announce(id, line) {
  if (announced.get(id) === line) return;
  announced.set(id, line);
  console.log(`[calendarSync] ${DRY_RUN ? 'DRY RUN ' : ''}${line}`);
}

async function processTicket(row, ctx, result) {
  const id = row.id;
  const status = row.status && row.status.displayName;
  const isAdd = status === ADD_STATUS;
  if (settled.get(id) === status) return;

  const [detail, rawLog] = await Promise.all([
    ninja.get(`/v2/ticketing/ticket/${id}`),
    ninja.get(`/v2/ticketing/ticket/${id}/log-entry`),
  ]);
  const comments = (Array.isArray(rawLog) ? rawLog : [])
    .filter((e) => e.type === 'COMMENT' && !e.system)
    .sort((a, b) => a.createTime - b.createTime);
  const checks = comments.map(readCheckComment).filter(Boolean);
  const last = checks[checks.length - 1] || null;

  if (isAdd && (!last || last.kind === 'added')) {
    settled.set(id, status); // never checked (before the sync's time), or already added
    return;
  }

  // Replies since the last note: "Field: value" lines go into the ticket.
  const values = currentValues(detail, ctx);
  const fieldUpdates = {};
  const notes = [];
  let replied = false;
  for (const c of comments) {
    if (isCheckComment(c) || (last && c.createTime <= last.time)) continue;
    for (const [role, text] of Object.entries(ctx.checker.readReply(entryText(c)))) {
      replied = true;
      const attr = ctx.attrsByRole[role];
      const parsed = ctx.checker.replyValue(role, text);
      if (parsed.error || !attr) {
        notes.push(`Couldn't use "${FIELD_NAMES[role]}: ${text}" from the reply: ${parsed.error || 'no such field'}.`);
        continue;
      }
      if (String(values[role]) !== String(parsed.value)) {
        values[role] = parsed.value;
        fieldUpdates[attr.id] = parsed.value;
      }
    }
  }
  const hasUpdates = Object.keys(fieldUpdates).length > 0;
  const updateLine = hasUpdates
    ? ` Fill in from reply: ${Object.entries(fieldUpdates).map(([aid, v]) => `${ctx.attrsById.get(Number(aid)).name} = ${JSON.stringify(v)}`).join(', ')}.`
    : '';

  const check = ctx.checker.validate(values);

  if (!check.ok) {
    needsInfo.add(id);
    const current = last && last.kind === 'missing' && last.hash === check.signature;
    if (current && !replied) return;
    const problemText = check.problems.map((p) => `${FIELD_NAMES[p.role]}: ${p.problem}`).join('; ');
    result.missing.push({ id, problems: check.problems });
    announce(id, `#${id} "${detail.subject}" (${status}): missing info — ${problemText}.${updateLine} Post the missing-info form.`);
    if (DRY_RUN) return;
    if (hasUpdates) await updateTicket(detail, { fieldUpdates });
    await postNote(id, ctx.checker.missingNote(check, notes));
    return;
  }

  // Passes: approve (and assign) unless the latest note already approves exactly this.
  const approvedCurrent = last && last.kind === 'approved' && last.hash === check.fingerprint;
  const nameOf = (tid) => ctx.technicianNames.get(tid) || `Technician #${tid}`;
  let assigneeNames = [detail.assignedAppUserId, ...(detail.additionalAssignedTechnicianIds || [])].filter(Boolean).map(nameOf).join(' + ') || 'Unassigned';

  if (!approvedCurrent || hasUpdates) {
    const assigneeId = assigneeFor(check.main.weekday);
    const additionalIds = [
      ...new Set([...(detail.additionalAssignedTechnicianIds || []), ...check.days.map((w) => assigneeFor(w.weekday))]),
    ].filter((tid) => tid && tid !== assigneeId);
    assigneeNames = [assigneeId, ...additionalIds].filter(Boolean).map(nameOf).join(' + ');
    const assignChanged =
      assigneeId !== detail.assignedAppUserId ||
      additionalIds.length !== (detail.additionalAssignedTechnicianIds || []).length ||
      additionalIds.some((tid) => !(detail.additionalAssignedTechnicianIds || []).includes(tid));
    result.approved.push({ id, days: check.days.length, assignee: assigneeNames });
    announce(
      id,
      `#${id} "${detail.subject}" (${status}): approved — ${check.days.map(ctx.checker.dayText).join('; ')} at ${check.location}; assign ${assigneeNames}.${updateLine}`
    );
    if (!DRY_RUN) {
      if (hasUpdates || assignChanged) {
        await updateTicket(detail, { fieldUpdates, ...(assignChanged ? { assigneeId, additionalIds } : {}) });
      }
      await postNote(id, ctx.checker.approvalNote(check, assigneeNames));
      lastNoteAt.delete(id); // the "added" note may follow straight away
    }
  }

  if (!isAdd) return;

  announce(`${id}:add`, `#${id} "${detail.subject}": add ${check.days.length} event(s) to the calendar.`);
  if (DRY_RUN) {
    result.added.push({ id, days: check.days.length });
    return;
  }
  let created = 0;
  for (const w of check.days) {
    if (await findEvent(id, w.day)) continue;
    await graph.post(
      `/users/${encodeURIComponent(MAILBOX)}/events`,
      buildEvent(detail, ctx, w, check, assigneeNames, descriptionOf(rawLog))
    );
    created++;
  }
  await postNote(id, ctx.checker.addedNote(check, created));
  settled.set(id, status);
  result.added.push({ id, days: check.days.length, created });
  console.log(`[calendarSync] #${id} added to calendar (${created} new of ${check.days.length} event(s))`);
}

// The board, fields and technicians the sync works with -> { board, ctx } or { error }.
async function loadContext() {
  const [boards, attributes, technicians] = await Promise.all([
    ninja.get('/v2/ticketing/trigger/boards'),
    ninja.get('/v2/ticketing/attributes'),
    ninja.get('/v2/user/technicians'),
  ]);
  const board = boards.find((b) => b.name === AV_BOARD);
  if (!board) return { error: `No NinjaOne board named "${AV_BOARD}" (check .env)` };

  const attrsByRole = {};
  for (const [role, name] of Object.entries(FIELD_NAMES)) {
    attrsByRole[role] = attributes.find((a) => a.name === name) || null;
  }
  for (const role of ['date', 'start', 'end', 'location']) {
    if (!attrsByRole[role]) return { error: `No ticket field named "${FIELD_NAMES[role]}" (check .env)` };
  }
  const ctx = {
    attrsById: new Map(attributes.map((a) => [a.id, a])),
    attrsByRole,
    technicianNames: new Map(technicians.map((t) => [t.id, [t.firstName, t.lastName].filter(Boolean).join(' ') || t.email])),
    checker: makeChecker({
      labels: FIELD_NAMES,
      timeZone: TIME_ZONE,
      locationOptions: (attrsByRole.location.content.values || []).filter((o) => o.active !== false),
    }),
  };
  return { board, ctx };
}

// The calendar event(s) a ticket would get, built from its current fields,
// without writing anything (npm run sync-once -- --preview <id>).
async function previewEvents(id) {
  const { ctx, error } = await loadContext();
  if (error) throw new Error(error);
  const [detail, rawLog] = await Promise.all([
    ninja.get(`/v2/ticketing/ticket/${id}`),
    ninja.get(`/v2/ticketing/ticket/${id}/log-entry`),
  ]);
  const check = ctx.checker.validate(currentValues(detail, ctx));
  if (!check.ok) return { ok: false, problems: check.problems };
  const assigneeNames =
    [detail.assignedAppUserId, ...(detail.additionalAssignedTechnicianIds || [])]
      .filter(Boolean)
      .map((tid) => ctx.technicianNames.get(tid) || `Technician #${tid}`)
      .join(' + ') || 'Unassigned';
  return { ok: true, events: check.days.map((w) => buildEvent(detail, ctx, w, check, assigneeNames, descriptionOf(rawLog))) };
}

async function run() {
  const error = configError();
  if (error) return { ok: false, error };
  const loaded = await loadContext();
  if (loaded.error) return { ok: false, error: loaded.error };
  const { board, ctx } = loaded;

  const { rows } = await ninja.runBoard(board.id);
  const statusOf = (t) => t.status && t.status.displayName;
  const candidates = rows.filter(
    (t) =>
      (CHECK_STATUSES.includes(statusOf(t)) || statusOf(t) === ADD_STATUS) &&
      (!ONLY_TICKETS.length || ONLY_TICKETS.includes(t.id))
  );
  for (const [id, status] of settled) {
    if (!candidates.some((t) => t.id === id && statusOf(t) === status)) settled.delete(id);
  }

  const result = { ok: true, dryRun: DRY_RUN, approved: [], missing: [], added: [], errors: [] };
  const nextNeedsInfo = new Set();
  const previous = needsInfo;
  needsInfo = nextNeedsInfo; // processTicket adds to it
  // One at a time: few tickets, and a failure partway should leave as
  // little half-done as possible.
  for (const row of candidates) {
    try {
      await processTicket(row, ctx, result);
    } catch (err) {
      if (previous.has(row.id)) nextNeedsInfo.add(row.id); // keep the marker until it's checked again
      if (halted) throw err;
      result.errors.push({ id: row.id, error: err.message });
      console.error(`[calendarSync] #${row.id} failed: ${err.message}`);
    }
  }
  result.needsInfo = [...nextNeedsInfo];
  return result;
}

// What an error means for staff, and which runbook section fixes it.
// Shown in the dashboard's alert banner (see `alert` below).
const PROBLEMS = [
  [/write access not connected/i, "NinjaOne write access isn't signed in", 'Sign in again: runbook "Re-sign in to NinjaOne".'],
  [/web-app token request failed/i, 'The NinjaOne sign-in was rejected (revoked, account disabled, or app secret changed)', 'Sign in again: runbook "Re-sign in to NinjaOne".'],
  [/Azure AD token request failed/i, "The Microsoft calendar app can't sign in (client secret expired or wrong)", 'Renew the secret: runbook "Renew the Microsoft client secret".'],
  [/Graph request failed.*(403|AccessDenied)/i, 'No permission to the AV Events Calendar', 'Check the Entra app\'s admin consent and the Exchange access policy (runbook "Reference").'],
  [/Graph request failed/i, 'The AV Events Calendar could not be updated', 'Check the error below; it usually clears on the next run.'],
  [/sync stopped|can't be read back/i, 'The sync stopped itself after an unexpected result', 'Check the ticket named below, then restart: runbook "If the sync stopped itself".'],
  [/not configured/i, 'Calendar sync settings are missing', 'Fill in the settings named below in backend/.env and restart.'],
  [/No NinjaOne board|No ticket field|No NinjaOne status/i, 'A NinjaOne board or field name no longer matches', 'Update the name in backend/.env to match NinjaOne and restart.'],
  [/NinjaOne request failed.*\b401\b|NinjaOne token request failed/i, "Can't read from NinjaOne", 'Check the NinjaOne read app credentials in backend/.env.'],
];

function describe(message) {
  const match = PROBLEMS.find(([re]) => re.test(message));
  return match ? { reason: match[1], action: match[2] } : { reason: 'Calendar sync error', action: 'Check backend/server.err.log on the dashboard VM.' };
}

// null when all is well; otherwise what the banner should say.
function alertFor(result) {
  if (!result.ok) {
    return { level: 'error', ...describe(result.error), detail: result.error };
  }
  if (result.errors && result.errors.length) {
    const first = result.errors[0];
    const { reason, action } = describe(first.error);
    return {
      level: 'warn',
      reason: `${result.errors.length} ticket(s) couldn't be processed — ${reason}`,
      action,
      detail: `#${first.id}: ${first.error}`,
    };
  }
  return null;
}

async function getStats() {
  if (running) return lastResult; // previous run still going — don't double-book
  running = true;
  try {
    lastResult = { ...(await run()), lastRunAt: new Date().toISOString() };
  } catch (err) {
    // Includes the sync halting itself; report it like any other failure.
    console.error(`[calendarSync] ${err.message}`);
    lastResult = { ok: false, error: err.message, lastRunAt: new Date().toISOString() };
  } finally {
    running = false;
  }
  lastResult.alert = alertFor(lastResult);
  lastResult.dryRun = DRY_RUN;
  return lastResult;
}

// alertFor: for npm run check-calendar; previewEvents: for npm run sync-once.
module.exports = { getStats, needsInfoIds, alertFor, previewEvents };
