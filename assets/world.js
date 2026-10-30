// Ottawa Plated — the world.
// A globe of plates (three.js): drag to spin it, scroll or pinch to fly in, tap a plate to turn it
// towards you, hold it to reveal the dish and restaurant. A hidden list keeps the collection crawlable.
import * as THREE from 'three';
import { fetchAll, esc, pad, linkLabel, dishPath, altText, cropAttrs, dishTitle, tileHTML } from './core.js';

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const canvas = $('world');
const loaderEl = $('loader');
const pctEl = $('ld-pct');
const enterBtn = $('enter');
const grid = $('grid');
const countEl = $('count');
const cursor = $('cursor');
const curLabel = cursor.querySelector('.cur-label');
const curProg = cursor.querySelector('.cur-prog');
const rv = $('reveal');
const rvBody = $('rv-body');
const rvClose = $('rv-close');

const HOME_TITLE = document.title;
const HOLD_MS = Infinity; // a single tap opens a plate; pressing only lifts it
const RING = 2 * Math.PI * 26;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
};

let items = [];
try { items = JSON.parse($('seed').textContent).items || []; } catch {}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 4);
function hash(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/* ---------- hidden collection (search engines, no-WebGL and reduced-motion visitors) ---------- */
function renderIndex() {
  grid.innerHTML = items.map(tileHTML).join('');
  countEl.textContent = `${items.length} ${items.length === 1 ? 'plate' : 'plates'}`;
}

grid.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-slug]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const i = items.findIndex((d) => d.slug === a.dataset.slug);
  if (i < 0) return;
  e.preventDefault();
  const r = a.getBoundingClientRect();
  openPlate(i, { from: { x: r.left, y: r.top, w: r.width } });
});

