/* Front end for server.py. No build step; plain browser JS. */

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const MAX_SPAN = 8;

const COLORS = {
  conf: { 7: '#f2b134', 8: '#ec6a2c', 9: '#c81e1e' },
  past: '#6f695f',
  spread: ['#5b2a86', '#d1495b', '#ffb627'],
  persist: ['#fdc86b', '#e8590c', '#8f1010'],
  sev: { 2: '#8fd0c0', 3: '#3a9d92', 4: '#145a56', 5: '#9bcf53' },
  day: '#d5367f',
  night: '#2a78d6',
};
const SEV_NAMES = { 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Greener after' };
const CONF_NAMES = { 7: 'low', 8: 'nominal', 9: 'high' };

const PRESETS = [
  { name: 'Dixie Fire, 2021', bbox: [-122.4, 39.0, -120.4, 41.0], start: '2021-07-01', end: '2021-09-30' },
  { name: 'Carr Fire, 2018', bbox: [-123.0, 40.35, -122.0, 41.05], start: '2018-07-15', end: '2018-09-15' },
  { name: 'Caldor Fire, 2021', bbox: [-120.9, 38.4, -119.8, 39.0], start: '2021-08-10', end: '2021-10-15' },
  { name: 'Evros, Greece 2023', bbox: [25.5, 40.75, 26.7, 41.4], start: '2023-08-10', end: '2023-09-15' },
  { name: 'Rondônia, Amazon 2022', bbox: [-64.5, -10.5, -61.5, -8.0], start: '2022-08-01', end: '2022-09-30' },
  { name: 'NSW Black Summer', bbox: [149.2, -36.6, 151.2, -33.2], start: '2019-11-01', end: '2020-01-31' },
];

const S = {
  bbox: null, start: null, end: null,     // what is on screen in the form
  run: null,                              // {bbox, start, end} of the loaded analysis
  fires: null, baseline: null, frp: null, sev: null,
  status: {}, idx: 0, token: 0, timer: null, meta: null, label: '',
};

/* ---------------------------------------------------------------- helpers */

const fmtDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const ms = (iso) => Date.parse(iso + 'T00:00:00Z');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const num = (x, digits = 0) => x.toLocaleString('en-US', { maximumFractionDigits: digits });
const big = (x) => (x >= 100 ? num(Math.round(x)) : x >= 10 ? num(x, 0) : num(x, 1));
const sum = (a) => a.reduce((s, x) => s + x, 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Nothing on the page pops in or out: every change goes through these. */
const show = (el, on) => { el.classList.toggle('off', !on); el.inert = !on; };           // floating things
const fold = (el, open) => { el.classList.toggle('shut', !open); el.inert = !open; };    // things in the flow
function setText(el, html) {
  if (el._html === html) return;
  el._html = html; el.innerHTML = html;
  el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'ease-out' });
}
function setList(el, items) {
  const sig = items.join('|');
  if (el._sig === sig) return false;
  el._sig = sig;
  el.innerHTML = items.map((html, i) => `<li class="rise" style="animation-delay:${i * 45}ms">${html}</li>`).join('');
  return true;
}
const store = {
  load() { try { return JSON.parse(localStorage.getItem('fire-prefs')) || {}; } catch { return {}; } },
  save() { try { localStorage.setItem('fire-prefs', JSON.stringify(P)); } catch { /* private mode */ } },
};
const SECTIONS = [
  ['numbers', 'Key numbers'], ['activity', 'Fire activity'], ['periods', 'Critical periods'], ['unusual', 'Unusual conditions'],
  ['power', 'Radiative power'], ['history', 'Burn history'], ['sources', 'Data sources'],
];
const STATS = [
  ['area', 'Area burned'], ['peak', 'Peak 8-day window'], ['ratio', 'Compared with earlier years'],
  ['frpmax', 'Strongest detection'], ['night', 'Radiative power at night'], ['reburn', 'On earlier burn scars'],
];
/* What the user has chosen to see; remembered between visits. */
const P = { order: SECTIONS.map(([id]) => id), hide: {}, layers: { fire: true, frp: true, sev: true }, mode: 'window', base: 'clean', panel: true, ...store.load() };
for (const [id] of SECTIONS) if (!P.order.includes(id)) P.order.push(id);

function winRange(i) {
  const W = S.fires.windows;
  const a = ms(W[i].date);
  const b = i + 1 < W.length ? Math.min(ms(W[i + 1].date), a + 8 * DAY) : a + 8 * DAY;
  return [a, b];
}
function winLabel(i) {
  const [a, b] = winRange(i);
  return `${fmtDay.format(a)} – ${fmtDay.format(b - DAY)}`;
}
function winOfTime(t) {
  const W = S.fires?.windows || [];
  for (let i = W.length - 1; i >= 0; i--) if (t >= ms(W[i].date)) return i;
  return 0;
}
const isNight = (t, lon) => {
  const h = (((t / 3600000 + lon / 15) % 24) + 24) % 24;   // local solar hour
  return h < 6 || h >= 18;
};

/* ------------------------------------------------------------------- map */

const raster = (tiles, attribution, extra = {}) => ({ type: 'raster', tiles, tileSize: 256, attribution, ...extra });
const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const gibsTiles = (date) => [
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
];
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const empty = () => ({ type: 'FeatureCollection', features: [] });
const FADE = { duration: 600 };

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const dark = () => darkQuery.matches;

