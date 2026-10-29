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
//
// Ticket writes are a separate client (`write`, see ./ninjaWebAuth.js):
// NinjaOne rejects ticket updates from client-credentials apps with 405, so
// writes go through a "Web" app signed in once by a technician.

const webAuth = require('./ninjaWebAuth');

const INSTANCE_URL = process.env.NINJAONE_INSTANCE_URL; // e.g. https://app.ninjarmm.com
const CLIENT_ID = process.env.NINJAONE_CLIENT_ID;
const CLIENT_SECRET = process.env.NINJAONE_CLIENT_SECRET;

// Read-only is enough: device, alert and ticketing reads all work with
// "monitoring" alone, so the dashboard never holds write access.
const SCOPE = 'monitoring';
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 200;

let accessToken = null;
let tokenExpiresAt = 0; // epoch ms
let tokenRequest = null; // in-flight request, shared by concurrent callers

// A new token can invalidate the previous one, so parallel calls must
// share a single token request rather than each fetching their own.
function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return Promise.resolve(accessToken);
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

function makeClient(getToken) {
  async function request(method, path, body) {
    const token = await getToken();
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
      // Writes fail with a reason in the body; reads rarely do, but it's cheap to include.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      const err = new Error(
        `NinjaOne request failed (${method} ${path}): ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`
      );
      err.status = res.status;
      throw err;
    }

    const text = await res.text(); // updates answer 204 with no body
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
  };
}

const read = makeClient(getAccessToken);

// Board runs page with lastCursorId; a short page means we've seen them all.
async function runBoard(boardId) {
  const rows = [];
  let attributes = {};
  let cursor;
  for (;;) {
    const page = await read.post(`/v2/ticketing/trigger/board/${boardId}/run`, {
      pageSize: PAGE_SIZE,
      ...(cursor !== undefined ? { lastCursorId: cursor } : {}),
    });
    const data = page.data || [];
    rows.push(...data);
    attributes = (page.metadata && page.metadata.attributes) || attributes;
    if (data.length < PAGE_SIZE) break;
    cursor = page.metadata.lastCursorId;
  }
  return { rows, attributes };
}

module.exports = {
  get: read.get,
  post: read.post,
  runBoard,
  write: makeClient(webAuth.getAccessToken),
};
