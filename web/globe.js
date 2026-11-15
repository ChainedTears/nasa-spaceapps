/* The globe as a stage: stars behind it, a glow around it, and a camera that
   moves with some weight. Loaded last; also starts the page. */

const G = {
  mode: 'orbit',            // 'orbit' (whole Earth, turning) or 'area' (down over a place)
  v: 0, b: 0,               // current spin (°/s of longitude) and drift (°/s of bearing)
  held: false, resumeAt: Infinity, touched: false,
  flight: 0, flying: false, intro: null, last: performance.now(),
};
const SPIN = 3.2, DRIFT = 0.8;
const RAD = Math.PI / 180;

/* ------------------------------------------------------------- geometry */

const camDistance = () => map.transform.cameraToCenterDistance || innerHeight * 1.5;
const globeRadius = (zoom, lat) => (512 * 2 ** zoom) / (2 * Math.PI) / Math.cos(lat * RAD);
/* Radius of the globe's outline on screen, in pixels (it is nearer than its centre). */
function apparentRadius(zoom, lat) {
  const R = globeRadius(zoom, lat), c = camDistance();
  return (c * R) / Math.sqrt((R + c) ** 2 - R ** 2);
}
/* The zoom at which the globe slightly overfills the short side of the free space. */
function heroZoom(lat = 18) {
  const pad = padding();
  const target = 0.53 * Math.min(innerWidth - (wide() ? pad.right - 30 : 0), innerHeight - (wide() ? 0 : pad.bottom - 110));
  let lo = 0, hi = 5;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (apparentRadius(mid, lat) < target) lo = mid; else hi = mid; }
  return lo;
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/* ---------------------------------------------------------------- stars */

/* A fixed sky of points on a sphere. It turns as the globe turns, more slowly,
   so space has depth; each star twinkles on its own clock. */
const sky = (() => {
  const cv = $('stars'), ctx = cv.getContext('2d');
  const N = 9000, pts = new Float32Array(N * 6);
  const TINTS = ['#ffffff', '#ffe6c7', '#cfe0ff'];
  let seed = 20211;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < N; i++) {
    const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z), o = i * 6;
    pts[o] = r * Math.cos(phi); pts[o + 1] = z; pts[o + 2] = r * Math.sin(phi);
    pts[o + 3] = 0.5 + 1.7 * rnd() ** 5;             // radius: mostly faint, a few bright
    pts[o + 4] = rnd() * 6.283;                      // twinkle phase
    pts[o + 5] = Math.floor(rnd() * 3);              // tint
  }
  let w = 0, h = 0, dpr = 1, blank = true;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = cv.width = Math.round(innerWidth * dpr); h = cv.height = Math.round(innerHeight * dpr);
  }
  resize();
  addEventListener('resize', resize);
  function draw(now, lng, lat, bearing, alpha) {
    if (alpha < 0.01) { if (!blank) { ctx.clearRect(0, 0, w, h); blank = true; } return; }
    blank = false;
    ctx.clearRect(0, 0, w, h);
    const K = 0.4;                                    // how much of the globe's turn the sky follows
    const ya = -lng * RAD * K, xa = lat * RAD * K, ba = -bearing * RAD;
    const cy = Math.cos(ya), sy = Math.sin(ya), cxa = Math.cos(xa), sxa = Math.sin(xa), cb = Math.cos(ba), sb = Math.sin(ba);
    const f = Math.max(w, h) * 1.1, ox = w / 2, oy = h / 2, t = now / 1000;
    for (let tint = 0; tint < 3; tint++) {
      ctx.fillStyle = TINTS[tint];
      for (let o = 0; o < N * 6; o += 6) {
        if (pts[o + 5] !== tint) continue;
        const x = pts[o], y = pts[o + 1], z = pts[o + 2];
        const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
        const y2 = y * cxa - z1 * sxa, z2 = y * sxa + z1 * cxa;
        if (z2 < 0.25) continue;
        const px = (x1 / z2) * f, py = (y2 / z2) * f;
        const sx = ox + px * cb - py * sb, sy2 = oy - (px * sb + py * cb);
        if (sx < -4 || sx > w + 4 || sy2 < -4 || sy2 > h + 4) continue;
        const size = pts[o + 3] * dpr;
        ctx.globalAlpha = alpha * Math.min(1, 0.45 + pts[o + 3] * 0.5) * (calm ? 0.9 : 0.72 + 0.28 * Math.sin(t * (0.6 + pts[o + 3]) + pts[o + 4]));
        if (size < 1.1) ctx.fillRect(sx, sy2, size, size);
        else { ctx.beginPath(); ctx.arc(sx, sy2, size * 0.62, 0, 6.283); ctx.fill(); }
      }
    }
  }
  return { draw };
})();

