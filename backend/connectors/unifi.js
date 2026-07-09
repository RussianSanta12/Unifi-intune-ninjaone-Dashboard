// UniFi connector — self-hosted Network Application (session-cookie auth).
//
// When you migrate to a UniFi OS console, replace the login/cookie logic
// below with a single "X-API-KEY" header (see comment at bottom of file).

const fetch = require('node-fetch');
const https = require('https');

const HOST = process.env.UNIFI_HOST; // e.g. https://192.168.1.1:8443
const USERNAME = process.env.UNIFI_USERNAME;
const PASSWORD = process.env.UNIFI_PASSWORD;
const CONFIGURED_SITE = process.env.UNIFI_SITE || 'default';
const VERIFY_SSL = (process.env.UNIFI_VERIFY_SSL || 'false').toLowerCase() === 'true';

// Self-hosted controllers commonly use a self-signed cert.
const agent = new https.Agent({ rejectUnauthorized: VERIFY_SSL });

let sessionCookie = null;

// Cache of known sites on this controller, refreshed periodically.
let siteList = null; // [{ name, desc }, ...]
let siteListFetchedAt = 0;
const SITE_LIST_TTL_MS = 10 * 60 * 1000; // re-check sites every 10 min

// "Connected now" cycles slowly through all sites — one site advances per poll.
let cycleIndex = 0;

// Unique-client snapshots, bucketed by calendar month, so we can report
// "past three months" broken out by month name. NOTE: the UniFi controller
// does not expose a true historical "unique clients per month" metric —
// this data only accumulates from when the dashboard starts polling.
// Structure: { "2026-07": Set(macs), "2026-06": Set(macs), ... }
const monthlyClientSets = {};
const MONTHS_TO_KEEP = 3;

async function login() {
  if (!HOST || !USERNAME || !PASSWORD) {
    throw new Error('UniFi credentials are not configured (check .env)');
  }

  const res = await fetch(`${HOST}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    agent,
  });

  if (!res.ok) {
    throw new Error(`UniFi login failed: ${res.status} ${res.statusText}`);
  }

  const setCookie = res.headers.raw()['set-cookie'];
  if (!setCookie || setCookie.length === 0) {
    throw new Error('UniFi login did not return a session cookie');
  }

  sessionCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function authenticatedGet(path) {
  if (!sessionCookie) {
    await login();
  }

  let res = await fetch(`${HOST}${path}`, {
    headers: { Cookie: sessionCookie },
    agent,
  });

  // Session likely expired — re-login once and retry.
  if (res.status === 401) {
    await login();
    res = await fetch(`${HOST}${path}`, {
      headers: { Cookie: sessionCookie },
      agent,
    });
  }

  if (!res.ok) {
    throw new Error(`UniFi request failed (${path}): ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function getSites() {
  const now = Date.now();
  if (siteList && now - siteListFetchedAt < SITE_LIST_TTL_MS) {
    return siteList;
  }

  try {
    const data = await authenticatedGet('/api/self/sites');
    const sites = (data.data || []).map((s) => ({
      name: s.name,
      desc: s.desc || s.name,
    }));
    siteList = sites.length ? sites : [{ name: CONFIGURED_SITE, desc: CONFIGURED_SITE }];
  } catch (err) {
    // If site listing isn't available for some reason, fall back to the
    // single configured site rather than failing the whole poll.
    siteList = [{ name: CONFIGURED_SITE, desc: CONFIGURED_SITE }];
  }

  siteListFetchedAt = now;
  return siteList;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(date) {
  return date.toLocaleString('en-US', { month: 'long' });
}

function recordSnapshot(clients) {
  const now = new Date();
  const key = monthKey(now);

  if (!monthlyClientSets[key]) {
    monthlyClientSets[key] = new Set();
  }

  for (const c of clients) {
    if (c.mac) monthlyClientSets[key].add(c.mac);
  }

  // Trim any month buckets outside our retention window.
  const keepKeys = new Set();
  for (let i = 0; i < MONTHS_TO_KEEP; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keepKeys.add(monthKey(d));
  }
  for (const existingKey of Object.keys(monthlyClientSets)) {
    if (!keepKeys.has(existingKey)) {
      delete monthlyClientSets[existingKey];
    }
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
      uniqueClients: monthlyClientSets[key] ? monthlyClientSets[key].size : 0,
    });
  }
  return result; // [currentMonth, lastMonth, twoMonthsAgo]
}

async function getStats() {
  const sites = await getSites();

  // Cycle slowly through all sites — one poll = one site's "connected now"
  // count, advancing to the next site on the following poll.
  const site = sites[cycleIndex % sites.length];
  cycleIndex += 1;

  // /stat/sta returns currently connected clients for the site.
  const data = await authenticatedGet(`/api/s/${site.name}/stat/sta`);
  const clients = data.data || [];

  // Unique-client history is tracked against the configured "home" site
  // (UNIFI_SITE) regardless of which site we're cycling through for the
  // "connected now" display, so the monthly figures stay consistent.
  if (site.name === CONFIGURED_SITE) {
    recordSnapshot(clients);
  }

  return {
    ok: true,
    connectedNow: clients.length,
    connectedNowSite: site.desc,
    siteCount: sites.length,
    monthlyBreakdown: getMonthlyBreakdown(),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getStats };

/*
 * --- UniFi OS migration notes ---
 * Once you're on a UniFi OS console, generate an API key at:
 *   Integrations → Create New API Key
 * Then replace login()/authenticatedGet() with a simple header call:
 *
 *   const res = await fetch(`${HOST}${path}`, {
 *     headers: { 'X-API-KEY': process.env.UNIFI_API_KEY },
 *     agent,
 *   });
 *
 * No cookie/session management needed, and rate limits are more generous.
 *
 * --- Note on historical monthly data ---
 * The controller does not expose a true "unique clients per month" metric
 * going backward in time — /stat/report/monthly.site gives periodic
 * concurrent-station counts, not unique MACs over the month. So the monthly
 * breakdown above only becomes accurate for months the dashboard has been
 * running continuously; it will read 0 for months before that.
 */
