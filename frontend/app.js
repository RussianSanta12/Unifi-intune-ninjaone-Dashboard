const POLL_INTERVAL_MS = 30_000; // how often the frontend asks the backend for fresh cached data

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setStatus(id, panelData) {
  const el = document.getElementById(id);
  if (!el) return;
  if (panelData && panelData.ok === false) {
    el.textContent = `Error: ${panelData.error || 'unknown error'}`;
    el.classList.add('error');
  } else {
    el.textContent = '';
    el.classList.remove('error');
  }
}

// Per-list state so an unchanged refresh doesn't rebuild the DOM and
// reset the auto-scroll position mid-scroll.
const issueListState = new Map(); // id -> { signature }

function renderIssueList(id, issues, labelFn, { autoScroll = false, classFn = null } = {}) {
  const el = document.getElementById(id);
  if (!el) return;

  const items = issues || [];
  const signature = JSON.stringify(items);
  const prev = issueListState.get(id);
  if (prev && prev.signature === signature) return; // data unchanged — leave it alone

  const state = { signature };
  issueListState.set(id, state);

  el.innerHTML = '';
  items.forEach((issue) => {
    const li = document.createElement('li');
    li.innerHTML = labelFn(issue);
    if (classFn) li.className = classFn(issue);
    el.appendChild(li);
  });

  if (autoScroll && items.length) {
    startAutoScroll(el, AUTO_SCROLL_PX_PER_SEC, () => issueListState.get(id) === state);
  }
}

// Continuously scrolls a box (no visible scrollbar). Its children are cloned
// once so the loop wraps seamlessly. Only activates when content overflows;
// stops once isCurrent() turns false (the box was re-rendered).
const AUTO_SCROLL_PX_PER_SEC = 35;