/* -------------------------------------------------------------- beacons */

/* Each example is an ember on the globe; selecting one dives to it. */
const beacons = PRESETS.map((p, i) => {
  const [w, s, e, n] = p.bbox, at = [(w + e) / 2, (s + n) / 2];
  const el = document.createElement('div');
  el.className = 'beacon far';
  el.innerHTML = `<button type="button" aria-label="${esc(p.name)}"><i style="animation-delay:${-i * 0.47}s"></i><span>${esc(p.name)}</span></button>`;
  el.firstChild.onclick = (ev) => {
    ev.stopPropagation();
    if (drawing) return;
    if (P.tab === 'season') seasonPreset(i);
    else pickPreset(i);
  };
  new maplibregl.Marker({ element: el, opacityWhenCovered: '0' }).setLngLat(at).addTo(map);
  return { el, lng: at[0], lat: at[1], tabs: ['records', 'season'] };
});
/* Hidden in other views, when the camera is low (unless the pin marks a place
   to see up close), and when the place is round the back of the globe. */
function beaconFar(b, c, z) {
  if (!b.tabs.includes(P.tab) || drawing || document.body.classList.contains('boot')) return true;
  if (z > 5.2 && !b.near) return true;
  const R = globeRadius(z, c.lat);
  const cosd = Math.sin(c.lat * RAD) * Math.sin(b.lat * RAD) + Math.cos(c.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - c.lng) * RAD);
  return cosd < R / (R + camDistance()) + 0.05;
}

/* --------------------------------------------------------------- camera */

function setMode(mode) {
  G.mode = mode;
  swap($('orbit').firstElementChild, mode === 'orbit' && BOX[P.tab]() ? 'Return to area' : 'Whole Earth');
}

/* Run camera moves one after another. Anything the user does cancels the rest. */
async function flight(steps) {
  const id = ++G.flight;
  G.flying = true;
  for (const step of steps) {
    map.stop();
    await new Promise((ok) => { map.once('moveend', ok); step(); });
    if (id !== G.flight) return;
  }
  G.flying = false;
  G.resumeAt = performance.now() + (G.mode === 'orbit' ? 300 : 2500);
}

/* Where the camera should end up to frame the chosen area, clear of the UI. */
function areaCamera(box) {
  const [w, s, e, n] = box, pad = padding();
  const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / (2 * Math.PI);
  const availW = Math.max(innerWidth - pad.left - pad.right, 160), availH = Math.max(innerHeight - pad.top - pad.bottom, 160);
  const zoom = Math.log2(Math.min(availW / ((512 * (e - w)) / 360), availH / (512 * (my(n) - my(s)))));
  return { center: [(w + e) / 2, (s + n) / 2], zoom: Math.min(zoom - 0.35, 10.5), padding: pad };
}

/* The dive: from far out, first turn the globe to face the place while easing
   back a little, then plunge and tilt into the terrain. */
