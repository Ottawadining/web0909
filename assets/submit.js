import { CONFIG, LIVE } from './core.js';

const form = document.getElementById('submit-form');
const status = document.getElementById('f-status');
const send = document.getElementById('f-send');
const started = Date.now();

const IG = /^https:\/\/(www\.)?instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/?(\?.*)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function say(msg, err = false) { status.textContent = msg; status.classList.toggle('err', err); }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const v = (k) => String(fd.get(k) || '').trim();
  const photo = fd.get('photo');
  const hasPhoto = photo && photo.size > 0;

  if (!v('restaurant') || !v('dish') || !v('photographer')) return say('Please complete the restaurant, dish and photographer fields.', true);
  if (!EMAIL.test(v('email'))) return say('Please enter a valid contact email.', true);
  if (!v('instagram_url') && !hasPhoto) return say('Please add an Instagram post link or upload a photograph.', true);
  if (v('instagram_url') && !IG.test(v('instagram_url'))) return say('The Instagram link should look like https://www.instagram.com/p/…', true);
  if (hasPhoto && (photo.size > 10 * 1024 * 1024 || !/^image\/(jpeg|png|webp)$/.test(photo.type))) return say('Photographs must be JPG, PNG or WebP and under 10 MB.', true);
  if (!fd.get('permission')) return say('Please confirm you have permission to authorise publication.', true);

  if (!LIVE) return say('Submissions open soon. Thank you for your patience.', true);

  fd.set('elapsed', String(Date.now() - started));
  if (!hasPhoto) fd.delete('photo');
  send.disabled = true; say('Sending…');
  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/submit-dish`, {
      method: 'POST',
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` },
      body: fd,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Something went wrong. Please try again.');
    form.reset();
    say('Thank you. Your submission is in the review queue.');
  } catch (err) {
    say(err.message, true);
  } finally {
    send.disabled = false;
  }
});
