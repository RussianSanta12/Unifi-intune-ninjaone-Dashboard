// NinjaOne connector — OAuth 2.0 Client Credentials flow (machine-to-machine).
//
// Setup: Administration → Apps → API → Client app IDs → Add client app
// → platform = "API Services (machine-to-machine)". Copy the Client ID
// and Client Secret into .env.
//
// NINJAONE_INSTANCE_URL must match YOUR region, not just the US default —
// check the address bar while logged into the NinjaOne dashboard:
//   US: app.ninjarmm.com, US2: us2.ninjarmm.com, EU: eu.ninjarmm.com,
//   CA: ca.ninjarmm.com, OC: oc.ninjarmm.com
// Using the wrong region here is a common cause of auth/connection failures
// even with correct Client ID/Secret.

const fetch = require('node-fetch');

const INSTANCE_URL = process.env.NINJAONE_INSTANCE_URL; // e.g. https://app.ninjarmm.com
const CLIENT_ID = process.env.NINJAONE_CLIENT_ID;
const CLIENT_SECRET = process.env.NINJAONE_CLIENT_SECRET;

let accessToken = null;
let tokenExpiresAt = 0; // epoch ms

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return accessToken;
  }

  if (!INSTANCE_URL || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('NinjaOne credentials are not configured (check .env)');
  }

  const res = await fetch(`${INSTANCE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'monitoring',
    }),
  });

  if (!res.ok) {
    throw new Error(`NinjaOne token request failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  accessToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return accessToken;
}

async function authenticatedGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${INSTANCE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`NinjaOne request failed (${path}): ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// /v2/queries/* endpoints are cursor-paginated: { cursor: { name }, results: [] }.
// Follow the cursor until exhausted so we see the whole fleet.
async function getAllQueryResults(path) {
  const all = [];
  let cursor = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page = await authenticatedGet(cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path);
    const results = page.results || [];
    all.push(...results);
    cursor = page.cursor && page.cursor.name && results.length ? page.cursor.name : null;
  } while (cursor);
  return all;
}

// Rank for sorting issues: worse first.
const HEALTH_RANK = { UNHEALTHY: 0, NEEDS_ATTENTION: 1 };
const SEVERITY_RANK = { CRITICAL: 0, MAJOR: 1, MODERATE: 2, MINOR: 3, NONE: 4 };

function deviceLabel(device, id) {
  if (!device) return `Device #${id}`;
  return device.systemName || device.dnsName || device.netbiosName || `Device #${id}`;
}

async function getStats() {
  // device-health is NinjaOne's own per-device health rollup — the same
  // status the Ninja console shows (UNHEALTHY / NEEDS_ATTENTION / HEALTHY).
  const [devices, alerts, health] = await Promise.all([
    authenticatedGet('/v2/devices'),
    authenticatedGet('/v2/alerts'),
    getAllQueryResults('/v2/queries/device-health'),
  ]);

  const deviceList = Array.isArray(devices) ? devices : [];
  const alertList = Array.isArray(alerts) ? alerts : [];

  const deviceById = new Map(deviceList.map((d) => [d.id, d]));

  // Group alerts per device so each issue row can show its alert messages.
  const alertsByDevice = new Map();
  for (const a of alertList) {
    const list = alertsByDevice.get(a.deviceId) || [];
    list.push(a);
    alertsByDevice.set(a.deviceId, list);
  }

  // Devices the health rollup flags as having a problem.
  const unhealthy = [];
  const needsAttention = [];
  for (const h of health) {
    const status = h.healthStatus || h.health || h.status;
    if (status === 'UNHEALTHY') unhealthy.push(h);
    else if (status === 'NEEDS_ATTENTION') needsAttention.push(h);
  }

  // Build one issue row per problem device: name + health status + its
  // alert messages (worst alert severity used for sorting ties).
  const issueMap = new Map(); // deviceId -> issue

  const addIssue = (deviceId, healthStatus) => {
    if (issueMap.has(deviceId)) {
      if (healthStatus) issueMap.get(deviceId).healthStatus = healthStatus;
      return;
    }
    const deviceAlerts = (alertsByDevice.get(deviceId) || [])
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
    issueMap.set(deviceId, {
      deviceId,
      deviceName: deviceLabel(deviceById.get(deviceId), deviceId),
      healthStatus: healthStatus || null,
      severity: deviceAlerts.length ? deviceAlerts[0].severity || 'UNKNOWN' : null,
      messages: deviceAlerts.map((a) => a.message || a.subject || 'Alert').slice(0, 3),
    });
  };

  unhealthy.forEach((h) => addIssue(h.deviceId, 'UNHEALTHY'));
  needsAttention.forEach((h) => addIssue(h.deviceId, 'NEEDS_ATTENTION'));
  alertList.forEach((a) => addIssue(a.deviceId, null)); // alert-only devices

  const pressingIssues = Array.from(issueMap.values()).sort((a, b) => {
    const ha = a.healthStatus ? HEALTH_RANK[a.healthStatus] ?? 2 : 2;
    const hb = b.healthStatus ? HEALTH_RANK[b.healthStatus] ?? 2 : 2;
    if (ha !== hb) return ha - hb;
    return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  });

  return {
    ok: true,
    totalDevices: deviceList.length,
    unhealthyCount: unhealthy.length,
    needsAttentionCount: needsAttention.length,
    openAlertCount: alertList.length,
    pressingIssues,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getStats };