function startAutoScroll(el, pxPerSec, isCurrent) {
  requestAnimationFrame(() => {
    if (!isCurrent()) return;
    el.scrollTop = 0;
    if (el.scrollHeight <= el.clientHeight + 1) return; // everything fits — no scroll needed

    const originals = Array.from(el.children);
    originals.forEach((child) => el.appendChild(child.cloneNode(true)));

    // Exact loop distance: from the first item to its clone.
    const loopHeight = el.children[originals.length].offsetTop - el.children[0].offsetTop;

    let pos = 0;
    let last = performance.now();
    function step(now) {
      if (!isCurrent()) return;
      pos += (pxPerSec * (now - last)) / 1000;
      last = now;
      if (pos >= loopHeight) pos -= loopHeight;
      el.scrollTop = pos;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

// Ticket text comes from end users, so escape it before it goes into innerHTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Status is shown only as the row's stripe color; the legend is the key.
function renderLegend(id, statuses) {
  const el = document.getElementById(id);
  if (!el) return;
  const items = (statuses || []).map(
    (name, i) => `<span class="legend-item"><span class="legend-dot status-${i}"></span>${escapeHtml(name)}</span>`
  );
  if (items.length) {
    items.push(
      '<span class="legend-item"><span class="marker marker-public"></span>Public comment</span>',
      '<span class="legend-item"><span class="marker marker-private"></span>Private note</span>',
      '<span class="legend-item"><span class="legend-box"></span>Unassigned</span>'
    );
  }
  el.innerHTML = items.join('');
}

// Comment markers sit in the margin left of the status stripe (see the
// .markers CSS): one is centered, two stack yellow over red. On AV cards
// they sit in a row, with the "needs info" marker (tickets the calendar sync
// couldn't schedule) first, left of the comment markers.
function ticketMarkers(ticket) {
  const markers = [];
  if (ticket.needsInfoMarker) markers.push('<span class="marker marker-info"></span>');
  if (ticket.publicMarker) markers.push('<span class="marker marker-public"></span>');
  if (ticket.privateMarker) markers.push('<span class="marker marker-private"></span>');
  return markers.length ? `<span class="markers">${markers.join('')}</span>` : '';
}

// Title and assignees on the left; location (and "needed by") on the right.
function formatShortDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Right side of a list row: the location, with the "needed by" date beneath
// it when the panel has a date field (LIST_PANEL_DATE_FIELD).
function issueSide(ticket) {
  const lines = [];
  if (ticket.location) lines.push(`<span class="issue-location">${escapeHtml(ticket.location)}</span>`);
  if (ticket.neededBy) lines.push(`<span class="issue-due">Needed by ${escapeHtml(formatShortDate(ticket.neededBy))}</span>`);
  return lines.length ? `<div class="issue-side">${lines.join('')}</div>` : '';
}

function ticketLabel(ticket) {
  const assignees = ticket.assignee ? [ticket.assignee, ...(ticket.additionalAssignees || [])].join(' + ') : 'Unassigned';
  return (
    ticketMarkers(ticket) +
    '<div class="issue-main">' +
    `<span class="issue-title"><span class="ticket-id">#${escapeHtml(ticket.id)}</span>${escapeHtml(ticket.subject)}</span>` +
    escapeHtml(assignees) +
    '</div>' +
    issueSide(ticket)
  );
}

function renderTicketSide(side, sideData, statuses) {
  const ok = sideData && sideData.ok !== false;
  setText(`tickets-${side}-count`, ok ? `(${sideData.count})` : '');
  renderLegend(`tickets-${side}-legend`, statuses);
  renderIssueList(`tickets-${side}`, ok ? sideData.tickets : [], ticketLabel, {
    autoScroll: true,
    classFn: (ticket) => `status-${ticket.statusIndex}` + (ticket.unassigned ? ' unassigned' : ''),
  });
  setStatus(`tickets-${side}-status`, sideData);
}

// --- AV monthly calendar ---
// Shows the current month, padded with the neighboring months' days to fill
// the first and last weeks. Each ticket sits on its event day. Past days are
// dimmed; closed tickets are brown; Added to Calendar fills green.

const ADDED_TO_CALENDAR = 2; // status index of "Added to Calendar"

let avCalendarSignature = null;
let avCalendarData = null; // last data, so a resize can re-fit the cells

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

// Set from /api/stats each refresh: the backend leaves calendarSync out
// entirely when CALENDAR_SYNC_ENABLED isn't on.
let calendarSyncEnabled = false;

// The status names, from the last poll (NINJAONE_TICKET_STATUSES).
let statusNames = [];

function avLegend(unassignedCount) {
  return [
    `<span class="legend-item legend-unassigned${unassignedCount ? ' active' : ''}">&#9888; ${unassignedCount} Unassigned</span>`,
    `<span class="legend-item"><span class="legend-fill status-2"></span>${escapeHtml(statusNames[2] || 'Added to Calendar')}</span>`,
    '<span class="legend-item"><span class="marker marker-public"></span>Public comment</span>',
    '<span class="legend-item"><span class="marker marker-private"></span>Private note</span>',
    calendarSyncEnabled ? '<span class="legend-item"><span class="marker marker-info"></span>Needs event info</span>' : '',
  ].join('');
}

// Ticket # and title, wrapping to two lines; the week panel above carries
// the details. The space after the # lets the title wrap between words.
function calendarTicket(ticket) {
  const classes = ['cal-ticket'];
  if (ticket.closed) classes.push('closed');
  else classes.push(`status-${ticket.statusIndex}`);
  if (ticket.unassigned) classes.push('unassigned');
  return (
    `<div class="${classes.join(' ')}">` +
    (ticket.closed ? '' : ticketMarkers(ticket)) +
    `<span class="cal-title"><span class="ticket-id">#${escapeHtml(ticket.id)}</span> ${escapeHtml(ticket.subject)}</span>` +
    '</div>'
  );
}

// A ticket's event day plus any recurring days, one Date per distinct day.
function ticketDays(ticket) {
  const days = new Map();
  for (const iso of [ticket.eventDate, ...(ticket.recurringDates || [])]) {
    if (!iso) continue;
    const date = new Date(iso);
    days.set(dayKey(date), date);
  }
  return [...days.values()];
}

// Within a day: open before closed, unassigned first, then by status.
function compareCalendarTickets(a, b) {
  return !!a.closed - !!b.closed || !!b.unassigned - !!a.unassigned || a.statusIndex - b.statusIndex;
}

// Each day shows as many tickets as fit; the rest collapse into "+N more",
// which sits in the day's header row so it doesn't cost a line.
function fitCalendarDay(cell) {
  const cards = Array.from(cell.querySelectorAll('.cal-ticket'));
  let hidden = 0;
  while (cell.scrollHeight > cell.clientHeight && hidden < cards.length) {
    cards[cards.length - 1 - hidden].remove();
    hidden++;
    let more = cell.querySelector('.cal-more');
    if (!more) {
      more = document.createElement('span');
      more.className = 'cal-more';
      cell.querySelector('.cal-day-head').insertBefore(more, cell.querySelector('.cal-day-num'));
    }
    more.textContent = `+${hidden} more`;
  }
}

function renderAvCalendar(sideData) {
  const grid = document.getElementById('tickets-av');
  if (!grid) return;
  avCalendarData = sideData;
  const ok = sideData && sideData.ok !== false;
  const tickets = ok ? sideData.tickets || [] : [];

  const today = startOfDay(new Date());
  // Re-render when the data or the day changes (today's outline, past dimming).
  const signature = dayKey(today) + JSON.stringify(sideData);
  if (signature === avCalendarSignature) return;
  avCalendarSignature = signature;

  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const gridStart = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), 1 - firstOfMonth.getDay());
  const gridEnd = new Date(lastOfMonth.getFullYear(), lastOfMonth.getMonth(), lastOfMonth.getDate() + 7 - lastOfMonth.getDay());

  // Recurring tickets land on every one of their days.
  const byDay = new Map();
  const onGrid = new Set();
  for (const ticket of tickets) {
    for (const date of ticketDays(ticket)) {
      if (date < gridStart || date >= gridEnd) continue;
      const key = dayKey(date);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ticket);
      onGrid.add(ticket);
    }
  }
  // Counted per ticket, not per day it appears on.
  const openOnGrid = [...onGrid].filter((t) => !t.closed);

  setText('tickets-av-count', ok ? `(${openOnGrid.length})` : '');
  setText('tickets-av-month', today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
  const legend = document.getElementById('tickets-av-legend');
  if (legend) legend.innerHTML = ok ? avLegend(openOnGrid.filter((t) => t.unassigned).length) : '';

  const cells = [];
  for (let day = gridStart; day < gridEnd; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const dayTickets = (byDay.get(dayKey(day)) || []).sort(compareCalendarTickets);
    const unassigned = dayTickets.filter((t) => t.unassigned && !t.closed).length;
    const classes = ['cal-day'];
    if (day.getMonth() !== today.getMonth()) classes.push('other-month');
    if (day < today) classes.push('past');
    if (day.getTime() === today.getTime()) classes.push('today');

    cells.push(
      `<div class="${classes.join(' ')}">` +
        '<div class="cal-day-head">' +
        (unassigned ? `<span class="cal-unassigned">&#9888; ${unassigned}</span>` : '') +
        `<span class="cal-day-num">${day.getDate()}</span>` +
        '</div>' +
        dayTickets.map(calendarTicket).join('') +
        '</div>'
    );
  }
  grid.innerHTML = cells.join('');
  grid.querySelectorAll('.cal-day').forEach(fitCalendarDay);

  // Footer: events already added to the calendar for all of next month
  // (a recurring ticket counts once per day it falls on).
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextAdded = tickets
    .filter((t) => !t.closed && t.statusIndex === ADDED_TO_CALENDAR)
    .flatMap(ticketDays)
    .filter((date) => date.getFullYear() === nextMonth.getFullYear() && date.getMonth() === nextMonth.getMonth()).length;
  setText(
    'tickets-av-next',
    ok ? `${nextMonth.toLocaleDateString('en-US', { month: 'long' })}: ${nextAdded} event${nextAdded === 1 ? '' : 's'} added to calendar` : ''
  );

  setStatus('tickets-av-status', sideData);
}

// --- AV events this week (top panel) ---
// Sun–Sat of the current week, so it moves to the next week once Saturday
// ends. One column per day with full event details; a column that overflows
// scrolls slowly on its own.

const WEEK_SCROLL_PX_PER_SEC = 12;

let weekSignature = null;

// Rough start time in minutes, only for ordering a day's events. Times are
// free text ("6:30pm (5:30 setup)", "5-6:30pm"); a missing am/pm is taken
// from later in the text, else 1–6 count as pm. Unreadable times sort last.
function startMinutes(text) {
  const value = String(text || '');
  if (/\bnoon\b/i.test(value)) return 12 * 60;
  const match = value.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\b/i);
  if (!match) return Infinity;
  const hour = Number(match[1]);
  if (hour < 1 || hour > 23) return Infinity;
  if (hour > 12) return hour * 60 + Number(match[2] || 0);
  const laterMeridiem = value.slice(match.index + match[0].length).match(/\d\s*([ap])\.?m\b/i);
  const meridiem = (match[3] || (laterMeridiem && laterMeridiem[1]) || (hour <= 6 ? 'p' : 'a')).toLowerCase();
  return (hour % 12) * 60 + Number(match[2] || 0) + (meridiem === 'p' ? 12 * 60 : 0);
}

function eventTime(ticket) {
  if (ticket.startTime && ticket.endTime) return `${ticket.startTime} – ${ticket.endTime}`;
  if (ticket.startTime) return ticket.startTime;
  if (ticket.endTime) return `until ${ticket.endTime}`;
  return 'Time not set';
}

function weekEvent(ticket) {
  const classes = ['week-event', ticket.closed ? 'closed' : `status-${ticket.statusIndex}`];
  if (ticket.unassigned) classes.push('unassigned');
  const assignees = ticket.assignee ? [ticket.assignee, ...(ticket.additionalAssignees || [])].join(' + ') : 'Unassigned';
  const recurring = (ticket.recurringDates || []).length ? '<span class="week-tag">&#8635; Recurring</span>' : '';
  return (
    `<div class="${classes.join(' ')}">` +
    (ticket.closed ? '' : ticketMarkers(ticket)) +
    `<div class="week-time">${escapeHtml(eventTime(ticket))}</div>` +
    `<div class="week-title">${escapeHtml(ticket.subject)}</div>` +
    (ticket.location ? `<div class="week-row">&#128205; <b>${escapeHtml(ticket.location)}</b></div>` : '') +
    `<div class="week-row week-who">&#128100; ${escapeHtml(assignees)}</div>` +
    `<div class="week-row">${recurring}#${escapeHtml(ticket.id)}` +
    (ticket.attendees ? ` · &#128101; <b>${escapeHtml(ticket.attendees)}</b>` : '') +
    `${ticket.requester ? ` · ${escapeHtml(ticket.requester)}` : ''}</div>` +
    '</div>'
  );
}

function renderWeek(sideData) {
  const grid = document.getElementById('week');
  if (!grid) return;
  const ok = sideData && sideData.ok !== false;
  const tickets = ok ? sideData.tickets || [] : [];

  const today = startOfDay(new Date());
  const signature = dayKey(today) + JSON.stringify(sideData);
  if (signature === weekSignature) return;
  weekSignature = signature;

  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i));
  const byDay = new Map(days.map((day) => [dayKey(day), []]));
  const inWeek = new Set();
  for (const ticket of tickets) {
    for (const date of ticketDays(ticket)) {
      const list = byDay.get(dayKey(date));
      if (!list) continue;
      list.push(ticket);
      inWeek.add(ticket);
    }
  }

  const short = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  setText('week-count', ok ? `(${[...inWeek].filter((t) => !t.closed).length})` : '');
  setText('week-range', `${short(days[0])} – ${short(days[6])}`);

  grid.innerHTML = days
    .map((day) => {
      const events = byDay
        .get(dayKey(day))
        .sort((a, b) => startMinutes(a.startTime) - startMinutes(b.startTime) || a.id - b.id);
      const unassigned = events.filter((t) => t.unassigned && !t.closed).length;
      const isToday = day.getTime() === today.getTime();
      const classes = ['week-day'];
      if (day < today) classes.push('past');
      if (isToday) classes.push('today');
      return (
        `<div class="${classes.join(' ')}">` +
        '<div class="week-day-head">' +
        `<span class="week-day-name">${isToday ? 'Today' : day.toLocaleDateString('en-US', { weekday: 'short' })}</span>` +
        (unassigned ? `<span class="week-unassigned">&#9888; ${unassigned} unassigned</span>` : '') +
        `<span class="week-day-date">${short(day)}</span>` +
        '</div>' +
        `<div class="week-events">${events.length ? events.map(weekEvent).join('') : '<div class="week-empty">No events</div>'}</div>` +
        '</div>'
      );
    })
    .join('');

  grid.querySelectorAll('.week-events').forEach((column) => {
    startAutoScroll(column, WEEK_SCROLL_PX_PER_SEC, () => weekSignature === signature);
  });
  setStatus('week-status', sideData);
}

