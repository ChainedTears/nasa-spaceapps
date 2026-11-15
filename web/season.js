/* Calendar: for any place, what has burned there in each month of the year,
   from NASA's MODIS burned-area maps since 2001 (MCD64A1). Laid out from this
   month forward so responders can see what the coming months usually bring.
   It is history, not a forecast. */

const C = { place: P.seasonPlace, data: null, token: 0, sel: null };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SIG_KM2 = 1;                                   // a month "had fire" if at least this much burned
const SIZES = { 1: 'Local, about 110 km across', 2: 'Regional, about 220 km across', 4: 'Wide, about 440 km across' };
const thisMonth = () => new Date().getUTCMonth();

BOX.season = () => C.place?.bbox || null;
HAS.season = () => !!C.place;
WRAPS.season[1] = () => !!C.data;
SUMMARY.season = () => (C.place ? `${esc(C.place.label)} <small>fire calendar</small>` : 'Choose a place <small>fire calendar</small>');

/* --------------------------------------------------------------- places */

function boxAround(lng, lat, size) {
  const half = size / 2, k = Math.min(1 / Math.cos((Math.abs(lat) * Math.PI) / 180), 3);
  const halfLon = Math.min(half * k, MAX_SPAN / 2);
  const s = Math.max(-89, lat - half), n = Math.min(89, lat + half);
  const w = Math.max(-180, lng - halfLon), e = Math.min(180, lng + halfLon);
  return [w, s, e, n].map((x) => +x.toFixed(4));
}
function setPlace(bbox, label, { fly = true } = {}) {
  C.place = { bbox, label };
  P.seasonPlace = C.place; store.save();
  syncAOI(); syncPanel(); updateSummary();
  if (fly) flyToArea(4200, bbox);
  loadSeason();
}
function pickPlace(lng, lat, label) {
  const bbox = boxAround(lng, lat, +P.seasonSize);
  setPlace(bbox, label || coordText(lat, lng));
  if (!label) placeName(lat, lng).then((name) => {
    if (C.place?.bbox !== bbox) return;
    C.place.label = name; store.save();
    setHead('season', { place: esc(name) }); updateSummary();
  });
}
function seasonPreset(i) {
  const p = PRESETS[i];
  setPlace(p.bbox, p.name.replace(/,? \d{4}$/, ''));
}
/* From anywhere (a live fire's popup, say): open the calendar for a point. */
function openCalendarAt(lng, lat, label) {
  if (P.tab !== 'season') setTab('season', { fly: false });
  pickPlace(lng, lat, label);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cal]');
  if (!b) return;
  const [lng, lat] = b.dataset.cal.split(',').map(Number);
  closePopup();
  openCalendarAt(lng, lat, b.dataset.calLabel || '');
});
/* In this view a click anywhere on the globe chooses that place. */
map.on('click', (e) => {
  if (P.tab !== 'season' || drawing) return;
  pickPlace(e.lngLat.lng, e.lngLat.lat);
});

/* ----------------------------------------------------------------- data */

async function loadSeason() {
  const token = ++C.token, place = C.place;
  C.data = null; C.sel = null;
  syncWraps();
  setHead('season', {
    place: esc(place.label), period: 'Fire calendar', tab: 'Calendar',
    note: 'Reading every NASA burned-area map of this place since 2001. The first look at a new place takes about half a minute.',
  });
  crossfade('season', token + '|none', empty());
  setBusy('season', true);
  try {
    const d = await getJSON(`/api/calendar?bbox=${place.bbox.join(',')}`);
    if (token !== C.token) return;
    C.data = prepareSeason(d);
    renderSeason();
  } catch (err) {
    if (token === C.token) setHead('season', { note: 'Could not load the calendar: ' + esc(err.message) });
  } finally {
    if (token === C.token) setBusy('season', false);
  }
}

const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

