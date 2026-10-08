// Ottawa Plated admin. Uses the public anon key + an admin's signed-in session;
// row-level security (supabase/schema.sql) decides what that session may change.
import { CONFIG, LIVE, esc, pad, fmtDate, storageUrl, dishPath } from './core.js';

const $ = (id) => document.getElementById(id);
const views = ['setup', 'login', 'list', 'edit', 'subs'];
function view(name) {
  views.forEach((v) => ($(`v-${v}`).hidden = v !== name));
  document.querySelectorAll('#adm-nav a[data-view]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.view === name || (name === 'edit' && a.dataset.view === 'list')));
  window.scrollTo(0, 0);
}

if (!LIVE) { view('setup'); throw new Error('Supabase not configured'); }

const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

let dishes = [];
let editing = null;          // dish row being edited, or null for new
let fromSubmission = null;   // submission row a new dish came from

/* ================= auth ================= */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $('adm-nav').hidden = true; return view('login'); }
  const { data: ok } = await sb.rpc('is_admin');
  if (!ok) {
    await sb.auth.signOut();
    $('l-status').textContent = 'This account is not an administrator.';
    $('l-status').className = 'form-status err';
    return view('login');
  }
  $('adm-nav').hidden = false;
  await loadList();
  refreshSubCount();
  route();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('l-status'); st.className = 'form-status'; st.textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email: $('l-email').value.trim(), password: $('l-pass').value });
  if (error) { st.textContent = error.message; st.className = 'form-status err'; return; }
  st.textContent = '';
  boot();
});
$('signout').addEventListener('click', async (e) => { e.preventDefault(); location.hash = ''; await sb.auth.signOut(); });

function route() {
  if (location.hash === '#submissions') { view('subs'); loadSubs(); }
  else view('list');
}
window.addEventListener('hashchange', route);

/* ================= collection list ================= */
async function loadList() {
  const { data, error } = await sb.from('dishes').select('*').order('sort_order').order('published_at', { ascending: false, nullsFirst: true });
  if (error) { alert(error.message); return; }
  dishes = data;
  renderList();
}

function renderList() {
  const pub = dishes.filter((d) => d.published).length;
  $('list-count').textContent = `${pub} published · ${dishes.length - pub} draft`;
  if (!dishes.length) { $('list').innerHTML = '<li class="empty">No dishes yet. Add the first one.</li>'; return; }
  $('list').innerHTML = dishes.map((d, i) => `
    <li class="adm-row${d.published ? '' : ' is-draft'}" data-id="${d.id}">
      <img src="${esc(storageUrl(d.image_thumb))}" alt="" loading="lazy" width="64" height="64">
      <span class="no">No. ${pad(d.catalog_no)}</span>
      <div class="t"><b>${esc(d.dish_name)}</b><span>${esc(d.restaurant)}</span>
        <small>${d.published ? `Added ${esc(fmtDate(d.published_at))} · <a href="${dishPath(d)}" target="_blank" rel="noopener">${dishPath(d)}</a>` : 'Draft — not visible'}</small></div>
      <div class="ctl">
        <button class="pill${d.published ? ' on' : ''}" data-act="toggle">${d.published ? 'Published' : 'Draft'}</button>
      </div>
      <div class="ctl row-actions">
        <span class="ord">
          <button data-act="top" title="Move to top" aria-label="Move to top" ${i === 0 ? 'disabled' : ''}>⤒</button>
          <button data-act="up" title="Move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-act="down" title="Move down" aria-label="Move down" ${i === dishes.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
        <button class="btn btn-sm" data-act="edit">Edit</button>
      </div>
    </li>`).join('');
}

$('list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  const i = dishes.findIndex((d) => d.id === id);
  const d = dishes[i];
  b.disabled = true;
  try {
    if (b.dataset.act === 'edit') return openEditor(d);
    if (b.dataset.act === 'toggle') {
      const { error } = await sb.from('dishes').update({ published: !d.published }).eq('id', id);
      if (error) throw error;
    } else if (b.dataset.act === 'top') {
      const { error } = await sb.from('dishes').update({ sort_order: dishes[0].sort_order - 1 }).eq('id', id);
      if (error) throw error;
    } else {
      const j = b.dataset.act === 'up' ? i - 1 : i + 1;
      const o = dishes[j];
      // swap; if equal (legacy), nudge apart
      let a = o.sort_order, c = d.sort_order;
      if (a === c) a = b.dataset.act === 'up' ? c - 0.5 : c + 0.5;
      const r1 = await sb.from('dishes').update({ sort_order: a }).eq('id', d.id);
      const r2 = await sb.from('dishes').update({ sort_order: c }).eq('id', o.id);
      if (r1.error || r2.error) throw (r1.error || r2.error);
    }
    await loadList();
  } catch (err) { alert(err.message); } finally { b.disabled = false; }
});

