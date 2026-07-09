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

function renderIssueList(id, issues, labelFn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  (issues || []).forEach((issue) => {
    const li = document.createElement('li');
    li.innerHTML = labelFn(issue);
    el.appendChild(li);
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

function renderNinjaOne(data) {
  if (!data || data.ok === false) {
    setText('ninjaone-offline', '–');
    setText('ninjaone-alerts', '–');
    renderIssueList('ninjaone-issues', [], () => '');
    setStatus('ninjaone-status', data);
    return;
  }
  setText('ninjaone-offline', data.offlineCount ?? '–');
  setText('ninjaone-alerts', data.openAlertCount ?? '–');
  renderIssueList('ninjaone-issues', data.pressingIssues, (issue) =>
    `<span class="issue-title">${issue.severity || 'Alert'}</span>${issue.message || ''}`
  );
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
  renderIssueList('intune-issues', data.pressingIssues, (issue) =>
    `<span class="issue-title">${issue.deviceName || 'Device'}</span>${issue.complianceState || 'unknown'}`
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
