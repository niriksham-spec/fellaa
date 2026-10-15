// ============ extras.js : real distance, fare & CO2 engine, location, rate-my-ride ============

// ---- Settings you can edit (₹ and kg) ----
const TARIFF = {
  auto:   { base: 30,  perKm: 15 },   // estimate for an auto rickshaw
  cab:    { base: 100, perKm: 14 },   // estimate for a regular cab
  shared: { base: 20,  perKm: 6  },   // Fella Ride, split across riders
  minFare: 20,                        // lowest fare shown
};
const CO2_KG_PER_KM = 0.12;           // cite a published emission factor on your slide

// ---- Distance ----
function haversineKm(a, b) {
  const R = 6371, t = d => d * Math.PI / 180;
  const h = Math.sin(t(b[0] - a[0]) / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(t(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Real road distance from OpenStreetMap routing (free). Falls back to straight-line x1.3 if offline.
async function roadKm(from, to) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=false`;
    const j = await (await fetch(url)).json();
    if (j.routes && j.routes[0]) return j.routes[0].distance / 1000;
  } catch (e) { /* fall through */ }
  return haversineKm(from, to) * 1.3;
}

// ---- Fares and CO2 ----
function fareOf(kind, km) {
  const t = TARIFF[kind];
  return Math.max(TARIFF.minFare, Math.round((t.base + t.perKm * km) / 5) * 5);
}
function compareFares(km) {
  const shared = fareOf('shared', km);
  const soloCo2 = km * CO2_KG_PER_KM;
  return {
    km: +km.toFixed(1),
    auto: fareOf('auto', km),
    cab: fareOf('cab', km),
    shared,
    saving: fareOf('auto', km) - shared,
    co2Saved: +soloCo2.toFixed(2),
  };
}

// ---- Location and place search ----
function getMyLocation() {
  return new Promise((ok, bad) => {
    if (!navigator.geolocation) return bad(new Error('Location is not supported on this device.'));
    navigator.geolocation.getCurrentPosition(
      p => ok([p.coords.latitude, p.coords.longitude]),
      () => bad(new Error('Allow location access to use your current location.')),
      { enableHighAccuracy: true, timeout: 15000 });
  });
}
async function searchPlace(text) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=in&q=${encodeURIComponent(text)}`;
  const j = await (await fetch(url)).json();
  return j.map(p => ({ name: p.display_name, lat: +p.lat, lng: +p.lon }));
}

// ---- Rate my ride popup (opens after a completed trip) ----
function openRateModal(p) {
  if (document.getElementById('rate-modal')) return;
  const box = document.createElement('div');
  box.id = 'rate-modal';
  box.className = 'gift-overlay';
  box.innerHTML = `<div class="gift-modal" style="text-align:left">
    <h2>Rate your ride</h2>
    <p class="muted">${esc(p.target.name)} · ${esc(p.area)} → ${esc(p.dest)} · ${esc(p.time)}</p>
    <div id="rate-stars" style="margin:10px 0">${[1,2,3,4,5].map(n => `<span data-s="${n}" style="font-size:34px;cursor:pointer;color:#f5a623">☆</span>`).join('')}</div>
    <label>Describe them<select id="rate-tag">${TAGS.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button class="btn" id="rate-send">Submit</button>
      <button class="btn ghost" id="rate-later">Later</button>
    </div>
  </div>`;
  document.body.appendChild(box);
  let stars = 0;
  const paint = () => box.querySelectorAll('#rate-stars span').forEach(s => s.textContent = +s.dataset.s <= stars ? '★' : '☆');
  box.querySelectorAll('#rate-stars span').forEach(s => s.onclick = () => { stars = +s.dataset.s; paint(); });
  document.getElementById('rate-later').onclick = () => {
    sessionStorage.setItem('rate-skip-' + p.rideId + p.target.id, '1');
    box.remove();
  };
  document.getElementById('rate-send').onclick = () => {
    if (!stars) return flash('Tap a star rating first.');
    const tag = document.getElementById('rate-tag').value;
    box.remove();
    act(() => api('/api/ratings', { rideId: p.rideId, toUserId: p.target.id, stars, tag }), 'Thanks! Your feedback is saved.');
  };
}
// Check every few seconds whether there is a completed ride waiting for feedback
setInterval(() => {
  if (!token || !me || !pending || !pending.length) return;
  const p = pending[0];
  if (sessionStorage.getItem('rate-skip-' + p.rideId + p.target.id)) return;
  openRateModal(p);
}, 4000);