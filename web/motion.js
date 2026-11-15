/* Motion. Every change on screen goes through one of these, so nothing pops. */

const $ = (id) => document.getElementById(id);
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2,.7,.2,1)';
const T = calm ? { fast: 120, base: 160, slow: 200 } : { fast: 200, base: 400, slow: 700 };
const CLIP = ['hidden', 'hidden'];

/* Floating things fade and settle; things in the flow fold open and shut. */
function show(el, on) { el.classList.toggle('off', !on); el.inert = !on; }
function fold(el, open) { el.classList.toggle('shut', !open); el.inert = !open; }

/* Replace an element's content: the old fades out, the new fades in, and the
   box eases to its new size. Calls made mid-change are folded into it. */
function swap(el, html, { then } = {}) {
  if (el._html === html) { if (el._out) el._then = then; else then?.(); return false; }
  const first = el._html == null && !el.firstChild;
  el._html = html; el._then = then;
  if (el._out) return true;
  const settle = () => { el.innerHTML = el._html; const f = el._then; el._then = null; f?.(); };
  if (first || el.closest('.off, .shut') || !el.getClientRects().length) {
    settle();
    el.animate({ opacity: [0, 1] }, { duration: T.base, easing: 'ease-out' });
    return true;
  }
  const a = el.getBoundingClientRect(), from = getComputedStyle(el).opacity;
  el._in?.cancel();
  el._out = el.animate({ opacity: [from, 0] }, { duration: T.fast * 0.7, easing: 'ease-in' });
  el._out.onfinish = () => {
    el._out = null; settle();
    const b = el.getBoundingClientRect();
    el._in = el.animate(
      [{ opacity: 0, transform: calm ? 'none' : 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: T.base, easing: EASE },
    );
    const size = {};
    if (Math.abs(a.width - b.width) > 1) size.width = [a.width + 'px', b.width + 'px'];
    if (Math.abs(a.height - b.height) > 1) size.height = [a.height + 'px', b.height + 'px'];
    if (!calm && (size.width || size.height)) {
      el.style.overflow = 'hidden';
      const done = () => { el.style.overflow = ''; };
      const sizing = el.animate(size, { duration: T.base, easing: EASE });
      sizing.onfinish = done; sizing.oncancel = done;
    }
  };
  return true;
}

/* Keep a list in step with `items` (HTML strings): rows that stay are left
   alone, new rows open up, rows that are gone close and are then removed. */
function setList(el, items) {
  const sig = items.join('|');
  if (el._sig === sig) return false;
  const initial = el._sig == null;
  el._sig = sig;
  const want = new Set(items);
  const have = new Map();
  for (const li of el.children) if (!li._leaving) have.set(li._key, li);
  let cursor = el.firstElementChild, fresh = 0;
  for (const html of items) {
    while (cursor && (cursor._leaving || !want.has(cursor._key))) cursor = cursor.nextElementSibling;
    let li = have.get(html);
    if (li) have.delete(html);
    else {
      li = document.createElement('li'); li._key = html; li.innerHTML = html; li._new = true;
    }
    if (li === cursor) cursor = cursor.nextElementSibling; else el.insertBefore(li, cursor);
    if (li._new) {
      li._new = false;
      const h = li.offsetHeight;
      li.animate({ height: ['0px', h + 'px'], opacity: [0, 1], overflow: CLIP },
        { duration: T.base, easing: EASE, delay: initial ? fresh++ * 45 : 0, fill: 'backwards' });
    }
  }
  for (const li of have.values()) {
    li._leaving = true; li.inert = true;
    li.animate({ height: [li.offsetHeight + 'px', '0px'], opacity: [1, 0], overflow: CLIP },
      { duration: T.base * 0.8, easing: EASE, fill: 'forwards' }).onfinish = () => li.remove();
  }
  return true;
}

/* Change the layout inside `box`; its children slide from where they were. */
function flip(box, mutate, { skip, size = false } = {}) {
  const before = new Map();
  for (const k of box.children) if (k !== skip) before.set(k, k.getBoundingClientRect());
  const h0 = box.offsetHeight;
  mutate();
  for (const k of box.children) {
    const a = before.get(k);
    if (!a || (!a.width && !a.height)) continue;
    const b = k.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      k.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: T.base, easing: EASE });
    }
  }
  const h1 = box.offsetHeight;
  if (size && h0 !== h1) box.animate({ height: [h0 + 'px', h1 + 'px'], overflow: CLIP }, { duration: T.base, easing: EASE });
}

/* Add or remove an item of a wrapping row (a chip); its neighbours make room. */
function present(el, on) {
  if (!el.hidden === on && !el._going) return;
  if (on) {
    el._going = false;
    flip(el.parentElement, () => { el.hidden = false; }, { size: true });
    el.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: T.base, easing: EASE });
  } else {
    el._going = true;
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: T.fast, easing: 'ease-in' }).onfinish = () => {
      if (!el._going) return;
      el._going = false;
      flip(el.parentElement, () => { el.hidden = true; }, { size: true });
    };
  }
}

/* A group arriving one after another. */
function stagger(els, step = 45) {
  [...els].forEach((el, i) => el.animate(
    [{ opacity: 0, transform: calm ? 'none' : 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
    { duration: T.base, easing: EASE, delay: i * step, fill: 'backwards' },
  ));
}

/* Replace content by sliding it sideways (dir: 1 forward, -1 back). */
function slide(el, html, dir) {
  el._next = html; el._dir = dir;
  if (el._sliding) return;
  if (!el.firstChild || el.closest('.off, .shut')) { el.innerHTML = html; return; }
  const dx = calm ? 0 : 14;
  el._sliding = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-el._dir * dx}px)` }], { duration: T.fast * 0.7, easing: 'ease-in' });
  el._sliding.onfinish = () => {
    el._sliding = null; el.innerHTML = el._next;
    el.animate([{ opacity: 0, transform: `translateX(${el._dir * dx}px)` }, { opacity: 1, transform: 'none' }], { duration: T.base * 0.8, easing: EASE });
  };
}
