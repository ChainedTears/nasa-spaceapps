/* Live: every satellite fire detection worldwide in the last day to week
   (NASA FIRMS, VIIRS on NOAA-20 and NOAA-21), plus named incidents (NASA EONET).
   No area to choose: the whole globe is the subject. */

const L = { data: null, incidents: null, token: 0, timer: null, clock: null, hot: [], loadedAt: 0 };
const LIVE_WINDOWS = { '24h': ['last 24 hours', 24], '48h': ['last 48 hours', 48], '7d': ['last 7 days', 168] };
const REFRESH = 10 * 60000;

/* Likely spread: which land around the fires in view can carry them (ESA WorldCover). */
const SP = { data: null, token: 0, timer: null, box: null, state: 'off' };
const SPREAD_COLORS = { 1: '#d9480f', 2: '#f08c2e', 3: '#ffd27a', 0: '#5f7f99' };
const SPREAD_NAME = { 1: 'Very likely', 2: 'Likely', 3: 'Possible' };
const SPREAD_MIN_ZOOM = 7, SPREAD_SPAN = 1.9;

/* ------------------------------------------------------------------ map */

const HEAT_ON = ['interpolate', ['linear'], ['zoom'], 0, 0.95, 5, 0.85, 7.5, 0];
const DOT_ON = ['interpolate', ['linear'], ['zoom'], 4.2, 0, 6.5, ['interpolate', ['linear'], ['get', 'age'], 0, 0.95, 1, 0.4]];
mapReady.then(() => {
  map.addSource('live', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'live-heat', type: 'heatmap', source: 'live', maxzoom: 9,
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'p'], 0, 0.08, 20, 0.3, 200, 0.8],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.22, 3, 0.45, 6, 1.1],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 1.6, 3, 4.5, 6, 12],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)', 0.06, 'rgba(150,30,14,0.55)', 0.25, 'rgba(214,64,24,0.85)', 0.5, '#f2802f', 0.8, '#ffbf55', 1, '#ffe7b0'],
      'heatmap-opacity': 0, 'heatmap-opacity-transition': FADE,
    },
  }, 'season-a');
  map.addLayer({
    id: 'live-dot', type: 'circle', source: 'live',
    paint: {
      'circle-pitch-alignment': 'map',
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        4, ['interpolate', ['linear'], ['get', 'p'], 0, 1.2, 100, 3],
        10, ['interpolate', ['linear'], ['get', 'p'], 0, 3.5, 50, 8, 500, 15]],
      'circle-color': ['interpolate', ['linear'], ['get', 'p'], 0, '#ffd36e', 15, '#ff8a2e', 80, '#e8401c', 400, '#a10f1a'],
      'circle-blur': 0.2,
      'circle-opacity': 0, 'circle-opacity-transition': FADE,
    },
  }, 'season-a');
  map.addSource('spread', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'spread-cell', type: 'circle', source: 'spread',
    paint: {
      'circle-pitch-alignment': 'map',
      'circle-color': ['match', ['get', 'b'], 1, SPREAD_COLORS[1], 2, SPREAD_COLORS[2], 3, SPREAD_COLORS[3], SPREAD_COLORS[0]],
      'circle-opacity': 0, 'circle-opacity-transition': FADE,
    },
  }, 'live-heat');
  setLiveLayers();
});
function setLiveLayers() {
  if (!map.getLayer('live-heat')) return;
  const on = P.tab === 'live' && P.live.dots;
  map.setPaintProperty('live-heat', 'heatmap-opacity', on ? HEAT_ON : 0);
  map.setPaintProperty('live-dot', 'circle-opacity', on ? DOT_ON : 0);
  const spread = P.tab === 'live' && P.live.spread && !!SP.data;
  map.setPaintProperty('spread-cell', 'circle-opacity', spread ? ['match', ['get', 'b'], 0, 0.5, 1, 0.62, 2, 0.5, 0.38] : 0);
}
LAYER_HOOKS.push(setLiveLayers);

