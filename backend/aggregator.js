// Polls each connector on a timer and caches the latest results in memory.
// The frontend only ever talks to this cache via /api/stats — it never
// triggers a live API call itself, so external rate limits stay controlled
// in one place.
//
// UniFi and Intune are out of scope for now (connector files are kept in
// ./connectors for later). To bring one back, add it to CONNECTORS below.
//
// calendarSync isn't shown on the page; it writes AV tickets to the events
// calendar each poll, and its last run is visible at /api/stats.

const ninjaone = require('./connectors/ninjaone');
const tickets = require('./connectors/tickets');
const calendarSync = require('./connectors/calendarSync');

const CONNECTORS = { ninjaone, tickets, calendarSync };

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
