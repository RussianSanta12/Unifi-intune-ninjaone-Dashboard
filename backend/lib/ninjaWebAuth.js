// NinjaOne write access — OAuth 2.0 Authorization Code flow with a refresh
// token. NinjaOne rejects ticket updates from client-credentials apps (405),
// so the calendar sync writes through a "Web" app that a technician signs in
// to once at http://localhost:<PORT>/auth/ninjaone/start. Changes it makes
// show in the ticket log as that technician.
//
// Setup: Administration → Apps → API → Client app IDs → Add client app
// → platform = "Web", scopes = Monitoring + Management + Offline access,
// grant types = Authorization code + Refresh token, redirect URI =
// NINJAONE_WEB_REDIRECT_URI below. Copy its Client ID / Secret into .env.
//
// Only the refresh token is kept on disk (data/, gitignored). Anyone with
// that file can act as the signed-in technician, so keep the folder private.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INSTANCE_URL = process.env.NINJAONE_INSTANCE_URL;
const CLIENT_ID = process.env.NINJAONE_WEB_CLIENT_ID;
const CLIENT_SECRET = process.env.NINJAONE_WEB_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.NINJAONE_WEB_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/ninjaone/callback`;
const SCOPE = 'monitoring management offline_access';
const REQUEST_TIMEOUT_MS = 15_000;
const STATE_TTL_MS = 10 * 60_000;

const TOKEN_FILE = path.join(__dirname, '..', 'data', 'ninjaone-web-token.json');

let refreshToken = loadRefreshToken();
let accessToken = null;
let tokenExpiresAt = 0; // epoch ms
const pendingStates = new Map(); // state -> expiresAt

function loadRefreshToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refreshToken || null;
  } catch {
    return null;
  }
}

function saveRefreshToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: token, savedAt: new Date().toISOString() }, null, 2));
}

function isConfigured() {
  return Boolean(INSTANCE_URL && CLIENT_ID && CLIENT_SECRET);
}

function isConnected() {
  return isConfigured() && Boolean(refreshToken);
}

async function tokenRequest(params) {
  const res = await fetch(`${INSTANCE_URL}/ws/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err = new Error(`NinjaOne web-app token request failed: ${res.status} ${res.statusText} ${detail}`.trim());
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  accessToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  // NinjaOne may rotate the refresh token; always keep the newest one.
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    refreshToken = json.refresh_token;
    saveRefreshToken(refreshToken);
  }
  return accessToken;
}

let refreshing = null; // in-flight refresh, shared by concurrent callers

function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return Promise.resolve(accessToken);
  }
  if (!refreshing) {
    refreshing = refreshAccessToken().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function refreshAccessToken() {
  if (!isConnected()) {
    throw new Error('NinjaOne write access is not connected (sign in at /auth/ninjaone/start)');
  }
  try {
    return await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  } catch (err) {
    // A rejected refresh token won't start working again; require a new sign-in.
    if (err.status === 400 || err.status === 401) {
      refreshToken = null;
      fs.rmSync(TOKEN_FILE, { force: true });
    }
    throw err;
  }
}

function authorizeUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
  });
  return `${INSTANCE_URL}/ws/oauth/authorize?${params}`;
}

async function handleCallback({ code, state }) {
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expiresAt || Date.now() > expiresAt) {
    throw new Error('Sign-in link expired or was not started here — try /auth/ninjaone/start again');
  }
  if (!code) throw new Error('NinjaOne did not return an authorization code');
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  if (!refreshToken) {
    throw new Error('NinjaOne returned no refresh token — enable the Offline access scope and Refresh token grant');
  }
}

module.exports = { isConfigured, isConnected, getAccessToken, authorizeUrl, handleCallback };
