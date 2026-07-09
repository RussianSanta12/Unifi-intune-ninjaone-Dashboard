require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const aggregator = require('./aggregator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Serve the static frontend directly from this server so the whole
// dashboard is just "run the backend" — no separate frontend server needed.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/api/stats', (req, res) => {
  res.json(aggregator.getCache());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSeconds: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Stats Dashboard backend running at http://localhost:${PORT}`);
  aggregator.start();
});
