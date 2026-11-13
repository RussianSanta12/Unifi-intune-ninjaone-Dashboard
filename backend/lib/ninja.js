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

// forgetToken: when given, a 401 drops the token and retries once — another
// process (a script, a second dashboard) signing in with the same app
// invalidates our token, and NinjaOne sometimes refuses a fresh one once
// (calendar test, ticket #1144).
function makeClient(getToken, forgetToken) {
  async function request(method, path, body, retried = false) {
    const token = await getToken();
    const isForm = body instanceof FormData; // comments are multipart; fetch sets the boundary
    const res = await fetch(`${INSTANCE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401 && forgetToken && !retried) {
      forgetToken(token);
      return request(method, path, body, true);
    }
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
    // POST /v2/ticketing/ticket/{id}/comment takes multipart/form-data with
    // the comment as a JSON part named "comment".
    comment: (ticketId, { body, isPublic = false }) => {
      const form = new FormData();
      const htmlBody = `<p>${String(body)
        .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
        .replace(/\n/g, '<br>')}</p>`;
      form.append('comment', new Blob([JSON.stringify({ public: isPublic, body, htmlBody })], { type: 'application/json' }));
      return request('POST', `/v2/ticketing/ticket/${ticketId}/comment`, form);
    },
  };
}

const read = makeClient(getAccessToken, (token) => {
  if (accessToken === token) accessToken = null; // not if a parallel call already replaced it
});

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
  // A 401 means the write wasn't done, so retrying it once is safe.
  write: makeClient(webAuth.getAccessToken, webAuth.forgetAccessToken),
};