/* ---------- the world: a globe of plates you spin and fly into ---------- */
const VS = /* glsl */`
uniform float uSpeed;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  p.z -= sin(uv.x * 3.14159) * sin(uv.y * 3.14159) * uSpeed * 0.22;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FS = /* glsl */`
uniform sampler2D uMap;
uniform vec4 uCrop;
uniform float uHas;
uniform float uBright;
uniform float uFog;
uniform float uBack;
varying vec2 vUv;
void main() {
  // plates lie flat on the sphere; from behind (far side, or from inside) un-mirror the photo
  vec2 uv = gl_FrontFacing ? vUv : vec2(1.0 - vUv.x, vUv.y);
  vec3 c = texture2D(uMap, uCrop.xy + uv * uCrop.zw).rgb;
  if (!gl_FrontFacing) c *= uBack;
  c = mix(vec3(0.082, 0.075, 0.059), c, uHas) * uBright;
  c = mix(c, vec3(0.055, 0.048, 0.038), uFog);
  gl_FragColor = vec4(c, 1.0);
}`;

// a soft, feathered shadow that sits a little beneath each photo
const SHADOW_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SHADOW_FS = /* glsl */`
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = abs(vUv - 0.5) * 2.0;                 // 0 at centre, 1 at the edge
  vec2 q = max(p - 0.56, 0.0) / 0.44;            // square core, feathered rim
  float a = 1.0 - smoothstep(0.0, 1.0, length(q));
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uOpacity);
}`;

function createWorld() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const FOV = 40;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 40000);
  const globe = new THREE.Group();
  scene.add(globe);
  const geo = new THREE.PlaneGeometry(1, 1, 10, 10);
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  const down = new THREE.Vector3(), toCam = new THREE.Vector3();
  const blank = new THREE.DataTexture(new Uint8Array([21, 19, 15, 255]), 1, 1);
  blank.needsUpdate = true;
  const texLoader = new THREE.TextureLoader();
  texLoader.setCrossOrigin('anonymous');
  const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const textures = new Map();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const v = new THREE.Vector3(), vp = new THREE.Vector3(), mtx = new THREE.Matrix4();
  const ORIGIN = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), UP_POLE = new THREE.Vector3(0, 0, 1);
  const nW = new THREE.Vector3(), upW = new THREE.Vector3(), xW = new THREE.Vector3(), qW = new THREE.Quaternion(), qInv = new THREE.Quaternion();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

  const RAD = 1000;
  let W = 0, H = 0, fit = 3000, plates = [], meshes = [];
  const rot = { x: .22, y: 0 }, rotT = { x: .22, y: 0 };
  let dist = 3000, distT = 3000, zoomRatio = 1, homeRatio = 1, zoomed = false;
  let speed = 0, introAt = -1, idleAt = 0, last = performance.now(), raf = 0, paused = false;
  let hovered = null;

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
      e.t = t; e.done = true;
    }, undefined, () => { e.done = true; });
    return e;
  }

  // Hand out dishes so every dish appears equally often and its copies sit as far apart as
  // possible. (A simple i % n repeats in neat clusters when n lines up with the spiral, e.g. 13.)
  function spreadDishes(N, n) {
    const dirs = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), th = i * 2.399963;
      dirs.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }
    const order = [...Array(N).keys()].sort((a, b) => hash(a, 11, 6) - hash(b, 11, 6));
    const count = new Array(n).fill(0), copies = Array.from({ length: n }, () => []), out = new Array(N);
    for (const i of order) {
      const lo = Math.min(...count);
      let best = -1, bestScore = Infinity;
      for (let d = 0; d < n; d++) {
        if (count[d] !== lo) continue;
        let near = -1; // dot product with this dish's closest copy (1 = same spot, -1 = opposite side)
        for (const j of copies[d]) { const a = dirs[i], b = dirs[j]; near = Math.max(near, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]); }
        const score = near + hash(i, d, 8) * 1e-3;
        if (score < bestScore) { bestScore = score; best = d; }
      }
      out[i] = best; count[best]++; copies[best].push(i);
    }
    // Polish: swap pairs of plates whenever it pushes same-dish copies further apart.
    const dot = (i, j) => dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1] + dirs[i][2] * dirs[j][2];
    const cost = (i, d, skip) => { let c = 0; for (const j of copies[d]) if (j !== i && j !== skip) c += Math.exp(6 * dot(i, j)); return c; };
    for (let t = 0; t < 6000; t++) {
      const a = Math.floor(hash(t, 1, 9) * N), b = Math.floor(hash(t, 2, 9) * N), da = out[a], db = out[b];
      if (da === db) continue;
      const before = cost(a, da, b) + cost(b, db, a), after = cost(a, db, b) + cost(b, da, a);
      if (after < before) {
        out[a] = db; out[b] = da;
        copies[da].splice(copies[da].indexOf(a), 1, b);
        copies[db].splice(copies[db].indexOf(b), 1, a);
      }
    }
    return out;
  }

  // Plates sit on a Fibonacci sphere (evenly spread, no grid), each a little in or out of the shell.
  // With few dishes each one appears several times; repeats land far apart.
  function build() {
    plates.forEach((p) => { globe.remove(p.m); p.m.material.dispose(); globe.remove(p.sh); p.sh.material.dispose(); });
    plates = [];
    const n = items.length;
    if (!n) { meshes = []; return; }
    const N = n >= 160 ? Math.min(n, 240) : clamp(n * 4, 48, 160); // ~160 plates fill the shell
    const size = RAD * .37 * Math.sqrt(40 / N) * (innerWidth < innerHeight * .8 ? 1.08 : 1); // about half the surface covered
    const dishes = spreadDishes(N, n);
    for (let i = 0; i < N; i++) {
      const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), th = i * 2.399963;
      const rad = RAD * (.97 + hash(i, 7, 1) * .06); // a tight shell keeps the outline round
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: blank }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
          uHas: { value: 0 }, uBright: { value: 0 }, uFog: { value: 0 }, uSpeed: { value: 0 }, uBack: { value: .5 },
        },
        vertexShader: VS, fragmentShader: FS, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      const dish = dishes[i];
      const p = {
        m, dish, tex: texFor(items[dish]), has: 0, bright: 0, lift: 0, rect: null,
        base: new THREE.Vector3(Math.cos(th) * r * rad, y * rad, Math.sin(th) * r * rad),
        size: size * (.85 + hash(i, 3, 2) * .3),
        delay: hash(i, 5, 3),
        bob: hash(i, 2, 5) * Math.PI * 2,
      };
      // lay the plate flat on the sphere, facing outward, its top pointing to the north pole,
      // so plates curve over the top and bottom; a slight individual roll keeps it hand-placed
      mtx.lookAt(p.base, ORIGIN, Math.abs(y) > .995 ? UP_POLE : UP);
      p.roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (hash(i, 9, 4) - .5) * .14);
      m.quaternion.setFromRotationMatrix(mtx).multiply(p.roll);
      m.position.copy(p.base);
      m.userData.plate = p;
      globe.add(m);
      // its shadow: front side only, so it disappears on the far side and from inside the globe
      p.sh = new THREE.Mesh(shadowGeo, new THREE.ShaderMaterial({
        uniforms: { uOpacity: { value: 0 } }, vertexShader: SHADOW_VS, fragmentShader: SHADOW_FS,
        transparent: true, depthWrite: false,
      }));
      p.sh.renderOrder = 1;
      globe.add(p.sh);
      plates.push(p);
    }
    meshes = plates.map((p) => p.m);
  }

  function layout() {
    W = innerWidth; H = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    // distance at which the globe just fits the narrower side of the screen
    const half = Math.min(tanHalf, tanHalf * camera.aspect);
    // phones (portrait) let the globe overflow the sides so plates stay big enough to tap
    fit = RAD * (camera.aspect < .8 ? .74 : 1.12) / Math.sin(Math.atan(half));
    // Open close in, among the plates: the camera sits where a photo on the front of the globe
    // appears at a set share of the screen's shorter side, so phones and desktops look alike.
    if (!zoomed && plates.length) {
      const avg = plates.reduce((a, p) => a + p.size, 0) / plates.length;
      const focal = (H / 2) / tanHalf;
      const share = camera.aspect < .8 ? .29 : .21;
      homeRatio = clamp((RAD + avg * focal / (share * Math.min(W, H))) / fit, .3, 1);
    }
    if (!zoomed) zoomRatio = homeRatio;
    zoomRatio = Math.min(zoomRatio, homeRatio);
    distT = fit * zoomRatio;
    if (introAt < 0) dist = distT;
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000, .05); last = now;
    const k = 1 - Math.exp(-dt * 5);
    if (!input.down && now - idleAt > 2600) rotT.y += dt * .07; // drift when left alone
    const y0 = rot.y, x0 = rot.x;
    rot.x += (rotT.x - rot.x) * k;
    rot.y += (rotT.y - rot.y) * k;
    dist += (distT - dist) * (1 - Math.exp(-dt * 4));
    const av = dt > 0 ? Math.hypot(rot.y - y0, rot.x - x0) / dt : 0;
    speed += (Math.min(av / 2.2, 1) - speed) * .1;

    const t = introAt < 0 ? -1 : (now - introAt) / 1000;
    const e = t < 0 ? 0 : easeOut(t / 2.2);
    globe.rotation.set(rot.x, rot.y - (1 - e) * 1.6, 0);
    globe.scale.setScalar(.55 + .45 * e);
    camera.position.set(0, 0, dist * (1 + (1 - e) * .9));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    globe.updateMatrixWorld();
    // from outside, the backs of far-side plates sit dim behind the front ones; from inside, all are lit
    const camR = camera.position.z / globe.scale.x;
    const back = .42 + .58 * (1 - smooth(RAD * .85, RAD * 1.35, camR));
    const inside = (back - .42) / .58; // 0 outside the globe, 1 inside

    const hold = input.holdPlate;
    const holdP = hold ? clamp((now - input.holdAt) / HOLD_MS, 0, 1) : 0;
    const fogAmt = .88 * smooth(.3, .75, dist / fit); // the far side darkens; none once you're inside

    qInv.copy(globe.quaternion).invert();
    for (const p of plates) {
      const u = p.m.material.uniforms;
      if (p.tex.t && u.uMap.value !== p.tex.t) { u.uMap.value = p.tex.t; u.uCrop.value.copy(p.tex.crop); }
      p.has += ((p.tex.t ? 1 : 0) - p.has) * .08;
      const pe = t < 0 ? 0 : easeOut((t - .2 - p.delay * .9) / 1.1);
      p.lift += ((p === hold ? .1 + holdP * .18 : p === hovered ? .08 : 0) - p.lift) * .15;
      // breathe gently in and out along the sphere; a hovered or pressed plate rises off the surface
      p.m.position.copy(p.base).multiplyScalar(1 + Math.sin(now / 1400 + p.bob) * .012 + p.lift * .12);
      // stay flat on the sphere, but turn in place so the photo is always upright on screen
      // (screen-up projected onto the plate; this also tips plates over the top and bottom)
      nW.copy(p.base).applyQuaternion(globe.quaternion).normalize();
      upW.copy(UP).addScaledVector(nW, -nW.y);
      if (upW.lengthSq() > 1e-6) {
        upW.normalize();
        xW.crossVectors(upW, nW);
        mtx.makeBasis(xW, upW, nW);
        qW.setFromRotationMatrix(mtx);
        p.m.quaternion.copy(qInv).multiply(qW).multiply(p.roll);
      }
      const sc = p.size * pe * (1 + p.lift);
      p.m.scale.set(sc, sc, sc);
      // the shadow sits deeper in the globe and slightly lower, so photos seem to float above it
      // (it shifts against its photo as the globe turns, which is what reads as depth)
      down.set(0, -1, 0).applyQuaternion(p.m.quaternion);
      p.sh.position.copy(p.m.position).multiplyScalar(.93).addScaledVector(down, sc * .07);
      p.sh.quaternion.copy(p.m.quaternion);
      p.sh.scale.setScalar(sc * 1.32);

      p.m.getWorldPosition(v);
      vp.copy(v).applyMatrix4(camera.matrixWorldInverse);
      const zv = -vp.z;
      const want = hold ? (p === hold ? 1.08 : .3 + .55 * (1 - holdP)) : hovered ? (p === hovered ? 1.06 : .5) : .92;
      p.bright += (want - p.bright) * .12;
      // photos darken gently as they curve away from you, as if lit from the front
      toCam.copy(camera.position).sub(v).normalize();
      const facing = nW.dot(toCam);
      const shade = facing > 0 ? .55 + .45 * smooth(.05, .8, facing) : 1;
      u.uBright.value = p.bright * pe * (shade + (1 - shade) * inside);
      p.sh.material.uniforms.uOpacity.value = .62 * pe * (1 - inside) * smooth(0, .35, facing);
      u.uHas.value = p.has;
      u.uFog.value = smooth(-RAD * .25, RAD * 1.05, zv - dist) * fogAmt;
      u.uSpeed.value = speed;
      u.uBack.value = back;
      if (zv > 1) {
        vp.copy(v).project(camera);
        const px = sc * globe.scale.x * (H / 2) / (zv * tanHalf);
        p.rect = { x: (vp.x + 1) / 2 * W - px / 2, y: (1 - vp.y) / 2 * H - px / 2, w: px };
      } else p.rect = null;
    }

    renderer.render(scene, camera);
    input.tick(now, holdP);
    if (!paused) raf = requestAnimationFrame(frame);
  }

  function pick(clientX, clientY) {
    ndc.set(clientX / W * 2 - 1, -(clientY / H) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.plate : null;
  }

  const poke = () => { idleAt = performance.now(); };
  build();
  layout();
  return {
    pick, texFor,
    setHover(p) { hovered = p; },
    // dragging spins the globe: a full screen width is about half a turn
    drag(dx, dy) { poke(); rotT.y += dx / Math.min(W, 900) * Math.PI; rotT.x += dy / Math.min(H, 900) * Math.PI * .8; }, // spins endlessly both ways
    zoom(f) { poke(); zoomed = true; zoomRatio = clamp(zoomRatio * f, .18, homeRatio); distT = fit * zoomRatio; }, // in only: never further out than the opening view
    // turn the globe until this plate faces the viewer
    center(p) {
      poke();
      const { x, y, z } = p.base;
      const yaw = Math.atan2(-x, z), pitch = Math.atan2(y, Math.hypot(x, z));
      let d = (yaw - rotT.y) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
      rotT.y += d;
      let dp = (pitch - rotT.x) % (Math.PI * 2);
      if (dp > Math.PI) dp -= Math.PI * 2; else if (dp < -Math.PI) dp += Math.PI * 2;
      rotT.x += dp;
    },
    intro() { introAt = performance.now(); poke(); },
    refresh() { build(); layout(); },
    resize() { layout(); },
    pause() { paused = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    resume() { if (!paused && raf) return; paused = false; last = performance.now(); if (!raf) raf = requestAnimationFrame(frame); },
    start() { paused = false; last = performance.now(); raf = requestAnimationFrame(frame); },
  };
}

/* ---------- input: drag to spin, scroll / pinch to zoom, tap to face, hold to reveal ---------- */
const input = {
  holdPlate: null, holdAt: 0, down: false, id: null, lx: 0, ly: 0, lt: 0, vx: 0, vy: 0, moved: 0,
  cx: innerWidth / 2, cy: innerHeight / 2, rx: innerWidth / 2, ry: innerHeight / 2,
  tick(now, p) {
    this.rx += (this.cx - this.rx) * .25; this.ry += (this.cy - this.ry) * .25;
    cursor.style.transform = `translate3d(${this.rx}px, ${this.ry}px, 0)`;
    curProg.style.strokeDashoffset = String(RING * (1 - p));
    if (this.holdPlate && p >= 1) {
      const pl = this.holdPlate;
      this.cancelHold();
      openPlate(pl.dish, { from: pl.rect });
    }
  },
  cancelHold() {
    this.holdPlate = null;
    cursor.classList.toggle('is-on', fine);
    curProg.style.strokeDashoffset = String(RING);
  },
};

function bindInput() {
  const pts = new Map();
  let pinch = 0;
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { // second finger: pinch, not drag or hold
      pinch = spread(); input.cancelHold(); input.moved = 99; return;
    }
    Object.assign(input, { down: true, id: e.pointerId, lx: e.clientX, ly: e.clientY, lt: performance.now(), vx: 0, vy: 0, moved: 0 });
    input.cx = input.rx = e.clientX; input.cy = input.ry = e.clientY;
    root.classList.add('is-dragging');
    const p = world.pick(e.clientX, e.clientY);
    if (p) { input.holdPlate = p; input.holdAt = performance.now(); cursor.classList.add('is-on', 'is-plate'); curLabel.textContent = 'View'; }
  });
  canvas.addEventListener('pointermove', (e) => {
    input.cx = e.clientX; input.cy = e.clientY;
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const s = spread();
      if (pinch > 0 && s > 0) world.zoom(pinch / s);
      pinch = s;
      return;
    }
    if (!input.down || e.pointerId !== input.id) {
      if (fine && !input.down) {
        const p = world.pick(e.clientX, e.clientY);
        world.setHover(p);
        cursor.classList.add('is-on');
        cursor.classList.toggle('is-plate', !!p);
        curLabel.textContent = p ? 'View' : 'Drag';
      }
      return;
    }
    const now = performance.now(), dx = e.clientX - input.lx, dy = e.clientY - input.ly, dt = Math.max(now - input.lt, 1);
    input.vx = input.vx * .6 + (dx / dt) * .4; input.vy = input.vy * .6 + (dy / dt) * .4;
    input.lx = e.clientX; input.ly = e.clientY; input.lt = now;
    input.moved += Math.abs(dx) + Math.abs(dy);
    world.drag(dx, dy);
    if (input.holdPlate && input.moved > 8) { input.cancelHold(); world.setHover(null); curLabel.textContent = 'Drag'; cursor.classList.remove('is-plate'); }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = 0;
    if (!input.down || e.pointerId !== input.id) return;
    input.down = false;
    root.classList.remove('is-dragging');
    if (input.moved > 8 && input.moved < 99) world.drag(input.vx * 140, input.vy * 140); // flick
    else if (input.holdPlate && input.holdPlate.rect) { const pl = input.holdPlate; input.cancelHold(); openPlate(pl.dish, { from: pl.rect }); } // tap: open it
    input.cancelHold();
    if (!fine) cursor.classList.remove('is-plate');
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { if (!input.down) { world.setHover(null); cursor.classList.remove('is-on'); } });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = (e.deltaMode === 1 ? 32 : 1) * (e.ctrlKey ? e.deltaY * 3 : e.deltaY);
    world.zoom(Math.exp(clamp(d, -120, 120) * .0015));
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (!root.classList.contains('is-entered') || !rv.hidden) return;
    const map = { ArrowLeft: [-120, 0], ArrowRight: [120, 0], ArrowUp: [0, -90], ArrowDown: [0, 90] };
    if (map[e.key]) { e.preventDefault(); world.drag(...map[e.key]); }
    else if (e.key === '+' || e.key === '=') world.zoom(.85);
    else if (e.key === '-' || e.key === '_') world.zoom(1.18);
  });
  let rt = 0;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => world.resize(), 120); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) world.pause();
    else if (rv.hidden) world.resume();
  });
}

/* ---------- the revealed plate ---------- */
const rvState = { i: -1, pushed: false };

function plateMarkup(d) {
  return `<div class="rv-grid">
    <figure class="rv-photo"><div class="rv-frame"><img src="${esc(d.full)}"${cropAttrs(d)} alt="${esc(altText(d))}" decoding="async"></div></figure>
    <div class="rv-label">
      <h2 class="rv-dish" style="--i:0">${esc(d.dish)}</h2>
      <p class="rv-rest" style="--i:1">${esc(d.restaurant)}</p>
      ${d.description ? `<p class="rv-desc" style="--i:2">${esc(d.description)}</p>` : ''}
      ${d.photographer ? `<p class="rv-credit" style="--i:3">Photograph · ${esc(d.photographer)}</p>` : ''}
      ${d.link ? `<a class="rv-link" style="--i:4" href="${esc(d.link)}" rel="noopener" target="_blank">${esc(linkLabel(d.link))} ↗</a>` : ''}
    </div>
  </div>`;
}

function paint(i, from) {
  const d = items[i];
  rvState.i = i;
  rvBody.classList.remove('is-in');
  rvBody.innerHTML = plateMarkup(d);
  document.title = dishTitle(d);
  const frame = rvBody.querySelector('.rv-frame');
  if (from && !reduced) {
    const to = frame.getBoundingClientRect();
    const s = from.w / to.width;
    frame.style.transform = `translate(${from.x - to.left}px, ${from.y - to.top}px) scale(${s})`;
    frame.getBoundingClientRect();
    frame.style.transition = 'transform 1.15s cubic-bezier(.2,.8,.15,1)'; // fast lift-off, long gentle landing
    requestAnimationFrame(() => { frame.style.transform = ''; });
  }
  requestAnimationFrame(() => rvBody.classList.add('is-in'));
}

function openPlate(i, { from = null, push = true } = {}) {
  if (!items[i]) return;
  const wasOpen = !rv.hidden;
  rv.hidden = false;
  rv.classList.remove('is-closing');
  root.classList.add('is-viewing');
  rv.scrollTop = 0;
  paint(i, wasOpen ? null : from);
  requestAnimationFrame(() => rv.classList.add('is-open'));
  const url = dishPath(items[i]);
  if (!wasOpen && push) { history.pushState({ plate: items[i].slug }, '', url); rvState.pushed = true; }
  else history.replaceState({ plate: items[i].slug }, '', url);
  cursor.classList.remove('is-on');
  setTimeout(() => { if (!rv.hidden && !rv.classList.contains('is-closing')) world?.pause(); }, 1200); // once the blur has settled
  rvClose.focus({ preventScroll: true });
}

function hidePlate() {
  if (rv.hidden) return;
  rv.classList.add('is-closing');
  rv.classList.remove('is-open');
  root.classList.remove('is-viewing');
  rv.style.background = '';
  document.title = HOME_TITLE;
  world?.resume();
  setTimeout(() => { if (rv.classList.contains('is-closing')) { rv.hidden = true; rv.classList.remove('is-closing'); rvBody.innerHTML = ''; } }, 520);
  rvState.i = -1;
}

function closePlate() {
  if (rvState.pushed) { rvState.pushed = false; history.back(); }
  else { history.replaceState(null, '', '/'); hidePlate(); }
}

rvClose.addEventListener('click', closePlate);
rv.addEventListener('click', (e) => {
  if (e.target === rvBody || e.target === rv) closePlate();
});

// phones: drag the photo down to send it back to the globe
const swipe = { y0: 0, x0: 0, dy: 0, t0: 0, on: false, grid: null };
rv.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || rv.scrollTop > 2 || e.target.closest('a, button')) return;
  const t = e.touches[0];
  Object.assign(swipe, { y0: t.clientY, x0: t.clientX, dy: 0, t0: performance.now(), on: true, grid: rvBody.querySelector('.rv-grid') });
}, { passive: true });
rv.addEventListener('touchmove', (e) => {
  if (!swipe.on || !swipe.grid) return;
  const t = e.touches[0], dy = t.clientY - swipe.y0, dx = t.clientX - swipe.x0;
  if (swipe.dy === 0 && (dy <= 0 || Math.abs(dx) > Math.abs(dy))) { swipe.on = false; return; } // only a downward pull
  swipe.dy = Math.max(0, dy);
  if (e.cancelable) e.preventDefault();
  const k = Math.min(swipe.dy / 400, 1);
  swipe.grid.classList.add('is-dragging');
  swipe.grid.style.transform = `translateY(${swipe.dy}px) scale(${1 - k * .12})`;
  swipe.grid.style.opacity = String(1 - k * .5);
  rv.style.background = `rgba(11, 10, 8, ${.28 * (1 - k)})`;
}, { passive: false });
rv.addEventListener('touchend', () => {
  if (!swipe.on || !swipe.grid) return;
  swipe.on = false;
  const g = swipe.grid, fast = swipe.dy / Math.max(performance.now() - swipe.t0, 1) > .6;
  g.classList.remove('is-dragging');
  if (swipe.dy > 110 || (fast && swipe.dy > 40)) { g.style.opacity = '0'; g.style.transform = `translateY(${swipe.dy + 80}px) scale(.86)`; closePlate(); return; }
  g.style.transform = ''; g.style.opacity = ''; rv.style.background = '';
});
addEventListener('popstate', (e) => {
  const slug = e.state?.plate;
  const i = slug ? items.findIndex((d) => d.slug === slug) : -1;
  if (i >= 0) { openPlate(i, { push: false }); return; }
  rvState.pushed = false;
  hidePlate();
});
document.addEventListener('keydown', (e) => {
  if (rv.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closePlate(); }
  else if (e.key === 'Tab') {
    const f = [...rv.querySelectorAll('button, a[href]')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  }
});
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
  root.classList.add('is-static');
  loaderEl.remove();
  canvas.remove();
}

function boot() {
  const want = new URLSearchParams(location.search).get('plate');
  if (reduced || !items.length) { goStatic(); }
  else {
    try { world = createWorld(); } catch (e) { console.warn('WebGL unavailable, showing the collection as a grid', e); world = null; goStatic(); }
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