/* New detections fade out, change, and fade back in. */
let liveFadeTimer;
function putLive(fc) {
  clearTimeout(liveFadeTimer);
  if (!map.getLayer('live-heat')) return;
  map.setPaintProperty('live-heat', 'heatmap-opacity', 0);
  map.setPaintProperty('live-dot', 'circle-opacity', 0);
  liveFadeTimer = setTimeout(() => { map.getSource('live').setData(fc); setTimeout(setLiveLayers, 80); }, FADE.duration);
}

/* Named incidents are small rings on the globe; hidden in other views. */
let incidentPins = [];
function putIncidents(events) {
  for (const pin of incidentPins) {
    pin.el.classList.add('far');
    setTimeout(() => pin.marker.remove(), 700);
    PINS.splice(PINS.indexOf(pin), 1);
  }
  incidentPins = (P.live.named ? events : []).map((ev, i) => {
    const el = document.createElement('div');
    const size = ev.km2 ? Math.min(30, 14 + Math.log10(1 + ev.km2) * 7) : 14;
    el.className = 'incident far';
    el.innerHTML = `<button type="button" aria-label="${esc(ev.title)}" style="--s:${size.toFixed(0)}px"><i style="animation-delay:${-i * 0.37}s"></i><span>${esc(shortTitle(ev.title))}</span></button>`;
    el.firstChild.onclick = (e) => { e.stopPropagation(); incidentPopup(ev); };
    const marker = new maplibregl.Marker({ element: el, opacityWhenCovered: '0' }).setLngLat([ev.lon, ev.lat]).addTo(map);
    const pin = { el, marker, lng: ev.lon, lat: ev.lat, tabs: ['live'], near: true };
    PINS.push(pin);
    return pin;
  });
}
const shortTitle = (t) => t.replace(/^Wildfire\s+/i, '').replace(/^Prescribed Fire\s+/i, 'Prescribed: ');

/* ---------------------------------------------------------------- data */

async function loadLive({ force = false } = {}) {
  const token = ++L.token, w = P.live.window;
  setBusy('live', true);
  setHead('live', { note: `Downloading NASA FIRMS detections for the ${LIVE_WINDOWS[w][0]}…` });
  const [fires, incidents] = await Promise.allSettled([
    getJSON(`/api/live?window=${w}`),
    L.incidents && !force ? Promise.resolve(L.incidents) : getJSON('/api/incidents'),
  ]);
  if (token !== L.token) return;
  setBusy('live', false);
  if (incidents.status === 'fulfilled') L.incidents = incidents.value;
  if (fires.status === 'rejected') {
    setHead('live', { note: `Could not load live detections: ${esc(fires.reason.message)}` });
    if (L.incidents) { putIncidents(L.incidents.events); renderLive(); }
    return;
  }
  L.data = fires.value;
  L.loadedAt = Date.now();
  prepareLive();
  putIncidents(L.incidents?.events || []);
  renderLive();
}

function prepareLive() {
  const d = L.data, hours = LIVE_WINDOWS[d.window][1], now = Date.now();
  const feats = new Array(d.fires.length);
  let strongest = null, night = 0, total = 0;
  const cells = new Map();
  d.fires.forEach((r, i) => {
    const [lat, lon, p, tm, c, nt, n] = r;
    const t = d.t0 + tm * 60000;
    const age = Math.min(1, Math.max(0, (now - t) / (hours * 3600000)));
    feats[i] = { type: 'Feature', properties: { p, t, c, night: nt, n, age }, geometry: { type: 'Point', coordinates: [lon, lat] } };
    if (!strongest || p > strongest.p) strongest = { p, t, lat, lon, night: nt };
    total += n; if (nt) night += n;
    // Group into ~50 km cells to find the busiest places.
    const key = Math.round(lat / 0.5) + ',' + Math.round(lon / 0.5);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { p: 0, n: 0, lat: 0, lon: 0, w: 0, max: 0, last: 0 }));
    const wgt = Math.max(p, 0.5);
    cell.p += p; cell.n += n; cell.lat += lat * wgt; cell.lon += lon * wgt; cell.w += wgt;
    cell.max = Math.max(cell.max, p); cell.last = Math.max(cell.last, t);
  });
  L.fc = { type: 'FeatureCollection', features: feats };
  L.stats = { places: d.fires.length, total, strongest, nightShare: total ? night / total : 0 };
  L.hot = [...cells.values()].sort((a, b) => b.p - a.p).slice(0, 8)
    .map((c) => ({ ...c, lat: c.lat / c.w, lon: c.lon / c.w }));
  putLive(L.fc);
}

