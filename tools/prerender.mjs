// Prerender static pages from the collection.
//   node tools/prerender.mjs
// - writes /dish/<slug>.html for every published dish (indexable, shareable URLs)
// - injects the first page of the grid into index.html (instant paint, no-JS crawlers)
// - rewrites sitemap.xml
// Reads Supabase via the public anon key in config.js (read-only, published rows only).
// Runs automatically via .github/workflows/prerender.yml.
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONFIG, LIVE, fetchAll, tileHTML, plateHTML, dishJsonLd, dishTitle, dishDescription, dishPath, esc, fmtDate } from '../assets/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = CONFIG.SITE_URL;
const abs = (u) => (u.startsWith('http') ? u : SITE + u);

const HEAD_COMMON = `<meta name="theme-color" content="#f3f0e8">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/site.css">`;

const HEADER = `<header class="site-head">
    <a class="mark" href="/" aria-label="Ottawa Plated — home"><i aria-hidden="true"></i>OTTAWA<b>PLATED</b></a>
    <nav class="nav" aria-label="Primary">
      <a href="/">The Collection</a>
      <a href="/about.html">About</a>
      <a href="/submit.html">Submit</a>
    </nav>
  </header>`;

const FOOTER = `<footer class="site-foot foot">
    <p>© Ottawa Plated</p>
    <p>An ongoing visual collection of beautiful food made in Ottawa.</p>
    <p><a href="/about.html">About</a><a href="/submit.html">Submit a dish</a></p>
  </footer>`;

function dishDocument(d, i, all) {
  const url = SITE + dishPath(d);
  const title = dishTitle(d);
  const desc = dishDescription(d);
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
${d.sample ? '<meta name="robots" content="noindex">\n' : ''}<meta property="og:type" content="article">
<meta property="og:site_name" content="Ottawa Plated">
<meta property="og:title" content="${esc(`${d.dish} — ${d.restaurant}`)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${esc(abs(d.full))}">
<meta property="og:image:width" content="1600">
<meta property="og:image:height" content="1600">
<meta property="og:image:alt" content="${esc(`${d.dish} at ${d.restaurant}`)}">
<meta property="article:published_time" content="${esc(d.date)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(`${d.dish} — ${d.restaurant}`)}">
<meta name="twitter:image" content="${esc(abs(d.full))}">
<link rel="preload" as="image" href="${esc(d.full)}" fetchpriority="high">
${HEAD_COMMON}
<script type="application/ld+json">${JSON.stringify(dishJsonLd(d)).replace(/</g, '\\u003c')}</script>
</head>
<body>
<div class="wrap">
  ${HEADER}
  <main class="dish-page" id="main">
    <a class="back cap" href="/">← The Collection</a>
    <article>${plateHTML(d, { index: i, total: all.length, prev: all[i - 1], next: all[i + 1] })}</article>
  </main>
  ${FOOTER}
</div>
<script>
// arrow keys move between plates
document.addEventListener('keydown', function (e) {
  var a = e.key === 'ArrowRight' ? document.querySelector('.plate-nav a.next') : e.key === 'ArrowLeft' ? document.querySelector('.plate-nav a.prev') : null;
  if (a && !e.altKey && !e.metaKey) location.href = a.href;
});
</script>
</body>
</html>
`;
}

function replaceBetween(html, key, content) {
  const re = new RegExp(`(<!--${key}:START-->)[\\s\\S]*?(<!--${key}:END-->)`);
  if (!re.test(html)) throw new Error(`marker ${key} missing in index.html`);
  return html.replace(re, `$1${content}$2`);
}

async function main() {
  const all = await fetchAll();
  console.log(`${LIVE ? 'Supabase' : 'Preview samples'}: ${all.length} published dishes`);

  // dish pages
  const dir = path.join(ROOT, 'dish');
  await mkdir(dir, { recursive: true });
  const keep = new Set(all.map((d) => `${d.slug}.html`));
  for (const f of await readdir(dir)) if (f.endsWith('.html') && !keep.has(f)) await unlink(path.join(dir, f));
  await Promise.all(all.map((d, i) => writeFile(path.join(dir, `${d.slug}.html`), dishDocument(d, i, all))));

  // index: first page of tiles + seed data
  const first = all.slice(0, CONFIG.PAGE_SIZE);
  let index = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  index = replaceBetween(index, 'GALLERY', first.map(tileHTML).join(''));
  index = replaceBetween(index, 'COUNT', `${all.length} ${all.length === 1 ? 'plate' : 'plates'}`);
  index = replaceBetween(index, 'PREVIEW', LIVE ? '' : '<span class="note">Preview — temporary sample images, not real dishes</span>');
  const seed = JSON.stringify({ items: first, total: all.length }).replace(/</g, '\\u003c');
  index = replaceBetween(index, 'DATA', `<script type="application/json" id="seed">${seed}</script>`);
  await writeFile(path.join(ROOT, 'index.html'), index);

  // sitemap (sample pages are noindex and left out)
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, lastmod: all[0] ? all[0].date.slice(0, 10) : today, pri: '1.0' },
    { loc: `${SITE}/about.html`, pri: '0.4' },
    { loc: `${SITE}/submit.html`, pri: '0.3' },
    ...all.filter((d) => !d.sample).map((d) => ({ loc: SITE + dishPath(d), lastmod: d.date.slice(0, 10), pri: '0.7', img: abs(d.full), title: `${d.dish} — ${d.restaurant}` })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map((u) => `  <url>
    <loc>${esc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <priority>${u.pri}</priority>${u.img ? `\n    <image:image><image:loc>${esc(u.img)}</image:loc></image:image>` : ''}
  </url>`).join('\n')}
</urlset>
`;
  await writeFile(path.join(ROOT, 'sitemap.xml'), xml);
  console.log(`Wrote ${all.length} dish pages, index.html, sitemap.xml (${fmtDate(new Date().toISOString())})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
