-- Avalon Host initial local schema for Avalon Lite.
-- Prepared for local Supabase only. This repo is intentionally not linked to a remote project.

create extension if not exists "pgcrypto";

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'setup',
  game_type text not null default 'avalon_lite',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  display_name text not null,
  device_token_hash text,
  seat_index integer not null,
  is_host boolean not null default false,
  created_at timestamptz not null default now(),
  unique (room_id, seat_index)
);

create table if not exists public.game_state (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  phase text not null default 'setup',
  round_index integer not null default 0,
  leader_player_id uuid references public.players(id) on delete set null,
  proposed_team uuid[] not null default '{}',
  score jsonb not null default '{"success":0,"fail":0}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.private_roles (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  role text not null,
  allegiance text not null,
  visibility jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (room_id, player_id)
);

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  round_index integer not null,
  proposal_index integer not null default 0,
  vote text not null check (vote in ('approve', 'reject')),
  created_at timestamptz not null default now(),
  unique (room_id, player_id, round_index, proposal_index)
);

create table if not exists public.mission_actions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  round_index integer not null,
  card text not null check (card in ('success', 'fail')),
  created_at timestamptz not null default now(),
  unique (room_id, player_id, round_index)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  actor_player_id uuid references public.players(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.game_state enable row level security;
alter table public.private_roles enable row level security;
alter table public.votes enable row level security;
alter table public.mission_actions enable row level security;
alter table public.events enable row level security;

-- TODO: Replace these permissive local prototype policies with authenticated room membership policies.
-- Draft direction:
-- - rooms/game_state/events: readable by players in the same room.
-- - private_roles: readable only by matching player device token or trusted host service role.
-- - votes/mission_actions: insertable by matching player; public result should be aggregated via RPC/view.

create policy "local prototype read rooms"
  on public.rooms for select
  using (true);

create policy "local prototype read players"
  on public.players for select
  using (true);

create policy "local prototype read game_state"
  on public.game_state for select
  using (true);

create policy "local prototype read events"
  on public.events for select
  using (true);

create policy "local prototype write rooms"
  on public.rooms for all
  using (true)
  with check (true);

create policy "local prototype write players"
  on public.players for all
  using (true)
  with check (true);

create policy "local prototype write game_state"
  on public.game_state for all
  using (true)
  with check (true);

create policy "local prototype write votes"
  on public.votes for all
  using (true)
  with check (true);

create policy "local prototype write mission_actions"
  on public.mission_actions for all
  using (true)
  with check (true);

create policy "local prototype write events"
  on public.events for all
  using (true)
  with check (true);

-- Keep private role reads intentionally undocumented for clients until device-token auth is implemented.
create policy "local prototype private role owner draft"
  on public.private_roles for all
  using (true)
  with check (true);