$('reset-order').addEventListener('click', async () => {
  if (!confirm('Reorder the whole collection newest first? Your manual order will be replaced.')) return;
  const { error } = await sb.rpc('reset_dish_order');
  if (error) return alert(error.message);
  loadList();
});

$('new-dish').addEventListener('click', () => { fromSubmission = null; openEditor(null); });
$('edit-cancel').addEventListener('click', () => { editing = undefined; fromSubmission ? (location.hash = '#submissions', route()) : view('list'); });

/* ================= cropper ================= */
const stage = $('crop-stage'), canvas = $('crop-canvas'), zoomEl = $('zoom');
const crop = { img: null, blob: null, changed: false, zoom: 1, cx: 0, cy: 0 };

function cropSize() { return Math.min(crop.img.naturalWidth, crop.img.naturalHeight) / crop.zoom; }
function clampCrop() {
  const s = cropSize(), w = crop.img.naturalWidth, h = crop.img.naturalHeight;
  crop.cx = Math.min(Math.max(crop.cx, s / 2), w - s / 2);
  crop.cy = Math.min(Math.max(crop.cy, s / 2), h - s / 2);
}
function draw() {
  const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!crop.img) return;
  clampCrop();
  const s = cropSize();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.img, crop.cx - s / 2, crop.cy - s / 2, s, s, 0, 0, canvas.width, canvas.height);
}
new ResizeObserver(draw).observe(stage);

async function loadImage(src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  return img;
}

/** Normalise any upload to a JPEG ≤ 3000px; that becomes the stored "original" for re-cropping. */
async function useFile(file) {
  if (!file || !file.type.startsWith('image/')) return status('Please choose an image file.', true);
  const url = URL.createObjectURL(file);
  try {
    let img = await loadImage(url);
    const max = 3000, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    img = await loadImage(URL.createObjectURL(blob));
    setCropImage(img, null);
    crop.blob = blob; crop.changed = true;
    status('');
  } catch {
    status('This image could not be opened. Try a JPG or PNG (iPhone HEIC photos may need converting).', true);
  } finally { URL.revokeObjectURL(url); }
}

function setCropImage(img, saved) {
  crop.img = img; crop.blob = null; crop.changed = false;
  const w = img.naturalWidth, h = img.naturalHeight;
  if (saved && saved.size) {
    crop.zoom = Math.min(4, Math.max(1, Math.min(w, h) / saved.size));
    crop.cx = saved.x + saved.size / 2; crop.cy = saved.y + saved.size / 2;
  } else { crop.zoom = 1; crop.cx = w / 2; crop.cy = h / 2; }
  zoomEl.value = crop.zoom;
  stage.classList.add('has-img');
  draw();
}

function clearCrop() {
  crop.img = null; crop.blob = null; crop.changed = false; crop.zoom = 1; zoomEl.value = 1;
  stage.classList.remove('has-img'); draw();
}

$('photo-input').addEventListener('change', (e) => { useFile(e.target.files[0]); e.target.value = ''; });
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('over'); });
stage.addEventListener('dragleave', () => stage.classList.remove('over'));
stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('over'); useFile(e.dataTransfer.files[0]); });