function prepareSeason(d) {
  const years = d.years, ys = years.map(String);
  const val = (y, m) => d.monthly[y]?.[m];
  // Per calendar month: every year that month was mapped.
  const months = MONTHS.map((_, m) => {
    const rows = ys.map((y) => [+y, val(y, m)]).filter(([, v]) => v != null);
    const vals = rows.map(([, v]) => v);
    const worst = rows.reduce((a, b) => (b[1] > a[1] ? b : a), [null, -1]);
    return {
      m, n: vals.length, mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0, median: median(vals),
      fireYears: vals.filter((v) => v >= SIG_KM2).length, worst: worst[1] > 0 ? { year: worst[0], km2: worst[1] } : null,
    };
  });
  const peakMean = Math.max(...months.map((x) => x.mean), 1e-9);

  // Weekly shape of the season, from complete years only.
  const full = ys.filter((y) => d.monthly[y].every((v) => v != null));
  const weeks = Array.from({ length: 53 }, (_, w) => {
    const vals = full.map((y) => d.weekly[y][w]);
    return { mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0, max: Math.max(0, ...vals) };
  });
  const smooth = weeks.map((_, i) => [-1, 0, 1].reduce((s, k) => s + weeks[(i + k + 53) % 53].mean, 0) / 3);
  const total = smooth.reduce((a, b) => a + b, 0);
  let season = null;
  if (total > 0) {
    // The season is the shortest run of weeks (wrapping round New Year) holding 80% of the fire.
    let best = null;
    for (let a = 0; a < 53; a++) {
      let acc = 0;
      for (let len = 1; len <= 53; len++) {
        acc += smooth[(a + len - 1) % 53];
        if (acc >= 0.8 * total) { if (!best || len < best.len) best = { a, len }; break; }
      }
    }
    const peak = smooth.indexOf(Math.max(...smooth));
    season = { start: best.a, end: (best.a + best.len - 1) % 53, len: best.len, peak };
  }

  // The coming 90 days, year by year (wrapping into the next year when needed).
  const m0 = thisMonth(), ahead = [m0, (m0 + 1) % 12, (m0 + 2) % 12];
  const next90 = [];
  for (const y of years) {
    let sum = 0, ok = true;
    ahead.forEach((m, k) => { const v = val(String(m0 + k > 11 ? y + 1 : y), m); if (v == null) ok = false; else sum += v; });
    if (ok) next90.push({ year: y, km2: sum, wraps: m0 + 2 > 11 });
  }

  // Biggest single months on record.
  const biggest = [];
  for (const y of ys) d.monthly[y].forEach((v, m) => { if (v) biggest.push({ year: +y, m, km2: v }); });
  biggest.sort((a, b) => b.km2 - a.km2);

  // Pixels, each with its month and how long ago.
  const last = years.at(-1), first = years[0], span = Math.max(last - first, 1);
  const pixels = d.pixels.map(([lat, lon, year, doy]) => {
    const dt = new Date(Date.UTC(year, 0, doy));
    return { lat, lon, year, m: dt.getUTCMonth(), age: (last - year) / span };
  });
  return { ...d, months, peakMean, weeks, smooth, season, ahead, next90, biggest: biggest.slice(0, 8), pixels, full };
}

/* ------------------------------------------------------------ dashboard */

const SEASON_STATS = [['s-typical', 'Usually burns'], ['s-chance', 'Years with fire'], ['s-worst', 'Worst on record'], ['s-peak', 'Season peak']];
registerDash('season', {
  el: $('season-report'),
  sections: [['ahead', 'The months ahead'], ['next', 'Next 90 days'], ['shape', 'Fire season'], ['grid', 'Year by month'], ['biggest', 'Biggest fire months'], ['about', 'About this calendar']],
  defaults: () => ({ grid: true, biggest: true, about: true }),
  bodies: {
    ahead: '<p class="sub" id="ahead-sub"></p><div class="months" id="months"></div><p class="sub map-key" id="season-key"></p>',
    next: statsBody(SEASON_STATS),
    shape: '<p class="sub" id="shape-sub"></p><div class="chart" id="c-shape"></div>',
    grid: '<p class="sub">Area burned each month, every year on record. Select a month to see where.</p><div class="heat" id="heat"></div>',
    biggest: '<ol id="biggest" class="rows"></ol>',
    about: `<p class="sub">Built from NASA's MODIS burned-area product (MCD64A1, 500 m), read from Microsoft Planetary Computer: every month since 2001, about two to three months behind today. It shows what has burned here before, not a forecast. Small or short fires, fires under cloud, and many crop burns can be missed. A month counts as having fire when at least ${SIG_KM2} km² burned.</p>`,
  },
  onClick: (e) => {
    const b = e.target.closest('[data-sel]');
    if (!b) return false;
    const [m, y] = b.dataset.sel.split(',').map((x) => (x === '' ? null : +x));
    const same = C.sel && C.sel.m === m && (C.sel.y ?? null) === y;
    C.sel = same ? null : { m, y };
    paintSelection();
    return true;
  },
});

