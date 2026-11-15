/* Front end for server.py. No build step; plain browser JS.
   motion.js is loaded first (how things change); globe.js last (stars, camera, start-up). */

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
  bbox: null,                             // the area on screen in the form
  run: null,                              // {bbox, start, end} of the loaded analysis
  fires: null, baseline: null, frp: null, sev: null,
  status: {}, idx: 0, token: 0, timer: null, meta: null, label: '', events: [],
};

/* ---------------------------------------------------------------- helpers */

const fmtDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const fmtMonth = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const ms = (iso) => Date.parse(iso + 'T00:00:00Z');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const num = (x, digits = 0) => x.toLocaleString('en-US', { maximumFractionDigits: digits });
const big = (x) => (x >= 100 ? num(Math.round(x)) : x >= 10 ? num(x, 0) : num(x, 1));
const sum = (a) => a.reduce((s, x) => s + x, 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
/* The dashboard starts small; the rest waits in the "Add" tray. */
const defaultHide = () => ({ unusual: true, power: true, history: true, sources: true, 'stat:frpmax': true, 'stat:night': true, 'stat:reburn': true });

/* What the user has chosen to see; remembered between visits. Each view
   (Records, Live, Calendar) keeps its own dashboard arrangement in P.dash. */
const saved = store.load();
const P = {
  v: 3, tab: 'records', dash: {}, density: 'comfortable',
  layers: { fire: true, frp: true, sev: true }, mode: 'window', base: 'clean', panel: true,
  live: { window: '24h', dots: true, named: true }, seasonSize: '2', seasonPlace: null,
  ...(saved.v === 3 ? saved : Object.fromEntries(['layers', 'mode', 'base', 'density', 'panel'].filter((k) => saved[k] != null).map((k) => [k, saved[k]]))),
};
if (saved.v === 2 && Array.isArray(saved.order)) P.dash.records = { order: saved.order, hide: saved.hide || defaultHide(), collapsed: saved.collapsed || {} };
P.live = { window: '24h', dots: true, named: true, ...P.live };

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
/* The three views share one globe and one panel. Each says whether it has
   something to show, which area box (if any) it draws, and its header text. */
const TABS = ['records', 'live', 'season'];
const HAS = { records: () => !!S.run, live: () => true, season: () => false };
const BOX = { records: () => S.bbox, live: () => null, season: () => null };
const WRAPS = { records: ['report-wrap', () => !!S.fires?.windows.length], live: ['live-wrap', () => false], season: ['season-wrap', () => false] };
const SUMMARY = {};
const SHEET = { records: 'area', live: 'live', season: 'season' };
const TAB_HOOKS = {};
const LAYER_HOOKS = [];
const PINS = [];            // HTML markers on the globe: {el, lng, lat, tabs, near}
const HEAD = { records: {}, live: {}, season: {} };
function setHead(tab, parts) {
  Object.assign(HEAD[tab], parts);
  if (tab === P.tab) paintHead();
}
function paintHead() {
  const h = HEAD[P.tab];
  swap($('place'), h.place || '');
  swap($('period'), h.period || '');
  if (h.note) swap($('note'), h.note);
  fold($('note-wrap'), !!h.note);
  swap($('panel-tab').firstElementChild, h.tab || 'Dashboard');
}
function syncWraps() {
  for (const [tab, [id, has]] of Object.entries(WRAPS)) fold($(id), tab === P.tab && has());
  show($('timeline'), P.tab === 'records' && !!S.fires?.windows.length);
}
const BUSY = new Set();
function setBusy(key, on) {
  BUSY[on ? 'add' : 'delete'](key);
  document.body.classList.toggle('loading', BUSY.size > 0);
}
async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({ error: 'Unexpected response from the server.' }));
  if (!res.ok || body.error) throw new Error(body.error || res.statusText);
  return body;
}
/* A short place name for a point ("Cuito, Bié, Angola"), from a free reverse
   geocoder; falls back to coordinates. Only the point is sent. */
