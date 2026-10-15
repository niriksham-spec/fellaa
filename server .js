// Fella Ride backend: email code login, guest access, live updates, shared location and ratings
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const DEV_MODE = process.env.DEV_MODE === 'true';
const OTP_SECRET = process.env.OTP_SECRET || 'change-this-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = (text, params = []) => pool.query(text, params);
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
const ROLES = ['driver', 'passenger', 'connector']; // connector is shown as "Contractor"
const AREAS = ['North Gate', 'Tech Park', 'Old Town', 'Lake Side', 'Station Road'];
const DESTS = ['Campus', 'Airport', 'Railway Station', 'Bus Stand'];
const PLACE_OFF = {
  'Campus': [0, 0], 'North Gate': [0.012, 0], 'Tech Park': [0.006, 0.012], 'Old Town': [-0.008, -0.010],
  'Lake Side': [-0.010, 0.008], 'Station Road': [0.002, -0.014], 'Railway Station': [-0.020, -0.030],
  'Bus Stand': [0.004, -0.020], 'Airport': [0.090, 0.080],
};
const PLACES = Object.keys(PLACE_OFF);
const TIMES = ['07:30', '08:00', '08:30', '09:00', '17:30', '18:00'];
const AIR_TIMES = ['04:30', '06:00', '09:30', '13:00', '18:00', '21:30'];
const RATES = { auto: [30, 15], cab: [100, 14], shared: [20, 6] };
const TAGS = ['Polite', 'On time', 'Safe driving', 'Friendly', 'Clean vehicle', 'Good conversation', 'Respectful', 'Reliable', 'Late', 'Rude'];
const CO2_PER_KM = 0.12, GIFT_EVERY = 50;
const POINTS_SIGNUP = 20, POINTS_REFERRER = 100, POINTS_PER_TRIP = 5, POINTS_PER_CREDIT = 100;
const PUBLIC = 'public';
const DEMO_PASSWORD = 'demo1234';

const RIDE_SQL = `SELECT r.*, d.gender AS driver_gender, d.name AS driver_name,
  (SELECT COUNT(*)::int FROM bookings b WHERE b.ride_id = r.id) AS booked,
  (SELECT COUNT(*)::int FROM bookings b WHERE b.ride_id = r.id AND b.checked_in) AS checked
  FROM rides r LEFT JOIN users d ON d.id = r.driver_id`;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- Helpers ----------