function flyToArea(duration = 4800, box = BOX[P.tab]()) {
  if (!box) return;
  setMode('area');
  const cam = areaCamera(box), from = map.getCenter(), z = map.getZoom(), steps = [];
  const turn = Math.abs(((cam.center[0] - from.lng + 540) % 360) - 180) + Math.abs(cam.center[1] - from.lat);
  if (z < 4 && turn > 12 && !calm) {
    steps.push(() => map.easeTo({
      center: [cam.center[0], cam.center[1] * 0.8], zoom: Math.max(z - 0.3, 0.8), pitch: 0, bearing: 0, padding: cam.padding,
      duration: Math.min(900 + turn * 13, 2600), easing: (t) => t * t * (3 - 2 * t), essential: true,
    }));
  }
  steps.push(() => map.flyTo({ ...cam, pitch: 60, bearing: -22, duration, curve: 1.75, essential: true }));
  flight(steps);
}
/* Down to a single place, with no box: turn to face it, then descend and tilt. */
function flyToPoint(lng, lat, zoom = 8) {
  setMode('area');
  const from = map.getCenter(), z = map.getZoom(), steps = [];
  const turn = Math.abs(((lng - from.lng + 540) % 360) - 180) + Math.abs(lat - from.lat);
  if (z < 4 && turn > 12 && !calm) {
    steps.push(() => map.easeTo({
      center: [lng, lat * 0.8], zoom: Math.max(z - 0.3, 0.8), pitch: 0, bearing: 0, padding: padding(),
      duration: Math.min(900 + turn * 13, 2600), easing: (t) => t * t * (3 - 2 * t), essential: true,
    }));
  }
  steps.push(() => map.flyTo({ center: [lng, lat], zoom, pitch: 52, bearing: -16, padding: padding(), duration: 4200, curve: 1.7, essential: true }));
  flight(steps);
}
/* And back out: rise, level off, and let the globe turn again. */
function flyToEarth() {
  setMode('orbit');
  const c = map.getCenter();
  flight([() => map.flyTo({ center: [c.lng, 18], zoom: heroZoom(), pitch: 0, bearing: 0, padding: padding(), duration: 4400, curve: 1.5, essential: true })]);
}

/* Anything the user does to the map takes over from the choreography. */
function touch(hold) {
  G.touched = true;
  if (G.intro) { G.intro = null; introDone(); }
  if (G.flying) { G.flight++; G.flying = false; map.stop(); }
  G.v = 0; G.b = 0;
  if (hold) G.held = true;
  G.resumeAt = performance.now() + (G.mode === 'orbit' ? 2200 : 6000);
}
map.on('mousedown', () => touch(true));
map.on('touchstart', () => touch(true));
map.on('wheel', () => touch(false));
for (const ev of ['pointerup', 'pointercancel', 'touchend']) {
  addEventListener(ev, () => { if (G.held) { G.held = false; G.resumeAt = performance.now() + (G.mode === 'orbit' ? 2200 : 6000); } });
}
addEventListener('pointerdown', () => { G.touched = true; }, true);

$('orbit').onclick = () => { openPop(null); if (G.mode === 'orbit' && BOX[P.tab]()) flyToArea(); else flyToEarth(); };
$('zoom-in').onclick = () => { touch(false); map.easeTo({ zoom: map.getZoom() + 1, duration: 600 }); };
$('zoom-out').onclick = () => { touch(false); map.easeTo({ zoom: map.getZoom() - 1, duration: 600 }); };
$('compass').onclick = () => { touch(false); map.easeTo({ bearing: 0, pitch: 0, duration: 900 }); };

/* ----------------------------------------------------------- every frame */

