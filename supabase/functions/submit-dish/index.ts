// Ottawa Plated — public "Submit a dish" endpoint.
// Deploy:  supabase functions deploy submit-dish
// Secrets: supabase secrets set ALLOWED_ORIGIN=https://ottawaplated.com IP_SALT=<any long random string>
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically;
// the service role key never leaves the server.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? 'https://ottawaplated.com';
const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const IG = /^https:\/\/(www\.)?instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/?(\?.*)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX = 10 * 1024 * 1024;

async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Check real image bytes, not just the declared type.
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== ORIGIN) return json({ error: 'Not allowed' }, 403);

  let fd: FormData;
  try { fd = await req.formData(); } catch { return json({ error: 'Invalid form data.' }, 400); }
  const v = (k: string) => String(fd.get(k) ?? '').trim();

  // Spam traps: hidden honeypot field, and forms filled faster than a human could.
  if (v('website')) return json({ ok: true });
  if (Number(v('elapsed')) < 4000) return json({ error: 'Please take a moment and try again.' }, 400);

  const restaurant = v('restaurant'), dish = v('dish'), email = v('email');
  const photographer = v('photographer'), ig = v('instagram_url');
  const photo = fd.get('photo');
  const hasPhoto = photo instanceof File && photo.size > 0;

  if (!restaurant || restaurant.length > 120) return json({ error: 'Please enter the restaurant name.' }, 400);
  if (!dish || dish.length > 140) return json({ error: 'Please enter the dish name.' }, 400);
  if (!EMAIL.test(email) || email.length > 200) return json({ error: 'Please enter a valid email.' }, 400);
  if (!photographer || photographer.length > 120) return json({ error: 'Please credit the photographer.' }, 400);
  if (v('permission') !== 'on') return json({ error: 'Permission confirmation is required.' }, 400);
  if (!ig && !hasPhoto) return json({ error: 'Please add an Instagram link or a photograph.' }, 400);
  if (ig && !IG.test(ig)) return json({ error: 'That Instagram link does not look like a post.' }, 400);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  // Rate limit: 5 submissions per IP per hour (IP stored only as a salted hash).
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ipHash = await sha256(ip + (Deno.env.get('IP_SALT') ?? ''));
  const { count } = await db.from('submissions').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).gte('created_at', new Date(Date.now() - 3600e3).toISOString());
  if ((count ?? 0) >= 5) return json({ error: 'Too many submissions. Please try again later.' }, 429);

  let photo_path: string | null = null;
  if (hasPhoto) {
    const file = photo as File;
    if (file.size > MAX) return json({ error: 'Photographs must be under 10 MB.' }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniff(bytes);
    if (!type) return json({ error: 'Photographs must be JPG, PNG or WebP.' }, 400);
    photo_path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${TYPES[type]}`;
    const up = await db.storage.from('submissions').upload(photo_path, bytes, { contentType: type });
    if (up.error) return json({ error: 'Upload failed. Please try again.' }, 500);
  }

  const { error } = await db.from('submissions').insert({
    restaurant, dish_name: dish, email, photographer,
    instagram_url: ig || null, photo_path, permission_confirmed: true, ip_hash: ipHash,
  });
  if (error) return json({ error: 'Could not save the submission.' }, 500);
  return json({ ok: true });
});
