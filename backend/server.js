// Fella Ride backend: email code login, guest access, live updates, shared location and ratings
const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, process.env.FELLA_ENV_FILE || 'sec.env'),
});

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
const LOCAL_SERVER = require.main === module || process.env.FELLA_LOCAL_SERVER === 'true';
const DEV_MODE = process.env.DEV_MODE === 'true';
const OTP_SECRET = process.env.OTP_SECRET || 'change-this-secret';
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'fellaride-982b2';

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT must contain valid service-account JSON.');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      ...(projectId ? { projectId } : {}),
    });
  } else if (process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: projectId || 'demo-fella-ride' });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      ...(projectId ? { projectId } : {}),
    });
  }
}

const db = admin.firestore();
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
const ROLES = ['driver', 'passenger', 'connector'];
const AREAS = ['North Gate', 'Tech Park', 'Old Town', 'Lake Side', 'Station Road'];
const DESTS = ['Campus', 'Airport', 'Railway Station', 'Bus Stand'];
const PLACE_OFF = {
  Campus: [0, 0], 'North Gate': [0.012, 0], 'Tech Park': [0.006, 0.012], 'Old Town': [-0.008, -0.010],
  'Lake Side': [-0.010, 0.008], 'Station Road': [0.002, -0.014], 'Railway Station': [-0.020, -0.030],
  'Bus Stand': [0.004, -0.020], Airport: [0.090, 0.080],
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
const COLLECTIONS = {
  users: 'users', sessions: 'sessions', otps: 'otps', locations: 'locations',
  communities: 'communities', memberships: 'memberships', rides: 'rides', bookings: 'bookings',
  trips: 'trips', dailyLogs: 'daily_logs', interventions: 'interventions', ratings: 'ratings',
  emailIndex: 'email_index', firebaseUidIndex: 'firebase_uid_index',
};
const now = () => new Date().toISOString();
const ref = (collection, id) => db.collection(collection).doc(String(id));
const keyOf = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
const snapshotData = snap => snap.exists ? { ...snap.data(), id: snap.id } : null;
async function getDoc(collection, id) {
  return snapshotData(await ref(collection, id).get());
}
async function getAll(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map(snapshotData);
}
async function findFirst(collection, predicate) {
  return (await getAll(collection)).find(predicate) || null;
}
async function findAll(collection, predicate) {
  return (await getAll(collection)).filter(predicate);
}
async function putDoc(collection, id, data) {
  await ref(collection, id).set(data);
}
async function patchDoc(collection, id, data) {
  const doc = ref(collection, id);
  const snapshot = await doc.get();
  if (!snapshot.exists) return false;
  await doc.update(data);
  return true;
}
async function deleteDoc(collection, id) {
  await ref(collection, id).delete();
}
const membershipKey = (uid, cid) => keyOf(uid, cid);
const bookingKey = (rideId, uid) => keyOf(rideId, uid);
const ratingKey = (rideId, from, to) => keyOf(rideId, from, to);
const emailKey = email => keyOf(email);
const toMillis = value => value && typeof value.toDate === 'function'
  ? value.toDate().getTime()
  : new Date(value).getTime();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
let ready = Promise.resolve();
const wrap = fn => (req, res, next) => Promise.resolve()
  .then(() => ready)
  .then(() => fn(req, res, next))
  .catch(e => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Server problem. Please try again.' });
});
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const hashCode = (code, email) => crypto.createHash('sha256').update(OTP_SECRET + ':' + email + ':' + code).digest('hex');
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(hash));
}
const makeRefCode = () => 'FR' + crypto.randomBytes(3).toString('hex').toUpperCase();
const dayOf = req => {
  const day = String(req.headers['x-day'] || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
};
function shiftDay(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const mins = time => { const [h, m] = String(time).split(':').map(Number); return h * 60 + m; };
const pickupCode = (rideId, userId) => {
  let h = 0;
  for (const ch of rideId + userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(1000 + (h % 9000));
};
const round5 = n => Math.max(5, Math.round(n / 5) * 5);
function routeInfo(from, to, campus) {
  const o1 = PLACE_OFF[from] || [0, 0], o2 = PLACE_OFF[to] || [0, 0];
  const a = [campus[0] + o1[0], campus[1] + o1[1]], b = [campus[0] + o2[0], campus[1] + o2[1]];
  const R = 6371, toRadians = d => d * Math.PI / 180;
  const h = Math.sin(toRadians(b[0] - a[0]) / 2) ** 2
    + Math.cos(toRadians(a[0])) * Math.cos(toRadians(b[0])) * Math.sin(toRadians(b[1] - a[1]) / 2) ** 2;
  const km = Math.max(0.5, 2 * R * Math.asin(Math.sqrt(h)) * 1.3);
  const fare = rate => round5(rate[0] + rate[1] * km);
  return { km: +km.toFixed(1), auto: fare(RATES.auto), cab: fare(RATES.cab), shared: fare(RATES.shared), co2: +(km * CO2_PER_KM).toFixed(2) };
}
async function userById(id) {
  return getDoc(COLLECTIONS.users, id);
}
async function userByEmail(email) {
  const index = await getDoc(COLLECTIONS.emailIndex, emailKey(email));
  return index ? userById(index.user_id) : null;
}
async function campusOf(cid) {
  const community = await getDoc(COLLECTIONS.communities, cid);
  return community ? [community.lat, community.lng] : [12.9716, 77.5946];
}
async function isMember(uid, cid) {
  return !!(await getDoc(COLLECTIONS.memberships, membershipKey(uid, cid)));
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
  await putDoc(COLLECTIONS.sessions, token, { token, user_id: uid, created_at: now() });
  return token;
}
async function createUser({ name, email, gender, referral, password = null, id = null }) {
  const referrer = referral
    ? await findFirst(COLLECTIONS.users, user => user.ref_code === referral)
    : null;
  const userId = id || 'u_' + crypto.randomBytes(6).toString('hex');
  const userRef = ref(COLLECTIONS.users, userId);
  const indexRef = ref(COLLECTIONS.emailIndex, emailKey(email));
  const referrerRef = referrer ? ref(COLLECTIONS.users, referrer.id) : null;
  const created = {
    id: userId, name, email, password: password ? hashPassword(password) : null, gender,
    pref_women: false, ref_code: makeRefCode(), referred_by: referrer ? referrer.id : null,
    points: referrer ? POINTS_SIGNUP : 0, free_credits: 0, logs: 0, gift_claims: 0,
    streak_count: 0, streak_days: 0, streak_last: null, streak_best: 0,
    last_seen: now(), created_at: now(),
  };
  await db.runTransaction(async transaction => {
    const index = await transaction.get(indexRef);
    if (index.exists) fail(409, 'An account with this email already exists. Log in instead.');
    transaction.set(userRef, created);
    transaction.set(indexRef, { user_id: userId });
    if (referrerRef) transaction.update(referrerRef, { points: admin.firestore.FieldValue.increment(POINTS_REFERRER) });
  });
  return created;
}
const auth = wrap(async (req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = token ? await getDoc(COLLECTIONS.sessions, token) : null;
  let user = session ? await userById(session.user_id) : null;
  if (!user && token) {
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (error) {
      return res.status(401).json({ error: 'Please log in again.' });
    }
    const uidIndex = await getDoc(COLLECTIONS.firebaseUidIndex, decoded.uid);
    user = uidIndex ? await userById(uidIndex.user_id) : await userById(decoded.uid);
  }
  if (!user) return res.status(401).json({ error: 'Please log in again.' });
  req.user = user;
  req.day = dayOf(req);
  req.token = token;
  await patchDoc(COLLECTIONS.users, user.id, { last_seen: now() });
  next();
});

const clients = new Map();
function broadcast(cid, type = 'changed') {
  const set = clients.get(cid);
  if (!set) return;
  for (const response of set) response.write(`data: {"type":"${type}"}\n\n`);
}

async function logActivity(user, day) {
  const userRef = ref(COLLECTIONS.users, user.id);
  const dailyRef = ref(COLLECTIONS.dailyLogs, keyOf(user.id, day));
  return db.runTransaction(async transaction => {
    const [userSnapshot, dailySnapshot] = await Promise.all([transaction.get(userRef), transaction.get(dailyRef)]);
    if (!userSnapshot.exists) fail(404, 'Account not found.');
    const current = userSnapshot.data();
    let count = current.streak_count, days = current.streak_days;
    if (current.streak_last !== day) {
      if (current.streak_last === shiftDay(day, -1)) days += 1;
      else { days = 1; count = 0; }
    }
    count += 1;
    const best = Math.max(current.streak_best, count);
    const logs = current.logs + 1;
    transaction.update(userRef, {
      streak_count: count, streak_days: days, streak_last: day, streak_best: best, logs,
    });
    transaction.set(dailyRef, {
      user_id: user.id, day, n: dailySnapshot.exists ? dailySnapshot.data().n + 1 : 1,
    });
    return logs % GIFT_EVERY === 0;
  });
}
function seatProblem(user, ride) {
  if (ride.driver_id === user.id) return 'This is your own ride.';
  if (ride.mine) return 'You already have a seat on this ride.';
  if (ride.booked >= ride.seats) return 'No seats left on this ride.';
  if (ride.pink && user.gender !== 'Female') return 'Pink rides are for women passengers only.';
  if (user.pref_women && ride.driver_gender !== 'Female') return 'You chose women drivers only.';
  return null;
}
async function rideRow(id, uid) {
  const ride = await getDoc(COLLECTIONS.rides, id);
  if (!ride) return null;
  const [driver, bookings, mine] = await Promise.all([
    ride.driver_id ? userById(ride.driver_id) : null,
    findAll(COLLECTIONS.bookings, booking => booking.ride_id === id),
    getDoc(COLLECTIONS.bookings, bookingKey(id, uid)),
  ]);
  return {
    ...ride, driver_gender: driver ? driver.gender : null, driver_name: driver ? driver.name : null,
    booked: bookings.length, checked: bookings.filter(booking => booking.checked_in).length, mine: !!mine,
  };
}
async function confirmBooking(user, ride, day, kind, credit, matched) {
  const code = pickupCode(ride.id, user.id);
  const bookingRef = ref(COLLECTIONS.bookings, bookingKey(ride.id, user.id));
  const rideRef = ref(COLLECTIONS.rides, ride.id);
  const userRef = ref(COLLECTIONS.users, user.id);
  const tripId = 't_' + crypto.randomBytes(6).toString('hex');
  const info = routeInfo(ride.area, ride.dest, await campusOf(ride.community_id));
  const fare = credit ? 0 : info.shared;
  const status = (matched === undefined ? 'Seat booked' : matched ? 'Matched with a shared driver' : 'Shared Fella cab assigned')
    + '. Pickup code ' + code + ', departs ' + ride.time;
  await db.runTransaction(async transaction => {
    const [rideSnapshot, bookingSnapshot] = await Promise.all([transaction.get(rideRef), transaction.get(bookingRef)]);
    if (!rideSnapshot.exists) fail(404, 'Ride not found.');
    const currentRide = rideSnapshot.data();
    const currentBookings = await transaction.get(
      db.collection(COLLECTIONS.bookings).where('ride_id', '==', ride.id),
    );
    const currentUser = await transaction.get(userRef);
    if (!currentUser.exists) fail(404, 'Account not found.');
    const currentUserData = currentUser.data();
    const rideForCheck = {
      ...currentRide,
      booked: currentBookings.size,
      mine: bookingSnapshot.exists,
      driver_gender: ride.driver_gender,
    };
    const problem = seatProblem(currentUserData, rideForCheck);
    if (problem) fail(400, problem);
    transaction.create(bookingRef, {
      ride_id: ride.id, user_id: user.id, pickup_code: code, checked_in: false, created_at: now(),
    });
    transaction.set(ref(COLLECTIONS.trips, tripId), {
      id: tripId, user_id: user.id, community_id: ride.community_id, kind,
      from_place: ride.area, to_place: ride.dest, time: ride.time, status, ride_id: ride.id,
      km: info.km, fare, auto_fare: info.auto, co2: info.co2, credit, created_at: now(),
    });
    transaction.update(userRef, { points: admin.firestore.FieldValue.increment(POINTS_PER_TRIP) });
  });
  const milestone = await logActivity(await userById(user.id), day);
  broadcast(ride.community_id);
  return { code, fare, milestone };
}
async function membersOf(cid) {
  const memberships = await findAll(COLLECTIONS.memberships, membership => membership.community_id === cid);
  const members = await Promise.all(memberships.map(async membership => {
    const user = await userById(membership.user_id);
    return user ? {
      id: user.id, name: user.name, gender: user.gender, pref_women: user.pref_women,
      last_seen: user.last_seen, role: membership.role, area: membership.area, time: membership.time,
    } : null;
  }));
  return members.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
async function activeIdsOf(cid) {
  const rides = await findAll(COLLECTIONS.rides, ride => ride.community_id === cid);
  const rideIds = new Set(rides.map(ride => ride.id));
  const bookings = await findAll(COLLECTIONS.bookings, booking => rideIds.has(booking.ride_id));
  return new Set([
    ...bookings.map(booking => booking.user_id),
    ...rides.map(ride => ride.driver_id).filter(Boolean),
  ]);
}
function compatible(a, b) {
  if (!a || !b || a.id === b.id || a.area !== b.area) return false;
  if (Math.abs(mins(a.time) - mins(b.time)) > 30) return false;
  if (a.pref_women && b.role === 'driver' && b.gender !== 'Female') return false;
  if (b.pref_women && a.role === 'driver' && a.gender !== 'Female') return false;
  if (a.role === 'connector' || b.role === 'connector') return true;
  return a.role !== b.role;
}
function scoreOf(member, all) {
  let score = member.role === 'driver' ? 30 : member.role === 'connector' ? 25 : 15;
  score += Math.min(all.filter(other => compatible(member, other)).length, 5) * 6;
  if (Date.now() - toMillis(member.last_seen) < 3 * 864e5) score += 10;
  return Math.min(100, score);
}
async function repMap(ids) {
  const wanted = new Set(ids);
  const ratings = await findAll(COLLECTIONS.ratings, rating => wanted.has(rating.to_user));
  const grouped = new Map();
  for (const rating of ratings) {
    if (!grouped.has(rating.to_user)) grouped.set(rating.to_user, []);
    grouped.get(rating.to_user).push(rating);
  }
  const result = {};
  for (const [id, entries] of grouped) {
    const tagCounts = new Map();
    for (const entry of entries) tagCounts.set(entry.tag, (tagCounts.get(entry.tag) || 0) + 1);
    const top = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    result[id] = {
      avg: Math.round(entries.reduce((sum, entry) => sum + entry.stars, 0) / entries.length * 10) / 10,
      count: entries.length, top: top ? top[0] : null,
    };
  }
  return result;
}
async function reputationOf(uid) {
  const ratings = await findAll(COLLECTIONS.ratings, rating => rating.to_user === uid);
  const tags = new Map();
  for (const rating of ratings) tags.set(rating.tag, (tags.get(rating.tag) || 0) + 1);
  const avg = ratings.length
    ? Math.round(ratings.reduce((sum, rating) => sum + rating.stars, 0) / ratings.length * 10) / 10
    : null;
  return {
    avg, count: ratings.length,
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5).map(([tag, n]) => ({ tag, n })),
  };
}

if (LOCAL_SERVER) {
  app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, '..', 'indexx.html')));
  app.get('/extras.js', (req, res) => res.sendFile(path.resolve(__dirname, '..', 'extra.js')));
  for (const file of ['manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png']) {
    app.get('/' + file, (req, res) => res.sendFile(path.resolve(__dirname, '..', file)));
  }
} else {
  app.get('/', (req, res) => res.send('Fella Ride API is running.'));
}
app.get('/api/health', wrap(async (req, res) => {
  res.json({ ok: true, service: 'Fella Ride API', database: 'Firestore' });
}));

