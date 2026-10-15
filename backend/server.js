const cors = require('cors');
const express = require('express');

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.');
}

const tableUrl = new URL('/rest/v1/shared_state', SUPABASE_URL);

async function supabaseRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase request failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return body ? JSON.parse(body) : null;
}

async function readState() {
  const url = new URL(tableUrl);
  url.searchParams.set('id', 'eq.global');
  url.searchParams.set('select', 'state,revision');
  let rows = await supabaseRequest(url);

  if (rows.length === 0) {
    const insertUrl = new URL(tableUrl);
    insertUrl.searchParams.set('on_conflict', 'id');
    await supabaseRequest(insertUrl, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ id: 'global', state: null, revision: 0 }),
    });
    rows = await supabaseRequest(url);
  }

  if (rows.length !== 1 || !Number.isInteger(rows[0].revision)) {
    throw new Error('Supabase shared_state table returned an invalid row.');
  }
  return rows[0];
}

const app = express();
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (req, res) => {
  try {
    await readState();
    res.json({ ok: true });
  } catch (error) {
    console.error('Shared data health check failed:', error);
    res.status(503).json({ ok: false, error: 'Shared data storage is unavailable.' });
  }
});

app.get('/api/state', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const row = await readState();
    res.json({ state: row.state, revision: row.revision });
  } catch (error) {
    console.error('Could not read shared data:', error);
    res.status(503).json({ error: 'Could not read shared community data.' });
  }
});

app.put('/api/state', async (req, res) => {
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

  try {
    const url = new URL(tableUrl);
    url.searchParams.set('id', 'eq.global');
    url.searchParams.set('revision', `eq.${revision}`);
    const updated = await supabaseRequest(url, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ state: { communities }, revision: revision + 1 }),
    });

    if (updated.length === 0) {
      const latest = await readState();
      return res.status(409).json({
        error: 'Shared data changed. Reloading the latest community state.',
        state: latest.state,
        revision: latest.revision,
      });
    }

    res.json({ ok: true, revision: updated[0].revision });
  } catch (error) {
    console.error('Could not save shared data:', error);
    res.status(503).json({ error: 'Could not save shared community data.' });
  }
});

app.get('/', (req, res) => res.json({ service: 'Fella Ride shared API', ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Fella Ride shared API listening on port ' + PORT);
});
