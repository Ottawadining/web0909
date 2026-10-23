// Ottawa Plated — the world.
// A drag-to-explore field of plates (three.js). Tap a plate to bring it to the centre;
// hold it to reveal the dish and restaurant. The Index view is the plain, crawlable collection.
import * as THREE from 'three';
import { fetchAll, esc, pad, linkLabel, fmtDate, dishPath, altText, cropAttrs, dishTitle, tileHTML } from './core.js';

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const canvas = $('world');
const loaderEl = $('loader');
const pctEl = $('ld-pct');
const enterBtn = $('enter');
const grid = $('grid');
const countEl = $('count');
const indexEl = $('index');
const indexBtn = $('index-btn');
const indexClose = $('index-close');
const cursor = $('cursor');
const curLabel = cursor.querySelector('.cur-label');
const curProg = cursor.querySelector('.cur-prog');
const hint = $('hint');
const rv = $('reveal');
const rvBody = $('rv-body');
const rvClose = $('rv-close');

const HOME_TITLE = document.title;
const HOLD_MS = 650;
const RING = 2 * Math.PI * 26;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
};

let items = [];
try { items = JSON.parse($('seed').textContent).items || []; } catch {}

const mod = (n, m) => ((n % m) + m) % m;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 4);
function hash(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/* ---------- collection (Index view) ---------- */
function renderIndex() {
  grid.innerHTML = items.map(tileHTML).join('');
  countEl.textContent = `${items.length} ${items.length === 1 ? 'plate' : 'plates'}`;
}

function setIndex(open) {
  if (root.classList.contains('is-static')) open = true;
  root.classList.toggle('is-index', open);
  indexBtn.setAttribute('aria-expanded', String(open));
  if (open) { indexEl.focus({ preventScroll: true }); world?.pause(); }
  else world?.resume();
}

indexBtn.addEventListener('click', () => setIndex(!root.classList.contains('is-index')));
indexClose.addEventListener('click', () => setIndex(false));
grid.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-slug]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const i = items.findIndex((d) => d.slug === a.dataset.slug);
  if (i < 0) return;
  e.preventDefault();
  const r = a.getBoundingClientRect();
  openPlate(i, { from: { x: r.left, y: r.top, w: r.width } });
});

