// Shared NinjaOne API client — OAuth 2.0 Client Credentials flow
// (machine-to-machine). Used by every NinjaOne connector.
//
// Setup: Administration → Apps → API → Client app IDs → Add client app
// → platform = "API Services (machine-to-machine)", scope = Monitoring,
// grant type = Client credentials only (no redirect URI needed).
// Copy the Client ID and Client Secret into .env.
//
// NINJAONE_INSTANCE_URL must match YOUR region, not just the US default —
// check the address bar while logged into the NinjaOne dashboard:
//   US: app.ninjarmm.com, US2: us2.ninjarmm.com, EU: eu.ninjarmm.com,
//   CA: ca.ninjarmm.com, OC: oc.ninjarmm.com
// Using the wrong region here is a common cause of auth/connection failures
// even with correct Client ID/Secret.

const INSTANCE_URL = process.env.NINJAONE_INSTANCE_URL; // e.g. https://app.ninjarmm.com
const CLIENT_ID = process.env.NINJAONE_CLIENT_ID;
const CLIENT_SECRET = process.env.NINJAONE_CLIENT_SECRET;

// Read-only is enough: device, alert and ticketing reads all work with
// "monitoring" alone, so the dashboard never holds write access.
const SCOPE = 'monitoring';
const REQUEST_TIMEOUT_MS = 15_000;

let accessToken = null;
let tokenExpiresAt = 0; // epoch ms
let tokenRequest = null; // in-flight token fetch, shared by concurrent callers

// NinjaOne revokes a client's previous token when it issues a new one, so
// parallel requests must share one token fetch rather than each starting
// their own (otherwise the earlier tokens 401).
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return accessToken;
  }
  if (!tokenRequest) {
    tokenRequest = fetchAccessToken().finally(() => {
      tokenRequest = null;
    });
  }
  return tokenRequest;
}

async function fetchAccessToken() {
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
      scope: SCOPE,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`NinjaOne token request failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  accessToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return accessToken;
}

async function request(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${INSTANCE_URL}${path}`, {
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
    throw new Error(`NinjaOne request failed (${method} ${path}): ${res.status} ${res.statusText}`);
  }

  return res.json();
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);

module.exports = { get, post };