const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Server problem. Please try again.' });
});
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const hashCode = (code, email) => crypto.createHash('sha256').update(OTP_SECRET + ':' + email + ':' + code).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(hash));
}
const makeRefCode = () => 'FR' + crypto.randomBytes(3).toString('hex').toUpperCase();
const dayOf = req => {
  const d = String(req.headers['x-day'] || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
};
function shiftDay(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const mins = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const pickupCode = (rideId, userId) => {
  let h = 0;
  for (const ch of rideId + userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(1000 + (h % 9000));
};
const round5 = n => Math.max(5, Math.round(n / 5) * 5);
function routeInfo(from, to, campus) {
  const o1 = PLACE_OFF[from] || [0, 0], o2 = PLACE_OFF[to] || [0, 0];
  const a = [campus[0] + o1[0], campus[1] + o1[1]], b = [campus[0] + o2[0], campus[1] + o2[1]];
  const R = 6371, t = d => d * Math.PI / 180;
  const h = Math.sin(t(b[0] - a[0]) / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(t(b[1] - a[1]) / 2) ** 2;
  const km = Math.max(0.5, 2 * R * Math.asin(Math.sqrt(h)) * 1.3);
  const fare = r => round5(r[0] + r[1] * km);
  return { km: +km.toFixed(1), auto: fare(RATES.auto), cab: fare(RATES.cab), shared: fare(RATES.shared), co2: +(km * CO2_PER_KM).toFixed(2) };
}
const userById = async id => (await q('SELECT * FROM users WHERE id = $1', [id])).rows[0];
async function campusOf(cid) {
  const r = (await q('SELECT lat, lng FROM communities WHERE id = $1', [cid])).rows[0];
  return r ? [r.lat, r.lng] : [12.9716, 77.5946];
}
async function isMember(uid, cid) {
  return (await q('SELECT 1 FROM memberships WHERE user_id = $1 AND community_id = $2', [uid, cid])).rows.length > 0;
}
function userOut(u, day) {
  const alive = u.streak_last === day || u.streak_last === shiftDay(day, -1);
  return {
    id: u.id, name: u.name, email: u.email, gender: u.gender, prefWomen: u.pref_women, refCode: u.ref_code,
    points: u.points, freeCredits: u.free_credits, logs: u.logs, giftClaims: u.gift_claims,
    streak: { count: alive ? u.streak_count : 0, days: alive ? u.streak_days : 0, best: u.streak_best },
  };
}
async function newSession(uid) {
  const token = crypto.randomBytes(24).toString('hex');
  await q('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, uid]);
  return token;
}
async function createUser({ name, email, gender, referral, password = null }) {
  let referrerId = null;
  if (referral) {
    const r = (await q('SELECT id FROM users WHERE ref_code = $1', [referral])).rows[0];
    if (r) referrerId = r.id;
  }
  const id = 'u_' + crypto.randomBytes(6).toString('hex');
  await q(`INSERT INTO users (id, name, email, password, gender, ref_code, referred_by, points)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, name, email, password ? hashPassword(password) : null, gender, makeRefCode(), referrerId, referrerId ? POINTS_SIGNUP : 0]);
  if (referrerId) await q('UPDATE users SET points = points + $2 WHERE id = $1', [referrerId, POINTS_REFERRER]);
  return (await q('SELECT * FROM users WHERE id = $1', [id])).rows[0];
}
const auth = wrap(async (req, res, next) => {
  const token = String(req.headers.authorization || '').replace('Bearer ', '');
  const r = (await q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1', [token])).rows[0];
  if (!r) return res.status(401).json({ error: 'Please log in again.' });
  req.user = r;
  req.day = dayOf(req);
  req.token = token;
  await q('UPDATE users SET last_seen = now() WHERE id = $1', [r.id]);
  next();
});

// Live updates: connected browsers per community
const clients = new Map();
function broadcast(cid, type = 'changed') {
  const set = clients.get(cid);
  if (!set) return;
  for (const res of set) res.write(`data: {"type":"${type}"}\n\n`);
}

// Streak and gift counter. Returns true when this log is a milestone (every 50th).
async function logActivity(u, day) {
  let count = u.streak_count, days = u.streak_days, best = u.streak_best, logs = u.logs;
  const last = u.streak_last;
  if (last !== day) {
    if (last === shiftDay(day, -1)) days += 1;
    else { days = 1; count = 0; }
  }
  count += 1;
  best = Math.max(best, count);
  logs += 1;
  await q('UPDATE users SET streak_count=$2, streak_days=$3, streak_last=$4, streak_best=$5, logs=$6 WHERE id=$1',
    [u.id, count, days, day, best, logs]);
  await q(`INSERT INTO daily_logs (user_id, day, n) VALUES ($1, $2, 1)
    ON CONFLICT (user_id, day) DO UPDATE SET n = daily_logs.n + 1`, [u.id, day]);
  return logs % GIFT_EVERY === 0;
}
function seatProblem(u, ride) {
  if (ride.driver_id === u.id) return 'This is your own ride.';
  if (ride.mine) return 'You already have a seat on this ride.';
  if (ride.booked >= ride.seats) return 'No seats left on this ride.';
  if (ride.pink && u.gender !== 'Female') return 'Pink rides are for women passengers only.';
  if (u.pref_women && ride.driver_gender !== 'Female') return 'You chose women drivers only.';
  return null;
}
async function rideRow(id, uid) {
  const r = (await q(`${RIDE_SQL} WHERE r.id = $1`, [id])).rows[0];
  if (!r) return null;
  r.mine = (await q('SELECT 1 FROM bookings WHERE ride_id = $1 AND user_id = $2', [id, uid])).rows.length > 0;
  return r;
}
async function confirmBooking(u, ride, day, kind, credit, matched) {
  const code = pickupCode(ride.id, u.id);
  await q('INSERT INTO bookings (ride_id, user_id, pickup_code) VALUES ($1, $2, $3)', [ride.id, u.id, code]);
  const info = routeInfo(ride.area, ride.dest, await campusOf(ride.community_id));
  const fare = credit ? 0 : info.shared;
  const status = (matched === undefined ? 'Seat booked' : matched ? 'Matched with a shared driver' : 'Shared Fella cab assigned')
    + '. Pickup code ' + code + ', departs ' + ride.time;
  await q(`INSERT INTO trips (id, user_id, community_id, kind, from_place, to_place, time, status, ride_id, km, fare, auto_fare, co2, credit)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    ['t_' + crypto.randomBytes(6).toString('hex'), u.id, ride.community_id, kind, ride.area, ride.dest, ride.time,
     status, ride.id, info.km, fare, info.auto, info.co2, credit]);
  await q('UPDATE users SET points = points + $2 WHERE id = $1', [u.id, POINTS_PER_TRIP]);
  const milestone = await logActivity(await userById(u.id), day);
  broadcast(ride.community_id);
  return { code, fare, milestone };
}
async function membersOf(cid) {
  return (await q(`SELECT u.id, u.name, u.gender, u.pref_women, u.last_seen, m.role, m.area, m.time
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.community_id = $1 ORDER BY u.name`, [cid])).rows;
}
async function activeIdsOf(cid) {
  const r = await q(`SELECT b.user_id AS id FROM bookings b JOIN rides r ON r.id = b.ride_id WHERE r.community_id = $1
    UNION SELECT driver_id AS id FROM rides WHERE community_id = $1 AND driver_id IS NOT NULL`, [cid]);
  return new Set(r.rows.map(x => x.id));
}
function compatible(a, b) {
  if (!a || !b || a.id === b.id || a.area !== b.area) return false;
  if (Math.abs(mins(a.time) - mins(b.time)) > 30) return false;
  if (a.pref_women && b.role === 'driver' && b.gender !== 'Female') return false;
  if (b.pref_women && a.role === 'driver' && a.gender !== 'Female') return false;
  if (a.role === 'connector' || b.role === 'connector') return true;
  return a.role !== b.role;
}
function scoreOf(m, all) {
  let s = m.role === 'driver' ? 30 : m.role === 'connector' ? 25 : 15;
  s += Math.min(all.filter(o => compatible(m, o)).length, 5) * 6;
  if (Date.now() - new Date(m.last_seen).getTime() < 3 * 864e5) s += 10;
  return Math.min(100, s);
}

// Ratings: average stars and the most chosen word for a list of users
async function repMap(ids) {
  const map = {};
  if (!ids.length) return map;
  const avgs = (await q(`SELECT to_user AS id, ROUND(AVG(stars)::numeric,1) AS avg, COUNT(*)::int AS n
    FROM ratings WHERE to_user = ANY($1) GROUP BY to_user`, [ids])).rows;
  const tops = (await q(`SELECT DISTINCT ON (to_user) to_user AS id, tag FROM
    (SELECT to_user, tag, COUNT(*) AS n FROM ratings WHERE to_user = ANY($1) GROUP BY to_user, tag) t
    ORDER BY to_user, n DESC, tag`, [ids])).rows;
  avgs.forEach(a => { map[a.id] = { avg: Number(a.avg), count: a.n, top: null }; });
  tops.forEach(t => { map[t.id] = map[t.id] || { avg: null, count: 0, top: null }; map[t.id].top = t.tag; });
  return map;
}
async function reputationOf(uid) {
  const s = (await q('SELECT ROUND(AVG(stars)::numeric,1) AS avg, COUNT(*)::int AS n FROM ratings WHERE to_user = $1', [uid])).rows[0];
  const tags = (await q('SELECT tag, COUNT(*)::int AS n FROM ratings WHERE to_user = $1 GROUP BY tag ORDER BY n DESC, tag LIMIT 5', [uid])).rows;
  return { avg: s.avg === null ? null : Number(s.avg), count: s.n, tags };
}

// ---------- Accounts: email code login ----------
app.get('/', (req, res) => res.send('Fella Ride API is running.'));

app.post('/api/auth/request-otp', wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) fail(400, 'Enter a valid email address.');
  const exists = (await q('SELECT 1 FROM users WHERE email = $1', [email])).rows.length > 0;
  let name = null, gender = null, referral = null;
  if (b.mode === 'signup') {
    if (exists) fail(409, 'An account with this email already exists. Log in instead.');
    name = String(b.name || '').trim().slice(0, 40);
    if (!name) fail(400, 'Enter your name.');
    gender = String(b.gender || '');
    if (!GENDERS.includes(gender)) fail(400, 'Choose your gender. This decides which rides you can see.');
    referral = String(b.referral || '').trim().toUpperCase() || null;
    if (referral && !(await q('SELECT 1 FROM users WHERE ref_code = $1', [referral])).rows.length) {
      fail(400, 'That referral code was not found. Check it, or leave the box empty.');
    }
  } else if (!exists) {
    fail(404, 'No account with this email yet. Choose Create account first.');
  }
  const last = (await q('SELECT sent_at FROM otps WHERE email = $1', [email])).rows[0];
  if (last && Date.now() - new Date(last.sent_at).getTime() < 60000) fail(429, 'Please wait a minute before asking for another code.');

  const code = String(crypto.randomInt(100000, 1000000));
  await q(`INSERT INTO otps (email, code_hash, expires_at, attempts, sent_at, name, gender, referral)
    VALUES ($1, $2, now() + interval '10 minutes', 0, now(), $3, $4, $5)
    ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at,
      attempts = 0, sent_at = now(), name = EXCLUDED.name, gender = EXCLUDED.gender, referral = EXCLUDED.referral`,
    [email, hashCode(code, email), name, gender, referral]);

  if (mailer) {
    try {
      await mailer.sendMail({
        from: process.env.MAIL_FROM || 'Fella Ride <no-reply@example.com>',
        to: email,
        subject: 'Your Fella Ride login code',
        text: `Your Fella Ride code is ${code}. It expires in 10 minutes. If you did not ask for this, ignore this email.`,
      });
    } catch (e) {
      console.error('Email failed:', e.message);
      fail(500, 'Could not send the email. Check the email settings on the server.');
    }
  } else if (!DEV_MODE) {
    fail(500, 'Email is not set up on the server yet.');
  } else {
    console.log('[dev] code for ' + email + ': ' + code);
  }
  res.json({ ok: true, devCode: !mailer && DEV_MODE ? code : undefined });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const code = String((req.body || {}).code || '').trim();
  const o = (await q('SELECT * FROM otps WHERE email = $1', [email])).rows[0];
  if (!o) fail(400, 'Ask for a new code first.');
  if (new Date(o.expires_at) < new Date()) {
    await q('DELETE FROM otps WHERE email = $1', [email]);
    fail(400, 'This code has expired. Ask for a new one.');
  }
  if (o.attempts >= 5) {
    await q('DELETE FROM otps WHERE email = $1', [email]);
    fail(429, 'Too many wrong tries. Ask for a new code.');
  }
  if (o.code_hash !== hashCode(code, email)) {
    await q('UPDATE otps SET attempts = attempts + 1 WHERE email = $1', [email]);
    fail(400, 'Wrong code. Try again.');
  }
  await q('DELETE FROM otps WHERE email = $1', [email]);
  let user = (await q('SELECT * FROM users WHERE email = $1', [email])).rows[0];
  if (!user) {
    if (!o.name || !o.gender) fail(404, 'No account with this email yet. Choose Create account first.');
    user = await createUser({ name: o.name, email, gender: o.gender, referral: o.referral });
  }
  res.json({ token: await newSession(user.id), user: userOut(user, dayOf(req)) });
}));

// Guest access: a temporary account with no email or password
app.post('/api/guest', wrap(async (req, res) => {
  const id = 'u_g_' + crypto.randomBytes(6).toString('hex');
  await q(`INSERT INTO users (id, name, email, password, gender, ref_code)
    VALUES ($1, 'Guest', $2, NULL, 'Prefer not to say', $3)`,
    [id, id + '@guest.local', makeRefCode()]);
  res.json({ token: await newSession(id), user: userOut(await userById(id), dayOf(req)) });
}));

// Password login is kept only for the demo accounts
app.post('/api/login', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const u = (await q('SELECT * FROM users WHERE email = $1', [email])).rows[0];
  if (!u || !checkPassword(String((req.body || {}).password || ''), u.password)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  res.json({ token: await newSession(u.id), user: userOut(u, dayOf(req)) });
}));

app.post('/api/logout', auth, wrap(async (req, res) => {
  await q('DELETE FROM sessions WHERE token = $1', [req.token]);
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  res.json({ user: userOut(await userById(req.user.id), req.day) });
}));

app.put('/api/profile', auth, wrap(async (req, res) => {
  const g = String((req.body || {}).gender || '');
  if (!GENDERS.includes(g)) fail(400, 'Choose a gender.');
  await q('UPDATE users SET gender = $2, pref_women = $3 WHERE id = $1', [req.user.id, g, g === 'Female' && !!req.body.prefWomen]);
  res.json({ user: userOut(await userById(req.user.id), req.day) });
}));

// ---------- Live updates (server-sent events) ----------
app.get('/api/events', wrap(async (req, res) => {
  const token = String(req.query.token || '');
  const cid = String(req.query.community || '');
  const s = (await q('SELECT user_id FROM sessions WHERE token = $1', [token])).rows[0];
  if (!s) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  if (!clients.has(cid)) clients.set(cid, new Set());
  clients.get(cid).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    const set = clients.get(cid);
    if (set) set.delete(res);
  });
}));