let drag = null;
stage.addEventListener('pointerdown', (e) => {
  if (!crop.img) return;
  stage.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, cx: crop.cx, cy: crop.cy };
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const k = cropSize() / stage.getBoundingClientRect().width;
  crop.cx = drag.cx - (e.clientX - drag.x) * k;
  crop.cy = drag.cy - (e.clientY - drag.y) * k;
  crop.changed = true; draw();
});
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('wheel', (e) => {
  if (!crop.img) return;
  e.preventDefault();
  setZoom(crop.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
}, { passive: false });
stage.addEventListener('keydown', (e) => {
  if (!crop.img) return;
  const step = cropSize() * 0.02;
  const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (m) { e.preventDefault(); crop.cx += m[0]; crop.cy += m[1]; crop.changed = true; draw(); }
  if (e.key === '+' || e.key === '=') setZoom(crop.zoom * 1.06);
  if (e.key === '-') setZoom(crop.zoom / 1.06);
});
function setZoom(z) { crop.zoom = Math.min(4, Math.max(1, z)); zoomEl.value = crop.zoom; crop.changed = true; draw(); }
zoomEl.addEventListener('input', () => setZoom(Number(zoomEl.value)));

async function exportSquare(size) {
  const s = cropSize();
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.img, crop.cx - s / 2, crop.cy - s / 2, s, s, 0, 0, size, size);
  let blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86)); // older Safari
  return blob;
}

/* ================= editor ================= */
const f = { dish: $('e-dish'), rest: $('e-rest'), desc: $('e-desc'), link: $('e-link'), photo: $('e-photo'), pub: $('e-pub') };
function status(msg, err = false) { $('e-status').textContent = msg; $('e-status').className = `form-status${err ? ' err' : ''}`; }
f.desc.addEventListener('input', () => ($('desc-left').textContent = 300 - f.desc.value.length));

async function openEditor(d, prefill = {}) {
  editing = d;
  $('edit-title').textContent = d ? `Edit No. ${pad(d.catalog_no)}` : 'New dish';
  $('e-delete').hidden = !d;
  f.dish.value = d?.dish_name ?? prefill.dish_name ?? '';
  f.rest.value = d?.restaurant ?? prefill.restaurant ?? '';
  f.desc.value = d?.description ?? '';
  f.link.value = d?.link_url ?? prefill.link_url ?? '';
  f.photo.value = d?.photographer ?? prefill.photographer ?? '';
  f.pub.checked = d ? d.published : false;
  $('desc-left').textContent = 300 - f.desc.value.length;
  status('');
  clearCrop();
  view('edit');
  try {
    if (d) {
      const src = storageUrl(d.image_original || d.image_full);
      setCropImage(await loadImage(src), d.image_original ? d.crop : null);
    } else if (prefill.photoUrl) {
      const blob = await (await fetch(prefill.photoUrl)).blob();
      await useFile(new File([blob], 'submission', { type: blob.type }));
    }
  } catch { status('Could not load the existing photograph; you can still replace it.', true); }
}

function slugify(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '') || 'dish';
}
async function uniqueSlug(base) {
  const { data } = await sb.from('dishes').select('slug').like('slug', `${base}%`);
  const taken = new Set((data || []).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

async function upload(path, blob) {
  const { error } = await sb.storage.from('dishes').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return path;
}

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dish = f.dish.value.trim(), restaurant = f.rest.value.trim(), link = f.link.value.trim();
  if (!dish || !restaurant) return status('Dish and restaurant are required.', true);
  if (!crop.img) return status('Add a photograph.', true);
  if (link && !/^https:\/\/[^\s]+\.[^\s]+/.test(link)) return status('The link must start with https://', true);

  const save = $('e-save'); save.disabled = true; status('Saving…');
  const old = editing ? { t: editing.image_thumb, f: editing.image_full, o: editing.image_original } : null;
  try {
    const row = {
      dish_name: dish, restaurant,
      description: f.desc.value.trim() || null,
      link_url: link || null,
      photographer: f.photo.value.trim() || null,
      published: f.pub.checked,
    };
    const s = cropSize();
    const cropRect = { x: Math.round(crop.cx - s / 2), y: Math.round(crop.cy - s / 2), size: Math.round(s) };
    const imageChanged = !editing || crop.changed || crop.blob;
    let newPaths = null;
    if (imageChanged) {
      status('Preparing images…');
      const [full, thumb] = await Promise.all([exportSquare(1600), exportSquare(600)]);
      const ext = full.type === 'image/webp' ? 'webp' : 'jpg';
      const key = `${new Date().getFullYear()}/${crypto.randomUUID()}`;
      status('Uploading…');
      const orig = crop.blob ? await upload(`${key}-orig.jpg`, crop.blob) : (editing?.image_original || null);
      newPaths = {
        image_full: await upload(`${key}-1600.${ext}`, full),
        image_thumb: await upload(`${key}-600.${ext}`, thumb),
        image_original: orig,
        crop: orig ? cropRect : null,
      };
      Object.assign(row, newPaths);
    }
    if (editing) {
      const { error } = await sb.from('dishes').update(row).eq('id', editing.id);
      if (error) throw error;
      if (newPaths) {
        const stale = [old.t, old.f, crop.blob ? old.o : null].filter(Boolean);
        if (stale.length) await sb.storage.from('dishes').remove(stale);
      }
    } else {
      row.slug = await uniqueSlug(slugify(`${dish} ${restaurant}`));
      const { error } = await sb.from('dishes').insert(row);
      if (error) throw error;
      if (fromSubmission) await sb.from('submissions').update({ status: 'accepted' }).eq('id', fromSubmission.id);
    }
    fromSubmission = null; editing = undefined;
    await loadList();
    location.hash = '#collection'; view('list');
  } catch (err) {
    status(err.message || 'Save failed.', true);
  } finally { save.disabled = false; }
});

