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

**Device counts** (`connectors/ninjaone.js`): Unhealthy / Needs Attention from `/v2/queries/device-health`, open alerts from `/v2/alerts`. **Removed from the page (2026-11-07)** — the weekly AV calendar took their place. The connector is kept but not polled.

**AV events this week** (top panel, replaces the device counts):
- Sun–Sat of the current week (moves to the next week once Saturday ends), one column per day. Today has a gold outline; past days are darker.
- Each event card: time ("Event Start Time" – "End Time", free text shown as typed), title, location ("Location(IT)"), assignees (red "Unassigned" if none), ticket # and requester, and a "↻ Recurring" tag. Same colors and comment markers as the month calendar. Recurring tickets appear on each of their days.
- A day's events are ordered by a rough read of the start time (unreadable times last); proper parsing comes with the calendar-sync branch's `lib/eventTime.js`. Mic count may be added later.
- Compact: cards are a fixed height and each day shows exactly two; a column with more scrolls slowly on its own. Days with unassigned events get a red "⚠ N unassigned" badge in the day's header row.
- Layout below it: the bottom row is split 40% IT list / 60% AV month calendar so month cards have room for their titles.
- The time/location fields aren't board columns, so they come from each ticket's details (closed tickets on the calendar get a details call too, without the log call). The requester name comes from the board row.

