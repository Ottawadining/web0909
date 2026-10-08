# Ottawa Plated

A photographic collection of beautiful food made in Ottawa. Static site on GitHub Pages (repo `web0909`) with Supabase for the admin, images and submissions.

```
index.html        the collection (square grid + detail view)
about.html        about
submit.html       submit a dish → pending review queue
admin.html        content management (sign-in required)
404.html          also renders new dishes until their static page is built
dish/*.html       one indexable page per dish (generated)
sitemap.xml       generated
config.js         public settings — Supabase URL + anon key go here
assets/           styles, scripts, sample images
supabase/         database schema + submit-dish function
tools/prerender.mjs + .github/workflows/prerender.yml   page/sitemap builder
```

Until `config.js` has Supabase values, the site runs in **preview mode** with generated sample images, labelled as samples on the page and kept out of the sitemap (`noindex`).

## Going live with Supabase

1. **Create a project** at supabase.com (use the same anonymous Proton email as the rest of the network). Region: Canada (Central).
2. **SQL Editor** → paste and run `supabase/schema.sql`.
3. **Authentication → Users → Add user**: your admin email + password, tick *Auto confirm*. Then in the SQL editor:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'YOUR@EMAIL';
   ```
4. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
5. **Project Settings → API**: copy the Project URL and the **anon / publishable** key into `config.js`.
   Never use the `service_role` / secret key anywhere in this repo.
6. **Edge Functions → Deploy a new function** → name it `submit-dish` → paste `supabase/functions/submit-dish/index.ts` → deploy.
   In the function's settings, turn **off** "Enforce JWT verification" (it is a public form; it validates and rate-limits itself).
   **Edge Functions → Secrets**: add `ALLOWED_ORIGIN` = `https://ottawaplated.com` and `IP_SALT` = any long random string.
7. Upload the updated `config.js`. The samples disappear from the homepage straight away, and the GitHub Action rebuilds the dish pages and sitemap from Supabase (trigger it any time from **Actions → Rebuild dish pages → Run workflow**). Under **Settings → Actions → General → Workflow permissions**, choose *Read and write* so it can commit.

## Day-to-day

Go to `ottawaplated.com/admin.html` and sign in.

- **Add a dish**: choose or drop a photo, drag/zoom the square crop, fill in the fields, tick *Published*, save. The browser makes 1600px and 600px square WebP files; the original is kept so you can re-crop later.
- **Publish / Draft**: click the status pill.
- **Order**: ⤒ ↑ ↓ on each row. New dishes go to the top automatically. *Reset to newest first* undoes manual ordering.
- **Submissions**: *Create dish* opens the editor pre-filled (with the uploaded photo, if any). Instagram-link submissions are reference only — ask the restaurant for the original file; nothing is downloaded from Instagram.

New dishes show on the homepage immediately. Their own `/dish/…html` page works straight away through `404.html`, and becomes a fully static, indexable page the next time the action runs (every 6 hours).

## Deploying changes to the code

Upload changed files through the GitHub web interface as usual. Folder structure matters: keep `assets/`, `dish/`, `supabase/`, `tools/` and `.github/` as folders.

## Local preview

```
node tools/prerender.mjs     # optional: regenerate dish pages / sitemap
python -m http.server 8080   # then open http://localhost:8080
```
