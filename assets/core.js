// Shared data + rendering. Runs in the browser and in Node (tools/prerender.mjs).
import CONFIG from '../config.js';

export { CONFIG };
export const LIVE = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

/* ---------- helpers ---------- */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Toronto' });
}

export const pad = (n) => String(n).padStart(3, '0');
export const dishPath = (d) => `/dish/${d.slug}.html`;

export function linkLabel(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (/instagram\.com$/.test(u.hostname.replace(/^www\./, ''))) {
      const handle = u.pathname.split('/').filter(Boolean)[0];
      return handle && !['p', 'reel'].includes(handle) ? `@${handle}` : 'Instagram';
    }
    return u.hostname.replace(/^www\./, '');
  } catch { return 'Visit'; }
}

/* ---------- sample data (preview mode only) ---------- */
const SAMPLE_COUNT = 24;
export const SAMPLES = Array.from({ length: SAMPLE_COUNT }, (_, i) => {
  const n = SAMPLE_COUNT - i; // newest first
  const id = String(n).padStart(2, '0');
  const date = new Date(Date.UTC(2026, 9, 7) - i * 2 * 864e5).toISOString();
  return {
    id: `sample-${id}`,
    no: n,
    slug: `sample-${id}`,
    dish: `Sample image ${id}`,
    restaurant: 'Placeholder — not a real dish',
    description: 'A temporary generated study used to preview the layout. It will be replaced with authorised photography.',
    photographer: 'Generated sample',
    link: '',
    thumb: `/assets/samples/sample-${id}-600.webp`,
    full: `/assets/samples/sample-${id}-1600.webp`,
    date,
    sample: true,
  };
});

/* ---------- Supabase (read-only, public) ---------- */
const COLS = 'id,catalog_no,slug,dish_name,restaurant,description,link_url,photographer,image_thumb,image_full,published_at,created_at';

export const storageUrl = (path) =>
  path ? `${CONFIG.SUPABASE_URL}/storage/v1/object/public/dishes/${path.split('/').map(encodeURIComponent).join('/')}` : '';

export function normalize(r) {
  return {
    id: r.id,
    no: r.catalog_no,
    slug: r.slug,
    dish: r.dish_name,
    restaurant: r.restaurant,
    description: r.description || '',
    photographer: r.photographer || '',
    link: r.link_url || '',
    thumb: storageUrl(r.image_thumb),
    full: storageUrl(r.image_full),
    date: r.published_at || r.created_at,
    sample: false,
  };
}

/** Request headers for the public key. Legacy anon keys (JWTs) also go in Authorization;
 *  new sb_publishable_ keys must only be sent as apikey. */
export function keyHeaders() {
  const k = CONFIG.SUPABASE_ANON_KEY;
  return { apikey: k, ...(k.startsWith('eyJ') ? { Authorization: `Bearer ${k}` } : {}) };
}

