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
const issueListState = new Map(); // id -> { signature, raf }

function renderIssueList(id, issues, labelFn, { autoScroll = false, classFn = null } = {}) {
  const el = document.getElementById(id);
  if (!el) return;

  const items = issues || [];
  const signature = JSON.stringify(items);
  const prev = issueListState.get(id);
  if (prev && prev.signature === signature) return; // data unchanged — leave it alone

  if (prev && prev.raf) cancelAnimationFrame(prev.raf);
  const state = { signature, raf: null };
  issueListState.set(id, state);

  el.innerHTML = '';
  items.forEach((issue) => {
    const li = document.createElement('li');
    li.innerHTML = labelFn(issue);
    if (classFn) li.className = classFn(issue);
    el.appendChild(li);
  });

  if (autoScroll && items.length) startAutoScroll(el, state);
}

// Continuously scrolls the list (no visible scrollbar). Items are cloned
// once so the loop wraps seamlessly. Only activates when content overflows.
const AUTO_SCROLL_PX_PER_SEC = 35;

function startAutoScroll(el, state) {
  requestAnimationFrame(() => {
    if (state !== issueListState.get(el.id)) return; // superseded by a re-render
    el.scrollTop = 0;
    if (el.scrollHeight <= el.clientHeight + 1) return; // everything fits — no scroll needed

    const originals = Array.from(el.children);
    originals.forEach((li) => el.appendChild(li.cloneNode(true)));

    // Exact loop distance: from the first item to its clone.
    const loopHeight = el.children[originals.length].offsetTop - el.children[0].offsetTop;

    let pos = 0;
    let last = performance.now();
    function step(now) {
      if (state !== issueListState.get(el.id)) return;
      pos += (AUTO_SCROLL_PX_PER_SEC * (now - last)) / 1000;
      last = now;
      if (pos >= loopHeight) pos -= loopHeight;
      el.scrollTop = pos;
      state.raf = requestAnimationFrame(step);
    }
    state.raf = requestAnimationFrame(step);
  });
}

// Ticket text comes from end users, so escape it before it goes into innerHTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderNinjaOne(data) {
  const ok = data && data.ok !== false;
  setText('ninjaone-unhealthy', ok ? data.unhealthyCount ?? '–' : '–');
  setText('ninjaone-attention', ok ? data.needsAttentionCount ?? '–' : '–');
  setText('ninjaone-alerts', ok ? data.openAlertCount ?? '–' : '–');
  setStatus('ninjaone-status', data);
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
// .markers CSS): one is centered, two stack yellow over red.
function ticketMarkers(ticket) {
  const markers = [];
  if (ticket.publicMarker) markers.push('<span class="marker marker-public"></span>');
  if (ticket.privateMarker) markers.push('<span class="marker marker-private"></span>');
  return markers.length ? `<span class="markers">${markers.join('')}</span>` : '';
}

function ticketLabel(ticket) {
  const assignees = ticket.assignee ? [ticket.assignee, ...(ticket.additionalAssignees || [])].join(' + ') : 'Unassigned';
  return (
    ticketMarkers(ticket) +
    `<span class="issue-title"><span class="ticket-id">#${escapeHtml(ticket.id)}</span>${escapeHtml(ticket.subject)}</span>` +
    escapeHtml(assignees)
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

function avLegend(unassignedCount) {
  return [
    `<span class="legend-item legend-unassigned${unassignedCount ? ' active' : ''}">&#9888; ${unassignedCount} Unassigned</span>`,
    '<span class="legend-item"><span class="legend-fill status-2"></span>Added to Calendar</span>',
    '<span class="legend-item"><span class="marker marker-public"></span>Public comment</span>',
    '<span class="legend-item"><span class="marker marker-private"></span>Private note</span>',
  ].join('');
}

function calendarTicket(ticket) {
  const classes = ['cal-ticket'];
  if (ticket.closed) classes.push('closed');
  else classes.push(`status-${ticket.statusIndex}`);
  if (ticket.unassigned) classes.push('unassigned');
  const assignees = ticket.assignee ? [ticket.assignee, ...(ticket.additionalAssignees || [])].join(' + ') : 'Unassigned';
  return (
    `<div class="${classes.join(' ')}">` +
    (ticket.closed ? '' : ticketMarkers(ticket)) +
    `<span class="cal-title"><span class="ticket-id">#${escapeHtml(ticket.id)}</span>${escapeHtml(ticket.subject)}</span>` +
    `<span class="cal-who">${escapeHtml(assignees)}</span>` +
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

// Each day shows as many tickets as fit; the rest collapse into "+N more".
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
      cell.appendChild(more);
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
        (unassigned ? `<span class="cal-unassigned">&#9888; ${unassigned} unassigned</span>` : '') +
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

function renderTickets(data) {
  const ok = data && data.ok !== false;
  // If the whole connector failed, show its error on both sides.
  renderTicketSide('it', ok ? data.it : data, ok ? data.statuses : []);
  renderAvCalendar(ok ? data.av : data);
}

window.addEventListener('resize', () => {
  if (!avCalendarData) return;
  avCalendarSignature = null;
  renderAvCalendar(avCalendarData);
});

async function refresh() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();

    renderNinjaOne(data.ninjaone);
    renderTickets(data.tickets);

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
