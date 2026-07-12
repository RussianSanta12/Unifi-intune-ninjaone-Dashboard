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

function renderIssueList(id, issues, labelFn, { autoScroll = false } = {}) {
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

// Fallback month placeholders (current month + prior two), computed locally
// so the three blocks always render — with correct month names — even
// before the backend has completed its first successful poll.
function placeholderMonths() {
  const now = new Date();
  const months = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      month: d.toLocaleString('en-US', { month: 'long' }),
      uniqueClients: null,
    });
  }
  return months;
}

function renderUnifi(data) {
  const monthsEl = document.getElementById('unifi-months');
  const hasData = data && data.ok !== false;
  const breakdown = (hasData && data.monthlyBreakdown) || placeholderMonths();

  if (!hasData) {
    setText('unifi-connected-now', '–');
    setText('unifi-connected-now-label', 'Connected Now');
  } else {
    setText('unifi-connected-now', data.connectedNow ?? '–');
    setText(
      'unifi-connected-now-label',
      data.connectedNowSite ? `Connected Now — ${data.connectedNowSite}` : 'Connected Now'
    );
  }

  if (monthsEl) {
    monthsEl.innerHTML = '';
    breakdown.forEach((m, idx) => {
      const block = document.createElement('div');
      block.className = 'card' + (idx === 0 ? ' current' : '');
      const value = m.uniqueClients === null || m.uniqueClients === undefined ? '–' : m.uniqueClients;
      block.innerHTML = `
        <span class="stat-value">${value}</span>
        <span class="stat-label">${m.month}</span>
      `;
      monthsEl.appendChild(block);
    });
  }

  setStatus('unifi-status', data);
}

function ninjaIssueLabel(issue) {
  const badges = [];
  if (issue.healthStatus) {
    badges.push(
      `<span class="badge ${issue.healthStatus === 'UNHEALTHY' ? 'badge-bad' : 'badge-warn'}">` +
        issue.healthStatus.replace('_', ' ') +
        '</span>'
    );
  }
  if (issue.severity) badges.push(`<span class="badge">${issue.severity}</span>`);
  const detail = (issue.messages || []).join(' • ');
  return (
    `<span class="issue-title">${issue.deviceName || 'Device'} ${badges.join(' ')}</span>` +
    (detail || 'Flagged by device health')
  );
}

function renderNinjaOne(data) {
  if (!data || data.ok === false) {
    setText('ninjaone-unhealthy', '–');
    setText('ninjaone-attention', '–');
    setText('ninjaone-alerts', '–');
    renderIssueList('ninjaone-issues', [], () => '');
    setStatus('ninjaone-status', data);
    return;
  }
  setText('ninjaone-unhealthy', data.unhealthyCount ?? '–');
  setText('ninjaone-attention', data.needsAttentionCount ?? '–');
  setText('ninjaone-alerts', data.openAlertCount ?? '–');
  renderIssueList('ninjaone-issues', data.pressingIssues, ninjaIssueLabel, { autoScroll: true });
  setStatus('ninjaone-status', data);
}

function renderIntune(data) {
  if (!data || data.ok === false) {
    setText('intune-noncompliant', '–');
    setText('intune-total', '–');
    renderIssueList('intune-issues', [], () => '');
    setStatus('intune-status', data);
    return;
  }
  setText('intune-noncompliant', data.nonCompliantCount ?? '–');
  setText('intune-total', data.totalDevices ?? '–');
  renderIssueList(
    'intune-issues',
    data.pressingIssues,
    (issue) =>
      `<span class="issue-title">${issue.deviceName || 'Device'}</span>${issue.complianceState || 'unknown'}`,
    { autoScroll: true }
  );
  setStatus('intune-status', data);
}

async function refresh() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();

    renderUnifi(data.unifi);
    renderNinjaOne(data.ninjaone);
    renderIntune(data.intune);

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