/* ----------------------------------------------------------- dashboard */

const LIVE_STATS = [['live-count', 'Fire detections'], ['live-strong', 'Strongest detection'], ['live-night', 'Seen at night'], ['live-named', 'Named fires (United States)']];
registerDash('live', {
  el: $('live-report'),
  sections: [['now', 'Right now'], ['spread', 'Likely spread'], ['hot', 'Hottest places'], ['named', 'Named fires'], ['when', 'When fires were seen'], ['about', 'About live data']],
  defaults: () => ({ when: true, about: true, 'stat:live-night': true }),
  bodies: {
    now: statsBody(LIVE_STATS),
    spread: `<p class="sub" id="spread-status">Turn on Likely spread in the Live menu, then zoom in on a fire.</p>
      <div class="fold shut" id="spread-more" inert><div>
        <ol id="spread-bands" class="rows spread-rows"></ol>
      </div></div>
      <p class="sub">Based on land cover only (ESA WorldCover): forest, shrub and grass carry fire, crops and wetland slow it; water, towns, rock and ice stop it. No wind, weather or terrain. Not an official forecast.</p>`,
    hot: '<p class="sub">Grouped into areas about 50 km across, by total radiative power. Select one to fly there.</p><ol id="live-hot" class="rows places"></ol>',
    named: '<p class="sub">Incidents reported in the last 30 days, from NASA EONET (mostly IRWIN, United States).</p><ol id="live-named-list" class="rows places"></ol>',
    when: '<p class="sub">Detections in each 3-hour slot, UTC. Peaks follow the satellites\' passes.</p><div class="chart" id="c-live"></div>',
    about: `<p class="sub">Fire detections are from the VIIRS instruments on NOAA-20 and NOAA-21, via NASA FIRMS, usually within three hours of the satellite pass. Each point merges the detections in a cell about ${'<span id="live-cell">1 km</span>'} across and shows its strongest reading. Clouds, smoke and thick canopy hide fires; hot industrial sites can appear as fires.</p>
      <p class="sub">Not for life-safety decisions: follow local emergency services.</p>`,
  },
  onClick: (e) => {
    const b = e.target.closest('[data-fly]');
    if (!b) return false;
    const [lng, lat, zoom] = b.dataset.fly.split(',').map(Number);
    flyToPoint(lng, lat, zoom);
    const ev = L.incidents?.events.find((x) => x.id === b.dataset.incident);
    if (ev) setTimeout(() => incidentPopup(ev), 900);
    return true;
  },
});