app.get('/api/firebase-config', (req, res) => {
  const config = {
    apiKey: process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || (projectId ? `${projectId}.firebaseapp.com` : ''),
    projectId,
    appId: process.env.FIREBASE_APP_ID,
  };
  if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
    return res.status(503).json({ error: 'Firebase Authentication is not configured on the server yet.' });
  }
  res.json(config);
});

app.post('/api/referrals/validate', wrap(async (req, res) => {
  const referral = String((req.body || {}).referral || '').trim().toUpperCase();
  if (referral && !(await findFirst(COLLECTIONS.users, user => user.ref_code === referral))) {
    fail(400, 'That referral code was not found. Check it, or leave the box empty.');
  }
  res.json({ ok: true });
}));

const firebaseSignIn = wrap(async (req, res) => {
  const token = String(
    req.headers.authorization || (req.body || {}).idToken || '',
  ).replace(/^Bearer\s+/i, '');
  if (!token) fail(401, 'Please log in again.');
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (error) {
    fail(401, 'Please log in again.');
  }
  const userRecord = await admin.auth().getUser(decoded.uid);
  const email = String(decoded.email || userRecord.email || '').trim().toLowerCase();
  if (!validEmail(email)) fail(400, 'Your Firebase account must have a valid email address.');

  const body = req.body || {};
  const signingUp = body.mode === 'signup';
  const name = String(body.name || userRecord.displayName || decoded.name || email.split('@')[0]).trim().slice(0, 40);
  const gender = signingUp ? String(body.gender || '') : 'Prefer not to say';
  const referral = signingUp ? String(body.referral || '').trim().toUpperCase() || null : null;
  if (signingUp && !name) fail(400, 'Enter your name.');
  if (signingUp && !GENDERS.includes(gender)) fail(400, 'Choose your gender.');
  if (referral && !(await findFirst(COLLECTIONS.users, user => user.ref_code === referral))) {
    fail(400, 'That referral code was not found. Check it, or leave the box empty.');
  }

  let user = await userById(decoded.uid);
  if (!user) user = await userByEmail(email);
  if (signingUp && user && user.firebase_uid !== decoded.uid) {
    fail(409, 'An account with this email already exists. Log in instead.');
  }
  if (user && user.email !== email) fail(409, 'This Firebase account is already linked to a different email.');
  if (user && user.firebase_uid && user.firebase_uid !== decoded.uid) {
    fail(409, 'This Fella Ride account is already linked to another Firebase account.');
  }
  if (user && user.id !== decoded.uid && !decoded.email_verified) {
    fail(403, 'Verify your email address before linking it to an existing Fella Ride account.');
  }
  if (!user) {
    user = await createUser({
      id: decoded.uid, name, email, gender, referral,
    });
  }

  const uidRef = ref(COLLECTIONS.firebaseUidIndex, decoded.uid);
  const userRef = ref(COLLECTIONS.users, user.id);
  await db.runTransaction(async transaction => {
    const linked = await transaction.get(uidRef);
    if (linked.exists && linked.data().user_id !== user.id) {
      fail(409, 'This Firebase account is already linked to another Fella Ride account.');
    }
    transaction.set(uidRef, { user_id: user.id });
    transaction.update(userRef, { firebase_uid: decoded.uid });
  });
  res.json({
    message: 'Successfully signed in',
    uid: decoded.uid,
    email: user.email,
    token,
    user: userOut(await userById(user.id), dayOf(req)),
  });
});
app.post('/api/signin', firebaseSignIn);
app.post('/api/auth/session', firebaseSignIn);

