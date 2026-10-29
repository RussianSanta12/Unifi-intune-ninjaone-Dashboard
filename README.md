# Stats Dashboard

Locally hosted dashboard showing NinjaOne stats, sized for 16:9 displays.

> **Scope:** UniFi and Intune are paused for now. Their connector files are still in `backend/connectors/`, but the backend doesn't poll them and the page doesn't show them. See PLAN.md.

## Structure

```
Unifi-intune-ninjaone-Dashboard/
├── backend/          Node/Express server — polls NinjaOne, serves /api/stats + the frontend
│   ├── connectors/   One module per integration (only ninjaone.js is active)
│   ├── .env          Fill this in with your real credentials (gitignored)
│   ├── .env.example  Safe-to-commit template
│   └── server.js
└── frontend/         Static HTML/CSS/JS, served by the backend
    └── logo/         Drop your logo.png here
```

## Setup

1. Fill in `backend/.env` with your NinjaOne credentials (see PLAN.md for where to get them). `start` creates it from `.env.example` if it's missing.
2. Double-click `start.cmd` (or run `.\start.ps1`). It installs dependencies on first run, starts the server in the background, and opens http://localhost:3000.
3. Double-click `stop.cmd` (or run `.\stop.ps1`) to shut it down.
4. Open the URL fullscreen on whatever display you want the dashboard on.

Server output goes to `backend/server.log` and `backend/server.err.log`. To run it in the foreground instead, use `npm start` from `backend/`.

### Linux / macOS

Needs Node 20.6 or newer (Node 22 LTS recommended). Distro packages are often older; on Debian/Ubuntu use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Then, from the project folder:

```bash
./start.sh          # installs deps if needed, starts in the background, opens the browser if there's a desktop
./stop.sh           # shuts it down
PORT=3001 ./start.sh  # use a different port without editing .env
```

`start.sh` also reinstalls dependencies when `package-lock.json` changes (for example after switching branches). On a headless server it just prints the URL; open it from the display machine at `http://<server-ip>:3000`.

Only run one copy of the dashboard at a time (Windows or Linux): both would share the same NinjaOne API client, and each new sign-in cancels the other's.

## Notes

- The backend polls each API on a timer (`REFRESH_INTERVAL_SECONDS` in `.env`, default 60s) and caches results in memory. The frontend just reads that cache every 30s — it never calls the external APIs directly, so your API keys never reach the browser.
- If the NinjaOne credentials aren't set yet, the panel shows the error instead of numbers.
- See `PLAN.md` (project root) for full architecture notes and the UniFi OS migration path.