function renderLive() {
  syncWraps();
  const d = L.data, w = P.live.window;
  setHead('live', { place: 'Live', period: `Fires seen in the ${LIVE_WINDOWS[w][0]}`, tab: d ? `Live <small>${num(L.stats.total)}</small>` : 'Live' });
  updateLiveNote();
  updateSummary();
  if (!d) return;
  const st = L.stats, named = L.incidents?.events || [];
  swap($('v-live-count'), `${num(st.total)} <small>in ${num(st.places)} places</small>`);
  swap($('v-live-strong'), st.strongest ? `${big(st.strongest.p)} MW <small>${ago(st.strongest.t)}</small>` : '—');
  if (st.strongest) placeName(st.strongest.lat, st.strongest.lon).then((name) => {
    if (L.stats === st) swap($('v-live-strong'), `${big(st.strongest.p)} MW <small>${esc(name)}, ${ago(st.strongest.t)}</small>`);
  });
  swap($('v-live-night'), `${Math.round(st.nightShare * 100)}% <small>of detections</small>`);
  swap($('v-live-named'), L.incidents ? `${named.length} <small>updated in the last ${L.incidents.days} days</small>` : '—');
  $('live-cell').textContent = d.cell_deg >= 0.02 ? '2 km' : d.cell_deg >= 0.01 ? '1 km' : '500 m';

  // Hottest places: coordinates first, names as they arrive.
  const hotRow = (h, name) => `<button type="button" data-fly="${h.lon.toFixed(3)},${h.lat.toFixed(3)},8"><span>${esc(name)}</span><span><b>${big(h.p)} MW</b> total · ${num(h.n)} detections · strongest ${big(h.max)} MW</span></button>`;
  const hot = L.hot;
  setList($('live-hot'), hot.length ? hot.map((h) => hotRow(h, coordText(h.lat, h.lon))) : ['No fires detected.']);
  Promise.all(hot.map((h) => placeName(h.lat, h.lon))).then((names) => {
    if (L.hot === hot) setList($('live-hot'), hot.map((h, i) => hotRow(h, names[i])));
  });

  setList($('live-named-list'), named.length
    ? [...named].sort((a, b) => (b.km2 || 0) - (a.km2 || 0)).slice(0, 12).map((ev) => `<button type="button" data-fly="${ev.lon},${ev.lat},10" data-incident="${ev.id}"><span>${ev.km2 ? `${big(ev.km2)} km²` : 'size not given'}</span><span><b>${esc(shortTitle(ev.title))}</b> · ${ago(Date.parse(ev.date))}</span></button>`)
    : [L.incidents ? 'None reported in the last 30 days.' : 'Could not reach NASA EONET.']);

  drawLiveChart();
}
function drawLiveChart() {
  const d = L.data;
  if (!d || !$('c-live')) return;
  const slot = 3 * 3600000, hours = LIVE_WINDOWS[d.window][1];
  const end = Math.ceil(Date.now() / slot) * slot, start = end - hours * 3600000, n = hours / 3;
  const day = new Array(n).fill(0), nightA = new Array(n).fill(0);
  for (const f of L.fc.features) {
    const i = Math.floor((f.properties.t - start) / slot);
    if (i >= 0 && i < n) (f.properties.night ? nightA : day)[i] += f.properties.n;
  }
  const fmtSlot = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', timeZone: 'UTC' });
  barChart($('c-live'), {
    title: 'Detections per 3 hours',
    labels: day.map((_, i) => fmtSlot.format(start + i * slot).replace(',', '')),
    stacks: [{ name: 'Day', color: 'var(--day)', values: day }, { name: 'Night', color: 'var(--night)', values: nightA }],
    tip: (i) => `<b>${fmtSlot.format(start + i * slot)}:00 UTC</b><br>Day: ${num(day[i])}<br>Night: ${num(nightA[i])}`,
  });
}
function updateLiveNote() {
  const d = L.data;
  if (!d) return;
  const t = Date.parse(d.updated);
  setHead('live', { note: `Updated ${ago(t)} · ${d.satellites.join(' and ')} · <button class="link" type="button" data-live-refresh>Refresh</button>` });
}
SUMMARY.live = () => (L.data
  ? `Live <small>${LIVE_WINDOWS[P.live.window][0]} · ${num(L.stats.total)} detections</small>`
  : `Live <small>${LIVE_WINDOWS[P.live.window][0]}</small>`);
WRAPS.live[1] = () => !!L.data;
RESIZE.push(() => { if (P.tab === 'live') drawLiveChart(); });

/* --------------------------------------------------------------- popups */