// ---------- Shared live location (15 minutes) ----------
app.post('/api/location', auth, wrap(async (req, res) => {
  const lat = Number((req.body || {}).lat), lng = Number((req.body || {}).lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'Invalid location.');
  await q(`INSERT INTO locations (user_id, lat, lng, updated_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now()`,
    [req.user.id, lat, lng]);
  const cs = (await q('SELECT community_id FROM memberships WHERE user_id = $1', [req.user.id])).rows;
  cs.forEach(c => broadcast(c.community_id, 'location'));
  res.json({ ok: true });
}));

app.post('/api/location/stop', auth, wrap(async (req, res) => {
  await q('DELETE FROM locations WHERE user_id = $1', [req.user.id]);
  const cs = (await q('SELECT community_id FROM memberships WHERE user_id = $1', [req.user.id])).rows;
  cs.forEach(c => broadcast(c.community_id, 'location'));
  res.json({ ok: true });
}));

// ---------- Communities ----------
app.get('/api/communities', auth, wrap(async (req, res) => {
  const rows = (await q(`SELECT c.id, c.name, c.type, c.code,
    (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id)::int AS members,
    (SELECT COUNT(*) FROM rides r WHERE r.community_id = c.id)::int AS rides,
    EXISTS(SELECT 1 FROM memberships m WHERE m.community_id = c.id AND m.user_id = $1) AS joined
    FROM communities c WHERE c.type <> 'Public' ORDER BY c.name`, [req.user.id])).rows;
  res.json({ communities: rows.map(c => ({
    id: c.id, name: c.name, type: c.type, members: c.members, rides: c.rides,
    joined: c.joined, code: c.joined ? c.code : null,
  })) });
}));

