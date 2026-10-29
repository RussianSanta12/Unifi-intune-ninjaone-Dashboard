const express = require('express');
const path = require('path');
const aggregator = require('./aggregator');
const ninjaWebAuth = require('./lib/ninjaWebAuth');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the static frontend directly from this server so the whole
// dashboard is just "run the backend" — no separate frontend server needed.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/api/stats', (req, res) => {
  res.json(aggregator.getCache());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSeconds: process.uptime() });
});

// One-time NinjaOne sign-in that gives the calendar sync write access (see
// lib/ninjaWebAuth.js). Only answers on the server itself, so someone else
// on the network can't connect their own account.
function localOnly(req, res, next) {
  const ip = req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).send('Open this page on the dashboard server itself (http://localhost).');
}

app.get('/auth/ninjaone/start', localOnly, (req, res) => {
  if (!ninjaWebAuth.isConfigured()) {
    return res.status(500).send('Set NINJAONE_WEB_CLIENT_ID and NINJAONE_WEB_CLIENT_SECRET in .env first.');
  }
  res.redirect(ninjaWebAuth.authorizeUrl());
});

app.get('/auth/ninjaone/callback', localOnly, async (req, res) => {
  try {
    await ninjaWebAuth.handleCallback({ code: req.query.code, state: req.query.state });
    res.send('NinjaOne write access connected. You can close this tab.');
  } catch (err) {
    console.error(`[auth] NinjaOne sign-in failed: ${err.message}`);
    res.status(400).send(`NinjaOne sign-in failed: ${err.message.replace(/[<>&]/g, '')}`);
  }
});

app.listen(PORT, () => {
  console.log(`Stats Dashboard backend running at http://localhost:${PORT}`);
  aggregator.start();
});