app.post('/api/auth/request-otp', wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) fail(400, 'Enter a valid email address.');
  const exists = !!(await userByEmail(email));
  let name = null, gender = null, referral = null;
  if (b.mode === 'signup') {
    if (exists) fail(409, 'An account with this email already exists. Log in instead.');
    name = String(b.name || '').trim().slice(0, 40);
    if (!name) fail(400, 'Enter your name.');
    gender = String(b.gender || '');
    if (!GENDERS.includes(gender)) fail(400, 'Choose your gender. This decides which rides you can see.');
    referral = String(b.referral || '').trim().toUpperCase() || null;
    if (referral && !(await findFirst(COLLECTIONS.users, user => user.ref_code === referral))) {
      fail(400, 'That referral code was not found. Check it, or leave the box empty.');
    }
  } else if (!exists) {
    fail(404, 'No account with this email yet. Choose Create account first.');
  }
  const otpRef = ref(COLLECTIONS.otps, emailKey(email));
  const last = snapshotData(await otpRef.get());
  if (last && Date.now() - toMillis(last.sent_at) < 60000) fail(429, 'Please wait a minute before asking for another code.');

  const code = String(crypto.randomInt(100000, 1000000));
  await putDoc(COLLECTIONS.otps, emailKey(email), {
    email, code_hash: hashCode(code, email), expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
    attempts: 0, sent_at: now(), name, gender, referral,
  });
  if (mailer) {
    try {
      await mailer.sendMail({
        from: process.env.MAIL_FROM || 'Fella Ride <no-reply@example.com>',
        to: email,
        subject: 'Your Fella Ride login code',
        text: `Your Fella Ride code is ${code}. It expires in 10 minutes. If you did not ask for this, ignore this email.`,
      });
    } catch (error) {
      console.error('Email failed:', error.message);
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
  const otpRef = ref(COLLECTIONS.otps, emailKey(email));
  const result = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(otpRef);
    if (!snapshot.exists) return { error: [400, 'Ask for a new code first.'] };
    const otp = snapshot.data();
    if (toMillis(otp.expires_at) < Date.now()) {
      transaction.delete(otpRef);
      return { error: [400, 'This code has expired. Ask for a new one.'] };
    }
    if (otp.attempts >= 5) {
      transaction.delete(otpRef);
      return { error: [429, 'Too many wrong tries. Ask for a new code.'] };
    }
    if (otp.code_hash !== hashCode(code, email)) {
      transaction.update(otpRef, { attempts: otp.attempts + 1 });
      return { error: [400, 'Wrong code. Try again.'] };
    }
    transaction.delete(otpRef);
    return { otp };
  });
  if (result.error) fail(result.error[0], result.error[1]);
  let user = await userByEmail(email);
  if (!user) {
    if (!result.otp.name || !result.otp.gender) fail(404, 'No account with this email yet. Choose Create account first.');
    user = await createUser({
      name: result.otp.name, email, gender: result.otp.gender, referral: result.otp.referral,
    });
  }
  res.json({ token: await newSession(user.id), user: userOut(user, dayOf(req)) });
}));

