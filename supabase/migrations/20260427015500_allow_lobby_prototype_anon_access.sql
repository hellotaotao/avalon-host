-- Allow the anonymous browser prototype to use the lobby tables through PostgREST.
-- This is intentionally permissive for the current room-flow prototype.
-- Production should replace this with RPCs that verify room membership and device tokens.

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on table public.rooms to anon, authenticated;
grant select, insert, update, delete on table public.players to anon, authenticated;
grant select, insert, update, delete on table public.game_state to anon, authenticated;
grant select, insert, update, delete on table public.private_roles to anon, authenticated;
grant select, insert, update, delete on table public.votes to anon, authenticated;
grant select, insert, update, delete on table public.mission_actions to anon, authenticated;
grant select, insert, update, delete on table public.events to anon, authenticated;

-- Realtime broadcasts table changes only for tables in this publication.
do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.players;
exception
  when duplicate_object then null;
end $$;