const NAMES_CACHE = new Map();
const coordText = (lat, lon) => `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? 'E' : 'W'}`;
function placeName(lat, lon) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  if (!NAMES_CACHE.has(key)) {
    NAMES_CACHE.set(key, fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&localityLanguage=en`)
      .then((r) => r.json())
      .then((d) => {
        const country = d.countryCode === 'US' ? '' : d.countryName?.replace(' of America', '').replace(/ \(the\)$/, '');
        const parts = [d.city || d.locality, d.principalSubdivision, country].filter(Boolean);
        return [...new Set(parts)].slice(0, 3).join(', ') || coordText(lat, lon);
      })
      .catch(() => coordText(lat, lon)));
  }
  return NAMES_CACHE.get(key);
}
const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

const periodText = () => `${fmtFull.format(ms(S.run.start))} – ${fmtFull.format(ms(S.run.end))}`;

/* ------------------------------------------------------------------- map */

const raster = (tiles, attribution, extra = {}) => ({ type: 'raster', tiles, tileSize: 256, attribution, ...extra });
const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const gibsTiles = (date) => [
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
];
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const empty = () => ({ type: 'FeatureCollection', features: [] });
const FADE = { duration: 600 };
const XF = 320;                           // cross-fade between two states of a data layer
const XFADE = { duration: XF };

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const dark = () => darkQuery.matches;

/* Fire and radiative power each have two identical layers, a and b. New data
   goes into the hidden one and the pair cross-fades, so points never pop. */
const fireLayer = (id) => ({ id, type: 'circle', source: id, paint: { 'circle-pitch-alignment': 'map', 'circle-opacity': 0, 'circle-opacity-transition': XFADE } });
/* Calendar: places that burned in the chosen months; recent years brightest. */
const seasonLayer = (id) => ({
  id, type: 'circle', source: id,
  paint: {
    'circle-pitch-alignment': 'map',
    'circle-color': ['interpolate', ['linear'], ['get', 'age'], 0, '#ffd27a', 0.3, '#f4782f', 0.7, '#b8361f', 1, '#6e2a22'],
    'circle-opacity': 0, 'circle-opacity-transition': XFADE,
  },
});
const frpLayer = (id) => ({
  id, type: 'circle', source: id,
  paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'],
      6, ['interpolate', ['linear'], ['sqrt', ['get', 'p']], 0, 1, 10, 2, 50, 5],
      9.5, ['interpolate', ['linear'], ['sqrt', ['get', 'p']], 0, 1.5, 10, 4, 50, 14]],
    'circle-color': ['case', ['==', ['get', 'night'], 1], COLORS.night, COLORS.day],
    'circle-opacity': 0, 'circle-opacity-transition': XFADE,
    'circle-stroke-color': ['case', ['==', ['get', 'night'], 1], COLORS.night, COLORS.day],
    'circle-stroke-width': 1,
    'circle-stroke-opacity': 0, 'circle-stroke-opacity-transition': XFADE,
  },
});

const map = new maplibregl.Map({
  container: 'map',
  center: [-150, 18],
  zoom: 0.4,
  maxPitch: 75,
  attributionControl: false,              // credited by our own "©" line, bottom left
  style: {
    version: 8,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#0b1a33', 'horizon-color': '#f2b98a', 'fog-color': '#1a1410',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.4,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5.5, 1, 8, 0.3],
    },
    light: { anchor: 'map', position: [1.5, 80, 60], intensity: 0.5 },
    sources: {
      osm: raster(['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], OSM, { maxzoom: 19 }),
      gibs: raster(gibsTiles('2021-08-05'), 'Imagery: NASA GIBS', { maxzoom: 9 }),
      dem: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 12, attribution: 'Terrain: Mapzen, AWS Open Data' },
      shade: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 12 },
      aoi: { type: 'geojson', data: empty() },
      sev: { type: 'geojson', data: empty() },
      'fire-a': { type: 'geojson', data: empty() }, 'fire-b': { type: 'geojson', data: empty() },
      'season-a': { type: 'geojson', data: empty() }, 'season-b': { type: 'geojson', data: empty() },
      'frp-a': { type: 'geojson', data: empty() }, 'frp-b': { type: 'geojson', data: empty() },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#11161f' } },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': FADE } },
      { id: 'gibs', type: 'raster', source: 'gibs', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': FADE } },
      {
        id: 'shade', type: 'hillshade', source: 'shade',
        paint: { 'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 7, 0, 10, 0.35], 'hillshade-shadow-color': '#1a130c', 'hillshade-highlight-color': '#fff6e6', 'hillshade-accent-color': '#3a2a1a' },
      },
      { id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#c2491a', 'fill-opacity': 0.05, 'fill-opacity-transition': { duration: 280 } } },
      { id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#c2491a', 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 1, 'line-opacity-transition': { duration: 280 } } },
      {
        id: 'sev', type: 'circle', source: 'sev',
        paint: {
          'circle-color': ['match', ['get', 'k'], 2, COLORS.sev[2], 3, COLORS.sev[3], 4, COLORS.sev[4], COLORS.sev[5]],
          'circle-opacity': 0, 'circle-opacity-transition': XFADE, 'circle-pitch-alignment': 'map',
        },
      },
      seasonLayer('season-a'), seasonLayer('season-b'),
      fireLayer('fire-a'), fireLayer('fire-b'),
      frpLayer('frp-a'), frpLayer('frp-b'),
    ],
  },
});
const mapReady = new Promise((ok) => map.on('load', ok));
mapReady.then(() => {
  map.setTerrain({ source: 'dem', exaggeration: 1.8 });
  setLayers();
});

/* Layers fade rather than switch: visibility is expressed as opacity. */
const LAYER_OPACITY = { fire: { 'circle-opacity': 0.9 }, frp: { 'circle-opacity': 0.15, 'circle-stroke-opacity': 0.8 }, sev: { 'circle-opacity': 0.7 }, season: { 'circle-opacity': 0.85 } };
const LAYER_TAB = { fire: 'records', frp: 'records', sev: 'records', season: 'season' };
const X = { fire: { live: 'a' }, frp: { live: 'a' }, season: { live: 'a' } };
const liveId = (kind) => (X[kind] ? `${kind}-${X[kind].live}` : kind);
function setOpacity(id, on) {
  const kind = id.split('-')[0];
  const visible = on && P.layers[kind] !== false && LAYER_TAB[kind] === P.tab;
  for (const [prop, value] of Object.entries(LAYER_OPACITY[kind])) map.setPaintProperty(id, prop, visible ? value : 0);
}
function setLayers() {
  for (const kind of Object.keys(X)) for (const ab of 'ab') setOpacity(`${kind}-${ab}`, ab === X[kind].live);
  setOpacity('sev', true);
  for (const hook of LAYER_HOOKS) hook();
}
/* Put `data` on the hidden twin of a layer, then fade the twins across.
   Changes that arrive mid-fade wait; only the latest is shown. */
function crossfade(kind, sig, data, paint = {}) {
  const x = X[kind];
  if (x.busy) { x.next = [sig, data, paint]; return; }
  if (x.sig === sig) return;
  x.sig = sig; x.busy = true;
  const from = liveId(kind);
  x.live = x.live === 'a' ? 'b' : 'a';
  const to = liveId(kind);
  map.getSource(to).setData(data);
  for (const [prop, value] of Object.entries(paint)) map.setPaintProperty(to, prop, value);
  setTimeout(() => { setOpacity(to, true); setOpacity(from, false); }, 70);   // let the new data reach the GPU
  setTimeout(() => { x.busy = false; const n = x.next; x.next = null; if (n) crossfade(kind, ...n); }, XF + 110);
}
/* Single layers fade out, change, and fade back in. */
let sevTimer;
function fadeSev(apply) {
  clearTimeout(sevTimer);
  map.setPaintProperty('sev', 'circle-opacity', 0);
  sevTimer = setTimeout(() => { apply(); sevTimer = setTimeout(() => setOpacity('sev', true), 80); }, XF + 40);
}

/* The camera lives in globe.js. Padding keeps the subject clear of the dashboard. */
const wide = () => innerWidth >= 800;
const panelW = () => (P.density === 'compact' ? 364 : 420);
function padding() {
  const open = P.panel && HAS[P.tab]();
  return wide()
    ? { top: 80, bottom: 130, left: 30, right: open ? panelW() + 34 : 30 }
    : { top: 70, bottom: open ? innerHeight * 0.46 + 90 : 110, left: 16, right: 16 };
}

/* Circle radius that tracks a ground pixel of `deg` degrees, never below minPx. */
function groundRadius(deg, lat, minPx) {
  const metres = deg * 111320;
  const z0 = Math.log2((minPx * 2 * 78271.5 * Math.cos((lat * Math.PI) / 180)) / metres);
  return ['interpolate', ['exponential', 2], ['zoom'], z0, minPx, z0 + 10, minPx * 1024];
}

/* The "Map" surface: OpenFreeMap's open vector tiles, in a light and a dark
   flavour. Both are added under our data layers and toggled with the theme. */
const vector = { light: [], dark: [] };
/* Keep the globe quiet: from far away only the largest countries are named.
   Smaller countries, then cities, then states arrive as the camera comes down. */
const LABEL_FROM = [
  [/country.*(major|_1)$/, 0], [/country.*(minor|_2)$/, 3.2], [/country/, 4.4],
  [/city/, 5.2], [/state/, 6], [/town/, 7.5], [/water_name/, 3.5],
];
function sparse(layer) {
  if (layer.type !== 'symbol') return layer;
  const rule = LABEL_FROM.find(([re]) => re.test(layer.id));
  if (!rule) return layer;
  return { ...layer, minzoom: Math.max(layer.minzoom || 0, rule[1]), layout: { ...layer.layout, 'text-padding': 18 } };
}
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
        map.addLayer({ ...sparse(layer), id, layout: { ...sparse(layer).layout, visibility: 'none' } }, 'osm');
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
  // The raster surfaces sit above the vector one and cross-fade over it.
  for (const id of ['osm', 'gibs']) {
    const on = kind === id;
    if (on) map.setLayoutProperty(id, 'visibility', 'visible');
    requestAnimationFrame(() => map.setPaintProperty(id, 'raster-opacity', on ? 1 : 0));
    if (!on) setTimeout(() => { if (basemap !== id) map.setLayoutProperty(id, 'visibility', 'none'); }, FADE.duration + 100);
  }
}
/* The light and dark vector maps cannot blend, so the globe dims while they change over. */
darkQuery.addEventListener('change', () => {
  document.body.classList.add('dip');
  setTimeout(() => { setBasemap(basemap); document.body.classList.remove('dip'); }, 280);
});
function setGibsDate() {
  if (!S.fires?.windows.length) return;
  const [a] = winRange(S.idx);
  const date = iso(Math.min(a + 3 * DAY, Date.now() - 2 * DAY));
  if (date !== S.gibsDate) { S.gibsDate = date; map.getSource('gibs').setTiles(gibsTiles(date)); }
}

/* ------------------------------------------------------- area of interest */

const aoiShape = ([w, s, e, n]) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
let aoiTimer;
function aoiOpacity(on) {
  map.setPaintProperty('aoi-line', 'line-opacity', on ? 1 : 0);
  map.setPaintProperty('aoi-fill', 'fill-opacity', on ? 0.05 : 0);
}
/* Draw the current view's area box, or fade it away when the view has none. */
function syncAOI(fade = true) {
  mapReady.then(() => {
    clearTimeout(aoiTimer);
    const box = BOX[P.tab]();
    if (!box) return aoiOpacity(false);
    const put = () => { map.getSource('aoi').setData(aoiShape(box)); aoiOpacity(true); };
    if (!fade) return put();
    aoiOpacity(false);
    aoiTimer = setTimeout(put, 300);
  });
}
function setAOI(bbox, { fade = true } = {}) {
  let [w, s, e, n] = bbox.map((x) => +x.toFixed(4));
  if (e - w > MAX_SPAN) { const c = (w + e) / 2; w = c - MAX_SPAN / 2; e = c + MAX_SPAN / 2; banner(`Areas are limited to ${MAX_SPAN}° on a side — trimmed.`); }
  if (n - s > MAX_SPAN) { const c = (s + n) / 2; s = c - MAX_SPAN / 2; n = c + MAX_SPAN / 2; banner(`Areas are limited to ${MAX_SPAN}° on a side — trimmed.`); }
  S.bbox = [w, s, e, n];
  if (P.tab === 'records') syncAOI(fade);
  markStale();
}

let drawing = null;
function setDrawMode(on) {
  $('draw').classList.toggle('on', on);
  swap($('draw').firstElementChild, on ? 'Cancel drawing' : 'Draw a new area');
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  for (const h of ['dragPan', 'boxZoom', 'touchZoomRotate', 'dragRotate']) map[h][on ? 'disable' : 'enable']();
  drawing = on ? {} : null;
  if (on) { clearTimeout(aoiTimer); aoiOpacity(true); openPop(null); banner('Drag a box on the map. Esc cancels.'); }
}
const drawStart = (e) => { if (drawing) { drawing.a = e.lngLat; e.preventDefault(); } };
const drawMove = (e) => {
  if (!drawing?.a) return;
  const { a } = drawing, b = e.lngLat;
  drawing.box = [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)];
  map.getSource('aoi').setData(aoiShape(drawing.box));
};
const drawEnd = () => {
  if (!drawing?.a) return;
  const box = drawing.box;
  setDrawMode(false);
  if (box && box[2] - box[0] > 0.02 && box[3] - box[1] > 0.02) {
    clearPreset();
    setAOI(box, { fade: false });
    setMode('area');
    updateSummary(); openPop('area');
  } else if (S.bbox) setAOI(S.bbox, { fade: false });
};
map.on('mousedown', drawStart); map.on('touchstart', drawStart);
map.on('mousemove', drawMove); map.on('touchmove', drawMove);
map.on('mouseup', drawEnd); map.on('touchend', drawEnd);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawing) { setDrawMode(false); if (S.bbox) setAOI(S.bbox, { fade: false }); } });

/* --------------------------------------------------------------- loading */

let bannerTimer;
function banner(text) {
  const el = $('banner'), span = el.firstElementChild;
  if (el.classList.contains('off')) { span.textContent = text; span._html = esc(text); } else swap(span, esc(text));
  show(el, true);
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => show(el, false), 4500);
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
  swap(li, `${SOURCE_LABELS[kind]}: ${esc(text)}`);
  setBusy('records', Object.values(S.status).some((x) => x.state === 'wait'));
  updateNote();
}
/* One quiet line under the title says what is still on its way, or missing. */
function updateNote() {
  const st = S.status;
  let text = '';
  if (!S.run) text = '';
  else if (st.fires?.state === 'err') text = 'Could not load: ' + esc(st.fires.text);
  else if (!S.fires) text = 'Reading the satellite records. Sentinel-3 can take a minute for long periods.';
  else if (!S.fires.windows.length) text = `No MODIS data for ${periodText()}. The record starts in February 2000.`;
  else {
    const kinds = ['baseline', 'radiative', 'severity'];
    const waiting = kinds.filter((k) => st[k]?.state === 'wait').map((k) => SOURCE_LABELS[k]);
    const failed = kinds.filter((k) => st[k]?.state === 'err').map((k) => `${SOURCE_LABELS[k]} (${esc(st[k].text)})`);
    text = [waiting.length ? `Still reading: ${waiting.join(', ')}.` : '', failed.length ? `Unavailable: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ');
  }
  setHead('records', { note: text });
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
  Object.assign(S, { run: { bbox: [...S.bbox], start, end }, fires: null, baseline: null, frp: null, sev: null, derived: null, idx: 0, status: {}, gibsDate: null, events: [] });
  markStale();
  syncPanel();
  setHead('records', { place: esc(S.label), period: periodText(), tab: 'Dashboard' });
  syncWraps();
  updateSummary();
  await mapReady;
  if (token !== S.token) return;
  crossfade('fire', token + '|none', empty());
  crossfade('frp', token + '|none', empty());
  fadeSev(() => map.getSource('sev').setData(empty()));
  renderLegends();

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
  let maxN = 2;
  d.windows.forEach((w, i) => {
    w.fresh = 0;
    for (const [lat, lon, c] of w.pixels) {
      const key = lat + ',' + lon;
      let p = pix.get(key);
      if (!p) { p = { lat, lon, first: i, n: 0, c: 0, key }; pix.set(key, p); w.fresh++; }
      p.n++; p.c = Math.max(p.c, c);
      if (p.n > maxN) maxN = p.n;
    }
  });
  const counts = d.windows.map((w) => w.pixels.length);
  S.fires = { ...d, pix, counts, maxN, peak: counts.indexOf(Math.max(...counts, 0)) };
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
  const last = Math.max(F.windows.length - 1, 1), maxN = F.maxN;
  const color = {
    window: ['case', ['==', ['get', 's'], 0], COLORS.past, ['match', ['get', 'c'], 7, COLORS.conf[7], 8, COLORS.conf[8], COLORS.conf[9]]],
    spread: ['interpolate', ['linear'], ['get', 'f'], 0, COLORS.spread[0], last / 2, COLORS.spread[1], last, COLORS.spread[2]],
    persist: ['interpolate', ['linear'], ['get', 'n'], 1, COLORS.persist[0], (1 + maxN) / 2, COLORS.persist[1], maxN, COLORS.persist[2]],
  }[P.mode];
  const sig = `${S.token}|${P.mode}|${P.mode === 'persist' ? '' : i}`;
  crossfade('fire', sig, { type: 'FeatureCollection', features: feats }, { 'circle-color': color });

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
  crossfade('frp', `${sig}|${S.frp?.length || 0}`, {
    type: 'FeatureCollection',
    features: [...cells.values()].sort((x, y) => x.p - y.p).map((f) => ({
      type: 'Feature', properties: { p: f.p, night: f.night, t: f.t, count: f.count }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    })),
  });
  setGibsDate();
  renderLegends();
}