**IT / AV support requests** (`connectors/tickets.js`), shown as two side-by-side panels:
- Reads the existing NinjaOne boards "IT Support Requests" (form 1) and "AV Support Requests" (form 3) via `POST /v2/ticketing/trigger/board/{id}/run`, paginated with `lastCursorId`. Board runs include the assignee name and the board's custom-field columns, so no per-ticket calls.
- Shows only statuses New, In Progress, Added to Calendar. (These are NinjaOne's built-in NEW / OPEN / WAITING renamed, ids 1000 / 2000 / 3000.) Board runs reject status filters, so filtering happens in the connector.
- Each row: ticket ID, subject, primary assignee; AV also shows "Date of Event / Program" (custom field 14, a DATE). Status is shown only by the row's stripe color (New = blue, In Progress = gold, Added to Calendar = green) with a legend in each panel header.
- Sort: New, then In Progress, then Added to Calendar; within a status, AV by soonest event date, IT by oldest ticket.
- Board/field/status names are in `.env`; `npm run discover` prints the real values.
- Each row also shows additional assignees after the primary ("Technician A + Technician C"). **Unassigned** tickets fill the whole row with their status color so new tickets stand out.
- **Comment markers** (in the margin left of the status stripe; one marker is centered, two stack yellow over red):
  - **Yellow** = latest public comment by anyone other than the primary assignee. Clears when the assignee comments publicly after it.
  - **Red** = latest private/internal note by anyone, *including* the primary assignee.
  - Both also clear when a **technician** changes the status at or after the comment (same save counts). Status changes by requesters or automation are ignored, because NinjaOne reopens tickets automatically on email replies (e.g. Closed → In Progress), which would otherwise hide the marker. No time-based expiry.
  - Costs 2 extra calls per shown ticket per poll (`GET /v2/ticketing/ticket/{id}` and `/log-entry`), plus one `GET /v2/user/technicians` for assignee names.

**AV calendar check + sync** (`connectors/calendarSync.js`, rules in `lib/calendarCheck.js`), runs every poll:
- **On/off:** `CALENDAR_SYNC_ENABLED=true` turns the whole feature on; anything else (the default in `.env.example`) means it isn't polled, `/api/stats` has no `calendarSync` section, and the page shows no banner, dry-run tag or "Needs event info" key — the dashboard looks as it did before the sync. `CALENDAR_SYNC_DRY_RUN` then decides whether an enabled sync writes.
- **Check (New, In Progress):** every AV ticket is checked for what the calendar needs — event date, start/end times with am/pm (free text, `lib/eventTime.js`; the block starts at the setup time, so "6pm (5pm setup)" starts at 5pm), Location(IT), valid "Reoccurring Days" (`month:day`, `lib/recurringDays.js`) if "Reoccurring Event" is ticked, and at least one day from today on.
  - **Passes:** private note "[Calendar check] Approved to be added to calendar" listing the exact days/times/location, and the ticket is **assigned** by the main event date's weekday: Mon–Wed → Technician A, Thu–Sun → Technician B (technician IDs in `.env`); whoever covers another recurring day is added as an additional assignee (existing ones kept).
  - **Fails:** private "Missing info" form: each problem, the format it needs, and a "Field: value" reply template. The ticket gets the white **needs info** marker (first in the card's marker row). Staff fix it in the side panel, or reply with the lines filled in — the sync copies reply values into the ticket's fields (dropdown/date values are matched; ones it can't use are explained in the next form). Then it checks again and approves.
- **Add (staff set "Added to Calendar"):** checked once more; if it still passes (re-approved if it changed since approval), each upcoming day goes on the shared events calendar (`CALENDAR_MAILBOX`, `.env` only) via Microsoft Graph as its **own event** (Outlook recurrence can't express a date list), then a "[Calendar check] Added to the events calendar" note. If it no longer passes, a missing-info form instead and nothing is added. Past days are left off.
- **State lives in the notes:** each ends in `Ref: approved|missing|added/<hash>` (hash of the approved days/times/location, or of the problems). A note is re-posted only when that hash changes or someone replies, so nothing repeats each poll, and restarts lose nothing.
- **Not touched:** tickets in Added to Calendar that the sync never commented on (they predate it — e.g. #1116 — and are presumably on the calendar already), and tickets it has already added.
- The sync's notes never trigger the comment markers (red/yellow); staff replies do.
- **Ticket writes need a NinjaOne "Web" app** (Authorization Code + refresh token): NinjaOne answers ticket updates from client-credentials apps with 405. A technician signs in once at `http://localhost:3000/auth/ninjaone/start` (server only); the refresh token is kept in `backend/data/` (gitignored), and notes/updates show as that technician. NinjaOne may notify on each private note, depending on its notification rules.
- Graph uses its own app registration (`Calendars.ReadWrite`, limited to the events mailbox in Exchange Online), separate from the read-only Intune app.
- Safety: `CALENDAR_SYNC_DRY_RUN=true` (default) only logs. Events are tagged with ticket ID + day so retries don't double-book. Every ticket update is read back (the sync stops if anything else changed), every note is read back (it stops if it can't find it, rather than re-posting each poll), and it never posts two notes on one ticket within 2 minutes. `npm run check-calendar` checks the rules against real examples.
- **Alert banner:** when the sync can't run (not signed in, Microsoft secret expired, no calendar permission, stopped itself, settings missing) a red banner under the dashboard header gives the reason, the fix (runbook section) and the raw error; amber when some tickets failed or it hasn't finished a run in 10 minutes. Reasons are mapped in `calendarSync.js` (`PROBLEMS`), checked by `npm run check-calendar`. In dry run there's only a small "Calendar sync: dry run" tag in the header.
- **Revisit later — edits after a ticket is on the calendar.** Once a ticket has its "Added" note, later changes (new recurring days, changed times/date) don't reach the calendar; staff update it by hand. Moving it back to New/In Progress re-runs the check and, after re-approval and Added to Calendar again, adds any missing days (existing ones are found by tag) — removed days aren't deleted. Decided 2026-11-12 to leave this to people for now. If revisited: diff Added tickets' days/times against their tagged events and add/update/remove.
- Note: a new NinjaOne token invalidates the previous one, even across processes, so running scripts (`npm run discover`, checks against live data) while the dashboard is running can make either one fail once with 401.

**AV monthly calendar** (replaces the AV list; the IT panel stays a list):
- Sun–Sat grid of the current month, padded with the neighboring months' days to fill the first and last weeks (those days show their tickets too, slightly dimmed). Each ticket sits on its "Date of Event / Program" day; tickets with no date or outside the grid aren't shown.
- Per day: as many ticket cards (bold #id + title, wrapping to two lines) as fit the cell — two at 1080p — then "+N more" in the day's header row. Details live in the weekly panel above. Unassigned first, then by status; closed last.
- Cards: New / In Progress keep the colored stripe; **Added to Calendar** fills green; **Closed** fills brown. Days with unassigned tickets get a red "⚠ N" badge at the top. Comment markers sit in the card's top-right corner.
- Past days are dimmed (darker box, cards slightly faded so closed brown stays visible); today has a gold outline.
- Key in the heading row, between the title and the month name: "⚠ N Unassigned" (red when N > 0, counting open tickets on the grid), Added to Calendar, Public comment, Private note.
- **Recurring events:** if the ticket's "Reoccurring Event" checkbox (field 34) is ticked, it also shows on every day in "Reoccurring Days" (field 35) — a `month:day` list, e.g. `11:4, 11:16, 12:13`; bad entries are skipped. No year is given, so each day takes the year closest to the ticket's event date. Neither field is a board column, so values come from ticket details; a closed ticket is only fetched (and so only shows its recurring days) if its main event date is near the current month. Counts in the key/header are per ticket; per-day alerts and the next-month footer count each day.
- Footer: "<next month>: N events added to calendar" — Added to Calendar event days across all of next month.
- Closed tickets (`NINJAONE_AV_CLOSED_STATUS`, default "Closed") are AV-only and kept only when their event is within a week of the current month; they get the details call but skip the log call. The AV board does return closed tickets (checked 2026-11-07).

**Later — auto-close past AV events (not built).** Idea: each poll, close AV tickets in Added to Calendar whose event date is before today, with a private "Auto-closed by dashboard" note. Remember each close as (ticket, event date) so a ticket someone reopens isn't re-closed unless its date changes and passes again; re-read the ticket just before closing. Open questions before building:
- Needs a NinjaOne app with **Management** scope (writes) — preferably a separate client app so the dashboard's read-only key stays read-only. Note: ticket writes are refused (405) for client-credentials apps, so reuse the calendar sync's NinjaOne "Web" app (`ninja.write` in `lib/ninja.js`).
- Closing may email requesters depending on NinjaOne notification rules — check first.
- Ship behind `NINJAONE_AV_AUTO_CLOSE=off|dry-run|on`, starting in dry-run.

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