const kmText = (v) => (v >= 1 ? `${big(v)} km²` : v > 0 ? '< 1 km²' : 'none');
function renderSeason() {
  const D = C.data;
  syncWraps();
  const yrs = `${D.years[0]}–${D.years.at(-1)}`;
  setHead('season', { place: esc(C.place.label), period: 'Fire calendar', note: '', tab: 'Calendar' });
  updateSummary();

  /* ---- the months ahead: twelve tiles from this month on ---- */
  const m0 = thisMonth();
  swap($('ahead-sub'), `Average area burned in each month, ${yrs}, starting this month; below it, how many of those years had at least ${SIG_KM2} km² burn.`);
  swap($('months'), Array.from({ length: 12 }, (_, k) => {
    const mo = D.months[(m0 + k) % 12], v = mo.mean / D.peakMean;
    const peak = mo.mean === D.peakMean && mo.mean > 0;
    return `<button type="button" class="mo${k === 0 ? ' now' : ''}" data-sel="${mo.m}," style="--v:${v.toFixed(3)}">
      <span class="mo-name">${MONTHS[mo.m]}${peak ? ' <i class="peak" title="Usual peak">●</i>' : ''}</span>
      <span class="mo-bar"><i></i></span>
      <span class="mo-val">${kmText(mo.mean)}</span>
      <span class="mo-odds">${mo.fireYears} of ${mo.n}</span>
    </button>`;
  }).join(''), { then: paintSelection });

  /* ---- next 90 days ---- */
  const nx = D.next90, label = D.ahead.map((m) => MONTHS[m]).join(' – ').replace(/ – .* – /, ' – ');
  if (nx.length) {
    const vals = nx.map((x) => x.km2), worst = nx.reduce((a, b) => (b.km2 > a.km2 ? b : a));
    const fireYears = nx.filter((x) => x.km2 >= SIG_KM2).length;
    swap($('v-s-typical'), `${kmText(median(vals))} <small>median for ${label}; average ${kmText(vals.reduce((a, b) => a + b, 0) / vals.length)}</small>`);
    swap($('v-s-chance'), `${fireYears} of ${nx.length} <small>had at least ${SIG_KM2} km² burn</small>`);
    swap($('v-s-worst'), worst.km2 > 0 ? `${kmText(worst.km2)} <small>in ${worst.wraps ? `${worst.year}–${String(worst.year + 1).slice(2)}` : worst.year}</small>` : '—');
  } else for (const k of ['typical', 'chance', 'worst']) swap($('v-s-' + k), '—');
  if (D.season) {
    const pk = weekDate(D.season.peak), weeksAway = (D.season.peak - Math.floor(dayOfYear() / 7) + 53) % 53;
    swap($('v-s-peak'), `${partOfMonth(pk)} <small>${weeksAway <= 1 ? 'about now' : weeksAway < 9 ? `in ${weeksAway} weeks` : `in about ${Math.round(weeksAway / 4.35)} months`}</small>`);
  } else swap($('v-s-peak'), '—');

  /* ---- fire season shape ---- */
  swap($('shape-sub'), D.season
    ? `Usually ${seasonText(D.season)}, peaking ${partOfMonth(weekDate(D.season.peak))}. Average area burned per week, ${D.full[0]}–${D.full.at(-1)}.`
    : 'Almost nothing has burned here since 2001.');
  drawShape();

  /* ---- year by month ---- */
  const top = Math.log1p(Math.max(...D.biggest.map((b) => b.km2), 1));
  swap($('heat'), `<span></span>${MONTHS.map((m) => `<span class="hx">${m[0]}</span>`).join('')}` +
    [...D.years].reverse().map((y) => `<span class="hy">${y}</span>` + MONTHS.map((_, m) => {
      const v = D.monthly[String(y)][m];
      if (v == null) return '<i class="na"></i>';
      return `<button type="button" data-sel="${m},${y}" style="--v:${(Math.log1p(v) / top).toFixed(3)}" data-tip="${MONTHS_LONG[m]} ${y}: ${kmText(v)}"></button>`;
    }).join('')).join(''), { then: paintSelection });

  /* ---- biggest months ---- */
  setList($('biggest'), D.biggest.length
    ? D.biggest.map((b) => `<button type="button" data-sel="${b.m},${b.year}"><span>${MONTHS_LONG[b.m]} ${b.year}</span><span><b>${kmText(b.km2)}</b> burned</span></button>`)
    : ['Nothing on record.']);

  paintSelection();
  mapReady.then(() => {
    const lat = (D.bbox[1] + D.bbox[3]) / 2, r = groundRadius(D.resolution, lat, 1.6);
    for (const ab of 'ab') map.setPaintProperty('season-' + ab, 'circle-radius', r);
  });
}