function renderStaticLayers() {
  const F = S.fires;
  if (!F) return;
  const lat = (S.run.bbox[1] + S.run.bbox[3]) / 2, radius = groundRadius(F.resolution, lat, 2.2);
  if (S.radiusFor === S.token) return;
  S.radiusFor = S.token;
  for (const ab of 'ab') map.setPaintProperty('fire-' + ab, 'circle-radius', radius);
}
function renderSeverityLayer() {
  const d = S.sev;
  if (!d) return;
  const lat = (S.run.bbox[1] + S.run.bbox[3]) / 2;
  fadeSev(() => {
    map.setPaintProperty('sev', 'circle-radius', groundRadius(d.resolution, lat, 1.4));
    map.getSource('sev').setData({
      type: 'FeatureCollection',
      features: d.pixels.map(([la, lo, k, y]) => ({ type: 'Feature', properties: { k, y }, geometry: { type: 'Point', coordinates: [lo, la] } })),
    });
  });
}

/* The legend sits in the timeline, under its text, and lists only what is on the map. */
function renderLegends() {
  const dot = (c, label) => `<span class="k"><i style="background:${c}"></i>${label}</span>`;
  const ramp = (cols, a, b) => `<span class="k">${a}<i class="ramp" style="background:linear-gradient(90deg,${cols.join(',')})"></i>${b}</span>`;
  const row = (name, items) => `<div class="lg"><b>${name}</b><span>${items}</span></div>`;
  const W = S.fires?.windows || [], parts = [];
  if (P.layers.fire && W.length && S.fires.pix.size) {
    parts.push(row('Active fire', {
      window: dot(COLORS.conf[7], 'low') + dot(COLORS.conf[8], 'nominal') + dot(COLORS.conf[9], 'high') + dot(COLORS.past, 'burned earlier'),
      spread: ramp(COLORS.spread, fmtDay.format(ms(W[0].date)), fmtDay.format(ms(W[W.length - 1].date))),
      persist: ramp(COLORS.persist, '1', `${S.fires.maxN} windows`),
    }[P.mode]));
  }
  if (P.layers.frp && S.frp?.length) parts.push(row('Radiative power', dot(COLORS.day, 'day') + dot(COLORS.night, 'night')));
  if (P.layers.sev && S.sev?.pixels.length) parts.push(row('Past burn', [2, 3, 4, 5].map((k) => dot(COLORS.sev[k], SEV_NAMES[k].toLowerCase())).join('')));
  if (parts.length) swap($('legend'), parts.join(''));
  fold($('legend-wrap'), parts.length > 0);
}