/* ---------- the world ---------- */
const VS = /* glsl */`
uniform float uSpeed;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  p.z -= sin(uv.x * 3.14159) * sin(uv.y * 3.14159) * uSpeed * 0.16;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FS = /* glsl */`
uniform sampler2D uMap;
uniform vec4 uCrop;
uniform float uHas;
uniform float uBright;
uniform float uFog;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uMap, uCrop.xy + vUv * uCrop.zw).rgb;
  c = mix(vec3(0.082, 0.075, 0.059), c, uHas) * uBright;
  c = mix(c, vec3(0.043, 0.039, 0.031), uFog);
  gl_FragColor = vec4(c, 1.0);
}`;

function createWorld() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
  const geo = new THREE.PlaneGeometry(1, 1, 12, 12);
  const blank = new THREE.DataTexture(new Uint8Array([21, 19, 15, 255]), 1, 1);
  blank.needsUpdate = true;
  const texLoader = new THREE.TextureLoader();
  texLoader.setCrossOrigin('anonymous');
  const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const textures = new Map();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let W = 0, H = 0, D = 1, S = 200, CELL = 320, COLS = 0, ROWS = 0, K = 0, R = 1;
  let slots = [], meshes = [];
  const off = { x: 0, y: 0 }, target = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
  let speed = 0, introAt = -1, last = performance.now(), raf = 0, paused = false;
  let hovered = null, onTexture = () => {};

  function texFor(d) {
    let e = textures.get(d.id);
    if (e) return e;
    e = { t: null, crop: new THREE.Vector4(0, 0, 1, 1), done: false };
    textures.set(d.id, e);
    // Uncropped originals carry their square crop; load the original so the crop maps exactly.
    const src = d.crop ? d.full : (d.thumb || d.full);
    texLoader.load(src, (t) => {
      const im = t.image, iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
      if (d.crop) { const { x, y, size, w, h } = d.crop; e.crop.set(x / w, 1 - (y + size) / h, size / w, size / h); }
      else { const s = Math.min(iw, ih); e.crop.set((iw - s) / 2 / iw, (ih - s) / 2 / ih, s / iw, s / ih); }
      t.anisotropy = maxAniso;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      e.t = t; e.done = true; onTexture();
    }, undefined, () => { e.done = true; onTexture(); });
    return e;
  }

  function makeSlot() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: blank }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
        uHas: { value: 0 }, uBright: { value: .9 }, uFog: { value: 0 }, uSpeed: { value: 0 },
      },
      vertexShader: VS, fragmentShader: FS,
    });
    const m = new THREE.Mesh(geo, mat);
    scene.add(m);
    const s = { m, a: 0, b: 0, cx: NaN, cy: NaN, dish: -1, tex: null, jx: 0, jy: 0, size: S, delay: 0, has: 0, bright: .9, lift: 0, px: 0, py: 0, rect: null };
    m.userData.slot = s;
    return s;
  }

  function layout() {
    W = innerWidth; H = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    D = (H / 2) / Math.tan(THREE.MathUtils.degToRad(15)); // 1 world unit = 1 CSS px at z = 0
    camera.position.set(0, 0, D);
    camera.far = D * 4;
    camera.updateProjectionMatrix();
    S = clamp(Math.min(W, H) * .34, 120, 330);
    CELL = S * (W < 700 ? 1.55 : 1.62);
    R = Math.hypot(W, H) / 2;
    K = .16 * D / (R * R); // dome: edges sink 16% of the camera distance
    COLS = Math.ceil(W * 1.4 / CELL) + 2;
    ROWS = Math.ceil(H * 1.4 / CELL) + 2;
    const need = COLS * ROWS;
    while (slots.length < need) slots.push(makeSlot());
    while (slots.length > need) { const s = slots.pop(); scene.remove(s.m); s.m.material.dispose(); }
    slots.forEach((s, i) => { s.a = i % COLS; s.b = Math.floor(i / COLS); s.cx = NaN; });
    meshes = slots.map((s) => s.m);
  }

  function assign(s, cx, cy) {
    s.cx = cx; s.cy = cy;
    const n = items.length;
    if (!n) { s.dish = -1; s.m.visible = false; return; }
    s.m.visible = true;
    s.dish = mod(cx * 3 + cy * 5, n); // neighbours never repeat for n >= 9
    s.jx = (hash(cx, cy, 1) - .5) * CELL * .24;
    s.jy = (hash(cx, cy, 2) - .5) * CELL * .24;
    s.size = S * (.78 + hash(cx, cy, 3) * .4);
    s.tex = texFor(items[s.dish]);
    s.has = s.tex.t ? 1 : 0;
    const u = s.m.material.uniforms;
    u.uMap.value = s.tex.t || blank;
    u.uCrop.value.copy(s.tex.crop);
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000, .05); last = now;
    const k = 1 - Math.exp(-dt * 6.5);
    const px0 = off.x, py0 = off.y;
    off.x += (target.x - off.x) * k;
    off.y += (target.y - off.y) * k;
    const f60 = dt > 0 ? 1 / (dt * 60) : 1;
    vel.x = (off.x - px0) * f60; vel.y = (off.y - py0) * f60;
    speed += (Math.min(Math.hypot(vel.x, vel.y) / 40, 1) - speed) * .12;
    const GW = COLS * CELL, GH = ROWS * CELL;
    const t = introAt < 0 ? -1 : (now - introAt) / 1000;
    const hold = input.holdSlot;
    const holdP = hold ? clamp((now - input.holdAt) / HOLD_MS, 0, 1) : 0;

    for (const s of slots) {
      const sx = mod(s.a * CELL + off.x + GW / 2, GW) - GW / 2;
      const syBase = mod(s.b * CELL + off.y + GH / 2, GH) - GH / 2;
      const cx = Math.round((sx - off.x) / CELL), cy = Math.round((syBase - off.y) / CELL);
      if (cx !== s.cx || cy !== s.cy || s.dish < 0) assign(s, cx, cy);
      if (s.dish < 0) continue;
      const u = s.m.material.uniforms;
      if (!s.has && s.tex.t) { u.uMap.value = s.tex.t; u.uCrop.value.copy(s.tex.crop); }
      s.has += ((s.tex.t ? 1 : 0) - s.has) * .08;

      const x = sx + s.jx;
      const y = syBase + s.jy + (mod(cx, 2) ? CELL * .5 : 0);
      s.px = x; s.py = y;
      const z = -K * (x * x + y * y);
      const r = Math.hypot(x, y) / R;
      const intro = t < 0 ? 0 : easeOut((t - r * .55) / 1.1);
      const lifted = s === hovered || s === hold;
      s.lift += ((s === hold ? .06 + holdP * .1 : lifted ? .05 : 0) - s.lift) * .15;
      const sc = s.size * (.35 + .65 * intro) * (1 + s.lift);
      s.m.position.set(x, -y, z - (1 - intro) * D * .5 + s.lift * 60);
      s.m.rotation.set(Math.atan(K * y) + vel.y * .002, Math.atan(K * x) - vel.x * .002, 0); // half the dome's slope: plates lean, not fall over
      s.m.scale.set(sc, sc, sc);
      const want = hold ? (s === hold ? 1.08 : .35 + .5 * (1 - holdP)) : hovered ? (s === hovered ? 1.06 : .55) : .9;
      s.bright += (want - s.bright) * .12;
      u.uBright.value = s.bright * intro;
      u.uHas.value = s.has;
      u.uFog.value = smooth(.55, 1.25, r) * .92;
      u.uSpeed.value = speed;
      const pf = D / (D - s.m.position.z);
      s.rect = { x: W / 2 + x * pf - sc * pf / 2, y: H / 2 + y * pf - sc * pf / 2, w: sc * pf };
    }

    renderer.render(scene, camera);
    input.tick(now, holdP);
    if (!paused) raf = requestAnimationFrame(frame);
  }

  function pick(clientX, clientY) {
    ndc.set(clientX / W * 2 - 1, -(clientY / H) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit && hit.object.userData.slot.dish >= 0 ? hit.object.userData.slot : null;
  }

  layout();
  return {
    pick, texFor,
    set onTexture(fn) { onTexture = fn; },
    setHover(s) { hovered = s; },
    nudge(dx, dy) { target.x += dx; target.y += dy; },
    center(s) { target.x -= s.px; target.y -= s.py; },
    intro() { introAt = performance.now(); },
    refresh() { slots.forEach((s) => { s.cx = NaN; }); },
    resize() { layout(); },
    pause() { paused = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    resume() { if (!paused && raf) return; paused = false; last = performance.now(); if (!raf) raf = requestAnimationFrame(frame); },
    start() { paused = false; last = performance.now(); raf = requestAnimationFrame(frame); },
    cell: () => CELL,
  };
}

/* ---------- input: drag, wheel, tap-to-centre, hold-to-reveal ---------- */
const input = {
  holdSlot: null, holdAt: 0, down: false, id: null, sx: 0, sy: 0, lx: 0, ly: 0, lt: 0, vx: 0, vy: 0, moved: 0,
  cx: innerWidth / 2, cy: innerHeight / 2, rx: innerWidth / 2, ry: innerHeight / 2,
  tick(now, p) {
    // eased cursor follow
    this.rx += (this.cx - this.rx) * .25; this.ry += (this.cy - this.ry) * .25;
    cursor.style.transform = `translate3d(${this.rx}px, ${this.ry}px, 0)`;
    curProg.style.strokeDashoffset = String(RING * (1 - p));
    if (this.holdSlot && p >= 1) {
      const s = this.holdSlot;
      this.cancelHold();
      const r = s.rect;
      openPlate(s.dish, { from: r });
    }
  },
  cancelHold() {
    this.holdSlot = null;
    cursor.classList.toggle('is-on', fine);
    curProg.style.strokeDashoffset = String(RING);
  },
};

function bindInput() {
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    Object.assign(input, { down: true, id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, lt: performance.now(), vx: 0, vy: 0, moved: 0 });
    input.cx = input.rx = e.clientX; input.cy = input.ry = e.clientY;
    root.classList.add('is-dragging');
    const s = world.pick(e.clientX, e.clientY);
    if (s) { input.holdSlot = s; input.holdAt = performance.now(); cursor.classList.add('is-on', 'is-plate'); curLabel.textContent = 'Hold'; }
  });
  canvas.addEventListener('pointermove', (e) => {
    input.cx = e.clientX; input.cy = e.clientY;
    if (!input.down || e.pointerId !== input.id) {
      if (fine && !input.down) {
        const s = world.pick(e.clientX, e.clientY);
        world.setHover(s);
        cursor.classList.add('is-on');
        cursor.classList.toggle('is-plate', !!s);
        curLabel.textContent = s ? 'Hold' : 'Drag';
      }
      return;
    }
    const now = performance.now(), dx = e.clientX - input.lx, dy = e.clientY - input.ly, dt = Math.max(now - input.lt, 1);
    input.vx = input.vx * .6 + (dx / dt) * .4; input.vy = input.vy * .6 + (dy / dt) * .4;
    input.lx = e.clientX; input.ly = e.clientY; input.lt = now;
    input.moved += Math.abs(dx) + Math.abs(dy);
    world.nudge(dx, dy);
    if (input.holdSlot && input.moved > 8) { input.cancelHold(); world.setHover(null); curLabel.textContent = 'Drag'; cursor.classList.remove('is-plate'); }
  });
  const up = (e) => {
    if (!input.down || e.pointerId !== input.id) return;
    input.down = false;
    root.classList.remove('is-dragging');
    if (input.moved > 8) world.nudge(input.vx * 160, input.vy * 160); // flick
    else if (input.holdSlot) { // a tap: bring the plate to the centre and prompt the hold
      world.center(input.holdSlot);
      flashHint();
    }
    input.cancelHold();
    if (!fine) cursor.classList.remove('is-plate');
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (!input.down) { world.setHover(null); cursor.classList.remove('is-on'); } });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const m = e.deltaMode === 1 ? 32 : 1;
    world.nudge(-(e.shiftKey ? e.deltaY : e.deltaX) * m, -(e.shiftKey ? 0 : e.deltaY) * m);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (!root.classList.contains('is-entered') || root.classList.contains('is-index') || !rv.hidden) return;
    const c = world.cell(), map = { ArrowLeft: [c, 0], ArrowRight: [-c, 0], ArrowUp: [0, c], ArrowDown: [0, -c] };
    if (map[e.key]) { e.preventDefault(); world.nudge(...map[e.key]); }
  });
  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => world.resize(), 120); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) world.pause();
    else if (rv.hidden && !root.classList.contains('is-index')) world.resume();
  });
}

let hintT = 0;
function flashHint() {
  hint.classList.add('is-flash');
  hint.innerHTML = fine ? 'Hold to reveal' : 'Press and hold the plate';
  clearTimeout(hintT);
  hintT = setTimeout(() => { hint.classList.remove('is-flash'); hint.innerHTML = '<span class="long">Drag to explore <i>·</i> </span>Hold to reveal'; }, 1800);
}

/* ---------- the revealed plate ---------- */
const rvState = { i: -1, pushed: false };

function plateMarkup(d, i) {
  const n = items.length, prev = items[i - 1], next = items[i + 1];
  const link = d.link ? `<div><dt>Website</dt><dd><a href="${esc(d.link)}" rel="noopener" target="_blank">${esc(linkLabel(d.link))} ↗</a></dd></div>` : '';
  const nav = (p, cls, label) => p
    ? `<a class="${cls}" href="${dishPath(p)}" data-slug="${esc(p.slug)}">${label}</a>`
    : `<span class="${cls} is-off">${label}</span>`;
  return `<div class="rv-grid">
    <figure class="rv-photo"><div class="rv-frame"><img src="${esc(d.full)}"${cropAttrs(d)} alt="${esc(altText(d))}" decoding="async"></div></figure>
    <div class="rv-label">
      <p class="rv-no mono" style="--i:0">No. ${pad(d.no)} <span>/ ${pad(n)}</span></p>
      <h2 class="rv-dish" style="--i:1">${esc(d.dish)}</h2>
      <p class="rv-rest" style="--i:2">${esc(d.restaurant)}</p>
      ${d.description ? `<p class="rv-desc" style="--i:3">${esc(d.description)}</p>` : ''}
      <dl class="rv-meta" style="--i:4">
        ${d.photographer ? `<div><dt>Photograph</dt><dd>${esc(d.photographer)}</dd></div>` : ''}
        <div><dt>Added</dt><dd><time datetime="${esc(d.date)}">${esc(fmtDate(d.date))}</time></dd></div>
        ${link}
      </dl>
      <nav class="rv-nav" style="--i:5" aria-label="Browse the collection">${nav(prev, 'prev', '← Previous')}${nav(next, 'next', 'Next →')}</nav>
    </div>
  </div>`;
}

function paint(i, from) {
  const d = items[i];
  rvState.i = i;
  rvBody.classList.remove('is-in');
  rvBody.innerHTML = plateMarkup(d, i);
  document.title = dishTitle(d);
  const frame = rvBody.querySelector('.rv-frame');
  if (from && !reduced) {
    const to = frame.getBoundingClientRect();
    const s = from.w / to.width;
    frame.style.transform = `translate(${from.x - to.left}px, ${from.y - to.top}px) scale(${s})`;
    frame.getBoundingClientRect();
    frame.style.transition = 'transform 1s cubic-bezier(.7,0,.2,1)';
    requestAnimationFrame(() => { frame.style.transform = ''; });
  }
  requestAnimationFrame(() => rvBody.classList.add('is-in'));
  [items[i + 1], items[i - 1]].forEach((p) => { if (p) { const im = new Image(); im.src = p.full; } });
}

function openPlate(i, { from = null, push = true } = {}) {
  if (!items[i]) return;
  const wasOpen = !rv.hidden;
  rv.hidden = false;
  rv.classList.remove('is-closing');
  rv.scrollTop = 0;
  paint(i, wasOpen ? null : from);
  requestAnimationFrame(() => rv.classList.add('is-open'));
  const url = dishPath(items[i]);
  if (!wasOpen && push) { history.pushState({ plate: items[i].slug }, '', url); rvState.pushed = true; }
  else history.replaceState({ plate: items[i].slug }, '', url);
  cursor.classList.remove('is-on');
  setTimeout(() => { if (!rv.hidden) world?.pause(); }, 1000);
  rvClose.focus({ preventScroll: true });
}

function hidePlate() {
  if (rv.hidden) return;
  rv.classList.add('is-closing');
  rv.classList.remove('is-open');
  document.title = HOME_TITLE;
  if (!root.classList.contains('is-index')) world?.resume();
  setTimeout(() => { if (rv.classList.contains('is-closing')) { rv.hidden = true; rv.classList.remove('is-closing'); rvBody.innerHTML = ''; } }, 480);
  rvState.i = -1;
}

function closePlate() {
  if (rvState.pushed) { rvState.pushed = false; history.back(); }
  else { history.replaceState(null, '', '/'); hidePlate(); }
}

function step(dir) {
  const i = rvState.i + dir;
  if (!items[i]) return;
  rv.scrollTop = 0;
  paint(i, null);
  history.replaceState({ plate: items[i].slug }, '', dishPath(items[i]));
}

rvClose.addEventListener('click', closePlate);
rv.addEventListener('click', (e) => {
  const a = e.target.closest('.rv-nav a');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); step(a.classList.contains('next') ? 1 : -1); return; }
  if (e.target === rvBody || e.target === rv) closePlate();
});
addEventListener('popstate', (e) => {
  const slug = e.state?.plate;
  const i = slug ? items.findIndex((d) => d.slug === slug) : -1;
  if (i >= 0) { openPlate(i, { push: false }); return; }
  rvState.pushed = false;
  hidePlate();
});
document.addEventListener('keydown', (e) => {
  if (rv.hidden) {
    if (e.key === 'Escape' && root.classList.contains('is-index') && !root.classList.contains('is-static')) setIndex(false);
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closePlate(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'Tab') {
    const f = [...rv.querySelectorAll('button, a[href]')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  }
});
let tx = 0, ty = 0;
rv.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; tx = t.clientX; ty = t.clientY; }, { passive: true });
rv.addEventListener('touchend', (e) => {
  if (!e.target.closest('.rv-photo')) return;
  const t = e.changedTouches[0], dx = t.clientX - tx, dy = t.clientY - ty;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
}, { passive: true });

/* ---------- boot ---------- */
let world = null;

function enter() {
  if (root.classList.contains('is-entered')) return;
  session.set('plated-entered', '1');
  loaderEl.classList.add('is-out');
  root.classList.add('is-entered');
  world.intro();
  if (fine) cursor.classList.add('is-on');
  setTimeout(() => loaderEl.remove(), 1700);
}

function goStatic() {
  root.classList.add('is-static', 'is-index');
  loaderEl.remove();
  canvas.remove();
}

function boot() {
  const want = new URLSearchParams(location.search).get('plate');
  if (reduced || !items.length) { goStatic(); }
  else {
    try { world = createWorld(); } catch (e) { console.warn('WebGL unavailable, showing the index', e); world = null; goStatic(); }
  }

  if (world) {
    bindInput();
    world.start();
    const skip = !!want || session.get('plated-entered') === '1';
    if (skip) { root.classList.add('is-skip'); enter(); }
    else {
      // preloader: count up while the first plates' photographs arrive
      const first = items.slice(0, 12).map((d) => world.texFor(d));
      let shown = 0, ready = false;
      const progress = () => first.filter((e) => e.done).length / first.length;
      const done = () => { if (ready) return; ready = true; loaderEl.classList.add('is-ready'); enterBtn.tabIndex = 0; enterBtn.focus({ preventScroll: true }); };
      const tickPct = () => {
        shown += (progress() * 100 - shown) * .12 + .3;
        shown = Math.min(shown, progress() * 100);
        pctEl.textContent = pad(Math.round(shown));
        if (shown >= 99.5) { pctEl.textContent = '100'; setTimeout(done, 250); }
        else if (!ready) requestAnimationFrame(tickPct);
      };
      requestAnimationFrame(tickPct);
      setTimeout(done, 6000);
      enterBtn.addEventListener('click', enter);
      loaderEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ready) enter(); });
    }
  }

  if (want) { const i = items.findIndex((d) => d.slug === want); if (i >= 0) openPlate(i, { push: false }); }

  // The prerendered seed is only the first page; fetch the whole collection for the world.
  fetchAll().then((all) => {
    if (!all.length) return;
    const sig = (arr) => arr.map((d) => d.id + d.thumb).join('|');
    if (sig(all) === sig(items)) return;
    items = all;
    renderIndex();
    world?.refresh();
  }).catch((e) => console.error(e));
}

boot();
