-- Jarvis Mobile : schéma Supabase.
-- À coller dans Supabase > SQL Editor > New query, puis "Run".
-- Seul l'utilisateur dont l'e-mail est ci-dessous peut lire ou modifier les données depuis l'app.
-- Le worker du Mac utilise la clé service_role, qui passe outre ces règles.

create or replace function public.is_owner() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'celissemaxence20@gmail.com'
$$;

-- Posts LinkedIn / Instagram préparés par l'agent Visuels
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  folder text unique not null,              -- dossier local, sert de clé de synchro
  day_label text,                           -- « Mercredi 14/10 »
  title text not null,
  kind text not null default 'carrousel',   -- carrousel | video
  images text[] not null default '{}',      -- chemins dans le bucket « visuels »
  text_li text,
  text_ig text,
  canva_url text,
  chef_score numeric,
  chef_note text,
  status text not null default 'pending'
    check (status in ('pending','approved','publishing','published','rejected','failed')),
  networks text[] not null default '{linkedin,instagram}',
  decided_at timestamptz,
  published_at timestamptz,
  error text
);

-- Prospects contactés par mail
create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  entreprise text not null,
  zone text,
  ville text,
  sent_on date,
  subject text,
  angle text,
  message_id text,
  status text not null default 'envoyé',
  relance_on date,
  replied_at timestamptz,
  reply_snippet text
);

-- Prospects à appeler
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  nom text unique not null,
  ville text,
  added_on text,
  phone text,
  who text,
  hook text,
  whatsapp text,
  priority int not null default 99,
  result text,
  result_at timestamptz
);

-- Passages des agents (lus dans les logs)
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  log_file text unique not null,
  agent text not null,                      -- prospection | visuels | recap
  started_at timestamptz not null,
  level text not null default 'ok' check (level in ('ok','warn','bad')),
  title text,
  summary text
);

-- Alertes à traiter
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  key text unique,                          -- évite les doublons
  level text not null default 'warn' check (level in ('info','warn','bad')),
  title text not null,
  body text,
  resolved boolean not null default false
);

-- Chat avec les agents
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent text not null,                      -- prospection | visuels | recap | jarvis
  role text not null check (role in ('me','bot')),
  body text not null,
  status text not null default 'new' check (status in ('new','processing','done','failed'))
);

-- Abonnements aux notifications push (un par appareil)
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  sub jsonb not null,
  device text,
  created_at timestamptz not null default now()
);

-- Sécurité : tout est fermé sauf pour le propriétaire
do $$
declare t text;
begin
  foreach t in array array['posts','prospects','calls','agent_runs','alerts','messages','push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- Temps réel : l'app se met à jour toute seule
alter publication supabase_realtime add table public.posts, public.messages, public.alerts, public.calls, public.prospects, public.agent_runs;

-- Stockage privé des images des carrousels
insert into storage.buckets (id, name, public) values ('visuels', 'visuels', false)
on conflict (id) do nothing;
drop policy if exists owner_read_visuels on storage.objects;
create policy owner_read_visuels on storage.objects for select to authenticated
  using (bucket_id = 'visuels' and public.is_owner());

-- Signal de vie du Mac (le worker l'écrit toutes les 15 s)
create table if not exists public.heartbeat (id int primary key, at timestamptz not null default now());
alter table public.heartbeat enable row level security;
drop policy if exists owner_all on public.heartbeat;
create policy owner_all on public.heartbeat for select to authenticated using (public.is_owner());
