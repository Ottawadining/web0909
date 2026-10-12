-- Ottawa Plated — Supabase schema
-- Run once in Supabase → SQL Editor. Safe to re-run.

-- ============ admins ============
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- nobody reads/writes this table through the API; it's managed in the SQL editor.

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
grant execute on function public.is_admin() to anon, authenticated;

-- ============ dishes ============
create table if not exists public.dishes (
  id uuid primary key default gen_random_uuid(),
  catalog_no integer generated always as identity unique,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  dish_name text not null check (char_length(dish_name) between 1 and 140),
  restaurant text not null check (char_length(restaurant) between 1 and 120),
  description text check (char_length(description) <= 300),
  link_url text check (link_url is null or link_url ~ '^https://'),
  photographer text check (char_length(photographer) <= 120),
  image_thumb text not null,     -- storage path in bucket "dishes" (600px square)
  image_full text not null,      -- storage path (1600px square)
  image_original text,           -- storage path of the uploaded original, for re-cropping
  crop jsonb,                    -- {x, y, size} in original pixels
  published boolean not null default false,
  sort_order double precision not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dishes_public_order on public.dishes (published, sort_order, published_at desc);

-- New dishes go to the top (newest first); publishing stamps the date once.
create or replace function public.dishes_before_write()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.sort_order := coalesce((select min(sort_order) from public.dishes), 0) - 1;
  end if;
  if new.published and new.published_at is null then
    new.published_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists dishes_before_write on public.dishes;
create trigger dishes_before_write before insert or update on public.dishes
for each row execute function public.dishes_before_write();

alter table public.dishes enable row level security;
drop policy if exists "public reads published" on public.dishes;
create policy "public reads published" on public.dishes for select
  using (published or public.is_admin());
drop policy if exists "admins insert" on public.dishes;
create policy "admins insert" on public.dishes for insert to authenticated with check (public.is_admin());
drop policy if exists "admins update" on public.dishes;
create policy "admins update" on public.dishes for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete" on public.dishes;
create policy "admins delete" on public.dishes for delete to authenticated using (public.is_admin());

-- Reset to newest-first ordering (called from the admin).
create or replace function public.reset_dish_order()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.dishes d set sort_order = r.rn
  from (select id, row_number() over (order by coalesce(published_at, created_at) desc) as rn from public.dishes) r
  where d.id = r.id;
end $$;
grant execute on function public.reset_dish_order() to authenticated;

-- ============ submissions (pending review queue) ============
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  restaurant text not null check (char_length(restaurant) between 1 and 120),
  dish_name text not null check (char_length(dish_name) between 1 and 140),
  email text not null check (char_length(email) <= 200),
  instagram_url text check (instagram_url is null or instagram_url ~ '^https://(www\.)?instagram\.com/'),
  photo_path text,               -- path in private bucket "submissions"
  photographer text not null check (char_length(photographer) <= 120),
  permission_confirmed boolean not null check (permission_confirmed),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  ip_hash text,
  created_at timestamptz not null default now(),
  check (instagram_url is not null or photo_path is not null)
);
create index if not exists submissions_ip_recent on public.submissions (ip_hash, created_at desc);
alter table public.submissions enable row level security;
-- No public policies: inserts happen only in the submit-dish edge function (service role).
drop policy if exists "admins read submissions" on public.submissions;
create policy "admins read submissions" on public.submissions for select to authenticated using (public.is_admin());
drop policy if exists "admins update submissions" on public.submissions;
create policy "admins update submissions" on public.submissions for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins delete submissions" on public.submissions;
create policy "admins delete submissions" on public.submissions for delete to authenticated using (public.is_admin());

-- ============ storage ============
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dishes', 'dishes', true, 26214400, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = true;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('submissions', 'submissions', false, 10485760, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false;

drop policy if exists "admins write dishes bucket" on storage.objects;
create policy "admins write dishes bucket" on storage.objects for insert to authenticated
  with check (bucket_id = 'dishes' and public.is_admin());
drop policy if exists "admins update dishes bucket" on storage.objects;
create policy "admins update dishes bucket" on storage.objects for update to authenticated
  using (bucket_id = 'dishes' and public.is_admin());
drop policy if exists "admins delete dishes bucket" on storage.objects;
create policy "admins delete dishes bucket" on storage.objects for delete to authenticated
  using (bucket_id = 'dishes' and public.is_admin());
drop policy if exists "admins read submissions bucket" on storage.objects;
create policy "admins read submissions bucket" on storage.objects for select to authenticated
  using (bucket_id = 'submissions' and public.is_admin());
drop policy if exists "admins delete submissions bucket" on storage.objects;
create policy "admins delete submissions bucket" on storage.objects for delete to authenticated
  using (bucket_id = 'submissions' and public.is_admin());

-- ============ make yourself an admin ============
-- 1. Authentication → Users → Add user (email + password; "Auto confirm").
-- 2. Then run, with that email:
-- insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
