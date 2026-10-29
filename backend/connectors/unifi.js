// UniFi connector — Site Manager API (Ubiquiti cloud, api.ui.com).
//
// Auth is a single X-API-KEY header — no login/session cookie needed.
// Generate a key at unifi.ui.com (Integrations → Create New API Key,
// or the account API keys page), and set UNIFI_API_KEY in .env.
//
// Endpoints used (see https://developer.ui.com/site-manager-api/):
//   GET /v1/sites — all sites visible to the key, each including
//   statistics.counts (wifiClient, wiredClient, guestClient, totalDevice,
//   offlineDevice, ...). One call gives us everything the panel needs.
//
// NOTE: this talks to Ubiquiti's cloud, not your controller directly, so
// it requires your gateway/console to be linked to a Ubiquiti cloud
// account and your dashboard server to have outbound internet access.

const API_KEY = process.env.UNIFI_API_KEY;
const BASE_URL = 'https://api.ui.com';
const CONFIGURED_SITE = process.env.UNIFI_SITE; // optional: site name/desc to prefer, if you have multiple

// "Connected now" cycles slowly through all sites — one advances per poll.
let cycleIndex = 0;

// Site Manager does NOT expose client MAC lists, so true "unique clients
// per month" isn't possible. Instead we track the PEAK concurrent client
// count seen in each calendar month (only accumulates while the dashboard
// is running). Structure: { "2026-07": 42, "2026-06": 38, ... }
const monthlyPeaks = {};
const MONTHS_TO_KEEP = 3;

async function authenticatedGet(path) {
  if (!API_KEY) {
    throw new Error('UniFi Site Manager API key is not configured (check .env)');
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'X-API-KEY': API_KEY, Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`UniFi Site Manager request failed (${path}): ${res.status} ${res.statusText}`);
  }

  return res.json();
}

function siteName(site) {
  const meta = site.meta || {};
  return meta.desc || meta.name || site.siteId || 'Site';
}

function connectedClients(site) {
  const counts = (site.statistics && site.statistics.counts) || {};
  const wifi = counts.wifiClient ?? counts.wifiClientCount ?? 0;
  const wired = counts.wiredClient ?? counts.wiredClientCount ?? 0;
  return wifi + wired;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(date) {
  return date.toLocaleString('en-US', { month: 'long' });
}

function recordPeak(clientCount) {
  const now = new Date();
  const key = monthKey(now);
  monthlyPeaks[key] = Math.max(monthlyPeaks[key] || 0, clientCount);

  // Trim any month buckets outside our retention window.
  const keepKeys = new Set();
  for (let i = 0; i < MONTHS_TO_KEEP; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keepKeys.add(monthKey(d));
  }
  for (const existingKey of Object.keys(monthlyPeaks)) {
    if (!keepKeys.has(existingKey)) delete monthlyPeaks[existingKey];
  }
}

function getMonthlyBreakdown() {
  const now = new Date();
  const result = [];
  for (let i = 0; i < MONTHS_TO_KEEP; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    result.push({
      month: monthLabel(d),
      // Peak concurrent clients seen that month (see note at top of file).
      uniqueClients: monthlyPeaks[key] ?? 0,
    });
  }
  return result; // [currentMonth, lastMonth, twoMonthsAgo]
}

async function getStats() {
  const data = await authenticatedGet('/v1/sites');
  const sites = data.data || [];

  if (!sites.length) {
    throw new Error('No UniFi sites visible to this API key');
  }

  // Put the configured "home" site first (matched against name or desc).
  const ordered = CONFIGURED_SITE
    ? sites
        .filter((s) => siteName(s) === CONFIGURED_SITE || (s.meta && s.meta.name === CONFIGURED_SITE))
        .concat(sites.filter((s) => siteName(s) !== CONFIGURED_SITE && (!s.meta || s.meta.name !== CONFIGURED_SITE)))
    : sites;

  // Cycle slowly through all sites — one poll = one site's "connected now"
  // count, advancing to the next on the following poll.
  const site = ordered[cycleIndex % ordered.length];
  cycleIndex += 1;

  const clientCount = connectedClients(site);

  // Peak history is tracked against the home site so the monthly figures
  // stay consistent.
  const homeSite = ordered[0];
  if (site === homeSite) {
    recordPeak(clientCount);
  }

  return {
    ok: true,
    connectedNow: clientCount,
    connectedNowSite: siteName(site),
    siteCount: sites.length,
    monthlyBreakdown: getMonthlyBreakdown(),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getStats };

/*
 * --- Note on monthly data ---
 * Site Manager does not expose client MAC lists, so a true "unique clients
 * per month" metric is impossible via this API. The monthly figures are the
 * peak concurrent client count observed while the dashboard was running —
 * months before the dashboard started will read 0.
 *
 * If you need real unique-client counts, that requires the local controller
 * API (session auth today, local API key after your UniFi OS migration),
 * which can list client MACs.
 *
 * --- Note on cloud dependency ---
 * This connector calls Ubiquiti's cloud (api.ui.com). It requires your
 * gateway/console to be linked to a Ubiquiti cloud account and outbound
 * internet access from wherever this backend runs.
 */
