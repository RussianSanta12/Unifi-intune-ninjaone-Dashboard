// NinjaOne connector — OAuth 2.0 Client Credentials flow (machine-to-machine).
//
// Setup: Administration → Apps → API → Client app IDs → Add client app
// → platform = "API Services (machine-to-machine)". Copy the Client ID
// and Client Secret into .env.

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

async function getStats() {
  // Devices with active alerts/conditions — used to build the
  // "pressing issues" summary for the dashboard.
  const [devices, alerts] = await Promise.all([
    authenticatedGet('/v2/devices'),
    authenticatedGet('/v2/alerts'),
  ]);

  const deviceList = Array.isArray(devices) ? devices : [];
  const alertList = Array.isArray(alerts) ? alerts : [];

  const offlineDevices = deviceList.filter((d) => d.offline === true);

  return {
    ok: true,
    totalDevices: deviceList.length,
    offlineCount: offlineDevices.length,
    openAlertCount: alertList.length,
    pressingIssues: alertList.slice(0, 10).map((a) => ({
      deviceId: a.deviceId,
      message: a.message || a.subject || 'Alert',
      severity: a.severity || 'UNKNOWN',
    })),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getStats };