app.post('/api/guest', wrap(async (req, res) => {
  const id = 'u_g_' + crypto.randomBytes(6).toString('hex');
  const user = await createUser({
    id, name: 'Guest', email: id + '@guest.local', gender: 'Prefer not to say',
  });
  res.json({ token: await newSession(id), user: userOut(user, dayOf(req)) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const user = await userByEmail(email);
  if (!user || !checkPassword(String((req.body || {}).password || ''), user.password)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  res.json({ token: await newSession(user.id), user: userOut(user, dayOf(req)) });
}));

app.post('/api/logout', auth, wrap(async (req, res) => {
  await deleteDoc(COLLECTIONS.sessions, req.token);
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  res.json({ user: userOut(await userById(req.user.id), req.day) });
}));

app.put('/api/profile', auth, wrap(async (req, res) => {
  const gender = String((req.body || {}).gender || '');
  if (!GENDERS.includes(gender)) fail(400, 'Choose a gender.');
  await patchDoc(COLLECTIONS.users, req.user.id, {
    gender, pref_women: gender === 'Female' && !!req.body.prefWomen,
  });
  res.json({ user: userOut(await userById(req.user.id), req.day) });
}));

app.get('/api/events', wrap(async (req, res) => {
  const token = String(req.query.token || '');
  const cid = String(req.query.community || '');
  let valid = !!(await getDoc(COLLECTIONS.sessions, token));
  if (!valid && token) {
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (error) {
      decoded = null;
    }
    if (decoded) {
      const uidIndex = await getDoc(COLLECTIONS.firebaseUidIndex, decoded.uid);
      valid = !!(uidIndex && await userById(uidIndex.user_id));
    }
  }
  if (!valid) return res.status(401).end();
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

app.post('/api/location', auth, wrap(async (req, res) => {
  const lat = Number((req.body || {}).lat), lng = Number((req.body || {}).lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'Invalid location.');
  await putDoc(COLLECTIONS.locations, req.user.id, { user_id: req.user.id, lat, lng, updated_at: now() });
  const memberships = await findAll(COLLECTIONS.memberships, membership => membership.user_id === req.user.id);
  memberships.forEach(membership => broadcast(membership.community_id, 'location'));
  res.json({ ok: true });
}));

app.post('/api/location/stop', auth, wrap(async (req, res) => {
  await deleteDoc(COLLECTIONS.locations, req.user.id);
  const memberships = await findAll(COLLECTIONS.memberships, membership => membership.user_id === req.user.id);
  memberships.forEach(membership => broadcast(membership.community_id, 'location'));
  res.json({ ok: true });
}));

app.get('/api/communities', auth, wrap(async (req, res) => {
  const [communities, memberships, rides] = await Promise.all([
    getAll(COLLECTIONS.communities), getAll(COLLECTIONS.memberships), getAll(COLLECTIONS.rides),
  ]);
  const rows = communities.filter(community => community.type !== 'Public').sort((a, b) => a.name.localeCompare(b.name));
  res.json({ communities: rows.map(community => {
    const joined = memberships.some(membership => membership.community_id === community.id && membership.user_id === req.user.id);
    return {
      id: community.id, name: community.name, type: community.type,
      members: memberships.filter(membership => membership.community_id === community.id).length,
      rides: rides.filter(ride => ride.community_id === community.id).length,
      joined, code: joined ? community.code : null,
    };
  }) });
}));

app.post('/api/communities', auth, wrap(async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 50);
  if (!name) fail(400, 'Give the community a name.');
  const type = req.body.type === 'Workplace' ? 'Workplace' : 'College';
  const base = name.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'FR';
  let code = base + '26', n = 1;
  while (await findFirst(COLLECTIONS.communities, community => community.code === code)) code = base + (10 + n++);
  const id = 'c_' + crypto.randomBytes(4).toString('hex');
  await putDoc(COLLECTIONS.communities, id, {
    id, name, type, code, lat: 12.9716, lng: 77.5946, created_at: now(),
  });
  await putDoc(COLLECTIONS.memberships, membershipKey(req.user.id, id), {
    user_id: req.user.id, community_id: id, role: 'passenger', area: 'North Gate', time: '08:00',
  });
  res.json({ id, code });
}));

app.get('/api/communities/:id', auth, wrap(async (req, res) => {
  const cid = req.params.id, uid = req.user.id;
  const community = await getDoc(COLLECTIONS.communities, cid);
  if (!community) fail(404, 'Community not found.');
  const [membership, members, rides, allBookings, interventions, allUsers] = await Promise.all([
    getDoc(COLLECTIONS.memberships, membershipKey(uid, cid)), membersOf(cid),
    findAll(COLLECTIONS.rides, ride => ride.community_id === cid),
    getAll(COLLECTIONS.bookings),
    findAll(COLLECTIONS.interventions, intervention => intervention.community_id === cid),
    getAll(COLLECTIONS.users),
  ]);
  const rep = await repMap(members.map(member => member.id));
  const userMap = new Map(allUsers.map(user => [user.id, user]));
  const mine = new Set(allBookings.filter(booking => booking.user_id === uid).map(booking => booking.ride_id));
  const visibleRides = [];
  for (const ride of rides) {
    if (ride.pink && req.user.gender !== 'Female' && ride.driver_id !== uid) continue;
    const bookings = allBookings.filter(booking => booking.ride_id === ride.id);
    const driver = ride.driver_id ? userMap.get(ride.driver_id) : null;
    visibleRides.push({
      id: ride.id, area: ride.area, dest: ride.dest, time: ride.time, seats: ride.seats, pink: ride.pink,
      booked: bookings.length, checked: bookings.filter(booking => booking.checked_in).length,
      seatsLeft: ride.seats - bookings.length, driverId: ride.driver_id,
      driverName: ride.driver_id ? (driver ? driver.name : null) : 'Shared Fella cab',
      driverGender: driver ? driver.gender : null,
      driverRating: ride.driver_id && rep[ride.driver_id] ? rep[ride.driver_id].avg : null,
      completed: !!ride.completed, isOwn: ride.driver_id === uid, mine: mine.has(ride.id),
      code: mine.has(ride.id) ? pickupCode(ride.id, uid) : null, created_at: ride.created_at,
    });
  }
  visibleRides.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const active = await activeIdsOf(cid);
  const shownInterventions = interventions.map(intervention => ({
    id: intervention.id, member_id: intervention.member_id, type: intervention.type,
    message: intervention.message,
    status: intervention.status === 'sent' && active.has(intervention.member_id) ? 'converted' : intervention.status,
    name: userMap.get(intervention.member_id)?.name,
    created_at: intervention.created_at,
  })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const locations = membership
    ? (await getAll(COLLECTIONS.locations)).filter(location =>
      members.some(member => member.id === location.user_id) && Date.now() - toMillis(location.updated_at) < 15 * 60000)
      .map(location => ({
        id: location.user_id, name: userMap.get(location.user_id)?.name,
        lat: location.lat, lng: location.lng, updated_at: location.updated_at,
        isMe: location.user_id === uid,
      }))
    : [];
  res.json({
    community: { id: community.id, name: community.name, type: community.type, code: membership ? community.code : null, campus: [community.lat, community.lng] },
    me: membership || null,
    members: members.map(member => ({
      id: member.id, name: member.name, gender: member.gender, prefWomen: member.pref_women,
      role: member.role, area: member.area, time: member.time, isMe: member.id === uid,
      rating: rep[member.id] || { avg: null, count: 0, top: null },
    })),
    rides: visibleRides, interventions: shownInterventions, locations,
  });
}));

app.post('/api/communities/:id/join', auth, wrap(async (req, res) => {
  const community = await getDoc(COLLECTIONS.communities, req.params.id);
  if (!community || community.type === 'Public') fail(404, 'Community not found.');
  const body = req.body || {};
  if (String(body.code || '').trim().toUpperCase() !== community.code) fail(400, 'Community code not recognised.');
  const role = ROLES.includes(body.role) ? body.role : 'passenger';
  const area = AREAS.includes(body.area) ? body.area : 'North Gate';
  const time = TIMES.includes(body.time) ? body.time : '08:00';
  await putDoc(COLLECTIONS.memberships, membershipKey(req.user.id, community.id), {
    user_id: req.user.id, community_id: community.id, role, area, time,
  });
  broadcast(community.id);
  res.json({ ok: true });
}));

app.put('/api/communities/:id/role', auth, wrap(async (req, res) => {
  const role = String((req.body || {}).role || '');
  if (!ROLES.includes(role)) fail(400, 'Choose Driver, Passenger or Contractor.');
  const updated = await patchDoc(COLLECTIONS.memberships, membershipKey(req.user.id, req.params.id), { role });
  if (!updated) fail(403, 'Join this community first.');
  broadcast(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/communities/:id/rides', auth, wrap(async (req, res) => {
  const membership = await getDoc(COLLECTIONS.memberships, membershipKey(req.user.id, req.params.id));
  if (!membership) fail(403, 'Join this community first.');
  if (membership.role !== 'driver') fail(403, 'Set your role to Driver on the dashboard to post rides.');
  const body = req.body || {};
  const pink = !!body.pink;
  if (pink && req.user.gender !== 'Female') fail(403, 'Pink rides are for women drivers only.');
  const area = AREAS.includes(body.area) ? body.area : 'North Gate';
  const dest = DESTS.includes(body.dest) ? body.dest : 'Campus';
  const time = TIMES.includes(body.time) ? body.time : '08:00';
  const seats = Math.min(4, Math.max(1, Number(body.seats) || 1));
  const id = 'r_' + crypto.randomBytes(5).toString('hex');
  await putDoc(COLLECTIONS.rides, id, {
    id, community_id: req.params.id, driver_id: req.user.id, area, dest, time, seats, pink,
    completed: false, created_at: now(),
  });
  const milestone = await logActivity(req.user, req.day);
  broadcast(req.params.id);
  res.json({ id, milestone });
}));

app.post('/api/communities/:id/interventions/run', auth, wrap(async (req, res) => {
  const cid = req.params.id;
  if (!(await isMember(req.user.id, cid))) fail(403, 'Join this community first.');
  const [members, active, interventions] = await Promise.all([
    membersOf(cid), activeIdsOf(cid), findAll(COLLECTIONS.interventions, item => item.community_id === cid),
  ]);
  const hasAny = new Set(interventions.map(item => item.member_id));
  let created = 0;
  for (const member of members) {
    if (active.has(member.id) || hasAny.has(member.id) || scoreOf(member, members) < 40) continue;
    const matches = members.filter(other => compatible(member, other)).length;
    let type, message;
    if (member.role === 'driver') {
      type = 'post_ride';
      message = `${matches} commuters from ${member.area} leave around ${member.time}. Post a ride to fill your seats.`;
    } else if (member.role === 'connector') {
      type = 'connect';
      message = `Introduce ${member.area} members to each other and start a ride group.`;
    } else {
      type = 'find_ride';
      message = `${matches} possible rides from ${member.area} around ${member.time}. Request a seat.`;
    }
    const id = 'i_' + crypto.randomBytes(5).toString('hex');
    await putDoc(COLLECTIONS.interventions, id, {
      id, community_id: cid, member_id: member.id, type, message, status: 'draft', created_at: now(),
    });
    created++;
  }
  broadcast(cid);
  res.json({ created });
}));

app.put('/api/interventions/:id', auth, wrap(async (req, res) => {
  const intervention = await getDoc(COLLECTIONS.interventions, req.params.id);
  if (!intervention || !(await isMember(req.user.id, intervention.community_id))) fail(403, 'Not allowed.');
  await patchDoc(COLLECTIONS.interventions, req.params.id, { status: req.body.status === 'sent' ? 'sent' : 'draft' });
  broadcast(intervention.community_id);
  res.json({ ok: true });
}));

app.post('/api/rides/:id/book', auth, wrap(async (req, res) => {
  const ride = await rideRow(req.params.id, req.user.id);
  if (!ride) fail(404, 'Ride not found.');
  if (ride.community_id !== PUBLIC && !(await isMember(req.user.id, ride.community_id))) fail(403, 'Join this community first.');
  const problem = seatProblem(req.user, ride);
  if (problem) fail(400, problem);
  res.json(await confirmBooking(req.user, ride, req.day, 'seat', false));
}));

app.post('/api/rides/:id/complete', auth, wrap(async (req, res) => {
  const ride = await getDoc(COLLECTIONS.rides, req.params.id);
  if (!ride || ride.driver_id !== req.user.id) fail(403, 'Only the driver can mark a trip as completed.');
  await patchDoc(COLLECTIONS.rides, ride.id, { completed: true });
  broadcast(ride.community_id);
  res.json({ ok: true });
}));

app.post('/api/rides/:id/checkin', auth, wrap(async (req, res) => {
  const ride = await getDoc(COLLECTIONS.rides, req.params.id);
  if (!ride || ride.driver_id !== req.user.id) fail(403, 'Only the driver can check in passengers.');
  const code = String((req.body || {}).code || '').trim();
  const booking = await findFirst(COLLECTIONS.bookings, item => item.ride_id === req.params.id && item.pickup_code === code);
  if (!booking) fail(400, 'That code does not match a booked passenger.');
  if (booking.checked_in) fail(400, 'That passenger is already checked in.');
  await patchDoc(COLLECTIONS.bookings, bookingKey(req.params.id, booking.user_id), { checked_in: true });
  broadcast(ride.community_id);
  res.json({ ok: true });
}));

app.get('/api/ratings/pending', auth, wrap(async (req, res) => {
  const uid = req.user.id;
  const [allRides, allBookings, allUsers, ratings] = await Promise.all([
    getAll(COLLECTIONS.rides), getAll(COLLECTIONS.bookings), getAll(COLLECTIONS.users), getAll(COLLECTIONS.ratings),
  ]);
  const userMap = new Map(allUsers.map(user => [user.id, user]));
  const bookingsByRide = new Map();
  for (const booking of allBookings) {
    if (!bookingsByRide.has(booking.ride_id)) bookingsByRide.set(booking.ride_id, []);
    bookingsByRide.get(booking.ride_id).push(booking);
  }
  const rides = allRides.filter(ride => ride.completed
    && (ride.driver_id === uid || (bookingsByRide.get(ride.id) || []).some(booking => booking.user_id === uid)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30);
  const pending = [];
  for (const ride of rides) {
    let targets = [];
    if (ride.driver_id === uid) {
      targets = (bookingsByRide.get(ride.id) || []).map(booking => userMap.get(booking.user_id))
        .filter(Boolean).map(user => ({ id: user.id, name: user.name, role: 'passenger' }));
    } else if (ride.driver_id) {
      const driver = userMap.get(ride.driver_id);
      if (driver) targets = [{ id: driver.id, name: driver.name, role: 'driver' }];
    }
    for (const target of targets) {
      const done = ratings.some(rating => rating.ride_id === ride.id && rating.from_user === uid && rating.to_user === target.id);
      if (!done) pending.push({
        rideId: ride.id, area: ride.area, dest: ride.dest, time: ride.time,
        target: { id: target.id, name: target.name }, targetRole: target.role,
      });
    }
  }
  res.json({ pending });
}));

app.post('/api/ratings', auth, wrap(async (req, res) => {
  const body = req.body || {};
  const stars = Math.round(Number(body.stars));
  const tag = String(body.tag || '');
  const rideId = String(body.rideId || ''), to = String(body.toUserId || ''), uid = req.user.id;
  if (!(stars >= 1 && stars <= 5)) fail(400, 'Choose 1 to 5 stars.');
  if (!TAGS.includes(tag)) fail(400, 'Choose a word that describes them.');
  if (to === uid) fail(400, 'You cannot rate yourself.');
  const ride = await getDoc(COLLECTIONS.rides, rideId);
  if (!ride || !ride.completed) fail(400, 'You can rate after the driver marks the trip completed.');
  const [fromBooking, toBooking] = await Promise.all([
    getDoc(COLLECTIONS.bookings, bookingKey(rideId, uid)),
    getDoc(COLLECTIONS.bookings, bookingKey(rideId, to)),
  ]);
  const onRide = ride.driver_id === uid || !!fromBooking;
  const toOnRide = ride.driver_id === to || !!toBooking;
  if (!onRide || !toOnRide) fail(403, 'You can only rate people who shared this ride.');
  const id = ratingKey(rideId, uid, to);
  const ratingRef = ref(COLLECTIONS.ratings, id);
  const duplicate = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ratingRef);
    if (snapshot.exists) return true;
    transaction.create(ratingRef, {
      id: 'rt_' + crypto.randomBytes(5).toString('hex'), ride_id: rideId, from_user: uid,
      to_user: to, stars, tag, created_at: now(),
    });
    return false;
  });
  if (duplicate) fail(400, 'You already rated this person for this trip.');
  broadcast(ride.community_id);
  res.json({ ok: true });
}));

app.get('/api/reputation/me', auth, wrap(async (req, res) => {
  res.json(await reputationOf(req.user.id));
}));

app.get('/api/fare', wrap(async (req, res) => {
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!PLACES.includes(from) || !PLACES.includes(to) || from === to) fail(400, 'Invalid route.');
  res.json(routeInfo(from, to, await campusOf(PUBLIC)));
}));

app.post('/api/trips', auth, wrap(async (req, res) => {
  const body = req.body || {};
  const from = String(body.from || ''), to = String(body.to || ''), time = String(body.time || '');
  if (!PLACES.includes(from) || !PLACES.includes(to) || from === to) fail(400, 'Choose a start point and a different destination.');
  if (![...TIMES, ...AIR_TIMES].includes(time)) fail(400, 'Choose a departure time.');
  const user = await userById(req.user.id);
  let credit = false;
  if (body.useCredit && user.free_credits > 0) {
    const userRef = ref(COLLECTIONS.users, user.id);
    credit = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(userRef);
      const current = snapshot.data();
      if (!current.free_credits) return false;
      transaction.update(userRef, { free_credits: current.free_credits - 1 });
      return true;
    });
  }
  const refund = async () => {
    if (credit) await ref(COLLECTIONS.users, user.id).update({
      free_credits: admin.firestore.FieldValue.increment(1),
    });
  };
  const [allRides, memberships, allBookings, allUsers] = await Promise.all([
    getAll(COLLECTIONS.rides),
    findAll(COLLECTIONS.memberships, membership => membership.user_id === user.id),
    getAll(COLLECTIONS.bookings), getAll(COLLECTIONS.users),
  ]);
  const userMap = new Map(allUsers.map(item => [item.id, item]));
  const allowedCommunities = new Set([PUBLIC, ...memberships.map(membership => membership.community_id)]);
  const found = allRides.filter(ride => ride.area === from && ride.dest === to && allowedCommunities.has(ride.community_id));
  let ride = null;
  for (const candidate of found) {
    if (Math.abs(mins(candidate.time) - mins(time)) > 30) continue;
    const bookings = allBookings.filter(booking => booking.ride_id === candidate.id);
    const mine = bookings.some(booking => booking.user_id === user.id);
    const driver = candidate.driver_id ? userMap.get(candidate.driver_id) : null;
    const row = {
      ...candidate, booked: bookings.length, mine, driver_gender: driver ? driver.gender : null,
    };
    if (!seatProblem(user, row)) { ride = row; break; }
  }
  const matched = !!ride;
  if (!ride) {
    if (user.pref_women) {
      await refund();
      fail(400, 'No women drivers are posted on this route yet. Try another time, or turn off the women-drivers preference on Profile.');
    }
    const id = 's_' + crypto.randomBytes(5).toString('hex');
    ride = {
      id, community_id: PUBLIC, driver_id: null, area: from, dest: to, time, seats: 4,
      pink: false, completed: false, created_at: now(), booked: 0, mine: false, driver_gender: null,
    };
    await putDoc(COLLECTIONS.rides, id, ride);
  }
  const kind = from === 'Airport' || to === 'Airport' ? 'airport' : 'trip';
  try {
    const result = await confirmBooking(user, ride, req.day, kind, credit, matched);
    res.json({ code: result.code, fare: result.fare, milestone: result.milestone, matched });
  } catch (error) {
    await refund();
    throw error;
  }
}));

app.get('/api/trips', auth, wrap(async (req, res) => {
  const rows = await findAll(COLLECTIONS.trips, trip => trip.user_id === req.user.id);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ trips: rows.map(trip => ({
    id: trip.id, kind: trip.kind, from: trip.from_place, to: trip.to_place, time: trip.time, status: trip.status,
    km: Number(trip.km), fare: trip.fare, autoFare: trip.auto_fare, co2: Number(trip.co2), credit: trip.credit,
    rideId: trip.ride_id, communityId: trip.community_id,
  })) });
}));