/* What is selected (a month, a month of one year, or the next three months)
   decides which tiles light up, the map, and the line under the tiles. */
function paintSelection() {
  const D = C.data;
  if (!D) return;
  const sel = C.sel;
  for (const b of $('season-report').querySelectorAll('[data-sel]')) {
    const [m, y] = b.dataset.sel.split(',');
    const on = sel ? +m === sel.m && (y === '' ? sel.y == null : +y === sel.y) : false;
    b.classList.toggle('sel', on);
  }
  const months = sel ? [sel.m] : D.ahead;
  const keep = (p) => months.includes(p.m) && (sel?.y == null || p.year === sel.y);
  const feats = D.pixels.filter(keep).map((p) => ({ type: 'Feature', properties: { age: p.age }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }));
  crossfade('season', `${C.token}|${months.join()}|${sel?.y ?? ''}`, { type: 'FeatureCollection', features: feats });
  const when = sel
    ? (sel.y != null ? `${MONTHS_LONG[sel.m]} ${sel.y}` : `${MONTHS_LONG[sel.m]}, ${D.years[0]}–${D.years.at(-1)}`)
    : `the next three months (${D.ahead.map((m) => MONTHS[m]).join(', ')}), ${D.years[0]}–${D.years.at(-1)}`;
  swap($('season-key'), feats.length
    ? `<i class="key-ramp"></i>On the map: where it burned in ${when}. Brighter is more recent.${sel ? ' <button class="link" type="button" data-sel-clear>Show the next three months</button>' : ''}`
    : `Nothing burned here in ${when}.${sel ? ' <button class="link" type="button" data-sel-clear>Show the next three months</button>' : ''}`);
}
$('season-report').addEventListener('click', (e) => { if (e.target.closest('[data-sel-clear]')) { C.sel = null; paintSelection(); } });
$('season-report').addEventListener('mousemove', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t.dataset.tip, e); else if (e.target.closest('.heat')) hideTip();
});
$('season-report').addEventListener('mouseleave', hideTip);

/* ---- dates of the year ---- */
const dayOfYear = () => { const n = new Date(); return Math.floor((n - Date.UTC(n.getUTCFullYear(), 0, 1)) / DAY); };
const weekDate = (w) => new Date(Date.UTC(2001, 0, 1 + w * 7 + 3));
function partOfMonth(d) {
  const day = d.getUTCDate();
  return `${day <= 10 ? 'early' : day <= 20 ? 'mid-' : 'late'}${day <= 10 || day > 20 ? ' ' : ''}${MONTHS_LONG[d.getUTCMonth()]}`;
}
function seasonText(s) {
  if (s.len >= 44) return 'spread across the whole year';
  const a = weekDate(s.start).getUTCMonth(), b = weekDate(s.end).getUTCMonth();
  return a === b ? `in ${MONTHS_LONG[a]}` : `from ${MONTHS_LONG[a]} to ${MONTHS_LONG[b]}`;
}

/* The season as one smooth shape over the year: the average week, the usual
   season shaded, and today marked. The worst year is in the tooltip. */
