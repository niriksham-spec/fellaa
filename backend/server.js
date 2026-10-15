const cors = require('cors');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

let db = { state: null, revision: 0 };
if (fs.existsSync(DATA_FILE)) {
  try {
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (stored && typeof stored === 'object') {
      db = {
        state: stored.state && typeof stored.state === 'object' ? stored.state : null,
        revision: Number.isInteger(stored.revision) ? stored.revision : 0,
      };
    }
  } catch (error) {
    console.error('Could not read shared data file:', error);
    throw error;
  }
}

function persist() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tempFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(db));
  fs.renameSync(tempFile, DATA_FILE);
}

const app = express();
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ state: db.state, revision: db.revision });
});

app.put('/api/state', (req, res) => {
  const { communities, visitorId, revision } = req.body || {};
  if (!communities || typeof communities !== 'object' || Array.isArray(communities)) {
    return res.status(400).json({ error: 'Invalid community data.' });
  }
  if (Object.keys(communities).length > 100) {
    return res.status(400).json({ error: 'Too many communities.' });
  }
  if (typeof visitorId !== 'string' || !/^v_[a-f0-9]{32}$/.test(visitorId)) {
    return res.status(400).json({ error: 'Invalid visitor ID.' });
  }
  if (!Number.isInteger(revision) || revision < 0) {
    return res.status(400).json({ error: 'Invalid state revision.' });
  }
  if (revision !== db.revision) {
    return res.status(409).json({
      error: 'Shared data changed. Reloading the latest community state.',
      state: db.state,
      revision: db.revision,
    });
  }

  db.state = { communities };
  db.revision++;
  try {
    persist();
  } catch (error) {
    console.error('Could not save shared data:', error);
    return res.status(500).json({ error: 'Could not save shared community data.' });
  }
  res.json({ ok: true, revision: db.revision });
});

app.get('/', (req, res) => res.json({ service: 'Fella Ride shared API', ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Fella Ride shared API listening on port ' + PORT);
});
