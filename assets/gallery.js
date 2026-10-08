import { CONFIG, LIVE, fetchPage, tileHTML, plateHTML, dishTitle, dishPath } from './core.js';

const grid = document.getElementById('grid');
const moreWrap = document.getElementById('more');
const moreBtn = document.getElementById('more-btn');
const moreCount = document.getElementById('more-count');
const countEl = document.getElementById('count');
const lb = document.getElementById('lightbox');
const lbBody = document.getElementById('lb-body');
const lbClose = document.getElementById('lb-close');

const HOME_TITLE = document.title;
const state = { items: [], total: 0, loading: false, current: -1, pushed: false, opener: null };

/* ---------- grid ---------- */
function reveal(root = grid) {
  root.querySelectorAll('img:not(.is-in)').forEach((img) => {
    if (img.complete && img.naturalWidth) img.classList.add('is-in');
    else img.addEventListener('load', () => img.classList.add('is-in'), { once: true });
  });
}

function render(items, append = false) {
  const start = append ? state.items.length - items.length : 0;
  const html = items.map((d, i) => tileHTML(d, start + i)).join('');
  if (append) grid.insertAdjacentHTML('beforeend', html); else grid.innerHTML = html;
  reveal();
}

function updateChrome() {
  const left = state.total - state.items.length;
  moreWrap.hidden = left <= 0;
  moreCount.textContent = left > 0 ? `${state.items.length} / ${state.total}` : '';
  countEl.textContent = `${state.total} ${state.total === 1 ? 'plate' : 'plates'}`;
}

async function loadMore() {
  if (state.loading || state.items.length >= state.total) return false;
  state.loading = true; moreBtn.disabled = true;
  try {
    const { items, total } = await fetchPage(state.items.length, CONFIG.PAGE_SIZE);
    state.total = total;
    state.items.push(...items);
    render(items, true);
    updateChrome();
    return items.length > 0;
  } catch (e) {
    console.error(e);
    return false;
  } finally {
    state.loading = false; moreBtn.disabled = false;
  }
}

async function init() {
  // Prerendered first page (for instant paint / crawlers), then refresh from the source.
  const seed = document.getElementById('seed');
  if (seed) {
    try { Object.assign(state, JSON.parse(seed.textContent)); } catch {}
  }
  if (state.items.length && grid.children.length) {
    reveal();
  } else if (state.items.length) {
    render(state.items);
  }
  updateChrome();

  try {
    const fresh = await fetchPage(0, CONFIG.PAGE_SIZE);
    const sig = (arr) => arr.map((d) => d.id + d.thumb).join('|');
    if (sig(fresh.items) !== sig(state.items.slice(0, CONFIG.PAGE_SIZE))) {
      state.items = fresh.items;
      render(state.items);
    }
    state.total = fresh.total;
    if (LIVE) document.querySelector('.meta .note')?.remove();
    updateChrome();
  } catch (e) {
    console.error(e);
  }

  // Deep link: /?plate=slug (used by the 404 fallback for new dishes)
  const want = new URLSearchParams(location.search).get('plate');
  if (want) {
    const i = state.items.findIndex((d) => d.slug === want);
    if (i >= 0) open(i, { push: false });
  }
}

moreBtn.addEventListener('click', async () => {
  const before = state.items.length;
  await loadMore();
  const first = grid.children[before]?.querySelector('a');
  first?.focus({ preventScroll: true });
});

grid.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-slug]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const i = state.items.findIndex((d) => d.slug === a.dataset.slug);
  if (i >= 0) { state.opener = a; open(i); }
});

/* ---------- lightbox ---------- */
function preload(i) {
  const d = state.items[i];
  if (d) { const im = new Image(); im.decoding = 'async'; im.src = d.full; }
}

function show(i) {
  const d = state.items[i];
  state.current = i;
  const hasMore = state.items.length < state.total;
  lbBody.innerHTML = plateHTML(d, {
    index: i, total: state.total,
    prev: state.items[i - 1],
    next: state.items[i + 1] || (hasMore ? { slug: '__more__' } : null),
    headingTag: 'h2',
  });
  // the "__more__" sentinel: next page not loaded yet
  const nx = lbBody.querySelector('.plate-nav .next');
  if (nx && nx.dataset.slug === '__more__') nx.setAttribute('href', '#');
  const img = lbBody.querySelector('.plate-photo img');
  lbBody.classList.add('is-loading');
  const done = () => lbBody.classList.remove('is-loading');
  if (img.complete) done(); else { img.addEventListener('load', done, { once: true }); img.addEventListener('error', done, { once: true }); }
  document.title = dishTitle(d);
  preload(i + 1); preload(i - 1);
}

function open(i, { push = true } = {}) {
  const wasOpen = lb.classList.contains('is-open');
  show(i);
  const url = dishPath(state.items[i]);
  if (!wasOpen) {
    lb.hidden = false;
    requestAnimationFrame(() => lb.classList.add('is-open'));
    document.body.classList.add('lb-lock');
    lb.scrollTop = 0;
    if (push) { history.pushState({ plate: state.items[i].slug }, '', url); state.pushed = true; }
    else history.replaceState({ plate: state.items[i].slug }, '', url);
    lbClose.focus({ preventScroll: true });
  } else {
    history.replaceState({ plate: state.items[i].slug }, '', url);
  }
}

function hide() {
  lb.classList.remove('is-open');
  document.body.classList.remove('lb-lock');
  setTimeout(() => { if (!lb.classList.contains('is-open')) { lb.hidden = true; lbBody.innerHTML = ''; } }, 300);
  document.title = HOME_TITLE;
  const tile = grid.querySelector(`a[data-slug="${CSS.escape(state.items[state.current]?.slug || '')}"]`);
  (tile || state.opener)?.focus({ preventScroll: true });
  tile?.scrollIntoView({ block: 'nearest' });
  state.current = -1;
}

function close() {
  if (state.pushed) { state.pushed = false; history.back(); }
  else { history.replaceState(null, '', '/'); hide(); }
}

async function step(dir) {
  let i = state.current + dir;
  if (i < 0) return;
  if (i >= state.items.length) {
    const ok = await loadMore();
    if (!ok) return;
  }
  if (state.items[i]) { show(i); history.replaceState({ plate: state.items[i].slug }, '', dishPath(state.items[i])); lb.scrollTop = 0; }
}

lbClose.addEventListener('click', close);
lbBody.addEventListener('click', (e) => {
  const a = e.target.closest('.plate-nav a');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  step(a.classList.contains('next') ? 1 : -1);
});

window.addEventListener('popstate', (e) => {
  const slug = e.state?.plate;
  if (slug) {
    const i = state.items.findIndex((d) => d.slug === slug);
    if (i >= 0) { open(i, { push: false }); return; }
  }
  if (lb.classList.contains('is-open')) { state.pushed = false; hide(); }
});

document.addEventListener('keydown', (e) => {
  if (!lb.classList.contains('is-open')) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'Tab') {
    const f = [...lb.querySelectorAll('button, a[href]')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

// Swipe between plates on touch devices (horizontal only, on the photograph).
let tx = 0, ty = 0;
lbBody.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; tx = t.clientX; ty = t.clientY; }, { passive: true });
lbBody.addEventListener('touchend', (e) => {
  if (!e.target.closest('.plate-photo')) return;
  const t = e.changedTouches[0]; const dx = t.clientX - tx; const dy = t.clientY - ty;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
}, { passive: true });

init();
