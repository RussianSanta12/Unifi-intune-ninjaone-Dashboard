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

function formatEventDate(iso) {
  if (!iso) return 'No event date';
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Status is shown only as the row's stripe color; the legend is the key.
function renderLegend(id, statuses) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (statuses || [])
    .map((name, i) => `<span class="legend-item"><span class="legend-dot status-${i}"></span>${escapeHtml(name)}</span>`)
    .join('');
}

function ticketLabel(ticket) {
  const details = [escapeHtml(ticket.assignee || 'Unassigned')];
  if ('eventDate' in ticket) details.push(`Event: ${escapeHtml(formatEventDate(ticket.eventDate))}`);
  return (
    `<span class="issue-title"><span class="ticket-id">#${escapeHtml(ticket.id)}</span>${escapeHtml(ticket.subject)}</span>` +
    details.join(' · ')
  );
}

function renderTicketSide(side, sideData, statuses) {
  const ok = sideData && sideData.ok !== false;
  setText(`tickets-${side}-count`, ok ? `(${sideData.count})` : '');
  renderLegend(`tickets-${side}-legend`, statuses);
  renderIssueList(`tickets-${side}`, ok ? sideData.tickets : [], ticketLabel, {
    autoScroll: true,
    classFn: (ticket) => `status-${ticket.statusIndex}`,
  });
  setStatus(`tickets-${side}-status`, sideData);
}

function renderTickets(data) {
  const ok = data && data.ok !== false;
  // If the whole connector failed, show its error on both sides.
  renderTicketSide('it', ok ? data.it : data, ok ? data.statuses : []);
  renderTicketSide('av', ok ? data.av : data, ok ? data.statuses : []);
}

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
