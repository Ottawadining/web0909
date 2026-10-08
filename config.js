// Ottawa Plated — public site configuration.
//
// SUPABASE_URL and SUPABASE_ANON_KEY are safe to publish: the anon key is designed to be
// public, and row-level security in supabase/schema.sql limits it to reading published dishes.
// NEVER put the service_role key in this file (or anywhere in this repository).
//
// While both values are empty, the site runs in preview mode with labelled sample images.

export default {
  SITE_URL: 'https://ottawaplated.com',
  SITE_NAME: 'Ottawa Plated',
  SUPABASE_URL: '',        // e.g. 'https://abcdefghijkl.supabase.co'
  SUPABASE_ANON_KEY: '',   // Project Settings → API → anon / publishable key
  PAGE_SIZE: 18,
};