app.post('/api/trips/:id/cancel', auth, wrap(async (req, res) => {
  const tripRef = ref(COLLECTIONS.trips, req.params.id);
  const userRef = ref(COLLECTIONS.users, req.user.id);
  let trip;
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(tripRef);
    if (!snapshot.exists || snapshot.data().user_id !== req.user.id) fail(404, 'Trip not found.');
    trip = snapshot.data();
    if (trip.ride_id) transaction.delete(ref(COLLECTIONS.bookings, bookingKey(trip.ride_id, req.user.id)));
    if (trip.credit) transaction.update(userRef, { free_credits: admin.firestore.FieldValue.increment(1) });
    transaction.delete(tripRef);
  });
  if (trip.community_id) broadcast(trip.community_id);
  res.json({ ok: true });
}));

app.post('/api/activity', auth, wrap(async (req, res) => {
  const milestone = await logActivity(req.user, req.day);
  res.json({ milestone, user: userOut(await userById(req.user.id), req.day) });
}));

app.get('/api/streak', auth, wrap(async (req, res) => {
  const rows = await findAll(COLLECTIONS.dailyLogs, item => item.user_id === req.user.id);
  rows.sort((a, b) => b.day.localeCompare(a.day));
  res.json({ days: rows.slice(0, 30).reverse().map(item => ({ day: item.day, n: item.n })) });
}));