let popup = null;
map.on('click', (e) => {
  if (drawing || P.tab !== 'records') return;
  const pad = 6, box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const feats = map.queryRenderedFeatures(box, { layers: ['fire', 'frp', 'sev'].filter((id) => P.layers[id]).map(liveId) });
  closePopup();
  if (!feats.length) return;
  const parts = [], W = S.fires?.windows || [];
  const of = (kind) => feats.filter((f) => f.layer.id.startsWith(kind));
  const fire = of('fire')[0];
  if (fire) {
    const p = fire.properties;
    parts.push(`<p><b>Active fire (MODIS)</b><br>First seen ${winLabel(p.f)}<br>Burning in ${p.n} of ${W.length} windows${p.c ? `<br>Confidence: ${CONF_NAMES[p.c]}` : ''}</p>`);
  }
  const frps = of('frp').sort((a, b) => b.properties.p - a.properties.p);
  if (frps.length) {
    const p = frps[0].properties;
    parts.push(`<p><b>Radiative power (Sentinel-3)</b><br>${num(p.p, 1)} MW · ${fmtTime.format(p.t)} UTC (${p.night ? 'night' : 'day'})${p.count > 1 ? `<br>Strongest of ${p.count} readings at this spot` : ''}</p>`);
  }
  const sev = of('sev')[0];
  if (sev) parts.push(`<p><b>Past burn (MTBS)</b><br>${SEV_NAMES[sev.properties.k]} severity, ${sev.properties.y}</p>`);
  popup = new maplibregl.Popup({ maxWidth: '270px', closeButton: false, closeOnClick: false }).setLngLat(e.lngLat).setHTML(parts.join('')).addTo(map);
});
function closePopup() {
  if (!popup) return;
  const old = popup; popup = null;
  old.getElement()?.classList.add('leaving');
  setTimeout(() => old.remove(), 220);
}
for (const id of ['fire-a', 'fire-b', 'frp-a', 'frp-b', 'sev']) {
  map.on('mouseenter', id, () => { if (!drawing) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', id, () => { if (!drawing) map.getCanvas().style.cursor = ''; });
}

/* -------------------------------------------------------------- timeline */

function setIndex(i) {
  const W = S.fires?.windows || [];
  if (!W.length) return;
  S.idx = Math.max(0, Math.min(W.length - 1, i));
  $('scrub').value = S.idx;
  $('scrub-box').style.setProperty('--p', W.length > 1 ? S.idx / (W.length - 1) : 0);
  const w = W[S.idx], k = S.fires.pixel_km2;
  swap($('tl-date'), winLabel(S.idx) + ' ' + w.date.slice(0, 4));
  swap($('tl-note'), w.pixels.length
    ? `${big(w.pixels.length * k)} km² burning · ${big(w.fresh * k)} km² new`
    : 'no fire detected');
  renderFireLayer();
  drawActivityChart();
}
function stopPlay() { clearInterval(S.timer); S.timer = null; swap($('play').firstElementChild, 'Play'); }
$('play').onclick = () => {
  if (S.timer) return stopPlay();
  const W = S.fires.windows;
  if (S.idx >= W.length - 1) setIndex(0);
  swap($('play').firstElementChild, 'Pause');
  S.timer = setInterval(() => { if (S.idx >= W.length - 1) stopPlay(); else setIndex(S.idx + 1); }, 900);
};
$('scrub').oninput = (e) => { stopPlay(); setIndex(+e.target.value); };
$('scrub').onpointerdown = () => $('scrub-box').classList.add('drag');
addEventListener('pointerup', () => $('scrub-box').classList.remove('drag'));

/* ---------------------------------------------------------------- charts */

const tip = $('tip');
function showTip(html, ev) {
  if (tip._html !== html) { tip._html = html; tip.innerHTML = html; }
  const hidden = tip.classList.contains('off');
  const r = tip.getBoundingClientRect();
  const x = Math.max(8, Math.min(innerWidth - r.width - 8, ev.clientX - r.width / 2)), y = Math.max(8, ev.clientY - r.height - 14);
  if (hidden) tip.style.transition = 'none';          // appear in place; glide only once visible
  tip.style.setProperty('--x', x + 'px'); tip.style.setProperty('--y', y + 'px');
  if (hidden) { void tip.offsetWidth; tip.style.transition = ''; }
  tip.classList.remove('off');
}
const hideTip = () => tip.classList.add('off');
addEventListener('scroll', hideTip, true);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/* Stacked bars with an optional reference line + range band, one y-axis.
   The drawing is rebuilt (and cross-faded) only when the data or width changes;
   picking a bar just re-tints the bars that are already there. */
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
  cfg.labels.forEach((_, i) => {
    let base = 0;
    cfg.stacks.filter((s) => s.values[i] > 0).forEach((s, j) => {
      const y0 = y(base), y1 = y(base + s.values[i]);
      base += s.values[i];
      const h = Math.max(y0 - y1 - (j ? 1.5 : 0), 0.8), x = cx(i) - bw / 2, yy = y0 - (j ? 1.5 : 0) - h;
      svg += `<rect class="b" data-i="${i}" x="${x}" y="${yy}" width="${bw}" height="${h}" rx="${Math.min(1.5, bw / 3)}" style="animation-delay:${Math.round((i / n) * 400)}ms;--c:${s.color}${s.dim ? `;--cd:${s.dim}` : ''}"/>`;
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
  el._cfg = cfg;
  bindChart(el);
  swap(el, (legend.length ? `<div class="chart-legend">${legend.join('')}</div>` : '') + svg, {
    then: () => {
      const sel = el._cfg?.sel;
      el.classList.toggle('has-sel', sel != null);
      for (const b of el.querySelectorAll('.b')) b.classList.toggle('sel', +b.dataset.i === sel);
    },
  });
}
function chartNote(el, text) { el._cfg = null; el.classList.remove('has-sel'); swap(el, `<p class="chart-empty">${text}</p>`); }
function bindChart(el) {
  if (el._bound) return;
  el._bound = true;
  const at = (ev) => { const hit = ev.target.closest?.('.hit'); return hit && el._cfg ? +hit.dataset.i : null; };
  el.addEventListener('mousemove', (ev) => { const i = at(ev); if (i == null) hideTip(); else showTip(el._cfg.tip(i), ev); });
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('click', (ev) => { const i = at(ev); if (i != null) { el._cfg.pick?.(i); showTip(el._cfg.tip(i), ev); } });
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
  updateNote();
  const F = S.fires;
  if (!F || !F.windows.length) return;
  const D = (S.derived = derive());
  syncWraps();
  $('scrub').max = F.windows.length - 1;
  renderStaticLayers();

  const waiting = (kind) => S.status[kind]?.state === 'wait';
  const hasFire = F.pix.size > 0;
  setHead('records', { tab: `Dashboard <small>${big(D.touched)} km²</small>` });

  /* ---- key numbers ---- */
  const pending = (kind) => (waiting(kind) ? '<small>loading…</small>' : '—');
  const values = {
    area: `${big(D.touched)} km² <small>${num((100 * D.touched) / D.boxKm2, 1)}% of the area</small>`,
    peak: hasFire ? `${winLabel(D.peak)} <small>${big(D.area[D.peak])} km²</small>` : '—',
    ratio: D.ratio != null ? `${big(D.ratio)}× <small>the ${D.base.years[0]}–${D.base.years.at(-1)} average</small>` : pending('baseline'),
    frpmax: D.frpMax ? `${big(D.frpMax.p)} MW <small>${fmtTime.format(D.frpMax.t)} UTC</small>` : pending('radiative'),
    night: D.nightShare != null ? `${Math.round(D.nightShare * 100)}%` : pending('radiative'),
    reburn: D.reburn != null ? `${Math.round(D.reburn * 100)}% <small>of fire pixels, burns of ${D.scarYears[0]}–${D.scarYears[1]}</small>` : pending('severity'),
  };
  for (const [key] of STATS) swap($('v-' + key), values[key]);

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
  S.events = events;
  setList($('events'), events.length
    ? events.map((ev) => `<button type="button" data-i="${ev.i}"><span>${ev.when}</span><span><b>${ev.title}.</b> ${ev.text}</span></button>`)
    : ['None.']);

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
  } else chartNote($('c2'), waiting('radiative') ? 'Loading…' : esc('Sentinel-3: ' + (S.status.radiative?.text || 'no data')));

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
  } else chartNote($('c3'), waiting('severity') ? 'Loading…' : 'No MTBS data here (United States only, 1984–2018).');
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

/* ---------------------------------------------------------------- sheets */

/* One sheet open at a time; Esc or a click elsewhere closes. The View menu and
   the sheets it leads to share one spot, under the View button. */
function openPop(name) {
  const target = name ? $('pop-' + name) : null;
  const group = target?.dataset.group || name;
  if (target && group === 'view') target.style.left = wide() ? $('view').getBoundingClientRect().left + 'px' : '';
  for (const pop of document.querySelectorAll('.pop')) show(pop, pop === target);
  for (const b of document.querySelectorAll('[data-pop]')) b.classList.toggle('on', !!name && b.dataset.pop === group);
  if (name === 'view') stagger($('pop-view').querySelectorAll('.menu button, .nav'));
  if (name !== 'area') openCal(null);
  if (name) SHEET_OPEN[name]?.();
}
const SHEET_OPEN = {};
document.querySelectorAll('[data-pop]').forEach((b) => (b.onclick = () => openPop(b.classList.contains('on') ? null : b.dataset.pop)));
document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => openPop(b.dataset.go)));
addEventListener('pointerdown', (e) => { if (!e.target.closest('.pop, [data-pop]')) openPop(null); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { openPop(null); closePopup(); } });

SUMMARY.records = () => {
  const a = $('start').value, b = $('end').value;
  return `${esc(S.label || 'Choose an area')}${S.label && a && b ? ` <small>${fmtFull.format(ms(a))} – ${fmtFull.format(ms(b))}</small>` : ''}`;
};
function updateSummary() { swap($('summary'), SUMMARY[P.tab]?.() || ''); }

/* A row of choices where one is picked. Returns a function that re-marks it. */
function choice(id, value, onPick) {
  const mark = (v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  mark(value);
  $(id).onclick = (e) => { const b = e.target.closest('button'); if (b) { mark(b.dataset.v); onPick(b.dataset.v); store.save(); } };
  return mark;
}
choice('mode', P.mode, (v) => { P.mode = v; renderFireLayer(); renderLegends(); });
choice('base', P.base, (v) => { P.base = basemap = v; setBasemap(v); });
const markDensity = choice('density', P.density, (v) => { P.density = v; applyDensity(); });
for (const id of ['fire', 'frp', 'sev']) {
  $('l-' + id).checked = P.layers[id];
  $('l-' + id).onchange = (e) => {
    P.layers[id] = e.target.checked;
    if (id === 'fire') fold($('fire-sub'), P.layers.fire);
    setLayers(); renderLegends(); store.save();
  };
}
fold($('fire-sub'), P.layers.fire);

$('draw').onclick = () => setDrawMode(!drawing);
$('run').onclick = () => { openPop(null); analyze(); flyToArea(3600); };

function pickPreset(i) {
  const p = PRESETS[i];
  clearPreset(); $('presets').children[i].classList.add('on');
  S.label = p.name;
  setDate('start', p.start); setDate('end', p.end);
  openPop(null);
  setAOI(p.bbox);
  analyze();
  flyToArea();
}
$('presets').innerHTML = PRESETS.map((p, i) => `<button type="button" data-i="${i}">${p.name}</button>`).join('');
$('presets').onclick = (e) => { const b = e.target.closest('button'); if (b) pickPreset(+b.dataset.i); };

/* ---- the period: two dates, picked from a small calendar that folds open ---- */

const cal = { field: null, y: 0, m: 0 };
function setDate(field, value) {
  $(field).value = value;
  swap($('d-' + field).lastElementChild, value ? fmtFull.format(ms(value)) : 'Choose');
}
function openCal(field) {
  cal.field = field;
  for (const f of ['start', 'end']) $('d-' + f).classList.toggle('on', f === field);
  if (field) {
    const [y, m] = ($(field).value || iso(Date.now())).split('-').map(Number);
    drawCal(y, m - 1);
  }
  fold($('cal-wrap'), !!field);
}
function drawCal(y, m) {
  const first = Date.UTC(y, m, 1), d0 = new Date(first);
  y = d0.getUTCFullYear(); m = d0.getUTCMonth();
  const dir = Math.sign(y * 12 + m - (cal.y * 12 + cal.m));
  cal.y = y; cal.m = m;
  const a = $('start').value, b = $('end').value, today = iso(Date.now());
  const cls = (v) => (v === a || v === b ? 'on' : a && b && v > a && v < b ? 'in' : '');
  const grid = $('cal-grid');
  if (!dir && grid.firstChild && !grid._sliding) {
    for (const btn of grid.querySelectorAll('button')) btn.className = cls(btn.dataset.d);
    return;
  }
  const lead = (d0.getUTCDay() + 6) % 7, days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  let html = '<i></i>'.repeat(lead);
  for (let d = 0; d < days; d++) {
    const v = iso(first + d * DAY);
    html += `<button type="button" data-d="${v}" class="${cls(v)}"${v > today ? ' disabled' : ''}>${d + 1}</button>`;
  }
  swap($('cal-title'), fmtMonth.format(first));
  slide(grid, html, dir || 1);
}
for (const f of ['start', 'end']) $('d-' + f).onclick = () => openCal(cal.field === f ? null : f);
$('cal-pm').onclick = () => drawCal(cal.y, cal.m - 1);
$('cal-nm').onclick = () => drawCal(cal.y, cal.m + 1);
$('cal-py').onclick = () => drawCal(cal.y - 1, cal.m);
$('cal-ny').onclick = () => drawCal(cal.y + 1, cal.m);
$('cal-grid').onclick = (e) => {
  const b = e.target.closest('button[data-d]');
  if (!b || !cal.field) return;
  const field = cal.field;
  setDate(field, b.dataset.d);
  const s = $('start').value, en = $('end').value;
  if (s && en && en < s) { setDate('start', en); setDate('end', s); }       // keep the pair in order
  clearPreset(); markStale(); updateSummary();
  if (field === 'start') { cal.field = 'end'; $('d-start').classList.remove('on'); $('d-end').classList.add('on'); drawCal(cal.y, cal.m); }
  else { drawCal(cal.y, cal.m); openCal(null); }
};

/* ------------------------------------------------------------- dashboard */

/* Every view has a stack of cards, built once; after that cards are folded,
   unfolded and moved, never rebuilt. In "Edit" the user arranges them in place,
   and the "Add" tray holds whatever they took away. */
const DASH = {};
const cardHTML = (id, name, body) => `<section class="fold" data-s="${id}"><div><div class="card">
    <header>
      <button class="grip" type="button" aria-label="Move ${name}: drag, or use the up and down arrow keys"><i></i></button>
      <button class="card-title" type="button"><span>${name}</span><i class="chev"></i></button>
      <button class="link card-remove" type="button">Remove</button>
    </header>
    <div class="fold card-body"><div>${body}</div></div>
  </div></div></section>`;
/* A column of headline numbers; in Edit, chips choose which are shown. */
const statsBody = (stats) => `<div class="stats">${stats.map(([k, label]) => `<div class="fold" data-stat="${k}"><div><div class="stat"><span>${label}</span><b id="v-${k}">—</b></div></div></div>`).join('')}</div>
    <div class="fold shut edit-fold" inert><div><p class="sub" style="margin-top:10px">Numbers shown</p><div class="chips">${stats.map(([k, label]) => `<button class="chipx" type="button" data-stat-toggle="${k}">${label}</button>`).join('')}</div></div></div>`;

function registerDash(tab, { el, sections, bodies, defaults, onClick }) {
  const st = (P.dash[tab] ||= { order: sections.map(([id]) => id), hide: defaults(), collapsed: {} });
  st.order = st.order.filter((id) => sections.some(([x]) => x === id));
  for (const [id] of sections) if (!st.order.includes(id)) st.order.push(id);
  st.hide ||= defaults(); st.collapsed ||= {};
  const names = Object.fromEntries(sections);
  el.innerHTML = st.order.map((id) => cardHTML(id, names[id], bodies[id])).join('');
  $('tray').insertAdjacentHTML('beforeend', sections.map(([id, name]) => `<button class="chipx" type="button" data-tab="${tab}" data-add="${id}" hidden>+ ${name}</button>`).join(''));
  const d = (DASH[tab] = { el, sections, defaults, st });

  el.addEventListener('click', (e) => {
    if (onClick?.(e)) return;
    const t = e.target, id = t.closest('[data-s]')?.dataset.s, toggle = t.closest('[data-stat-toggle]');
    if (t.closest('.card-title')) st.collapsed[id] = !st.collapsed[id];
    else if (t.closest('.card-remove')) st.hide[id] = true;
    else if (toggle) { const k = 'stat:' + toggle.dataset.statToggle; st.hide[k] = !st.hide[k]; }
    else return;
    applyDash(tab); store.save();
  });

  /* Re-ordering: drag a card by its grip. The card follows the pointer; the
     others slide out of its way. Arrow keys on the grip do the same. */
  const saveOrder = () => { st.order = [...el.children].map((x) => x.dataset.s); store.save(); };
  el.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip) return;
    e.preventDefault();
    const sec = grip.closest('[data-s]'), panel = $('panel');
    const y0 = e.clientY, top0 = sec.offsetTop, scroll0 = panel.scrollTop;
    sec.classList.add('dragging');
    let lastY = y0;
    const move = (ev) => {
      const dy = ev.clientY - y0 + panel.scrollTop - scroll0;
      const up = ev.clientY < lastY, down = ev.clientY > lastY;
      lastY = ev.clientY;
      // Trade places once the leading edge of the dragged card passes a neighbour's middle.
      const top = top0 + dy, bottom = top + sec.offsetHeight;
      const prev = cardNeighbour(sec, -1), next = cardNeighbour(sec, 1);
      if (up && prev && top < prev.offsetTop + prev.offsetHeight / 2) flip(el, () => el.insertBefore(sec, prev), { skip: sec });
      else if (down && next && bottom > next.offsetTop + next.offsetHeight / 2) flip(el, () => el.insertBefore(sec, next.nextElementSibling), { skip: sec });
      sec.style.transform = `translateY(${dy - (sec.offsetTop - top0)}px)`;
    };
    const drop = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', drop); removeEventListener('pointercancel', drop);
      const from = sec.style.transform || 'none';
      sec.style.transform = '';
      sec.classList.remove('dragging');
      sec.animate([{ transform: from }, { transform: 'none' }], { duration: T.base, easing: EASE });
      saveOrder();
    };
    // Listen on the window: moving the card in the DOM would drop a pointer capture.
    addEventListener('pointermove', move);
    addEventListener('pointerup', drop); addEventListener('pointercancel', drop);
  });
  el.addEventListener('keydown', (e) => {
    const grip = e.target.closest('.grip'), dir = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!grip || !dir) return;
    e.preventDefault();
    const sec = grip.closest('[data-s]'), other = cardNeighbour(sec, dir);
    if (!other) return;
    flip(el, () => el.insertBefore(sec, dir < 0 ? other : other.nextElementSibling));
    grip.focus(); saveOrder();
  });
  applyDash(tab);
  return d;
}
const cardShown = (el) => el && !el.classList.contains('shut');
function cardNeighbour(sec, dir) {
  let el = sec;
  do { el = dir < 0 ? el.previousElementSibling : el.nextElementSibling; } while (el && !cardShown(el));
  return el;
}
function applyDash(tab) {
  const { el, st } = DASH[tab];
  for (const sec of el.querySelectorAll(':scope > [data-s]')) {
    const id = sec.dataset.s;
    fold(sec, !st.hide[id]);
    fold(sec.querySelector('.card-body'), !st.collapsed[id]);
    sec.querySelector('.card-title').setAttribute('aria-expanded', !st.collapsed[id]);
  }
  for (const x of el.querySelectorAll('[data-stat]')) fold(x, !st.hide['stat:' + x.dataset.stat]);
  for (const b of el.querySelectorAll('[data-stat-toggle]')) b.setAttribute('aria-pressed', !st.hide['stat:' + b.dataset.statToggle]);
  syncTray();
}
function syncTray() {
  const d = DASH[P.tab];
  for (const b of $('tray').children) present(b, b.dataset.tab === P.tab && !!DASH[b.dataset.tab]?.st.hide[b.dataset.add]);
  fold($('tray-empty'), !!d && !d.sections.some(([id]) => d.st.hide[id]));
}
const applyPrefs = () => { for (const tab of Object.keys(DASH)) applyDash(tab); };

