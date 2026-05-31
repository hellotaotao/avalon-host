-- Veiled Roundtable Neon schema.
-- Apply with DATABASE_URL set server-side; do not expose this value to Vite.

create extension if not exists pgcrypto;

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'lobby' check (status in ('setup', 'lobby', 'locked', 'reveal', 'proposal', 'vote', 'mission', 'assassin', 'finished')),
  game_type text not null default 'avalon_lite',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  display_name text not null,
  device_token_hash text,
  seat_index integer not null,
  is_host boolean not null default false,
  is_ready boolean not null default false,
  is_ai boolean not null default false,
  role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, seat_index)
);

alter table players add column if not exists is_ai boolean not null default false;

create index if not exists rooms_cleanup_idx on rooms(status, updated_at);
create index if not exists players_room_id_idx on players(room_id);
create index if not exists players_room_device_token_idx on players(room_id, device_token_hash);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rooms_set_updated_at on rooms;
create trigger rooms_set_updated_at
before update on rooms
for each row
execute function set_updated_at();

drop trigger if exists players_set_updated_at on players;
create trigger players_set_updated_at
before update on players
for each row
execute function set_updated_at();