async function rest(query, { count = false } = {}) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/dishes?${query}`, {
    headers: {
      ...keyHeaders(),
      ...(count ? { Prefer: 'count=exact' } : {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = await res.json();
  const range = res.headers.get('content-range');
  const total = range ? Number(range.split('/')[1]) : rows.length;
  return { rows, total };
}

const ORDER = 'order=sort_order.asc,published_at.desc';

/** Page of published dishes, newest (or admin-ordered) first. */
export async function fetchPage(offset = 0, limit = CONFIG.PAGE_SIZE) {
  if (!LIVE) return { items: SAMPLES.slice(offset, offset + limit), total: SAMPLES.length };
  const { rows, total } = await rest(`select=${COLS}&published=eq.true&${ORDER}&offset=${offset}&limit=${limit}`, { count: true });
  return { items: rows.map(normalize), total };
}

/** Every published dish in display order (used for prev/next and prerendering). */
export async function fetchAll() {
  if (!LIVE) return SAMPLES.slice();
  const out = [];
  for (let off = 0; ; off += 1000) {
    const { rows } = await rest(`select=${COLS}&published=eq.true&${ORDER}&offset=${off}&limit=1000`);
    out.push(...rows.map(normalize));
    if (rows.length < 1000) break;
  }
  return out;
}

/* ---------- rendering ---------- */
export function tileHTML(d, i) {
  const eager = i < 6;
  return `<li class="tile"><a href="${dishPath(d)}" data-slug="${esc(d.slug)}" aria-label="${esc(d.dish)}, ${esc(d.restaurant)}">` +
    `<img src="${esc(d.thumb)}" srcset="${esc(d.thumb)} 600w, ${esc(d.full)} 1600w" ` +
    `sizes="(min-width: 1024px) 31vw, 49vw" width="600" height="600" alt="${esc(altText(d))}" ` +
    `${eager ? `loading="eager"${i < 3 ? ' fetchpriority="high"' : ''}` : 'loading="lazy"'} decoding="async"></a></li>`;
}

export const altText = (d) => (d.sample ? `Placeholder sample image ${d.no}` : `${d.dish} at ${d.restaurant}, Ottawa`);

/** The gallery wall label + photograph. Used by the lightbox, 404 fallback and prerendered pages. */
export function plateHTML(d, { index, total, prev, next, headingTag = 'h1' } = {}) {
  const pos = index != null && total ? `<span>${pad(index + 1)}</span><span class="of">/ ${pad(total)}</span>` : '';
  const link = d.link
    ? `<div><dt>Restaurant</dt><dd><a href="${esc(d.link)}" rel="noopener" target="_blank">${esc(linkLabel(d.link))}<span aria-hidden="true"> ↗</span></a></dd></div>` : '';
  const nav = (p, n) => `<nav class="plate-nav" aria-label="Browse the collection">` +
    (p ? `<a class="prev" href="${dishPath(p)}" data-slug="${esc(p.slug)}" rel="prev"><span aria-hidden="true">←</span> Previous</a>` : '<span class="prev is-off">← Previous</span>') +
    (n ? `<a class="next" href="${dishPath(n)}" data-slug="${esc(n.slug)}" rel="next">Next <span aria-hidden="true">→</span></a>` : '<span class="next is-off">Next →</span>') +
    `</nav>`;
  return `
  <div class="plate">
    <figure class="plate-photo">
      <img src="${esc(d.full)}" width="1600" height="1600" alt="${esc(altText(d))}" decoding="async">
    </figure>
    <div class="plate-label">
      <p class="plate-no">No. ${pad(d.no)}${d.sample ? ' · <em>Sample</em>' : ''}</p>
      <${headingTag} class="plate-dish">${esc(d.dish)}</${headingTag}>
      <p class="plate-rest">${esc(d.restaurant)}</p>
      ${d.description ? `<p class="plate-desc">${esc(d.description)}</p>` : ''}
      <dl class="plate-meta">
        ${d.photographer ? `<div><dt>Photograph</dt><dd>${esc(d.photographer)}</dd></div>` : ''}
        <div><dt>Added</dt><dd><time datetime="${esc(d.date)}">${esc(fmtDate(d.date))}</time></dd></div>
        ${link}
      </dl>
      <div class="plate-foot">
        ${pos ? `<p class="plate-pos" aria-label="Plate ${index + 1} of ${total}">${pos}</p>` : ''}
        ${nav(prev, next)}
      </div>
    </div>
  </div>`;
}

export function dishJsonLd(d) {
  const url = CONFIG.SITE_URL + dishPath(d);
  const full = d.full.startsWith('http') ? d.full : CONFIG.SITE_URL + d.full;
  return {
    '@context': 'https://schema.org',
    '@type': 'ImageObject',
    '@id': url,
    url,
    contentUrl: full,
    name: `${d.dish} — ${d.restaurant}`,
    caption: d.description || `${d.dish} at ${d.restaurant}, Ottawa.`,
    datePublished: d.date,
    ...(d.photographer ? { creditText: d.photographer, creator: { '@type': 'Person', name: d.photographer } } : {}),
    about: { '@type': 'FoodEstablishment', name: d.restaurant, address: { '@type': 'PostalAddress', addressLocality: 'Ottawa', addressRegion: 'ON', addressCountry: 'CA' }, ...(d.link ? { sameAs: d.link } : {}) },
    isPartOf: { '@type': 'CollectionPage', name: 'Ottawa Plated', url: CONFIG.SITE_URL + '/' },
  };
}

export const dishTitle = (d) => `${d.dish}, ${d.restaurant} — Ottawa Plated`;
export const dishDescription = (d) =>
  d.description ? `${d.description} Photographed at ${d.restaurant}, Ottawa.` : `${d.dish} at ${d.restaurant}, Ottawa — part of Ottawa Plated, a visual collection of beautiful food made in Ottawa.`;