app.post('/api/gift/claim', auth, wrap(async (req, res) => {
  const userRef = ref(COLLECTIONS.users, req.user.id);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(userRef);
    const user = snapshot.data();
    if (Math.floor(user.logs / GIFT_EVERY) > user.gift_claims) {
      transaction.update(userRef, {
        gift_claims: user.gift_claims + 1, free_credits: user.free_credits + 1,
      });
    }
  });
  res.json({ user: userOut(await userById(req.user.id), req.day) });
}));

app.post('/api/points/redeem', auth, wrap(async (req, res) => {
  const userRef = ref(COLLECTIONS.users, req.user.id);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(userRef);
    const user = snapshot.data();
    if (user.points < POINTS_PER_CREDIT) fail(400, `You need ${POINTS_PER_CREDIT} points for a free ride.`);
    transaction.update(userRef, {
      points: user.points - POINTS_PER_CREDIT, free_credits: user.free_credits + 1,
    });
  });
  res.json({ user: userOut(await userById(req.user.id), req.day) });
}));

app.get('/api/referrals', auth, wrap(async (req, res) => {
  const rows = await findAll(COLLECTIONS.users, user => user.referred_by === req.user.id);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ referrals: rows.map(user => ({ name: user.name, at: user.created_at })) });
}));

async function seedDemo() {
  const users = await getAll(COLLECTIONS.users);
  if (users.length) return;
  const demos = [
    { id: 'u_demo_student', name: 'Demo Student', email: 'demo@fellaride.app', gender: 'Prefer not to say', role: 'passenger', area: 'North Gate' },
    { id: 'u_demo_woman', name: 'Demo Woman', email: 'demo.woman@fellaride.app', gender: 'Female', role: 'driver', area: 'Tech Park' },
    { id: 'u_demo_driver', name: 'Demo Driver', email: 'demo.driver@fellaride.app', gender: 'Male', role: 'driver', area: 'North Gate' },
  ];
  for (const demo of demos) {
    const user = await createUser({
      id: demo.id, name: demo.name, email: demo.email, gender: demo.gender, password: DEMO_PASSWORD,
    });
    await putDoc(COLLECTIONS.memberships, membershipKey(user.id, 'riverside'), {
      user_id: user.id, community_id: 'riverside', role: demo.role, area: demo.area, time: '08:00',
    });
  }
  const createdAt = now();
  await Promise.all([
    putDoc(COLLECTIONS.rides, 'r_demo_pink', {
      id: 'r_demo_pink', community_id: 'riverside', driver_id: 'u_demo_woman',
      area: 'Tech Park', dest: 'Campus', time: '08:00', seats: 3, pink: true,
      completed: false, created_at: createdAt,
    }),
    putDoc(COLLECTIONS.rides, 'r_demo_std', {
      id: 'r_demo_std', community_id: 'riverside', driver_id: 'u_demo_driver',
      area: 'North Gate', dest: 'Campus', time: '08:00', seats: 3, pink: false,
      completed: false, created_at: createdAt,
    }),
  ]);
}