const halo = $('halo'), needle = $('compass').firstElementChild;
let lastBearing = null;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - G.last) / 1000, 0.05);
  G.last = now;

  if (G.intro) {
    // Opening shot: the globe sweeps in from far away, slowing into its steady turn.
    const k = Math.min((now - G.intro.t0) / G.intro.dur, 1), e = 1 - (1 - k) ** 3;
    const c = map.getCenter();
    G.v = SPIN * (1 + 7 * (1 - e));
    map.jumpTo({ zoom: G.intro.from + (G.intro.to - G.intro.from) * e, center: [c.lng - G.v * dt, c.lat] });
    if (k === 1) { G.intro = null; G.resumeAt = 0; introDone(); }
  } else {
    // Spin and drift ease up to speed and ease away; they never start or stop dead.
    const z = map.getZoom();
    const free = !G.held && !G.flying && !drawing && now > G.resumeAt;
    const spin = free && G.mode === 'orbit' && z < 4.5;
    const drift = free && G.mode === 'area' && z > 5 && !calm;
    G.v += ((spin ? SPIN : 0) - G.v) * (1 - Math.exp(-dt / (spin ? 1.4 : 0.3)));
    G.b += ((drift ? DRIFT : 0) - G.b) * (1 - Math.exp(-dt / (drift ? 2.5 : 0.4)));
    if (!G.held && !G.flying && !map.isMoving()) {
      if (G.v > 0.02) { const c = map.getCenter(); map.jumpTo({ center: [c.lng - G.v * dt, c.lat] }); }
      else if (G.b > 0.01) map.jumpTo({ bearing: map.getBearing() + G.b * dt });
    }
  }

  // Scenery follows the camera.
  const z = map.getZoom(), c = map.getCenter(), bearing = map.getBearing(), pitch = map.getPitch();
  const far = 1 - smooth(3.4, 6.2, z);
  sky.draw(now, c.lng, c.lat, bearing, document.body.classList.contains('boot') ? 1 : 0.25 + 0.75 * far);
  // The glow arrives with the globe, not before it.
  const glow = far * (1 - Math.min(pitch / 25, 1)) * (G.revealAt ? smooth(0, 1800, now - G.revealAt) : 0);
  if (glow > 0.01) {
    const p = map.project(c);
    halo.style.opacity = glow;
    halo.style.transform = `translate(${p.x}px, ${p.y}px) scale(${apparentRadius(z, c.lat) / 300})`;
  } else if (halo.style.opacity !== '0') halo.style.opacity = '0';
  for (const b of beacons) b.el.classList.toggle('far', beaconFar(b, c, z));
  for (const b of PINS) b.el.classList.toggle('far', beaconFar(b, c, z));
  if (bearing !== lastBearing) { lastBearing = bearing; needle.style.transform = `rotate(${-bearing}deg)`; }
}

/* ---------------------------------------------------------------- start */

let introEnded = false;
function introDone() {
  if (introEnded) return;
  introEnded = true;
  [$('title'), $('tabs'), $('view'), $('credit')].forEach((el, i) => setTimeout(() => { show(el, true); if (el === $('tabs')) markTabs(); }, i * 140));
  TAB_HOOKS[P.tab]?.ready?.();
  // First visit: a short tour, which holds back the automatic dive below.
  TOUR.maybeStart();
  // If nobody has touched anything, show what the page is for: dive to the first example.
  setTimeout(() => { if (P.tab === 'records' && !S.run && !drawing && !G.touched && !TOUR.active && P.tourDone) pickPreset(0); }, 2200);
}

document.body.classList.toggle('compact', P.density === 'compact');
setTab(P.tab, { fly: false, first: true });
renderLegends();
fetch('/api/meta').then((r) => r.json()).then((m) => { S.meta = m; }).catch(() => {});
requestAnimationFrame(frame);
mapReady.then(async () => {
  // A slow map-style server must never leave the page blank.
  await Promise.race([addVectorBasemaps(), new Promise((ok) => setTimeout(ok, 5000))]);
  // Wait for the first tiles so the globe arrives whole, but never for long.
  await new Promise((ok) => { map.once('idle', ok); setTimeout(ok, 2500); });
  document.body.classList.remove('boot');
  G.revealAt = performance.now();
  G.intro = { from: map.getZoom(), to: heroZoom(), t0: performance.now(), dur: calm ? 500 : 3800 };
});
