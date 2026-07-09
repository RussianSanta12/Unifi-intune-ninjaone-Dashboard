// Polls each connector on a timer and caches the latest results in memory.
// The frontend only ever talks to this cache via /api/stats — it never
// triggers a live API call itself, so external rate limits stay controlled
// in one place.

const unifi = require('./connectors/unifi');
const ninjaone = require('./connectors/ninjaone');
const intune = require('./connectors/intune');

const REFRESH_INTERVAL_SECONDS = parseInt(process.env.REFRESH_INTERVAL_SECONDS || '60', 10);

const cache = {
  unifi: { ok: false, error: 'Not yet polled' },
  ninjaone: { ok: false, error: 'Not yet polled' },
  intune: { ok: false, error: 'Not yet polled' },
  lastPolledAt: null,
};

async function pollOne(name, connector) {
  try {
    cache[name] = await connector.getStats();
  } catch (err) {
    cache[name] = { ok: false, error: err.message };
    console.error(`[${name}] poll failed: ${err.message}`);
  }
}

async function pollAll() {
  await Promise.all([
    pollOne('unifi', unifi),
    pollOne('ninjaone', ninjaone),
    pollOne('intune', intune),
  ]);
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