/* The Records dashboard. */
const BODIES = {
  numbers: statsBody(STATS),
  activity: '<p class="sub">Area with active fire in each 8-day window, km². Select a bar to show it on the map.</p><div class="chart" id="c1"></div>',
  periods: '<ol id="events" class="rows"></ol>',
  unusual: '<ul id="flags" class="plain"></ul>',
  power: '<p class="sub">Megawatts per day, all Sentinel-3 detections.</p><div class="chart" id="c2"></div>',
  history: '<p class="sub">Area mapped by MTBS each year, km².</p><div class="chart" id="c3"></div>',
  sources: `<ul id="sources" class="plain">${Object.keys(SOURCE_LABELS).map((k) => `<li id="src-${k}"></li>`).join('')}</ul>
    <p class="sub">MODIS MOD/MYD14A2, Sentinel-3 SLSTR FRP and MTBS, read from Microsoft Planetary Computer. Imagery by NASA GIBS; map data © OpenStreetMap contributors, tiles by OpenFreeMap.</p>
    <button id="csv" class="link" type="button">Download these records as CSV</button>`,
};
registerDash('records', {
  el: $('report'), sections: SECTIONS, bodies: BODIES, defaults: defaultHide,
  onClick: (e) => {
    if (e.target.closest('#csv')) { downloadCSV(); return true; }
    const row = e.target.closest('#events button');
    if (row) { stopPlay(); setIndex(+row.dataset.i); return true; }
    return false;
  },
});