const map = new maplibregl.Map({
  container: 'map',
  center: [-40, 25],
  zoom: 2.1,
  maxPitch: 75,
  attributionControl: false,
  style: {
    version: 8,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#0b1a33', 'horizon-color': '#f2b98a', 'fog-color': '#1a1410',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.4,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5.5, 1, 8, 0.25],
    },
    light: { anchor: 'map', position: [1.5, 80, 60], intensity: 0.5 },
    sources: {
      osm: raster(['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], OSM, { maxzoom: 19 }),
      gibs: raster(gibsTiles('2021-08-05'), 'Imagery: NASA GIBS', { maxzoom: 9 }),
      dem: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 12, attribution: 'Terrain: Mapzen, AWS Open Data' },
      shade: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 12 },
      aoi: { type: 'geojson', data: empty() },
      sev: { type: 'geojson', data: empty() },
      fire: { type: 'geojson', data: empty() },
      frp: { type: 'geojson', data: empty() },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#11161f' } },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': FADE } },
      { id: 'gibs', type: 'raster', source: 'gibs', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': FADE } },
      {
        id: 'shade', type: 'hillshade', source: 'shade',
        paint: { 'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 7, 0, 10, 0.3], 'hillshade-shadow-color': '#1a130c', 'hillshade-highlight-color': '#fff6e6', 'hillshade-accent-color': '#3a2a1a' },
      },
      { id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#c2491a', 'fill-opacity': 0.05 } },
      { id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#c2491a', 'line-width': 2, 'line-dasharray': [2, 1.5] } },
      {
        id: 'sev', type: 'circle', source: 'sev',
        paint: {
          'circle-color': ['match', ['get', 'k'], 2, COLORS.sev[2], 3, COLORS.sev[3], 4, COLORS.sev[4], COLORS.sev[5]],
          'circle-opacity': 0, 'circle-opacity-transition': FADE, 'circle-pitch-alignment': 'map',
        },
      },
      { id: 'fire', type: 'circle', source: 'fire', paint: { 'circle-pitch-alignment': 'map', 'circle-opacity': 0, 'circle-opacity-transition': FADE } },
      {
        id: 'frp', type: 'circle', source: 'frp',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            6, ['interpolate', ['linear'], ['sqrt', ['get', 'p']], 0, 1, 10, 2, 50, 5],
            9.5, ['interpolate', ['linear'], ['sqrt', ['get', 'p']], 0, 1.5, 10, 4, 50, 14]],
          'circle-color': ['case', ['==', ['get', 'night'], 1], COLORS.night, COLORS.day],
          'circle-opacity': 0, 'circle-opacity-transition': FADE,
          'circle-stroke-color': ['case', ['==', ['get', 'night'], 1], COLORS.night, COLORS.day],
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0, 'circle-stroke-opacity-transition': FADE,
        },
      },
    ],
  },
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
document.querySelector('.maplibregl-ctrl-attrib')?.removeAttribute('open');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-left');
const mapReady = new Promise((ok) => map.on('load', ok));
mapReady.then(() => {
  map.setTerrain({ source: 'dem', exaggeration: 1.6 });
  map.easeTo({ padding: padding(), duration: 1200 });
  setLayers();
});

/* Layers fade rather than switch: visibility is expressed as opacity. */
const LAYER_OPACITY = { fire: { 'circle-opacity': 0.9 }, frp: { 'circle-opacity': 0.15, 'circle-stroke-opacity': 0.8 }, sev: { 'circle-opacity': 0.7 } };
function setLayers() {
  for (const [id, props] of Object.entries(LAYER_OPACITY)) {
    for (const [prop, value] of Object.entries(props)) map.setPaintProperty(id, prop, P.layers[id] ? value : 0);
  }
}

/* The camera. Padding keeps the subject clear of the dashboard. */
const wide = () => innerWidth >= 800;
function padding() {
  return wide()
    ? { top: 80, bottom: 120, left: 30, right: P.panel ? 450 : 30 }
    : { top: 70, bottom: P.panel ? innerHeight * 0.46 + 90 : 110, left: 16, right: 16 };
}
let spinning = true;
function spin() {
  if (spinning && !map.isMoving()) { const c = map.getCenter(); map.jumpTo({ center: [c.lng - 0.06, c.lat] }); }
  requestAnimationFrame(spin);
}
for (const ev of ['mousedown', 'touchstart', 'wheel']) map.on(ev, () => { if (spinning) setOrbit(false, { fly: false }); });
function flyToArea(duration = 5200) {
  if (!S.bbox) return;
  spinning = false;
  const [w, s, e, n] = S.bbox;
  // cameraForBounds works within the map's current padding, so set that first.
  map.setPadding(padding());
  let cam = null;
  try { cam = map.cameraForBounds([[w, s], [e, n]]); } catch { /* box does not fit; use the fallback */ }
  cam = cam || { center: [(w + e) / 2, (s + n) / 2], zoom: 6 };
  map.flyTo({ center: cam.center, zoom: Math.min(cam.zoom - 0.3, 10), pitch: 48, bearing: -14, duration, curve: 1.6, essential: true });
}
function setOrbit(on, { fly = true } = {}) {
  spinning = on;
  $('orbit').textContent = on ? 'Return to area' : 'Whole Earth';
  if (!fly) return;
  if (on) {
    const c = map.getCenter();
    map.flyTo({ center: [c.lng, 18], zoom: wide() ? 1.9 : 1.1, pitch: 0, bearing: 0, padding: padding(), duration: 4200, curve: 1.5, essential: true });
  } else flyToArea(4200);
}

/* Circle radius that tracks a ground pixel of `deg` degrees, never below minPx. */
function groundRadius(deg, lat, minPx) {
  const metres = deg * 111320;
  const z0 = Math.log2((minPx * 2 * 78271.5 * Math.cos((lat * Math.PI) / 180)) / metres);
  return ['interpolate', ['exponential', 2], ['zoom'], z0, minPx, z0 + 10, minPx * 1024];
}

/* The "Clean" basemap: OpenFreeMap's open vector tiles, in a light and a dark
   flavour. Both are added under our data layers and toggled with the theme. */
const vector = { light: [], dark: [] };
let basemap = P.base;
async function addVectorBasemaps() {
  try {
    for (const [theme, name] of [['light', 'positron'], ['dark', 'dark']]) {
      const style = await (await fetch(`https://tiles.openfreemap.org/styles/${name}`)).json();
      map.setGlyphs(style.glyphs);
      map.setSprite(style.sprite);
      for (const [id, src] of Object.entries(style.sources)) if (!map.getSource(id)) map.addSource(id, src);
      for (const layer of style.layers) {
        const id = `${theme}:${layer.id}`;
        map.addLayer({ ...layer, id, layout: { ...layer.layout, visibility: 'none' } }, 'osm');
        vector[theme].push(id);
      }
    }
  } catch {
    if (basemap === 'clean') basemap = 'osm';         // fall back to raster streets
  }
  setBasemap(basemap);
}
function setBasemap(kind) {
  for (const theme of ['light', 'dark']) {
    const on = theme === (dark() ? 'dark' : 'light');
    for (const id of vector[theme]) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  // The raster basemaps sit above the vector one and cross-fade over it.
  for (const id of ['osm', 'gibs']) {
    const on = kind === id;
    if (on) map.setLayoutProperty(id, 'visibility', 'visible');
    requestAnimationFrame(() => map.setPaintProperty(id, 'raster-opacity', on ? 1 : 0));
    if (!on) setTimeout(() => { if (basemap !== id) map.setLayoutProperty(id, 'visibility', 'none'); }, FADE.duration + 100);
  }
}
function setGibsDate() {
  if (!S.fires?.windows.length) return;
  const [a] = winRange(S.idx);
  const date = iso(Math.min(a + 3 * DAY, Date.now() - 2 * DAY));
  if (date !== S.gibsDate) { S.gibsDate = date; map.getSource('gibs').setTiles(gibsTiles(date)); }
}

/* ------------------------------------------------------- area of interest */

function setAOI(bbox, { fly = true } = {}) {
  let [w, s, e, n] = bbox.map((x) => +x.toFixed(4));
  if (e - w > MAX_SPAN) { const c = (w + e) / 2; w = c - MAX_SPAN / 2; e = c + MAX_SPAN / 2; banner(`Areas are limited to ${MAX_SPAN}° on a side — trimmed.`); }
  if (n - s > MAX_SPAN) { const c = (s + n) / 2; s = c - MAX_SPAN / 2; n = c + MAX_SPAN / 2; banner(`Areas are limited to ${MAX_SPAN}° on a side — trimmed.`); }
  S.bbox = [w, s, e, n];
  mapReady.then(() => {
    map.getSource('aoi').setData({
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    });
    if (fly) flyToArea();
  });
  markStale();
}

let drawing = null;
function setDrawMode(on) {
  $('draw').classList.toggle('on', on);
  $('draw').textContent = on ? 'Cancel drawing' : 'Draw a new area';
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  for (const h of ['dragPan', 'boxZoom', 'touchZoomRotate', 'dragRotate']) map[h][on ? 'disable' : 'enable']();
  drawing = on ? {} : null;
  if (on) { spinning = false; openPop(null); banner('Drag a box on the map. Esc cancels.'); }
}
const drawStart = (e) => { if (drawing) { drawing.a = e.lngLat; e.preventDefault(); } };
const drawMove = (e) => {
  if (!drawing?.a) return;
  const { a } = drawing, b = e.lngLat;
  drawing.box = [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)];
  const [w, s, ee, n] = drawing.box;
  map.getSource('aoi').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [ee, s], [ee, n], [w, n], [w, s]]] } });
};
const drawEnd = () => {
  if (!drawing?.a) return;
  const box = drawing.box;
  setDrawMode(false);
  if (box && box[2] - box[0] > 0.02 && box[3] - box[1] > 0.02) {
    clearPreset();
    setAOI(box, { fly: false });
    S.label = 'Custom area'; updateSummary(); openPop('area');
  } else if (S.bbox) setAOI(S.bbox, { fly: false });
};
map.on('mousedown', drawStart); map.on('touchstart', drawStart);
map.on('mousemove', drawMove); map.on('touchmove', drawMove);
map.on('mouseup', drawEnd); map.on('touchend', drawEnd);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawing) { setDrawMode(false); if (S.bbox) setAOI(S.bbox, { fly: false }); } });

