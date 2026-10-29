// NinjaOne device connector — the three headline counts at the top of the
// dashboard. Auth and HTTP live in ../lib/ninja.js.

const ninja = require('../lib/ninja');

// /v2/queries/* endpoints are cursor-paginated: { cursor: { name }, results: [] }.
// Follow the cursor until exhausted so we see the whole fleet.
async function getAllQueryResults(path) {
  const all = [];
  let cursor = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page = await ninja.get(cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path);
    const results = page.results || [];
    all.push(...results);
    cursor = page.cursor && page.cursor.name && results.length ? page.cursor.name : null;
  } while (cursor);
  return all;
}

async function getStats() {
  // device-health is NinjaOne's own per-device health rollup — the same
  // status the Ninja console shows (UNHEALTHY / NEEDS_ATTENTION / HEALTHY).
  const [alerts, health] = await Promise.all([
    ninja.get('/v2/alerts'),
    getAllQueryResults('/v2/queries/device-health'),
  ]);

  const countStatus = (status) => health.filter((h) => (h.healthStatus || h.health || h.status) === status).length;

  return {
    ok: true,
    unhealthyCount: countStatus('UNHEALTHY'),
    needsAttentionCount: countStatus('NEEDS_ATTENTION'),
    openAlertCount: Array.isArray(alerts) ? alerts.length : 0,
  };
}

module.exports = { getStats };