function drawShape() {
  const D = C.data, el = $('c-shape');
  if (!D || !el) return;
  const width = Math.max(el.clientWidth || 360, 240), height = 150, m = { l: 34, r: 8, t: 10, b: 22 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b;
  const top = niceMax(Math.max(...D.smooth, 1e-6));
  const x = (w) => m.l + (w / 52) * pw, y = (v) => m.t + ph - (Math.min(v, top) / top) * ph;
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Average area burned per week">`;
  if (D.season && D.season.len < 44) {
    const band = (a, b) => `<rect x="${x(a)}" y="${m.t}" width="${Math.max(x(b + 1) - x(a), 1)}" height="${ph}" style="fill:var(--band)"/>`;
    svg += D.season.start <= D.season.end ? band(D.season.start, D.season.end) : band(D.season.start, 52) + band(0, D.season.end);
  }
  for (const f of [0, 1]) svg += `<line class="grid" x1="${m.l}" x2="${width - m.r}" y1="${y(top * f)}" y2="${y(top * f)}"/><text x="${m.l - 6}" y="${y(top * f) + 4}" text-anchor="end">${big(top * f)}</text>`;
  MONTHS.forEach((mo, i) => { svg += `<text x="${x((i * 52) / 12 + 2.2)}" y="${height - 6}" text-anchor="middle">${mo[0]}</text>`; });
  const pts = D.smooth.map((v, w) => `${x(w).toFixed(1)},${y(v).toFixed(1)}`);
  svg += `<path class="shape" d="M${x(0)},${y(0)}L${pts.join('L')}L${x(52)},${y(0)}Z" style="fill:var(--bar);opacity:.85"/>`;
  const today = dayOfYear() / 7;
  svg += `<line x1="${x(today)}" x2="${x(today)}" y1="${m.t - 4}" y2="${m.t + ph}" style="stroke:var(--accent)" stroke-width="1.5"/><text x="${x(today) + 4}" y="${m.t + 6}" style="fill:var(--accent)">today</text>`;
  for (let w = 0; w < 53; w++) svg += `<rect class="hit" data-i="${w}" x="${x(w - 0.5)}" y="${m.t}" width="${pw / 52}" height="${ph}"/>`;
  svg += '</svg>';
  const legend = `<div class="chart-legend"><span><i style="background:var(--bar)"></i>Average week</span><span><i style="background:var(--band)"></i>Usual season</span></div>`;
  el._cfg = {
    tip: (w) => { const a = weekDate(w); return `<b>${fmtDay.format(a.getTime() - 3 * DAY)} – ${fmtDay.format(a.getTime() + 3 * DAY)}</b><br>Average ${kmText(D.weeks[w].mean)}<br>Worst year ${kmText(D.weeks[w].max)}`; },
    pick: (w) => { C.sel = { m: weekDate(w).getUTCMonth(), y: null }; paintSelection(); },
  };
  bindChart(el);
  swap(el, legend + svg);
}
RESIZE.push(() => { if (C.data) drawShape(); });

/* ----------------------------------------------------------- the sheet */

function fillSeasonSheet() {
  const items = [];
  if (S.bbox) items.push(`<button type="button" data-place="records">${esc(S.label || 'The Records area')} <small>the area open in Records</small></button>`);
  PRESETS.forEach((p, i) => items.push(`<button type="button" data-place="${i}">${esc(p.name.replace(/,? \d{4}$/, ''))}</button>`));
  $('season-places').innerHTML = items.join('');
  stagger($('season-places').children, 30);
}
SHEET_OPEN.season = fillSeasonSheet;
$('season-places').onclick = (e) => {
  const b = e.target.closest('[data-place]');
  if (!b) return;
  openPop(null);
  if (b.dataset.place === 'records') setPlace([...S.bbox], S.label || 'The Records area');
  else seasonPreset(+b.dataset.place);
};
choice('season-size', String(P.seasonSize), (v) => {
  P.seasonSize = v;
  swap($('season-size-note'), SIZES[v] + '. Applies to the next place you choose.');
});
$('season-size-note').textContent = SIZES[P.seasonSize] + '. Applies to the next place you choose.';

/* -------------------------------------------------------------- entering */

TAB_HOOKS.season = {
  enter({ fly, first }) {
    if (!C.place) {
      if (!first) banner('Click anywhere on the globe to see its fire calendar.');
      return;
    }
    if (fly) flyToArea(4200, C.place.bbox);
    if (!C.data && !BUSY.has('season')) loadSeason();
    else if (C.data) renderSeason();
  },
  ready() {
    if (C.place) flyToArea(4200, C.place.bbox);
    else banner('Click anywhere on the globe to see its fire calendar.');
  },
};