let editing = false;
function applyDensity() {
  document.body.classList.toggle('compact', P.density === 'compact');
  mapReady.then(() => { if (!G.flying) map.easeTo({ padding: padding(), duration: 700 }); });
  setTimeout(() => { for (const f of RESIZE) f(); }, 560);      // charts re-fit the new width
}
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  swap($('edit').firstElementChild, on ? 'Done' : 'Edit');
  fold($('edit-foot'), on);
  for (const el of document.querySelectorAll('.edit-fold')) fold(el, on);
  if (on) syncTray();
}
$('edit').onclick = () => setEditing(!editing);
$('tray').onclick = (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  const d = DASH[b.dataset.tab], id = b.dataset.add;
  d.st.hide[id] = false; applyDash(b.dataset.tab); store.save();
  setTimeout(() => d.el.querySelector(`[data-s="${id}"]`).scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 520);
};
$('reset').onclick = () => {
  const d = DASH[P.tab];
  Object.assign(d.st, { order: d.sections.map(([id]) => id), hide: d.defaults(), collapsed: {} });
  P.density = 'comfortable';
  flip(d.el, () => { for (const id of d.st.order) d.el.append(d.el.querySelector(`[data-s="${id}"]`)); });
  markDensity(P.density); applyDensity(); applyDash(P.tab); store.save();
};

