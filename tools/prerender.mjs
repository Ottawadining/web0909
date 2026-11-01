// ottawaplated.com has moved to plated.gallery/ottawa.
// This keeps one forwarding page per Ottawa dish at the old address (/dish/<slug>.html),
// so old links and search results land on the dish's new page.
//   node tools/prerender.mjs     (runs automatically via .github/workflows/prerender.yml)
import { writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchAll } from '../assets/core.js';
import { NEW, forwardPage } from './forward.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const all = await fetchAll(); // Ottawa dishes only (see assets/core.js)
const dir = path.join(ROOT, 'dish');
await mkdir(dir, { recursive: true });
const keep = new Set(all.map((d) => `${d.slug}.html`));
for (const f of await readdir(dir)) if (f.endsWith('.html') && !keep.has(f)) await unlink(path.join(dir, f));
await Promise.all(all.map((d) => writeFile(path.join(dir, `${d.slug}.html`), forwardPage(`${NEW}/ottawa/dish/${d.slug}.html`))));
console.log(`Wrote ${all.length} forwarding dish pages`);
