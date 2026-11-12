// Polls each connector on a timer and caches the latest results in memory.
// The frontend only ever talks to this cache via /api/stats — it never
// triggers a live API call itself, so external rate limits stay controlled
// in one place.
//
// UniFi, Intune and the NinjaOne device counts (ninjaone.js) are out of
// scope for now (connector files are kept in ./connectors for later). To
// bring one back, add it to CONNECTORS below.
//
// calendarSync checks AV tickets and writes them to the events calendar each
// poll; its last run is at /api/stats and drives the page's alert banner.
// It only runs when CALENDAR_SYNC_ENABLED=true — otherwise it isn't polled
// and /api/stats has no calendarSync section, so the page shows none of it.

const tickets = require('./connectors/tickets');
const calendarSync = require('./connectors/calendarSync');

const CALENDAR_SYNC_ENABLED = process.env.CALENDAR_SYNC_ENABLED === 'true';
const CONNECTORS = { tickets, ...(CALENDAR_SYNC_ENABLED ? { calendarSync } : {}) };

const REFRESH_INTERVAL_SECONDS = parseInt(process.env.REFRESH_INTERVAL_SECONDS || '60', 10);

const cache = { lastPolledAt: null };
for (const name of Object.keys(CONNECTORS)) {
  cache[name] = { ok: false, error: 'Not yet polled' };
}

async function pollOne(name, connector) {
  try {
    cache[name] = await connector.getStats();
  } catch (err) {
    cache[name] = { ok: false, error: err.message };
    console.error(`[${name}] poll failed: ${err.message}`);
  }
}

async function pollAll() {
  await Promise.all(Object.entries(CONNECTORS).map(([name, connector]) => pollOne(name, connector)));
  cache.lastPolledAt = new Date().toISOString();
}

function start() {
  pollAll(); // fire immediately on boot
  setInterval(pollAll, REFRESH_INTERVAL_SECONDS * 1000);
}

function getCache() {
  return cache;
}

module.exports = { start, getCache };