/* --------------------------------------------------------------- loading */

let bannerTimer;
function banner(text) {
  $('banner').textContent = text; show($('banner'), true);
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => show($('banner'), false), 4500);
}
function markStale() {
  const r = S.run;
  const same = r && S.bbox && r.bbox.join() === S.bbox.join() && r.start === $('start').value && r.end === $('end').value;
  $('run').classList.toggle('stale', !same && !!r);
}
function clearPreset() { S.label = 'Custom area'; document.querySelectorAll('#presets .on').forEach((b) => b.classList.remove('on')); }

const SOURCE_LABELS = { fires: 'MODIS active fire', baseline: 'Earlier years', radiative: 'Sentinel-3 radiative power', severity: 'MTBS burn severity' };
function setStatus(kind, state, text) {
  S.status[kind] = { state, text };
  const li = $('src-' + kind);
  li.className = state;
  setText(li, `${SOURCE_LABELS[kind]}: ${esc(text)}`);
  document.body.classList.toggle('loading', Object.values(S.status).some((x) => x.state === 'wait'));
}

async function fetchKind(kind, token) {
  const q = new URLSearchParams({ bbox: S.run.bbox.join(','), start: S.run.start, end: S.run.end });
  const res = await fetch(`/api/${kind}?${q}`);
  const body = await res.json().catch(() => ({ error: 'Unexpected response from the server.' }));
  if (token !== S.token) return null;                 // a newer request replaced this one
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function analyze() {
  if (!S.bbox) return banner('Choose an area first.');
  let start = $('start').value, end = $('end').value;
  if (!start || !end) return banner('Choose a start and end date.');
  if (end < start) [start, end] = [end, start];
  if (ms(end) - ms(start) > 370 * DAY) return banner('Please keep the period to a year or less.');

  const token = ++S.token;
  stopPlay();
  Object.assign(S, { run: { bbox: [...S.bbox], start, end }, fires: null, baseline: null, frp: null, sev: null, idx: 0, status: {}, gibsDate: null });
  markStale();
  await mapReady;
  for (const id of ['fire', 'frp', 'sev']) map.getSource(id).setData(empty());
  show($('timeline'), false);
  fold($('empty-wrap'), true); fold($('report-wrap'), false);
  updateSummary();
  setText($('empty'), 'Reading the satellite records. Sentinel-3 can take a minute for long periods.');

  const y0 = +start.slice(0, 4), y1 = +end.slice(0, 4);
  const m = S.meta;
  setStatus('fires', 'wait', 'loading…');
  setStatus('baseline', 'wait', 'loading…');
  if (m && end < m.radiative[0]) setStatus('radiative', 'none', `record starts ${fmtFull.format(ms(m.radiative[0]))}`);
  else setStatus('radiative', 'wait', 'downloading passes…');
  setStatus('severity', 'wait', 'loading…');

  const job = (kind, apply) => fetchKind(kind, token).then((d) => d && apply(d)).catch((err) => {
    if (token === S.token) { setStatus(kind, 'err', err.message); render(); }
  });

  job('fires', (d) => {
    prepareFires(d);
    const n = S.fires.pix.size;
    setStatus('fires', n ? 'ok' : 'none', n ? `${d.windows.length} windows, ${num(n)} fire pixels` : 'no fire detected');
    S.idx = S.fires.peak;
    render();
  });
  job('baseline', (d) => {
    S.baseline = d;
    const ys = d.years.map((y) => y.year);
    setStatus('baseline', ys.length ? 'ok' : 'none', ys.length ? `${Math.min(...ys)}–${Math.max(...ys)}` : 'no earlier years');
    render();
  });
  if (S.status.radiative.state === 'wait') job('radiative', (d) => {
    S.frp = d.fires.filter((f) => f[3] != null).map(([t, lat, lon, p]) => ({ t, lat, lon, p, night: isNight(t, lon) ? 1 : 0 }));
    const note = d.passes_used < d.passes ? ` (sampled ${d.passes_used} of ${d.passes} passes)` : '';
    setStatus('radiative', S.frp.length ? 'ok' : 'none', S.frp.length ? `${num(S.frp.length)} detections in ${d.passes} passes${note}` : `no fire in ${d.passes} passes`);
    render();
  });
  job('severity', (d) => {
    S.sev = d;
    const ys = d.years.map((y) => y.year);
    setStatus('severity', ys.length ? 'ok' : 'none', ys.length ? `burns mapped ${Math.min(...ys)}–${Math.max(...ys)}` : `none here for ${y0 - 15}–${Math.min(y1, 2018)} (US only, to 2018)`);
    renderSeverityLayer();
    render();
  });
}

/* Index MODIS pixels: when each was first seen and how often it burned. */
function prepareFires(d) {
  const pix = new Map();
  d.windows.forEach((w, i) => {
    w.fresh = 0;
    for (const [lat, lon, c] of w.pixels) {
      const key = lat + ',' + lon;
      let p = pix.get(key);
      if (!p) { p = { lat, lon, first: i, n: 0, c: 0, key }; pix.set(key, p); w.fresh++; }
      p.n++; p.c = Math.max(p.c, c);
    }
  });
  const counts = d.windows.map((w) => w.pixels.length);
  S.fires = { ...d, pix, counts, peak: counts.indexOf(Math.max(...counts, 0)) };
}

/* ------------------------------------------------------------ map layers */

function renderFireLayer() {
  const F = S.fires;
  if (!F || !F.windows.length) return;
  const i = S.idx, feats = [];
  const point = (p, props) => feats.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });

  if (P.mode === 'window') {
    const now = new Set(F.windows[i].pixels.map(([lat, lon]) => lat + ',' + lon));
    for (const p of F.pix.values()) if (p.first < i && !now.has(p.key)) point(p, { s: 0, f: p.first, n: p.n });
    for (const [lat, lon, c] of F.windows[i].pixels) { const p = F.pix.get(lat + ',' + lon); point(p, { s: 1, c, f: p.first, n: p.n }); }
  } else {
    for (const p of F.pix.values()) if (P.mode === 'persist' || p.first <= i) point(p, { s: 1, c: p.c, f: p.first, n: p.n });
  }
  map.getSource('fire').setData({ type: 'FeatureCollection', features: feats });

  const last = Math.max(F.windows.length - 1, 1);
  const maxN = Math.max(...[...F.pix.values()].map((p) => p.n), 2);
  const color = {
    window: ['case', ['==', ['get', 's'], 0], COLORS.past, ['match', ['get', 'c'], 7, COLORS.conf[7], 8, COLORS.conf[8], COLORS.conf[9]]],
    spread: ['interpolate', ['linear'], ['get', 'f'], 0, COLORS.spread[0], last / 2, COLORS.spread[1], last, COLORS.spread[2]],
    persist: ['interpolate', ['linear'], ['get', 'n'], 1, COLORS.persist[0], (1 + maxN) / 2, COLORS.persist[1], maxN, COLORS.persist[2]],
  }[P.mode];
  map.setPaintProperty('fire', 'circle-color', color);

  // Sentinel-3 detections for the same slice of time.
  const [a, b] = winRange(i);
  // Overlapping passes are merged: one marker per ~2 km cell, showing its strongest reading.
  const cells = new Map();
  for (const f of S.frp || []) {
    if (P.mode === 'window' ? f.t < a || f.t >= b : P.mode === 'spread' ? f.t >= b : false) continue;
    const key = Math.round(f.lat / 0.02) + ',' + Math.round(f.lon / 0.02);
    const c = cells.get(key);
    if (!c) cells.set(key, { ...f, count: 1 });
    else { c.count++; if (f.p > c.p) Object.assign(c, f); }
  }
  map.getSource('frp').setData({
    type: 'FeatureCollection',
    features: [...cells.values()].sort((x, y) => x.p - y.p).map((f) => ({
      type: 'Feature', properties: { p: f.p, night: f.night, t: f.t, count: f.count }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    })),
  });
  setGibsDate();
  renderLegends(maxN);
}