app.post('/api/communities', auth, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 50);
  if (!name) fail(400, 'Give the community a name.');
  const type = req.body.type === 'Workplace' ? 'Workplace' : 'College';
  const base = name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'FR';
  let code = base + '26', n = 1;
  while ((await q('SELECT 1 FROM communities WHERE code = $1', [code])).rows.length) code = base + (10 + n++);
  const id = 'c_' + crypto.randomBytes(4).toString('hex');
  await q('INSERT INTO communities (id, name, type, code, lat, lng) VALUES ($1, $2, $3, $4, $5, $6)', [id, name, type, code, 12.9716, 77.5946]);
  await q(`INSERT INTO memberships (user_id, community_id, role, area, time) VALUES ($1, $2, 'passenger', 'North Gate', '08:00')`, [req.user.id, id]);
  res.json({ id, code });
}));

app.get('/api/communities/:id', auth, wrap(async (req, res) => {
  const cid = req.params.id, uid = req.user.id;
  const c = (await q('SELECT * FROM communities WHERE id = $1', [cid])).rows[0];
  if (!c) fail(404, 'Community not found.');
  const mem = (await q('SELECT role, area, time FROM memberships WHERE user_id = $1 AND community_id = $2', [uid, cid])).rows[0] || null;
  const members = await membersOf(cid);
  const rep = await repMap(members.map(m => m.id));
  const mine = new Set((await q('SELECT ride_id FROM bookings WHERE user_id = $1', [uid])).rows.map(x => x.ride_id));
  const rides = (await q(`${RIDE_SQL} WHERE r.community_id = $1 AND (NOT r.pink OR $2 OR r.driver_id = $3)
    ORDER BY r.created_at DESC`, [cid, req.user.gender === 'Female', uid])).rows.map(r => ({
    id: r.id, area: r.area, dest: r.dest, time: r.time, seats: r.seats, pink: r.pink,
    booked: r.booked, checked: r.checked, seatsLeft: r.seats - r.booked,
    driverId: r.driver_id, driverName: r.driver_id ? r.driver_name : 'Shared Fella cab',
    driverGender: r.driver_gender,
    driverRating: r.driver_id && rep[r.driver_id] ? rep[r.driver_id].avg : null,
    completed: r.completed, isOwn: r.driver_id === uid, mine: mine.has(r.id),
    code: mine.has(r.id) ? pickupCode(r.id, uid) : null,
  }));
  const active = await activeIdsOf(cid);
  const interventions = (await q(`SELECT i.id, i.member_id, i.type, i.message, i.status, u.name
    FROM interventions i JOIN users u ON u.id = i.member_id WHERE i.community_id = $1 ORDER BY i.created_at DESC`, [cid])).rows
    .map(i => ({ ...i, status: i.status === 'sent' && active.has(i.member_id) ? 'converted' : i.status }));
  const locs = mem ? (await q(`SELECT l.user_id AS id, u.name, l.lat, l.lng, l.updated_at
    FROM locations l JOIN users u ON u.id = l.user_id
    JOIN memberships m ON m.user_id = l.user_id AND m.community_id = $1
    WHERE l.updated_at > now() - interval '15 minutes'`, [cid])).rows : [];
  res.json({
    community: { id: c.id, name: c.name, type: c.type, code: mem ? c.code : null, campus: [c.lat, c.lng] },
    me: mem,
    members: members.map(m => ({
      id: m.id, name: m.name, gender: m.gender, prefWomen: m.pref_women, role: m.role, area: m.area, time: m.time,
      isMe: m.id === uid, rating: rep[m.id] || { avg: null, count: 0, top: null },
    })),
    rides, interventions,
    locations: locs.map(l => ({ ...l, isMe: l.id === uid })),
  });
}));

