// Microsoft Graph client for the events calendar — Azure AD app-only auth
// (OAuth 2.0 Client Credentials flow). Separate from the Intune app so the
// read-only Intune registration never gains calendar write access.
//
// Setup: Azure Portal → App registrations → new app → Certificates &
// secrets → New client secret. Then API permissions → Microsoft Graph →
// Application permissions → Calendars.ReadWrite → Grant admin consent.
// Calendars.ReadWrite covers every mailbox in the tenant, so limit it to the
// events calendar in Exchange Online (RBAC for Applications, or
// New-ApplicationAccessPolicy -AccessRight RestrictAccess).

const TENANT_ID = process.env.CALENDAR_TENANT_ID;
const CLIENT_ID = process.env.CALENDAR_CLIENT_ID;
const CLIENT_SECRET = process.env.CALENDAR_CLIENT_SECRET;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 15_000;

let accessToken = null;
let tokenExpiresAt = 0; // epoch ms

function isConfigured() {
  return Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET);
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return accessToken;
  }

  if (!isConfigured()) {
    throw new Error('Calendar (Microsoft Graph) credentials are not configured (check .env)');
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Calendar/Azure AD token request failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  accessToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return accessToken;
}

async function request(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Graph request failed (${method} ${path.split('?')[0]}): ${res.status} ${res.statusText} ${detail}`.trim());
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

module.exports = {
  isConfigured,
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
};