function renderStaticLayers() {
  const F = S.fires;
  if (!F) return;
  const lat = (S.run.bbox[1] + S.run.bbox[3]) / 2;
  map.setPaintProperty('fire', 'circle-radius', groundRadius(F.resolution, lat, 2.2));
}
function renderSeverityLayer() {
  const d = S.sev;
  if (!d) return;
  const lat = (S.run.bbox[1] + S.run.bbox[3]) / 2;
  map.setPaintProperty('sev', 'circle-radius', groundRadius(d.resolution, lat, 1.4));
  map.getSource('sev').setData({
    type: 'FeatureCollection',
    features: d.pixels.map(([la, lo, k, y]) => ({ type: 'Feature', properties: { k, y }, geometry: { type: 'Point', coordinates: [lo, la] } })),
  });
}

function renderLegends(maxN) {
  const dot = (c, label) => `<span><i style="background:${c}"></i>${label}</span>`;
  const ramp = (cols, a, b) => `<span>${a}<i class="ramp" style="background:linear-gradient(90deg,${cols.join(',')})"></i>${b}</span>`;
  const W = S.fires?.windows || [];
  $('lg-fire').innerHTML = !W.length ? '' : {
    window: dot(COLORS.conf[7], 'low') + dot(COLORS.conf[8], 'nominal') + dot(COLORS.conf[9], 'high confidence') + dot(COLORS.past, 'burned earlier'),
    spread: ramp(COLORS.spread, fmtDay.format(ms(W[0].date)), fmtDay.format(ms(W[W.length - 1].date))),
    persist: ramp(COLORS.persist, '1', `${maxN} windows`),
  }[P.mode];
  $('lg-frp').innerHTML = S.frp?.length ? dot(COLORS.day, 'day') + dot(COLORS.night, 'night') : '';
  $('lg-sev').innerHTML = S.sev?.pixels.length ? [2, 3, 4, 5].map((k) => dot(COLORS.sev[k], SEV_NAMES[k].toLowerCase())).join('') : '';
}