app.post('/api/communities/:id/join', auth, wrap(async (req, res) => {
  const c = (await q('SELECT * FROM communities WHERE id = $1', [req.params.id])).rows[0];
  if (!c || c.type === 'Public') fail(404, 'Community not found.');
  const b = req.body || {};
  if (String(b.code || '').trim().toUpperCase() !== c.code) fail(400, 'Community code not recognised.');
  const role = ROLES.includes(b.role) ? b.role : 'passenger';
  const area = AREAS.includes(b.area) ? b.area : 'North Gate';
  const time = TIMES.includes(b.time) ? b.time : '08:00';
  await q(`INSERT INTO memberships (user_id, community_id, role, area, time) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, community_id) DO UPDATE SET role = EXCLUDED.role, area = EXCLUDED.area, time = EXCLUDED.time`,
    [req.user.id, c.id, role, area, time]);
  broadcast(c.id);
  res.json({ ok: true });
}));

// Change your role from the dashboard
app.put('/api/communities/:id/role', auth, wrap(async (req, res) => {
  const role = String((req.body || {}).role || '');
  if (!ROLES.includes(role)) fail(400, 'Choose Driver, Passenger or Contractor.');
  const r = await q('UPDATE memberships SET role = $3 WHERE user_id = $1 AND community_id = $2', [req.user.id, req.params.id, role]);
  if (!r.rowCount) fail(403, 'Join this community first.');
  broadcast(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/communities/:id/rides', auth, wrap(async (req, res) => {
  const m = (await q('SELECT role FROM memberships WHERE user_id = $1 AND community_id = $2', [req.user.id, req.params.id])).rows[0];
  if (!m) fail(403, 'Join this community first.');
  if (m.role !== 'driver') fail(403, 'Set your role to Driver on the dashboard to post rides.');
  const b = req.body || {};
  const pink = !!b.pink;
  if (pink && req.user.gender !== 'Female') fail(403, 'Pink rides are for women drivers only.');
  const area = AREAS.includes(b.area) ? b.area : 'North Gate';
  const dest = DESTS.includes(b.dest) ? b.dest : 'Campus';
  const time = TIMES.includes(b.time) ? b.time : '08:00';
  const seats = Math.min(4, Math.max(1, Number(b.seats) || 1));
  const id = 'r_' + crypto.randomBytes(5).toString('hex');
  await q(`INSERT INTO rides (id, community_id, driver_id, area, dest, time, seats, pink) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, req.params.id, req.user.id, area, dest, time, seats, pink]);
  const milestone = await logActivity(req.user, req.day);
  broadcast(req.params.id);
  res.json({ id, milestone });
}));

app.post('/api/communities/:id/interventions/run', auth, wrap(async (req, res) => {
  const cid = req.params.id;
  if (!(await isMember(req.user.id, cid))) fail(403, 'Join this community first.');
  const members = await membersOf(cid);
  const active = await activeIdsOf(cid);
  const hasAny = new Set((await q('SELECT DISTINCT member_id FROM interventions WHERE community_id = $1', [cid])).rows.map(r => r.member_id));
  let created = 0;
  for (const m of members) {
    if (active.has(m.id) || hasAny.has(m.id)) continue;
    if (scoreOf(m, members) < 40) continue;
    const matches = members.filter(o => compatible(m, o)).length;
    let type, message;
    if (m.role === 'driver') { type = 'post_ride'; message = `${matches} commuters from ${m.area} leave around ${m.time}. Post a ride to fill your seats.`; }
    else if (m.role === 'connector') { type = 'connect'; message = `Introduce ${m.area} members to each other and start a ride group.`; }
    else { type = 'find_ride'; message = `${matches} possible rides from ${m.area} around ${m.time}. Request a seat.`; }
    await q('INSERT INTO interventions (id, community_id, member_id, type, message) VALUES ($1, $2, $3, $4, $5)',
      ['i_' + crypto.randomBytes(5).toString('hex'), cid, m.id, type, message]);
    created++;
  }
  broadcast(cid);
  res.json({ created });
}));

app.put('/api/interventions/:id', auth, wrap(async (req, res) => {
  const i = (await q('SELECT community_id FROM interventions WHERE id = $1', [req.params.id])).rows[0];
  if (!i || !(await isMember(req.user.id, i.community_id))) fail(403, 'Not allowed.');
  await q('UPDATE interventions SET status = $2 WHERE id = $1', [req.params.id, req.body.status === 'sent' ? 'sent' : 'draft']);
  broadcast(i.community_id);
  res.json({ ok: true });
}));

// ---------- Rides ----------
app.post('/api/rides/:id/book', auth, wrap(async (req, res) => {
  const ride = await rideRow(req.params.id, req.user.id);
  if (!ride) fail(404, 'Ride not found.');
  if (ride.community_id !== PUBLIC && !(await isMember(req.user.id, ride.community_id))) fail(403, 'Join this community first.');
  const why = seatProblem(req.user, ride);
  if (why) fail(400, why);
  res.json(await confirmBooking(req.user, ride, req.day, 'seat', false));
}));

// Driver marks the trip finished. Passengers can rate after this.
app.post('/api/rides/:id/complete', auth, wrap(async (req, res) => {
  const r = (await q('SELECT driver_id, community_id FROM rides WHERE id = $1', [req.params.id])).rows[0];
  if (!r || r.driver_id !== req.user.id) fail(403, 'Only the driver can mark a trip as completed.');
  await q('UPDATE rides SET completed = true WHERE id = $1', [req.params.id]);
  broadcast(r.community_id);
  res.json({ ok: true });
}));

app.post('/api/rides/:id/checkin', auth, wrap(async (req, res) => {
  const ride = (await q('SELECT driver_id, community_id FROM rides WHERE id = $1', [req.params.id])).rows[0];
  if (!ride || ride.driver_id !== req.user.id) fail(403, 'Only the driver can check in passengers.');
  const b = (await q('SELECT user_id, checked_in FROM bookings WHERE ride_id = $1 AND pickup_code = $2',
    [req.params.id, String((req.body || {}).code || '').trim()])).rows[0];
  if (!b) fail(400, 'That code does not match a booked passenger.');
  if (b.checked_in) fail(400, 'That passenger is already checked in.');
  await q('UPDATE bookings SET checked_in = true WHERE ride_id = $1 AND user_id = $2', [req.params.id, b.user_id]);
  broadcast(ride.community_id);
  res.json({ ok: true });
}));

// ---------- Ratings and feedback ----------
// Rides you were part of, completed, where you have not rated the other person yet
app.get('/api/ratings/pending', auth, wrap(async (req, res) => {
  const uid = req.user.id;
  const rides = (await q(`SELECT r.id, r.area, r.dest, r.time, r.driver_id, d.name AS driver_name
    FROM rides r LEFT JOIN users d ON d.id = r.driver_id
    WHERE r.completed AND (r.driver_id = $1 OR r.id IN (SELECT ride_id FROM bookings WHERE user_id = $1))
    ORDER BY r.created_at DESC LIMIT 30`, [uid])).rows;
  const out = [];
  for (const r of rides) {
    let targets = [];
    if (r.driver_id === uid) {
      targets = (await q(`SELECT u.id, u.name FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.ride_id = $1`, [r.id])).rows
        .map(t => ({ id: t.id, name: t.name, role: 'passenger' }));
    } else if (r.driver_id) {
      targets = [{ id: r.driver_id, name: r.driver_name, role: 'driver' }];
    }
    for (const t of targets) {
      const done = (await q('SELECT 1 FROM ratings WHERE ride_id = $1 AND from_user = $2 AND to_user = $3', [r.id, uid, t.id])).rows.length > 0;
      if (!done) out.push({ rideId: r.id, area: r.area, dest: r.dest, time: r.time, target: { id: t.id, name: t.name }, targetRole: t.role });
    }
  }
  res.json({ pending: out });
}));

app.post('/api/ratings', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const stars = Math.round(Number(b.stars));
  const tag = String(b.tag || '');
  const rideId = String(b.rideId || ''), to = String(b.toUserId || ''), uid = req.user.id;
  if (!(stars >= 1 && stars <= 5)) fail(400, 'Choose 1 to 5 stars.');
  if (!TAGS.includes(tag)) fail(400, 'Choose a word that describes them.');
  if (to === uid) fail(400, 'You cannot rate yourself.');
  const ride = (await q('SELECT driver_id, completed, community_id FROM rides WHERE id = $1', [rideId])).rows[0];
  if (!ride || !ride.completed) fail(400, 'You can rate after the driver marks the trip completed.');
  const onRide = ride.driver_id === uid || (await q('SELECT 1 FROM bookings WHERE ride_id = $1 AND user_id = $2', [rideId, uid])).rows.length > 0;
  const toOnRide = ride.driver_id === to || (await q('SELECT 1 FROM bookings WHERE ride_id = $1 AND user_id = $2', [rideId, to])).rows.length > 0;
  if (!onRide || !toOnRide) fail(403, 'You can only rate people who shared this ride.');
  const ins = await q(`INSERT INTO ratings (id, ride_id, from_user, to_user, stars, tag) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (ride_id, from_user, to_user) DO NOTHING`,
    ['rt_' + crypto.randomBytes(5).toString('hex'), rideId, uid, to, stars, tag]);
  if (!ins.rowCount) fail(400, 'You already rated this person for this trip.');
  broadcast(ride.community_id);
  res.json({ ok: true });
}));

app.get('/api/reputation/me', auth, wrap(async (req, res) => {
  res.json(await reputationOf(req.user.id));
}));

// ---------- Trips (anyone can book, no community needed) ----------
app.get('/api/fare', wrap(async (req, res) => {
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!PLACES.includes(from) || !PLACES.includes(to) || from === to) fail(400, 'Invalid route.');
  res.json(routeInfo(from, to, await campusOf(PUBLIC)));
}));

app.post('/api/trips', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const from = String(b.from || ''), to = String(b.to || ''), time = String(b.time || '');
  if (!PLACES.includes(from) || !PLACES.includes(to) || from === to) fail(400, 'Choose a start point and a different destination.');
  if (![...TIMES, ...AIR_TIMES].includes(time)) fail(400, 'Choose a departure time.');
  const u = req.user;
  let credit = false;
  if (b.useCredit && u.free_credits > 0) {
    await q('UPDATE users SET free_credits = free_credits - 1 WHERE id = $1', [u.id]);
    credit = true;
  }
  const refund = async () => { if (credit) await q('UPDATE users SET free_credits = free_credits + 1 WHERE id = $1', [u.id]); };

  const found = (await q(`${RIDE_SQL} WHERE r.area = $1 AND r.dest = $2
    AND (r.community_id = $3 OR r.community_id IN (SELECT community_id FROM memberships WHERE user_id = $4))`,
    [from, to, PUBLIC, u.id])).rows;
  let ride = null;
  for (const r of found) {
    if (Math.abs(mins(r.time) - mins(time)) > 30) continue;
    r.mine = (await q('SELECT 1 FROM bookings WHERE ride_id = $1 AND user_id = $2', [r.id, u.id])).rows.length > 0;
    if (!seatProblem(u, r)) { ride = r; break; }
  }
  const matched = !!ride;
  if (!ride) {
    if (u.pref_women) {
      await refund();
      fail(400, 'No women drivers are posted on this route yet. Try another time, or turn off the women-drivers preference on Profile.');
    }
    const id = 's_' + crypto.randomBytes(5).toString('hex');
    await q(`INSERT INTO rides (id, community_id, driver_id, area, dest, time, seats, pink)
      VALUES ($1, $2, NULL, $3, $4, $5, 4, false)`, [id, PUBLIC, from, to, time]);
    ride = await rideRow(id, u.id);
  }
  const kind = from === 'Airport' || to === 'Airport' ? 'airport' : 'trip';
  const r = await confirmBooking(u, ride, req.day, kind, credit, matched);
  res.json({ code: r.code, fare: r.fare, milestone: r.milestone, matched });
}));

app.get('/api/trips', auth, wrap(async (req, res) => {
  const rows = (await q('SELECT * FROM trips WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id])).rows;
  res.json({ trips: rows.map(t => ({
    id: t.id, kind: t.kind, from: t.from_place, to: t.to_place, time: t.time, status: t.status,
    km: Number(t.km), fare: t.fare, autoFare: t.auto_fare, co2: Number(t.co2), credit: t.credit,
    rideId: t.ride_id, communityId: t.community_id,
  })) });
}));

app.post('/api/trips/:id/cancel', auth, wrap(async (req, res) => {
  const t = (await q('SELECT * FROM trips WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])).rows[0];
  if (!t) fail(404, 'Trip not found.');
  if (t.ride_id) await q('DELETE FROM bookings WHERE ride_id = $1 AND user_id = $2', [t.ride_id, req.user.id]);
  if (t.credit) await q('UPDATE users SET free_credits = free_credits + 1 WHERE id = $1', [req.user.id]);
  await q('DELETE FROM trips WHERE id = $1', [t.id]);
  if (t.community_id) broadcast(t.community_id);
  res.json({ ok: true });
}));

// ---------- Streak, gifts, points and referrals ----------
app.post('/api/activity', auth, wrap(async (req, res) => {
  const milestone = await logActivity(req.user, req.day);
  res.json({ milestone, user: userOut(await userById(req.user.id), req.day) });
}));

app.get('/api/streak', auth, wrap(async (req, res) => {
  const rows = (await q('SELECT day, n FROM daily_logs WHERE user_id = $1 ORDER BY day DESC LIMIT 30', [req.user.id])).rows;
  res.json({ days: rows.reverse() });
}));

app.post('/api/gift/claim', auth, wrap(async (req, res) => {
  const u = await userById(req.user.id);
  if (Math.floor(u.logs / GIFT_EVERY) > u.gift_claims) {
    await q('UPDATE users SET gift_claims = gift_claims + 1, free_credits = free_credits + 1 WHERE id = $1', [u.id]);
  }
  res.json({ user: userOut(await userById(u.id), req.day) });
}));

app.post('/api/points/redeem', auth, wrap(async (req, res) => {
  const u = await userById(req.user.id);
  if (u.points < POINTS_PER_CREDIT) fail(400, `You need ${POINTS_PER_CREDIT} points for a free ride.`);
  await q('UPDATE users SET points = points - $2, free_credits = free_credits + 1 WHERE id = $1', [u.id, POINTS_PER_CREDIT]);
  res.json({ user: userOut(await userById(u.id), req.day) });
}));

app.get('/api/referrals', auth, wrap(async (req, res) => {
  const rows = (await q('SELECT name, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC', [req.user.id])).rows;
  res.json({ referrals: rows.map(r => ({ name: r.name, at: r.created_at })) });
}));

// ---------- Database setup and demo accounts ----------
async function seedDemo() {
  if ((await q('SELECT COUNT(*)::int AS n FROM users')).rows[0].n > 0) return;
  const demos = [
    { id: 'u_demo_student', name: 'Demo Student', email: 'demo@fellaride.app', gender: 'Prefer not to say', role: 'passenger', area: 'North Gate' },
    { id: 'u_demo_woman', name: 'Demo Woman', email: 'demo.woman@fellaride.app', gender: 'Female', role: 'driver', area: 'Tech Park' },
    { id: 'u_demo_driver', name: 'Demo Driver', email: 'demo.driver@fellaride.app', gender: 'Male', role: 'driver', area: 'North Gate' },
  ];
  for (const d of demos) {
    await q(`INSERT INTO users (id, name, email, password, gender, ref_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [d.id, d.name, d.email, hashPassword(DEMO_PASSWORD), d.gender, makeRefCode()]);
    await q(`INSERT INTO memberships (user_id, community_id, role, area, time) VALUES ($1, 'riverside', $2, $3, '08:00')`,
      [d.id, d.role, d.area]);
  }
  await q(`INSERT INTO rides (id, community_id, driver_id, area, dest, time, seats, pink) VALUES
    ('r_demo_pink', 'riverside', 'u_demo_woman', 'Tech Park', 'Campus', '08:00', 3, true),
    ('r_demo_std', 'riverside', 'u_demo_driver', 'North Gate', 'Campus', '08:00', 3, false)`);
}

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT,
    gender TEXT NOT NULL DEFAULT 'Prefer not to say', pref_women BOOLEAN NOT NULL DEFAULT false,
    ref_code TEXT UNIQUE NOT NULL, referred_by TEXT, points INT NOT NULL DEFAULT 0,
    free_credits INT NOT NULL DEFAULT 0, logs INT NOT NULL DEFAULT 0, gift_claims INT NOT NULL DEFAULT 0,
    streak_count INT NOT NULL DEFAULT 0, streak_days INT NOT NULL DEFAULT 0, streak_last TEXT,
    streak_best INT NOT NULL DEFAULT 0, last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS otps (
    email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0, sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT, gender TEXT, referral TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS locations (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS communities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
    lat DOUBLE PRECISION, lng DOUBLE PRECISION)`);
  await q(`CREATE TABLE IF NOT EXISTS memberships (
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    community_id TEXT REFERENCES communities(id) ON DELETE CASCADE,
    role TEXT NOT NULL, area TEXT, time TEXT, PRIMARY KEY (user_id, community_id))`);
  await q(`CREATE TABLE IF NOT EXISTS rides (
    id TEXT PRIMARY KEY, community_id TEXT REFERENCES communities(id) ON DELETE CASCADE,
    driver_id TEXT REFERENCES users(id) ON DELETE CASCADE, area TEXT NOT NULL, dest TEXT NOT NULL,
    time TEXT NOT NULL, seats INT NOT NULL, pink BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT false`);
  await q(`CREATE TABLE IF NOT EXISTS bookings (
    ride_id TEXT REFERENCES rides(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    pickup_code TEXT NOT NULL, checked_in BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (ride_id, user_id))`);
  await q(`CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, community_id TEXT,
    kind TEXT NOT NULL, from_place TEXT NOT NULL, to_place TEXT NOT NULL, time TEXT NOT NULL,
    status TEXT NOT NULL, ride_id TEXT, km NUMERIC NOT NULL, fare INT NOT NULL, auto_fare INT NOT NULL,
    co2 NUMERIC NOT NULL, credit BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS daily_logs (
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, n INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day))`);
  await q(`CREATE TABLE IF NOT EXISTS interventions (
    id TEXT PRIMARY KEY, community_id TEXT REFERENCES communities(id) ON DELETE CASCADE,
    member_id TEXT REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY, ride_id TEXT REFERENCES rides(id) ON DELETE CASCADE,
    from_user TEXT REFERENCES users(id) ON DELETE CASCADE, to_user TEXT REFERENCES users(id) ON DELETE CASCADE,
    stars INT NOT NULL, tag TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ride_id, from_user, to_user))`);
  await q(`INSERT INTO communities (id, name, type, code, lat, lng) VALUES
    ('public', 'Public rides', 'Public', 'PUBLIC', 12.9716, 77.5946),
    ('riverside', 'Riverside University', 'College', 'RIVER26', 12.9716, 77.5946),
    ('lakeview', 'Lakeview Engineering College', 'College', 'LAKE26', 12.9352, 77.6245),
    ('northwind', 'Northwind Tech Park', 'Workplace', 'NORTH26', 12.9698, 77.7500)
    ON CONFLICT (id) DO NOTHING`);
  await seedDemo();
}

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

init()
  .then(() => app.listen(PORT, () => console.log('Fella Ride API running on port ' + PORT + ' (database ready)')))
  .catch(e => { console.error('Database setup failed:', e.message); process.exit(1); });