// Page and panel titles are per department (.env); the backend sends them.
function renderTitles(labels) {
  if (!labels) return;
  if (labels.dashboard) document.title = labels.dashboard;
  setText('dashboard-title', labels.dashboard);
  setText('tickets-it-title', labels.list);
  setText('tickets-av-title', labels.calendar);
  setText('week-title', labels.week);
}

function renderTickets(data) {
  const ok = data && data.ok !== false;
  if (ok) {
    statusNames = data.statuses || [];
    renderTitles(data.labels);
  }
  // If the whole connector failed, show its error on every panel.
  renderTicketSide('it', ok ? data.it : data, ok ? data.statuses : []);
  renderWeek(ok ? data.av : data);
  renderAvCalendar(ok ? data.av : data);
}

// Sizes change on resize: re-fit the month cells and re-check which week
// columns need to scroll.
window.addEventListener('resize', () => {
  if (!avCalendarData) return;
  avCalendarSignature = null;
  weekSignature = null;
  renderWeek(avCalendarData);
  renderAvCalendar(avCalendarData);
});

// The calendar sync runs every poll; if it hasn't finished a run in this
// long, it's stuck (or the backend's timer stopped).
const SYNC_STALE_MS = 10 * 60_000;

// Banner under the header when the calendar sync isn't working: red when it
// can't run at all, amber when some tickets failed or it's gone quiet. The
// reason and fix come from the backend (connectors/calendarSync.js). In dry
// run there's no banner, just a small tag in the header. With the sync turned
// off (no calendarSync in /api/stats) neither is shown.
function renderSyncAlert(sync) {
  const banner = document.getElementById('sync-alert');
  const mode = document.getElementById('sync-mode');
  if (!banner || !mode) return;

  let alert = sync && sync.alert;
  const ranAt = sync && sync.lastRunAt ? Date.parse(sync.lastRunAt) : null;
  if (!alert && ranAt && Date.now() - ranAt > SYNC_STALE_MS) {
    alert = {
      level: 'warn',
      reason: `Calendar sync hasn't run since ${new Date(ranAt).toLocaleTimeString()}`,
      action: 'Check backend/server.err.log on the dashboard VM, then restart the dashboard.',
    };
  }

  if (alert) {
    banner.className = `sync-alert sync-alert-${alert.level === 'error' ? 'error' : 'warn'}`;
    banner.innerHTML =
      '<span class="sync-alert-icon">&#9888;</span>' +
      '<div class="sync-alert-text">' +
      `<div><b>Calendar sync: ${escapeHtml(alert.reason)}.</b> ${escapeHtml(alert.action)}</div>` +
      (alert.detail ? `<div class="sync-alert-detail">${escapeHtml(alert.detail)}</div>` : '') +
      '</div>';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  const dryRun = sync && sync.dryRun;
  mode.textContent = dryRun ? 'Calendar sync: dry run' : '';
  mode.title = dryRun ? 'Logging only — not writing to tickets or the calendar (CALENDAR_SYNC_DRY_RUN=true)' : '';
  mode.hidden = !dryRun;
}

async function refresh() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();

    calendarSyncEnabled = Boolean(data.calendarSync);
    renderTickets(data.tickets);
    renderSyncAlert(data.calendarSync);

    const lastUpdated = document.getElementById('last-updated');
    if (lastUpdated) {
      lastUpdated.textContent = data.lastPolledAt
        ? `Last updated: ${new Date(data.lastPolledAt).toLocaleTimeString()}`
        : 'Waiting for first poll…';
    }
  } catch (err) {
    const lastUpdated = document.getElementById('last-updated');
    if (lastUpdated) lastUpdated.textContent = 'Unable to reach backend';
    console.error('Failed to fetch /api/stats', err);
  }
}

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