map.on('click', (e) => {
  if (drawing) return;
  const pad = 6, box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const feats = map.queryRenderedFeatures(box, { layers: ['fire', 'frp', 'sev'].filter((id) => P.layers[id]) });
  closePopup();
  if (!feats.length) return;
  const parts = [], W = S.fires?.windows || [];
  const fire = feats.find((f) => f.layer.id === 'fire');
  if (fire) {
    const p = fire.properties;
    parts.push(`<p><b>Active fire (MODIS)</b><br>First seen ${winLabel(p.f)}<br>Burning in ${p.n} of ${W.length} windows${p.c ? `<br>Confidence: ${CONF_NAMES[p.c]}` : ''}</p>`);
  }
  const frps = feats.filter((f) => f.layer.id === 'frp').sort((a, b) => b.properties.p - a.properties.p);
  if (frps.length) {
    const p = frps[0].properties;
    parts.push(`<p><b>Radiative power (Sentinel-3)</b><br>${num(p.p, 1)} MW · ${fmtTime.format(p.t)} UTC (${p.night ? 'night' : 'day'})${p.count > 1 ? `<br>Strongest of ${p.count} readings at this spot` : ''}</p>`);
  }
  const sev = feats.find((f) => f.layer.id === 'sev');
  if (sev) parts.push(`<p><b>Past burn (MTBS)</b><br>${SEV_NAMES[sev.properties.k]} severity, ${sev.properties.y}</p>`);
  popup = new maplibregl.Popup({ maxWidth: '270px', closeButton: false, closeOnClick: false }).setLngLat(e.lngLat).setHTML(parts.join('')).addTo(map);
});
let popup = null;
function closePopup() {
  if (!popup) return;
  const old = popup; popup = null;
  old.getElement()?.classList.add('leaving');
  setTimeout(() => old.remove(), 220);
}
for (const id of ['fire', 'frp', 'sev']) {
  map.on('mouseenter', id, () => { if (!drawing) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', id, () => { if (!drawing) map.getCanvas().style.cursor = ''; });
}

/* -------------------------------------------------------------- timeline */

function setIndex(i, { fromScrub = false } = {}) {
  const W = S.fires?.windows || [];
  if (!W.length) return;
  S.idx = Math.max(0, Math.min(W.length - 1, i));
  if (!fromScrub) $('scrub').value = S.idx;
  const w = W[S.idx], k = S.fires.pixel_km2;
  $('tl-date').textContent = winLabel(S.idx) + ' ' + w.date.slice(0, 4);
  $('tl-note').textContent = w.pixels.length
    ? `${big(w.pixels.length * k)} km² burning · ${big(w.fresh * k)} km² new`
    : 'no fire detected';
  renderFireLayer();
  drawActivityChart();
}
function stopPlay() { clearInterval(S.timer); S.timer = null; $('play').textContent = 'Play'; }
$('play').onclick = () => {
  if (S.timer) return stopPlay();
  const W = S.fires.windows;
  if (S.idx >= W.length - 1) setIndex(0);
  $('play').textContent = 'Pause';
  S.timer = setInterval(() => { if (S.idx >= W.length - 1) stopPlay(); else setIndex(S.idx + 1); }, 900);
};
$('scrub').oninput = (e) => { stopPlay(); setIndex(+e.target.value, { fromScrub: true }); };

/* ---------------------------------------------------------------- charts */

const tip = $('tip');
function showTip(html, ev) {
  tip.innerHTML = html; tip.classList.remove('off');
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - r.width / 2)) + 'px';
  tip.style.top = Math.max(8, ev.clientY - r.height - 14) + 'px';
}
const hideTip = () => tip.classList.add('off');
addEventListener('scroll', hideTip, true);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/* Stacked bars with an optional reference line + range band, one y-axis. */
function barChart(el, cfg) {
  const n = cfg.labels.length;
  const width = Math.max(el.clientWidth || 360, 240), height = 176;
  const m = { l: 40, r: 6, t: 8, b: 22 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b;
  const totals = cfg.labels.map((_, i) => sum(cfg.stacks.map((s) => s.values[i] || 0)));
  const top = niceMax(Math.max(...totals, ...(cfg.band?.hi || [0]), ...(cfg.line?.values || [0])));
  const y = (v) => m.t + ph - (v / top) * ph;
  const step = pw / n, bw = Math.max(1, Math.min(26, step - (step > 6 ? 2 : 0.5)));
  const cx = (i) => m.l + step * (i + 0.5);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(cfg.title)}">`;

  for (const f of [0, 0.5, 1]) {
    svg += `<line class="grid" x1="${m.l}" x2="${width - m.r}" y1="${y(top * f)}" y2="${y(top * f)}"/>`;
    svg += `<text x="${m.l - 6}" y="${y(top * f) + 4}" text-anchor="end">${big(top * f)}</text>`;
  }
  const every = Math.ceil(n / Math.max(2, Math.floor(pw / 64)));
  cfg.labels.forEach((lab, i) => {
    if (i % every === 0 && cx(i) < width - 20) svg += `<text x="${cx(i)}" y="${height - 6}" text-anchor="middle">${esc(lab)}</text>`;
  });
  if (cfg.band) {
    const up = cfg.band.hi.map((v, i) => `${cx(i)},${y(v)}`), down = cfg.band.lo.map((v, i) => `${cx(i)},${y(v)}`).reverse();
    svg += `<polygon points="${[...up, ...down].join(' ')}" style="fill:var(--band)"/>`;
  }
  const r = Math.min(4, bw / 2);
  cfg.labels.forEach((_, i) => {
    let base = 0;
    const live = cfg.stacks.filter((s) => s.values[i] > 0);
    live.forEach((s, j) => {
      const y0 = y(base), y1 = y(base + s.values[i]);
      base += s.values[i];
      const h = Math.max(y0 - y1 - (j ? 1.5 : 0), 0.8), x = cx(i) - bw / 2, yy = y0 - (j ? 1.5 : 0) - h;
      const dim = cfg.sel != null && cfg.sel !== i;
      const round = 0;
      svg += `<path class="b" style="animation-delay:${Math.round((i / n) * 400)}ms;fill:${dim && s.dim ? s.dim : s.color}" d="M${x},${yy + h}V${yy + round}q0,${-round} ${round},${-round}H${x + bw - round}q${round},0 ${round},${round}V${yy + h}Z"/>`;
    });
  });
  if (cfg.line) {
    svg += `<polyline points="${cfg.line.values.map((v, i) => `${cx(i)},${y(v)}`).join(' ')}" fill="none" style="stroke:var(--base)" stroke-width="2" stroke-linejoin="round" stroke-dasharray="1 4" stroke-linecap="round"/>`;
  }
  (cfg.marks || []).forEach((i) => { svg += `<circle cx="${cx(i)}" cy="${Math.max(y(totals[i]) - 7, 4)}" r="3" style="fill:var(--crit)"/>`; });
  cfg.labels.forEach((_, i) => { svg += `<rect class="hit" data-i="${i}" x="${m.l + step * i}" y="${m.t}" width="${step}" height="${ph}"/>`; });
  svg += '</svg>';

  const legend = [
    ...(cfg.stacks.length > 1 || cfg.line ? cfg.stacks.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`) : []),
    ...(cfg.line ? [`<span><i class="line" style="background:var(--base)"></i>${cfg.line.name}</span>`] : []),
    ...(cfg.band ? [`<span><i style="background:var(--band)"></i>${cfg.band.name}</span>`] : []),
    ...(cfg.marks?.length ? ['<span><i style="background:var(--crit);border-radius:50%;width:7px;height:7px"></i>above range</span>'] : []),
  ];
  const sig = cfg.title + totals.join();
  el.classList.toggle('grow', el.dataset.sig !== sig);       // replay the entrance only for new data
  el.dataset.sig = sig;
  el.innerHTML = (legend.length ? `<div class="chart-legend">${legend.join('')}</div>` : '') + svg;
  el.querySelectorAll('.hit').forEach((hit) => {
    const i = +hit.dataset.i;
    hit.onmousemove = (ev) => showTip(cfg.tip(i), ev);
    hit.onmouseleave = hideTip;
    hit.onclick = (ev) => { cfg.pick?.(i); showTip(cfg.tip(i), ev); };
  });
}

/* -------------------------------------------------------------- insights */

/* Everything the report needs, derived from whichever datasets have arrived. */
function derive() {
  const F = S.fires, k = F.pixel_km2, W = F.windows, counts = F.counts;
  const D = { k, n: W.length, area: counts.map((c) => c * k), touched: F.pix.size * k, peak: F.peak };
  const [w, s, e, nn] = S.run.bbox;
  D.boxKm2 = (e - w) * (nn - s) * 111.32 ** 2 * Math.cos((((s + nn) / 2) * Math.PI) / 180);

  // Baseline: the same windows in earlier years.
  const ys = S.baseline?.years || [];
  if (ys.length) {
    const rows = W.map((x) => ys.map((yr) => (yr.counts[x.win] || 0) * k));
    D.base = {
      years: ys.map((yr) => yr.year).sort(),
      mean: rows.map((r) => sum(r) / r.length), lo: rows.map((r) => Math.min(...r)), hi: rows.map((r) => Math.max(...r)),
    };
    const typical = sum(D.base.mean);
    D.ratio = typical > 0 ? sum(D.area) / typical : null;
    D.unusual = W.map((_, i) => counts[i] >= 20 && D.area[i] > D.base.hi[i] && D.area[i] >= 2 * D.base.mean[i]);
  }

  // Radiative power per UTC day.
  if (S.frp) {
    const d0 = ms(S.run.start), nDays = Math.round((ms(S.run.end) - d0) / DAY) + 1;
    D.days = Array.from({ length: nDays }, (_, i) => d0 + i * DAY);
    D.dayP = new Array(nDays).fill(0); D.nightP = new Array(nDays).fill(0);
    let best = null;
    for (const f of S.frp) {
      const i = Math.floor((f.t - d0) / DAY);
      if (i < 0 || i >= nDays) continue;
      (f.night ? D.nightP : D.dayP)[i] += f.p;
      if (!best || f.p > best.p) best = f;
    }
    D.frpMax = best;
    D.frpTotal = sum(D.dayP) + sum(D.nightP);
    D.nightShare = D.frpTotal ? sum(D.nightP) / D.frpTotal : null;
    D.strong = S.frp.filter((f) => f.p >= 500).length;
    const daily = D.days.map((_, i) => D.dayP[i] + D.nightP[i]);
    D.frpDay = daily.indexOf(Math.max(...daily));
    D.frpDayTotal = daily[D.frpDay];
  }

  // Reburn: fire pixels that fall on scars mapped before this period.
  if (S.sev && F.pix.size) {
    const year0 = +S.run.start.slice(0, 4), res = F.resolution;
    const cell = (lat, lon) => Math.round(lat / res) + ',' + Math.round(lon / res);
    const scars = new Set(), scarYears = new Set();
    for (const [lat, lon, cls, yr] of S.sev.pixels) if (yr < year0 && cls >= 2 && cls <= 4) { scars.add(cell(lat, lon)); scarYears.add(yr); }
    if (scars.size) {
      let hit = 0;
      for (const p of F.pix.values()) if (scars.has(cell(p.lat, p.lon))) hit++;
      D.reburn = hit / F.pix.size;
      D.scarYears = [Math.min(...scarYears), Math.max(...scarYears)];
    }
  }
  return D;
}

function drawActivityChart() {
  const D = S.derived;
  if (!D || !D.n) return;
  barChart($('c1'), {
    title: 'Area burning per 8-day window',
    labels: S.fires.windows.map((w) => fmtDay.format(ms(w.date))),
    stacks: [{ name: 'This period', color: 'var(--bar)', dim: 'var(--bar-dim)', values: D.area }],
    line: D.base && { name: `${D.base.years[0]}–${D.base.years.at(-1)} average`, values: D.base.mean },
    band: D.base && { name: 'range', lo: D.base.lo, hi: D.base.hi },
    marks: D.unusual ? D.unusual.map((u, i) => (u ? i : -1)).filter((i) => i >= 0) : [],
    sel: S.idx,
    pick: (i) => { stopPlay(); setIndex(i); },
    tip: (i) => `<b>${winLabel(i)}</b><br>${big(D.area[i])} km² burning` +
      (D.base ? `<br>Earlier years: ${big(D.base.mean[i])} km² on average (${big(D.base.lo[i])}–${big(D.base.hi[i])})` : '') +
      (S.fires.windows[i].cloud >= 0.2 ? `<br>${Math.round(S.fires.windows[i].cloud * 100)}% hidden by cloud` : ''),
  });
}

function render() {
  const F = S.fires;
  if (!F) {
    if (S.status.fires?.state === 'err') setText($('empty'), 'Could not load: ' + esc(S.status.fires.text));
    return;
  }
  const period = `${fmtFull.format(ms(S.run.start))} – ${fmtFull.format(ms(S.run.end))}`;
  if (!F.windows.length) {
    setText($('empty'), `No MODIS data for ${period}. The record starts in February 2000.`);
    return;
  }
  const D = (S.derived = derive());
  fold($('empty-wrap'), false); fold($('report-wrap'), true); show($('timeline'), true);
  $('scrub').max = F.windows.length - 1;
  renderStaticLayers();

  const waiting = (kind) => S.status[kind]?.state === 'wait';
  const hasFire = F.pix.size > 0;
  setText($('period'), period);

  /* ---- key numbers ---- */
  const pending = (kind) => (waiting(kind) ? 'loading…' : '—');
  const values = {
    area: `${big(D.touched)} km² <small>${num((100 * D.touched) / D.boxKm2, 1)}% of the area</small>`,
    peak: hasFire ? `${winLabel(D.peak)} <small>${big(D.area[D.peak])} km²</small>` : '—',
    ratio: D.ratio != null ? `${big(D.ratio)}× <small>the ${D.base.years[0]}–${D.base.years.at(-1)} average</small>` : pending('baseline'),
    frpmax: D.frpMax ? `${big(D.frpMax.p)} MW <small>${fmtTime.format(D.frpMax.t)} UTC</small>` : pending('radiative'),
    night: D.nightShare != null ? `${Math.round(D.nightShare * 100)}%` : pending('radiative'),
    reburn: D.reburn != null ? `${Math.round(D.reburn * 100)}% <small>of fire pixels, burns of ${D.scarYears[0]}–${D.scarYears[1]}</small>` : pending('severity'),
  };
  for (const [key] of STATS) setText($('v-' + key), values[key]);

  setIndex(S.idx);

  /* ---- critical periods ---- */
  const events = [];
  const peakN = F.counts[D.peak] || 0;
  if (peakN > 0) {
    const onset = F.counts.findIndex((c) => c >= Math.max(5, 0.1 * peakN));
    if (onset >= 0 && onset < D.peak) events.push({ i: onset, when: winLabel(onset), title: 'Onset', text: `${big(D.area[onset])} km² burning.` });
    const grown = F.windows.map((w) => w.fresh), g = grown.indexOf(Math.max(...grown));
    if (grown[g] > 0) events.push({ i: g, when: winLabel(g), title: 'Fastest spread', text: `${big(grown[g] * D.k)} km² newly burned.` });
    for (let i = 0; i < D.n; i++) {
      if (F.counts[i] < 0.5 * peakN) continue;
      let j = i; while (j + 1 < D.n && F.counts[j + 1] >= 0.5 * peakN) j++;
      const hi = F.counts.slice(i, j + 1).indexOf(Math.max(...F.counts.slice(i, j + 1))) + i;
      events.push({
        i: hi, when: i === j ? winLabel(i) : `${fmtDay.format(winRange(i)[0])} – ${fmtDay.format(winRange(j)[1] - DAY)}`,
        title: hi === D.peak ? 'Peak' : 'Surge',
        text: `${big(D.area[hi])} km² burning${j > i ? `, ${j - i + 1} windows` : ''}.`,
      });
      i = j;
    }
    if (D.frpDayTotal > 0) events.push({ i: winOfTime(D.days[D.frpDay]), t: D.days[D.frpDay], when: fmtDay.format(D.days[D.frpDay]), title: 'Most intense day', text: `${big(D.frpDayTotal)} MW in total.` });
    const fade = F.counts.findIndex((c, i) => i > D.peak && c < 0.1 * peakN);
    if (fade > 0) events.push({ i: fade, when: winLabel(fade), title: 'Decline', text: 'Below a tenth of the peak.' });
  }
  events.sort((a, b) => (a.t ?? winRange(a.i)[0]) - (b.t ?? winRange(b.i)[0]));
  const fresh = setList($('events'), events.length
    ? events.map((ev, n) => `<button data-n="${n}"><span>${ev.when}</span><span><b>${ev.title}.</b> ${ev.text}</span></button>`)
    : ['None.']);
  if (fresh) $('events').querySelectorAll('button').forEach((b) => (b.onclick = () => { stopPlay(); setIndex(events[+b.dataset.n].i); }));

  /* ---- unusual conditions ---- */
  const flags = [];
  if (D.unusual?.some(Boolean)) {
    const idx = D.unusual.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
    const worst = idx.reduce((a, b) => (D.area[b] - D.base.hi[b] > D.area[a] - D.base.hi[a] ? b : a));
    const times = D.base.mean[worst] > 0 ? `${big(D.area[worst] / D.base.mean[worst])}× the average` : 'none in earlier years';
    flags.push(`${idx.length} of ${D.n} windows had more fire than any of the ${D.base.years.length} earlier years (largest: ${winLabel(worst)}, ${times}).`);
  }
  if (D.nightShare >= 0.35) flags.push(`${Math.round(D.nightShare * 100)}% of radiative power was detected at night.`);
  if (D.strong > 0) flags.push(`${num(D.strong)} detections above 500 MW.`);
  if (D.reburn >= 0.2) flags.push(`${Math.round(D.reburn * 100)}% of fire pixels are on burns mapped ${D.scarYears[0]}–${D.scarYears[1]}.`);
  const cloudy = F.windows.filter((w) => w.cloud >= 0.3).length;
  if (cloudy) flags.push(`Cloud covered over 30% of the area in ${cloudy} window${cloudy > 1 ? 's' : ''}; fire counts there may be low.`);
  const still = ['baseline', 'radiative', 'severity'].filter(waiting);
  if (still.length) flags.push('Still loading: ' + still.map((kind) => SOURCE_LABELS[kind]).join(', ') + '.');
  setList($('flags'), flags.length ? flags : ['None found.']);

  /* ---- radiative power chart ---- */
  if (D.frpTotal > 0) {
    barChart($('c2'), {
      title: 'Fire radiative power per day',
      labels: D.days.map((t) => fmtDay.format(t)),
      stacks: [{ name: 'Day', color: 'var(--day)', values: D.dayP }, { name: 'Night', color: 'var(--night)', values: D.nightP }],
      pick: (i) => { stopPlay(); setIndex(winOfTime(D.days[i])); },
      tip: (i) => `<b>${fmtDay.format(D.days[i])}</b><br>Day: ${big(D.dayP[i])} MW<br>Night: ${big(D.nightP[i])} MW`,
    });
  } else {
    $('c2').dataset.sig = ''; $('c2').innerHTML = `<p class="chart-empty">${waiting('radiative') ? 'Loading…' : esc('Sentinel-3: ' + (S.status.radiative?.text || 'no data'))}</p>`;
  }

  /* ---- severity chart ---- */
  const years = S.sev?.years || [];
  if (years.length) {
    const sk = S.sev.pixel_km2;
    const stack = (code, name) => ({ name, color: `var(--sev-${code})`, values: years.map((yr) => yr.counts[code] * sk) });
    barChart($('c3'), {
      title: 'Burn severity by year',
      labels: years.map((yr) => String(yr.year)),
      stacks: [stack(2, 'Low'), stack(3, 'Moderate'), stack(4, 'High')],
      tip: (i) => `<b>${years[i].year}</b><br>High: ${big(years[i].counts[4] * sk)} km²<br>Moderate: ${big(years[i].counts[3] * sk)} km²<br>Low: ${big(years[i].counts[2] * sk)} km²`,
    });
  } else {
    $('c3').dataset.sig = ''; $('c3').innerHTML = `<p class="chart-empty">${waiting('severity') ? 'Loading…' : 'No MTBS data here (United States only, 1984–2018).'}</p>`;
  }
}

/* ------------------------------------------------------------------ CSV */

function downloadCSV() {
  const rows = [['source', 'time_utc', 'latitude', 'longitude', 'value', 'unit']];
  for (const w of S.fires?.windows || []) for (const [lat, lon, c] of w.pixels) rows.push(['MODIS MxD14A2', w.date, lat, lon, CONF_NAMES[c], 'fire confidence (8-day window)']);
  for (const f of S.frp || []) rows.push(['Sentinel-3 SLSTR FRP', new Date(f.t).toISOString(), f.lat, f.lon, f.p, 'MW']);
  for (const [lat, lon, k, y] of S.sev?.pixels || []) rows.push(['MTBS', `${y}-12-31`, lat, lon, SEV_NAMES[k], 'burn severity class']);
  const url = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: `fire-records_${S.run.start}_${S.run.end}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------------------------------------- controls */

/* Popovers: one open at a time; Esc or a click elsewhere closes. */
function openPop(name) {
  for (const pop of document.querySelectorAll('.pop')) show(pop, pop.id === 'pop-' + name);
  for (const b of document.querySelectorAll('[data-pop]')) b.classList.toggle('on', b.dataset.pop === name);
}
document.querySelectorAll('[data-pop]').forEach((b) => (b.onclick = () => openPop(b.classList.contains('on') ? null : b.dataset.pop)));
addEventListener('pointerdown', (e) => { if (!e.target.closest('.pop, [data-pop]')) openPop(null); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { openPop(null); closePopup(); } });

function updateSummary() {
  const a = $('start').value, b = $('end').value;
  setText($('summary'), `${esc(S.label || 'Choose an area')}${a && b ? ` <small>${fmtFull.format(ms(a))} – ${fmtFull.format(ms(b))}</small>` : ''}`);
}

/* A row of choices where one is picked. */
function choice(id, value, onPick) {
  const mark = (v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  mark(value);
  $(id).onclick = (e) => { const b = e.target.closest('button'); if (b) { mark(b.dataset.v); onPick(b.dataset.v); store.save(); } };
}
choice('mode', P.mode, (v) => { P.mode = v; renderLegends(2); renderFireLayer(); });
choice('base', P.base, (v) => { P.base = basemap = v; setBasemap(v); });
darkQuery.addEventListener('change', () => setBasemap(basemap));
for (const id of ['fire', 'frp', 'sev']) {
  $('l-' + id).checked = P.layers[id];
  fold($('lg-' + id).parentElement, P.layers[id]);
  $('l-' + id).onchange = (e) => { P.layers[id] = e.target.checked; fold($('lg-' + id).parentElement, P.layers[id]); setLayers(); store.save(); };
}

$('orbit').onclick = () => setOrbit(!spinning);
$('draw').onclick = () => setDrawMode(!drawing);
$('run').onclick = () => { openPop(null); if (S.bbox) flyToArea(3000); analyze(); };
$('start').onchange = $('end').onchange = () => { clearPreset(); markStale(); updateSummary(); };

$('presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}</button>`).join('');
$('presets').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const p = PRESETS[+b.dataset.i];
  clearPreset(); b.classList.add('on');
  S.label = p.name;
  $('start').value = p.start; $('end').value = p.end;
  openPop(null);
  setOrbit(false, { fly: false });
  setAOI(p.bbox);
  analyze();
};

/* The dashboard: built once, then sections are folded, unfolded and re-ordered. */
const BODIES = {
  numbers: `<div id="stats">${STATS.map(([k, label]) => `<div class="fold" data-stat="${k}"><div><div class="stat"><span>${label}</span><b id="v-${k}">—</b></div></div></div>`).join('')}</div>`,
  activity: '<p class="sub">Area with active fire in each 8-day window, km². Select a bar to show it on the map.</p><div class="chart" id="c1"></div>',
  periods: '<ol id="events" class="rows"></ol>',
  unusual: '<ul id="flags" class="plain"></ul>',
  power: '<p class="sub">Megawatts per day, all Sentinel-3 detections.</p><div class="chart" id="c2"></div>',
  history: '<p class="sub">Area mapped by MTBS each year, km².</p><div class="chart" id="c3"></div>',
  sources: `<ul id="sources" class="plain">${Object.keys(SOURCE_LABELS).map((k) => `<li id="src-${k}"></li>`).join('')}</ul>
    <p class="sub">MODIS MOD/MYD14A2, Sentinel-3 SLSTR FRP and MTBS, read from Microsoft Planetary Computer. Imagery by NASA GIBS; map data © OpenStreetMap contributors, tiles by OpenFreeMap.</p>
    <button id="csv" class="link" type="button">Download these records as CSV</button>`,
};
$('report').innerHTML = P.order.map((id) => `<section class="fold" data-s="${id}"><div><h3>${SECTIONS.find(([x]) => x === id)[1]}</h3>${BODIES[id]}</div></section>`).join('');
$('csv').onclick = downloadCSV;
$('custom-list').innerHTML = P.order.map((id) => `<li data-s="${id}">
    <label><input type="checkbox" data-hide="${id}"> ${SECTIONS.find(([x]) => x === id)[1]}</label>
    <span><button data-move="-1" aria-label="Move up">↑</button><button data-move="1" aria-label="Move down">↓</button></span>
    ${id === 'numbers' ? `<div class="fold" id="stat-toggles"><div>${STATS.map(([k, label]) => `<label><input type="checkbox" data-hide="stat:${k}"> ${label}</label>`).join('')}</div></div>` : ''}
  </li>`).join('');

function applyPrefs() {
  for (const el of $('report').querySelectorAll('[data-s]')) fold(el, !P.hide[el.dataset.s]);
  for (const el of $('report').querySelectorAll('[data-stat]')) fold(el, !P.hide['stat:' + el.dataset.stat]);
  for (const box of $('custom-list').querySelectorAll('[data-hide]')) box.checked = !P.hide[box.dataset.hide];
  fold($('stat-toggles'), !P.hide.numbers);
  // A chart that was folded away has no width to measure; redraw once it is back.
  if (S.fires?.windows.length) setTimeout(render, 30);
}
/* Re-order children to match P.order, sliding each from where it was (FLIP). */
function reorder(container) {
  const items = [...container.querySelectorAll(':scope > [data-s]')];
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
  for (const id of P.order) container.append(items.find((el) => el.dataset.s === id));
  for (const el of items) {
    const dy = before.get(el) - el.getBoundingClientRect().top;
    if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
}
$('custom-list').onchange = (e) => {
  const key = e.target.dataset.hide;
  if (!key) return;
  P.hide[key] = !e.target.checked;
  applyPrefs(); store.save();
};
$('custom-list').onclick = (e) => {
  const move = +e.target.dataset?.move;
  if (!move) return;
  const id = e.target.closest('li').dataset.s, i = P.order.indexOf(id), j = i + move;
  if (j < 0 || j >= P.order.length) return;
  [P.order[i], P.order[j]] = [P.order[j], P.order[i]];
  reorder($('custom-list')); reorder($('report')); store.save();
};
$('reset').onclick = () => {
  P.order = SECTIONS.map(([id]) => id); P.hide = {};
  reorder($('custom-list')); reorder($('report')); applyPrefs(); store.save();
};

function setPanel(open) {
  P.panel = open; store.save();
  show($('panel'), open); show($('panel-tab'), !open);
  document.body.classList.toggle('panel-open', open);
  mapReady.then(() => { if (!spinning) map.easeTo({ padding: padding(), duration: 700 }); });
}
$('panel-hide').onclick = () => setPanel(false);
$('panel-tab').onclick = () => setPanel(true);

let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.fires?.windows.length) render(); }, 150); });

/* ----------------------------------------------------------------- start */

applyPrefs();
setPanel(P.panel);
fold($('report-wrap'), false);
updateSummary();
renderLegends(2);
fetch('/api/meta')
fetch('/api/meta').then((r) => r.json()).then((m) => { S.meta = m; }).catch(() => {});
mapReady.then(() => {
  addVectorBasemaps();
  spin();
  // Open on the turning globe, then dive to the first example.
  setTimeout(() => { if (!S.run && !drawing) $('presets').querySelector('button').click(); }, 2600);
});