async function init() {
  const communities = [
    { id: 'public', name: 'Public rides', type: 'Public', code: 'PUBLIC', lat: 12.9716, lng: 77.5946 },
    { id: 'riverside', name: 'Riverside University', type: 'College', code: 'RIVER26', lat: 12.9716, lng: 77.5946 },
    { id: 'lakeview', name: 'Lakeview Engineering College', type: 'College', code: 'LAKE26', lat: 12.9352, lng: 77.6245 },
    { id: 'northwind', name: 'Northwind Tech Park', type: 'Workplace', code: 'NORTH26', lat: 12.9698, lng: 77.7500 },
  ];
  for (const community of communities) {
    const communityRef = ref(COLLECTIONS.communities, community.id);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(communityRef);
      if (!snapshot.exists) transaction.set(communityRef, { ...community, created_at: now() });
    });
  }
  await seedDemo();
}

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

ready = init();
if (!LOCAL_SERVER) ready.catch(error => console.error('Firebase setup failed:', error.message));
exports.fellaRideApi = onRequest({ region: 'us-central1', timeoutSeconds: 120 }, app);

if (LOCAL_SERVER) {
  ready
    .then(() => app.listen(PORT, () => console.log('Fella Ride API running on port ' + PORT + ' (Firestore ready)')))
    .catch(error => {
      console.error('Firebase setup failed:', error.message);
      process.exit(1);
    });
}