$('e-delete').addEventListener('click', async () => {
  if (!editing || !confirm(`Delete “${editing.dish_name}” permanently? This also removes its photographs.`)) return;
  const { error } = await sb.from('dishes').delete().eq('id', editing.id);
  if (error) return status(error.message, true);
  await sb.storage.from('dishes').remove([editing.image_thumb, editing.image_full, editing.image_original].filter(Boolean));
  editing = undefined;
  await loadList(); view('list');
});

/* ================= submissions ================= */
async function refreshSubCount() {
  const { count } = await sb.from('submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  $('sub-count').textContent = count ? `(${count})` : '';
}

let subs = [];
async function loadSubs() {
  let q = sb.from('submissions').select('*').order('created_at', { ascending: false }).limit(200);
  if (!$('show-all').checked) q = q.eq('status', 'pending');
  const { data, error } = await q;
  if (error) return alert(error.message);
  subs = data;
  const paths = subs.map((s) => s.photo_path).filter(Boolean);
  const urls = {};
  if (paths.length) {
    const { data: signed } = await sb.storage.from('submissions').createSignedUrls(paths, 3600);
    (signed || []).forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  }
  subs.forEach((s) => (s._url = urls[s.photo_path] || ''));
  $('subs').innerHTML = subs.length ? subs.map((s) => `
    <li class="adm-row sub-row" data-id="${s.id}">
      ${s._url ? `<a href="${esc(s._url)}" target="_blank" rel="noopener"><img src="${esc(s._url)}" alt=""></a>` : '<span class="ph">Instagram<br>link</span>'}
      <div class="t">
        <b>${esc(s.dish_name)}<span class="status">${esc(s.status)}</span></b>
        <span>${esc(s.restaurant)} · Photograph: ${esc(s.photographer)}</span>
        <small><a href="mailto:${esc(s.email)}">${esc(s.email)}</a> · ${esc(fmtDate(s.created_at))}</small>
        ${s.instagram_url ? `<small><a href="${esc(s.instagram_url)}" target="_blank" rel="noopener">${esc(s.instagram_url)}</a></small>` : ''}
      </div>
      <div class="ctl">
        <button class="btn btn-sm" data-act="use">Create dish</button>
        ${s.status === 'pending' ? '<button class="btn btn-sm btn-quiet" data-act="decline">Decline</button>' : ''}
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>
      </div>
    </li>`).join('') : '<li class="empty">No pending submissions.</li>';
}
$('show-all').addEventListener('change', loadSubs);

$('subs').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const s = subs.find((x) => x.id === b.closest('[data-id]').dataset.id);
  if (b.dataset.act === 'use') {
    fromSubmission = s;
    // Instagram links are reference only: ask the restaurant for the original file; never scrape.
    openEditor(null, { dish_name: s.dish_name, restaurant: s.restaurant, photographer: s.photographer, photoUrl: s._url || null });
    if (!s._url) status('This submission is an Instagram link. Ask the submitter for the original photograph, then add it here.');
    return;
  }
  if (b.dataset.act === 'decline') await sb.from('submissions').update({ status: 'declined' }).eq('id', s.id);
  if (b.dataset.act === 'delete') {
    if (!confirm('Delete this submission and its photograph?')) return;
    if (s.photo_path) await sb.storage.from('submissions').remove([s.photo_path]);
    await sb.from('submissions').delete().eq('id', s.id);
  }
  loadSubs(); refreshSubCount();
});

sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') boot(); });
boot();