function popupAt(lngLat, html) {
  closePopup();
  popup = new maplibregl.Popup({ maxWidth: '290px', closeButton: false, closeOnClick: false }).setLngLat(lngLat).setHTML(html).addTo(map);
}
const calendarLink = (lng, lat, label = '') => `<p><button class="link" type="button" data-cal="${lng},${lat}" data-cal-label="${esc(label)}">Fire calendar for this place</button></p>`;
function incidentPopup(ev) {
  const src = ev.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.id)}</a>`).join(', ');
  popupAt([ev.lon, ev.lat], `<p><b>${esc(ev.title)}</b><br>${ev.km2 ? `${big(ev.km2)} km² (${num(ev.km2 / 0.0040468564)} acres)<br>` : ''}Reported ${fmtFull.format(Date.parse(ev.first))} · updated ${ago(Date.parse(ev.date))}${src ? `<br>Source: ${src}` : ''}</p>${calendarLink(ev.lon, ev.lat, shortTitle(ev.title))}`);
}
map.on('click', (e) => {
  if (P.tab !== 'live' || drawing || !map.getLayer('live-dot') || map.getZoom() < 4.5) return;
  const pad = 6, box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const f = map.queryRenderedFeatures(box, { layers: ['live-dot'] }).sort((a, b) => b.properties.p - a.properties.p)[0];
  if (!f) return spreadPopup(e) || closePopup();
  const p = f.properties, [lng, lat] = f.geometry.coordinates;
  popupAt([lng, lat], `<p><b>Satellite fire detection</b><br>${num(p.p, 1)} MW at ${fmtTime.format(p.t)} UTC (${ago(p.t)}, ${p.night ? 'night' : 'day'})${p.n > 1 ? `<br>Strongest of ${p.n} detections here` : ''}<br>Confidence: ${['low', 'nominal', 'high'][p.c]}</p>${calendarLink(lng, lat)}`);
});
map.on('mouseenter', 'live-dot', () => { if (P.tab === 'live' && map.getZoom() >= 4.5) map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'live-dot', () => { if (P.tab === 'live') map.getCanvas().style.cursor = ''; });

/* ----------------------------------------------------------- the sheet */

const markWindow = choice('live-window', P.live.window, (v) => { P.live.window = v; loadLive(); });
for (const k of ['dots', 'named', 'spread']) {
  $('lv-' + k).checked = !!P.live[k];
  $('lv-' + k).onchange = (e) => {
    P.live[k] = e.target.checked; store.save();
    if (k === 'dots') setLiveLayers();
    else if (k === 'spread') { SP.box = null; SP.state = 'off'; updateSpread(); }
    else putIncidents(L.incidents?.events || []);
  };
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-live-refresh]')) loadLive({ force: true });
});

/* -------------------------------------------------------------- entering */

TAB_HOOKS.live = {
  enter({ fly }) {
    // Live is about the whole planet: rise to the globe unless already looking at it.
    if (fly && G.mode === 'area') flyToEarth();
    if (!L.data || Date.now() - L.loadedAt > REFRESH) loadLive();
    else renderLive();
    clearInterval(L.timer); clearInterval(L.clock);
    L.timer = setInterval(() => loadLive(), REFRESH);
    L.clock = setInterval(updateLiveNote, 60000);
    updateSpread();
  },
  leave() { clearInterval(L.timer); clearInterval(L.clock); clearTimeout(SP.timer); },
};

/* --------------------------------------------------------- likely spread */

const spreadKm = (x) => (x >= 100 ? `${num(Math.round(x))} km²` : `${num(x, 1)} km²`);

function viewBox() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => +x.toFixed(3));
}
const inside = (a, b) => b && a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

function setSpreadStatus(text, more = false) {
  if ($('spread-status')) swap($('spread-status'), text);
  if ($('spread-more')) fold($('spread-more'), more);
}

/* Called whenever the view settles: load spread for the fires in view, if zoomed in enough. */
function updateSpread() {
  clearTimeout(SP.timer);
  if (P.tab !== 'live') return;
  if (!P.live.spread) {
    SP.token++; SP.data = null; SP.box = null; setLiveLayers();
    setSpreadStatus('Turn on Likely spread in the Live menu, then zoom in on a fire.');
    return;
  }
  const box = viewBox(), span = Math.max(box[2] - box[0], box[3] - box[1]);
  if (map.getZoom() < SPREAD_MIN_ZOOM || span > SPREAD_SPAN) {
    SP.token++;
    if (SP.data) { SP.data = null; SP.box = null; setLiveLayers(); }
    setSpreadStatus('Zoom in on a fire to see where it could spread.');
    if (SP.state !== 'hint') { SP.state = 'hint'; banner('Zoom in on a fire to see where it could spread.'); }
    return;
  }
  if (SP.data && inside(box, SP.box)) return;
  SP.timer = setTimeout(() => loadSpread(box), 450);
}

async function loadSpread(box) {
  const token = ++SP.token;
  SP.state = 'loading';
  setBusy('spread', true);
  setSpreadStatus('Reading land cover around the fires in view…', !!SP.data);
  let d;
  try { d = await getJSON(`/api/spread?bbox=${box.join(',')}`); } catch (err) {
    if (token !== SP.token) return;
    setBusy('spread', false); SP.state = 'error';
    setSpreadStatus(`Could not work out likely spread: ${esc(err.message)}`);
    return;
  }
  setBusy('spread', false);
  if (token !== SP.token) return;
  SP.state = 'shown'; SP.data = d; SP.box = d.bbox;
  map.getSource('spread').setData({
    type: 'FeatureCollection',
    features: d.cells.map(([lat, lon, b, k, km]) => ({ type: 'Feature', properties: { b, k, km }, geometry: { type: 'Point', coordinates: [lon, lat] } })),
  });
  if (d.resolution) map.setPaintProperty('spread-cell', 'circle-radius', groundRadius(d.resolution, (d.bbox[1] + d.bbox[3]) / 2, 1.2));
  setLiveLayers();
  renderSpread();
}

function renderSpread() {
  const d = SP.data;
  if (!d) return;
  if (!d.fires) { setSpreadStatus('No fires detected in view in the last 48 hours.'); return; }
  const main = (fuel) => Object.entries(fuel || {}).filter(([k]) => d.classes[k]).sort((a, b) => b[1] - a[1])[0];
  const row = (color, name, value, text) => `<button type="button" tabindex="-1"><span><i class="swatch" style="background:${color}"></i>${name}</span><span><b>${value}</b> ${text}</span></button>`;
  const rows = d.bands.map((b) => {
    const top = main(b.fuel);
    return row(SPREAD_COLORS[b.band], b.name, spreadKm(b.km2), `of burnable land, ~${b.km} km of fuel from a fire${top ? ` · mostly ${esc(d.classes[top[0]].toLowerCase())}` : ''}`);
  });
  const bar = main(d.barrier_fuel);
  rows.push(row(SPREAD_COLORS[0], 'Barriers', spreadKm(d.barrier_km2), `of unburnable land at the edge${bar ? ` · mostly ${esc(d.classes[bar[0]].toLowerCase())}` : ''}`));
  setList($('spread-bands'), rows);
  setSpreadStatus(`${num(d.fires)} fire detection${d.fires === 1 ? '' : 's'} in view in the last 48 hours.${d.sampled ? ' Thinned for drawing.' : ''}`, true);
}

function spreadPopup(e) {
  if (!P.live.spread || !SP.data || !map.getLayer('spread-cell')) return false;
  const pad = 3, box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const f = map.queryRenderedFeatures(box, { layers: ['spread-cell'] })[0];
  if (!f) return false;
  const p = f.properties, land = SP.data.classes[p.k] || 'Unknown land';
  popupAt(e.lngLat, p.b
    ? `<p><b>${SPREAD_NAME[p.b]} spread</b><br>${esc(land)} · ~${num(p.km, 1)} km of fuel from the nearest fire</p><p class="sub">Land cover only; no wind or weather.</p>`
    : `<p><b>Natural barrier</b><br>${esc(land)} · fire is unlikely to cross here</p>`);
  return true;
}

map.on('moveend', () => { if (P.tab === 'live') updateSpread(); });