/* The panel shows once the view has something to show, unless the user hid it. */
function syncPanel() {
  const has = HAS[P.tab](), open = P.panel && has;
  show($('panel'), open); show($('panel-tab'), has && !P.panel);
  document.body.classList.toggle('panel-open', open);
  if (!open && editing) setEditing(false);
}
function setPanel(open) {
  P.panel = open; store.save();
  syncPanel();
  mapReady.then(() => { if (!G.flying) map.easeTo({ padding: padding(), duration: 700 }); });
}
$('panel-hide').onclick = () => setPanel(false);
$('panel-tab').onclick = () => setPanel(true);

/* ------------------------------------------------------------------ views */

/* Switch between Records, Live and Calendar. The globe stays; layers, box,
   panel, header and title chip change over to the new view. */
function markTabs() {
  const seg = $('tabs'), on = seg.querySelector(`[data-tab="${P.tab}"]`);
  for (const b of seg.querySelectorAll('button')) { b.classList.toggle('on', b === on); b.setAttribute('aria-selected', b === on); }
  const mark = seg.querySelector('.seg-mark');
  mark.style.width = on.offsetWidth + 'px';
  mark.style.transform = `translateX(${on.offsetLeft}px)`;
}
function setTab(tab, { fly = true, first = false } = {}) {
  if (!TABS.includes(tab)) tab = 'records';
  if (tab === P.tab && !first) return;
  const prev = P.tab;
  P.tab = tab; store.save();
  document.body.dataset.tab = tab;
  $('title').dataset.pop = SHEET[tab];
  markTabs();
  if (!first) {
    openPop(null); closePopup(); stopPlay();
    if (drawing) setDrawMode(false);
    if (editing) setEditing(false);
    TAB_HOOKS[prev]?.leave?.();
  }
  setLayers(); syncAOI(!first); syncWraps(); syncPanel(); paintHead(); updateSummary(); syncTray();
  if (typeof setMode === 'function') setMode(G.mode);
  TAB_HOOKS[tab]?.enter?.({ fly, first });
  if (!first) mapReady.then(() => { if (!G.flying) map.easeTo({ padding: padding(), duration: 700 }); });
}
$('tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };
TAB_HOOKS.records = { enter: ({ fly }) => { if (fly && S.bbox) flyToArea(); } };

const RESIZE = [() => { if (S.fires?.windows.length) render(); }];

let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { markTabs(); for (const f of RESIZE) f(); }, 150); });
