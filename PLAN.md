# Stats Dashboard — Plan

> **Current scope (2026-10-29): NinjaOne only.** UniFi and Intune are paused
> and will be revisited later. Their connectors (`backend/connectors/unifi.js`,
> `intune.js`) are kept but not polled, and the page doesn't show them. To
> re-enable one, add it to `CONNECTORS` in `backend/aggregator.js`, restore its
> `.env` section, and add its panel back to the frontend. Note for later: the
> current `unifi.js` uses the cloud Site Manager API, which conflicts with the
> local-only decision below — settle that before re-enabling it.

## What it shows (16:9 layout, e.g. 1920x1080 or 1280x720)

Three panels on one screen:

1. **UniFi** — devices currently connected (live count), plus monthly connected-user trend/math (e.g. unique clients per day rolled into a monthly count or average) for a specific network/site.
2. **NinjaOne** — summarized devices with pressing issues (open alerts, offline devices, failed patches, etc.).
3. **Intune** — summarized devices with pressing issues (non-compliant devices, sync failures, security alerts).

## Architecture

Backend + frontend, all running locally.

- **Backend**: Node.js (Express) or Python (FastAPI) service. Holds all API credentials, polls each API on its own interval, caches results in memory, exposes a simple internal `/api/stats` endpoint for the frontend.
- **Frontend**: Single static HTML/CSS/JS page sized to 16:9, polls the backend every N seconds (e.g. 30–60s), renders the three panels. No API secrets ever reach the browser.
- **Refresh**: Backend does the real API polling on a timer; frontend just polls the backend, so external API rate limits are controlled in one place.

## Per-API integration notes

### UniFi (self-hosted Network Application — current)
Self-hosted controller does **not** support the newer API-key auth (that's UniFi OS only). Use local admin credentials + session cookie auth:
- Log in via `POST /api/login` with a **local admin account** (not your main admin — create a dedicated one to avoid MFA issues) to get a session cookie.
- Reuse that cookie for subsequent calls (e.g. `/api/s/{site}/stat/sta` for connected clients).
- Sessions expire — backend needs to re-login periodically/on 401.
- For monthly connected-user math: poll connected clients periodically and store/aggregate over time (the controller doesn't give you "monthly unique users" as a single stat — you build it from repeated snapshots), or use the controller's stats endpoints (`/api/s/{site}/stat/report/monthly.site`) if available.

**When you migrate to UniFi OS**: switch to the local **API Key** method instead — generate a key in Integrations → Create New API Key on the UniFi OS console, and send it as a header (no more cookie/session juggling, lower rate-limit risk). This will simplify the UniFi module considerably — flagging now so the migration is a small isolated change.

**Considered and rejected**: Ubiquiti's **Site Manager API** (cloud, `api.ui.com`/`unifi.ui.com`, simple `X-API-KEY` header auth, no session/cookie management, works both pre- and post-OS-migration). Decided against it to keep the dashboard fully local/offline with no cloud dependency — staying on local controller auth (session cookie now, local API key after UniFi OS migration) as documented above.

### NinjaOne
OAuth 2.0, **Client Credentials flow** (machine-to-machine, no user login needed):
- In NinjaOne: Administration → Apps → API → Client app IDs → Add client app → platform = "API Services (machine-to-machine)".
- Scope: **Monitoring** only. Device, alert, and ticketing *reads* all work with it, so the dashboard stays read-only. Grant type: Client credentials only (no redirect URI needed).
- Get `Client ID` + `Client Secret`. Auth/HTTP is shared in `backend/lib/ninja.js`.

**Device counts** (`connectors/ninjaone.js`): Unhealthy / Needs Attention from `/v2/queries/device-health`, open alerts from `/v2/alerts`.

**IT / AV support requests** (`connectors/tickets.js`), shown as two side-by-side panels:
- Reads the existing NinjaOne boards "IT Support Requests" (form 1) and "AV Support Requests" (form 3) via `POST /v2/ticketing/trigger/board/{id}/run`, paginated with `lastCursorId`. Board runs include the assignee name and the board's custom-field columns, so no per-ticket calls.
- Shows only statuses New, In Progress, Added to Calendar. (These are NinjaOne's built-in NEW / OPEN / WAITING renamed, ids 1000 / 2000 / 3000.) Board runs reject status filters, so filtering happens in the connector.
- Each row: ticket ID, subject, primary assignee; AV also shows "Date of Event / Program" (custom field 14, a DATE). Status is shown only by the row's stripe color (New = blue, In Progress = gold, Added to Calendar = green) with a legend in each panel header.
- Sort: New, then In Progress, then Added to Calendar; within a status, AV by soonest event date, IT by oldest ticket.
- Board/field/status names are in `.env`; `npm run discover` prints the real values.

### Intune (via Microsoft Graph API)
Azure AD app registration + client secret (app-only auth):
- Azure Portal → App registrations → new app → Certificates & secrets → New client secret (expires ≤ 12 months, needs manual renewal — note the expiry).
- API permissions → Microsoft Graph → Application permissions → add `DeviceManagementManagedDevices.Read.All` (read-only is enough for a dashboard).
- Grant admin consent.
- Backend does the OAuth client-credentials flow against Azure AD to get a token, then calls Graph endpoints for managed devices / compliance state to build the "pressing issues" summary (non-compliant, not checked in recently, etc.).

## .env template

```
# --- UniFi (self-hosted Network Application) ---
UNIFI_HOST=https://192.168.1.1:8443       # controller URL
UNIFI_USERNAME=dashboard-local-admin       # dedicated local admin, not your main account
UNIFI_PASSWORD=
UNIFI_SITE=default                         # site name/id to pull stats for
UNIFI_VERIFY_SSL=false                     # true once you have a valid cert
# When migrating to UniFi OS, replace the three lines above with:
# UNIFI_API_KEY=
# UNIFI_HOST=https://<console-ip-or-hostname>

# --- NinjaOne ---
NINJAONE_INSTANCE_URL=https://app.ninjarmm.com     # or your region's instance
NINJAONE_CLIENT_ID=
NINJAONE_CLIENT_SECRET=

# --- Intune / Microsoft Graph ---
INTUNE_TENANT_ID=
INTUNE_CLIENT_ID=
INTUNE_CLIENT_SECRET=

# --- App config ---
PORT=3000
REFRESH_INTERVAL_SECONDS=60
```

## Next steps

1. Confirm backend language: Node/Express vs Python/FastAPI (either works fine).
2. Create the dedicated UniFi local admin account.
3. Create the NinjaOne machine-to-machine client app, note Client ID/Secret.
4. Register the Azure AD app for Intune, add client secret + Graph permission, grant admin consent.
5. Fill in `.env` with real values (never commit this file — add `.gitignore`).
6. Scaffold backend: three "connector" modules (unifi.js/py, ninjaone.js/py, intune.js/py) each exposing a `getStats()` function, an aggregator that polls them on a timer and caches results, and one `/api/stats` route.
7. Build the static 16:9 frontend with three panels, polling `/api/stats`.
8. Test each connector independently before wiring up the full dashboard.
