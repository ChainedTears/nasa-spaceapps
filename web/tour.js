/* A short guided tour for first-time visitors. It starts once, after the
   opening shot, and can be skipped at any step: Skip, ×, Esc or a click on
   the dimmed page. "Take the tour" in View replays it. Loaded after globe.js. */

const TOUR_STEPS = [
  {
    title: 'Welcome to Fire records',
    text: 'Explore satellite records of wildfires: what burned, when, and how fiercely. You can also see fires burning right now and where they could spread. This tour takes under a minute.',
  },
  {
    target: '#tabs', tab: 'records',
    title: 'Three views',
    text: '<b>Records</b> looks back at one area and period. <b>Live</b> shows every fire seen by satellite in the last days. <b>Calendar</b> shows which months usually burn in a place.',
  },
  {
    target: '#title', tab: 'records',
    title: 'Choose an area and period',
    text: 'Open this to pick a famous fire, or draw your own box on the map and choose the dates. Then select <b>Load this area</b>.',
  },
  {
    target: '#view', tab: 'records',
    title: 'Change what you see',
    text: 'Turn data layers on and off, switch the map surface (map, streets or satellite imagery), zoom, or rise back to the whole Earth.',
  },
  {
    target: '#timeline', tab: 'records', when: () => !!S.fires?.windows.length,
    title: 'Step through time',
    text: 'Press Play or drag the slider to move through the record, eight days at a time.',
  },
  {
    tab: 'records', when: () => !!S.run,
    target: () => (P.panel ? '#panel' : '#panel-tab'),
    title: 'The dashboard',
    text: 'Key numbers and charts for what is on the map. Select <b>Edit</b> to add, remove or reorder sections.',
  },
  {
    target: '#tabs [data-tab="live"]', tab: 'live',
    title: 'Fires burning now',
    text: 'Live shows NASA FIRMS detections from the last 24 hours to 7 days, plus named US incidents.',
  },
  {
    target: '#title', tab: 'live',
    title: 'Where could a fire spread?',
    text: 'With <b>Likely spread</b> on (in this menu), zoom in on a fire. The map shades the land that could carry it, from ESA WorldCover land cover: very likely, likely and possible. Water, towns and bare rock show as barriers. It ignores wind and weather and is not an official forecast.',
  },
];

const TOUR = {
  active: false, i: 0, el: null, card: null, spot: null, lastFocus: null,

  build() {
    if (this.el) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="tour off" id="tour" inert>
        <div class="tour-back" data-tour="skip"></div>
        <div class="tour-spot" id="tour-spot"></div>
        <div class="tour-card" id="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">
          <button class="tour-x" type="button" data-tour="skip" aria-label="Skip the tour">×</button>
          <p class="eyebrow" id="tour-count"></p>
          <h3 id="tour-title"></h3>
          <p class="sub" id="tour-text"></p>
          <div class="tour-acts">
            <button class="link" type="button" data-tour="skip">Skip tour</button>
            <span>
              <button class="chip tour-prev" type="button" data-tour="prev">Back</button>
              <button class="chip tour-next" type="button" data-tour="next">Next</button>
            </span>
          </div>
        </div>
      </div>`);
    this.el = $('tour'); this.card = $('tour-card'); this.spot = $('tour-spot');
    this.el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-tour]')?.dataset.tour;
      if (act === 'skip') this.end();
      else if (act === 'next') this.go(this.i + 1, 1);
      else if (act === 'prev') this.go(this.i - 1, -1);
    });
    // Capture phase: the tour's keys win over the page's own shortcuts.
    addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); this.end(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.i + 1, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.i - 1, -1); }
      else if (e.key === 'Tab') this.trapFocus(e);
    }, true);
    addEventListener('resize', () => { if (this.active) this.place(); });
  },

  maybeStart() { if (!P.tourDone) setTimeout(() => { if (!P.tourDone && !this.active) this.start(); }, 500); },

  start() {
    this.build();
    openPop(null); closePopup();
    this.active = true; this.lastFocus = document.activeElement;
    show(this.el, true);
    this.go(0, 1);
  },

  /* Move to step i, skipping steps whose target isn't on screen. */
  go(i, dir = 1) {
    while (i >= 0 && i < TOUR_STEPS.length) {
      const step = TOUR_STEPS[i];
      // A map that is still loading must not strand the tour mid-way.
      if (step.tab && P.tab !== step.tab) try { setTab(step.tab); } catch (err) { console.warn(err); }
      if ((!step.when || step.when()) && (!step.target || this.target(step))) break;
      i += dir;
    }
    if (i >= TOUR_STEPS.length) return this.end();
    if (i < 0) return;
    this.i = i;
    const step = TOUR_STEPS[i], last = i === TOUR_STEPS.length - 1;
    // Number only the steps that apply now (no loaded area: no timeline or dashboard).
    const shown = TOUR_STEPS.filter((st) => !st.when || st.when());
    $('tour-count').textContent = `${shown.indexOf(step) + 1} of ${shown.length}`;
    swap($('tour-title'), step.title);
    swap($('tour-text'), step.text, { then: () => this.place() });
    this.card.querySelector('.tour-prev').hidden = i === 0;
    swap(this.card.querySelector('.tour-next'), last ? 'Done' : i === 0 ? 'Start' : 'Next');
    // Some steps change the view; let it settle before measuring.
    setTimeout(() => this.place(), 60);
    setTimeout(() => this.place(), T.slow);
    this.card.querySelector('.tour-next').focus({ preventScroll: true });
  },

  target(step) {
    const sel = typeof step.target === 'function' ? step.target() : step.target;
    const el = sel && document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? el : null;
  },

  place() {
    if (!this.active) return;
    const step = TOUR_STEPS[this.i], el = step.target && this.target(step);
    const card = this.card, gap = 14, pad = 6, vw = innerWidth, vh = innerHeight;
    if (!el) {
      this.spot.classList.add('none');
      card.style.left = `${Math.max(16, (vw - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.max(16, (vh - card.offsetHeight) / 2)}px`;
      return;
    }
    const r = el.getBoundingClientRect();
    this.spot.classList.remove('none');
    Object.assign(this.spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    if (vw < 600) {          // phones: the card sits along the bottom edge, or the top if the target is low
      card.style.left = '16px';
      card.style.top = r.top > vh * 0.55 ? '16px' : `${vh - card.offsetHeight - 16}px`;
      return;
    }
    const w = card.offsetWidth, h = card.offsetHeight;
    let top = r.bottom + pad + gap, left = r.left + r.width / 2 - w / 2;
    if (top + h > vh - 16) top = r.top - pad - gap - h;                          // no room below: above
    if (top < 16) { top = Math.min(Math.max(16, r.top), vh - h - 16); left = r.left - pad - gap - w; if (left < 16) left = r.right + pad + gap; }  // tall target: beside it
    card.style.left = `${Math.min(Math.max(16, left), vw - w - 16)}px`;
    card.style.top = `${Math.min(Math.max(16, top), vh - h - 16)}px`;
  },

  trapFocus(e) {
    const items = [...this.card.querySelectorAll('button:not([hidden])')];
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!this.card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  },

  end() {
    if (!this.active) return;
    this.active = false;
    P.tourDone = true; store.save();
    show(this.el, false);
    this.lastFocus?.focus?.({ preventScroll: true });
    // Nothing loaded yet: show what the page is for, as the intro would have.
    if (P.tab === 'records' && !S.run && !drawing) setTimeout(() => pickPreset(0), 400);
  },
};

$('tour-replay').onclick = () => { openPop(null); TOUR.start(); };
