// UniFi connector — Site Manager API (Ubiquiti cloud, api.ui.com).
//
// Auth is a single X-API-KEY header — no login/session cookie needed.
// Generate a key at unifi.ui.com (Integrations → Create New API Key,
// or the account API keys page), and set UNIFI_API_KEY in .env.
//
// NOTE: this talks to Ubiquiti's cloud, not your controller directly, so
// it requires your gateway/console to be linked to a Ubiquiti cloud
// account and your dashboard server to have outbound internet access.

const fetch = require('node-fetch');

const API_KEY = process.env.UNIFI_API_KEY;
const BASE_URL = 'https://api.ui.com';
const CONFIGURED_SITE = process.env.UNIFI_SITE; // optional: workspace name/desc to filter to, if you have multiple

// Cache of known workspaces (sites), refreshed periodically.
let workspaceList = null; // [{ id, name }, ...]
let workspaceListFetchedAt = 0;
const WORKSPACE_LIST_TTL_MS = 10 * 60 * 1000; // re-check workspaces every 10 min

// "Connected now" cycles slowly through all workspaces — one advances per poll.
let cycleIndex = 0;

// Unique-client snapshots, bucketed by calendar month, so we can report
// "past three months" broken out by month name. NOTE: Site Manager does not
// expose a true historical "unique clients per month" metric — this data
// only accumulates from when the dashboard starts polling.
// Structure: { "2026-07": Set(macs), "2026-06": Set(macs), ... }
const monthlyClientSets = {};
const MONTHS_TO_KEEP = 3;

async function authenticatedGet(path) {
  if (!API_KEY) {
    throw new Error('UniFi Site Manager API key is not configured (check .env)');
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'X-API-KEY': API_KEY },
  });

  if (!res.ok) {
    throw new Error(`UniFi Site Manager request failed (${path}): ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function getWorkspaces() {
  const now = Date.now();
  if (workspaceList && now - workspaceListFetchedAt < WORKSPACE_LIST_TTL_MS) {
    return workspaceList;
  }

  const data = await authenticatedGet('/v1/mobility/workspaces');
  const workspaces = (data.data || []).map((w) => ({
    id: w.workspaceId || w.id,
    name: w.name || w.workspaceId || w.id,
  }));

  if (!workspaces.length) {
    throw new Error('No UniFi Site Manager workspaces found for this API key');
  }

  workspaceList = CONFIGURED_SITE
    ? workspaces.filter((w) => w.name === CONFIGURED_SITE).concat(
        workspaces.filter((w) => w.name !== CONFIGURED_SITE)
      )
    : workspaces;

  workspaceListFetchedAt = now;
  return workspaceList;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(date) {
  return date.toLocaleString('en-US', { month: 'long' });
}

function recordSnapshot(clientMacs) {
  const now = new Date();
  const key = monthKey(now);

  if (!monthlyClientSets[key]) {
    monthlyClientSets[key] = new Set();
  }

  for (const mac of clientMacs) {
    if (mac) monthlyClientSets[key].add(mac);
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

// Site Manager exposes clients per-device, not per-site in one call, so we
// have to list devices in the workspace first, then fetch each device's
// clients and sum them.
async function getConnectedClientMacsForWorkspace(workspaceId) {
  const devicesData = await authenticatedGet(`/v1/mobility/workspaces/${workspaceId}/devices`);
  const devices = devicesData.data || [];

  const clientLists = await Promise.all(
    devices.map((d) =>
      authenticatedGet(`/v1/mobility/workspaces/${workspaceId}/devices/${d.deviceId || d.id}/clients`).catch(
        () => ({ data: [] }) // one device's client list failing shouldn't fail the whole poll
      )
    )
  );

  const macs = [];
  for (const cl of clientLists) {
    for (const c of cl.data || []) {
      if (c.mac) macs.push(c.mac);
    }
  }
  return macs;
}

async function getStats() {
  const workspaces = await getWorkspaces();

  // Cycle slowly through all workspaces — one poll = one workspace's
  // "connected now" count, advancing to the next on the following poll.
  const workspace = workspaces[cycleIndex % workspaces.length];
  cycleIndex += 1;

  const macs = await getConnectedClientMacsForWorkspace(workspace.id);

  // Unique-client history is tracked against the configured "home" workspace
  // (UNIFI_SITE) if set, otherwise whichever workspace comes first in the
  // cycle, so the monthly figures stay consistent.
  const homeWorkspace = CONFIGURED_SITE ? workspaces.find((w) => w.name === CONFIGURED_SITE) : workspaces[0];
  if (homeWorkspace && workspace.id === homeWorkspace.id) {
    recordSnapshot(macs);
  }

  return {
    ok: true,
    connectedNow: macs.length,
    connectedNowSite: workspace.name,
    siteCount: workspaces.length,
    monthlyBreakdown: getMonthlyBreakdown(),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getStats };

/*
 * --- Note on historical monthly data ---
 * Site Manager does not expose a true "unique clients per month" metric
 * going backward in time. So the monthly breakdown above only becomes
 * accurate for months the dashboard has been running continuously; it will
 * read 0 for months before that.
 *
 * --- Note on cloud dependency ---
 * This connector calls Ubiquiti's cloud (api.ui.com), not your controller
 * directly. It requires your gateway/console to be linked to a Ubiquiti
 * cloud account and outbound internet access from wherever this backend
 * runs. If you need a fully local/offline setup instead, use local
 * controller auth (session cookie, or local API key on UniFi OS) against
 * your controller's own IP instead of Site Manager.
 */
