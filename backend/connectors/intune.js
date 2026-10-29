// Intune connector — Microsoft Graph API via Azure AD app-only auth
// (OAuth 2.0 Client Credentials flow).
//
// Setup: Azure Portal → App registrations → new app → Certificates &
// secrets → New client secret. Then API permissions → Microsoft Graph →
// Application permissions → DeviceManagementManagedDevices.Read.All
// → Grant admin consent.

const TENANT_ID = process.env.INTUNE_TENANT_ID;
const CLIENT_ID = process.env.INTUNE_CLIENT_ID;
const CLIENT_SECRET = process.env.INTUNE_CLIENT_SECRET;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let accessToken = null;
let tokenExpiresAt = 0; // epoch ms

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return accessToken;
  }

  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Intune/Azure AD credentials are not configured (check .env)');
  }

  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });

  if (!res.ok) {
    throw new Error(`Intune/Azure AD token request failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  accessToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return accessToken;
}

async function authenticatedGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Graph request failed (${path}): ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// Follow @odata.nextLink so we get every managed device, not just the
// first page (Graph pages at 1000 by default).
async function getAllPages(path) {
  const all = [];
  let data = await authenticatedGet(path);
  all.push(...(data.value || []));
  while (data['@odata.nextLink']) {
    const next = data['@odata.nextLink'].replace(GRAPH_BASE, '');
    data = await authenticatedGet(next);
    all.push(...(data.value || []));
  }
  return all;
}

async function getStats() {
  // managedDevices includes compliance state per device.
  const devices = await getAllPages(
    '/deviceManagement/managedDevices?$select=deviceName,complianceState,lastSyncDateTime'
  );

  const nonCompliant = devices.filter((d) => d.complianceState !== 'compliant');

  return {
    ok: true,
    totalDevices: devices.length,
    nonCompliantCount: nonCompliant.length,
    // Full list — the frontend auto-scrolls through it.
    pressingIssues: nonCompliant.map((d) => ({
      deviceName: d.deviceName,
      complianceState: d.complianceState,
      lastSyncDateTime: d.lastSyncDateTime,
    })),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { getStats };
