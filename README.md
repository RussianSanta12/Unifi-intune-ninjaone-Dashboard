# Stats Dashboard

Locally hosted dashboard showing UniFi, NinjaOne, and Intune stats, sized for 16:9 displays.

## Structure

```
stats-dashboard/
├── backend/          Node/Express server — polls the 3 APIs, serves /api/stats + the frontend
│   ├── connectors/   One module per integration (unifi.js, ninjaone.js, intune.js)
│   ├── .env          Fill this in with your real credentials (gitignored)
│   ├── .env.example  Safe-to-commit template
│   └── server.js
└── frontend/         Static HTML/CSS/JS, served by the backend
    └── logo/         Drop your logo.png here
```

## Setup

1. `cd backend && npm install`
2. Fill in `backend/.env` with your credentials (see PLAN.md for where to get each one).
3. Drop a logo file at `frontend/logo/logo.png` (optional).
4. `npm start` (from `backend/`) — serves everything at http://localhost:3000
5. Open that URL fullscreen on whatever display you want the dashboard on.

## Notes

- The backend polls each API on a timer (`REFRESH_INTERVAL_SECONDS` in `.env`, default 60s) and caches results in memory. The frontend just reads that cache every 30s — it never calls the external APIs directly, so your API keys never reach the browser.
- If a connector's credentials aren't set yet, `/api/stats` will return an error for that panel only — the other panels keep working.
- See `PLAN.md` (project root) for full architecture notes and the UniFi OS migration path.
