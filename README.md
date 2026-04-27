# Avalon Host

Mobile-first room flow for face-to-face Avalon Lite gatherings. One person creates a room at the table, everyone else joins with a 5-digit numeric code or share link, players mark ready, and the host starts once the lobby is valid.

## Local Run

```bash
npm install
npm run dev
npm test
npm run build
```

When Supabase env vars are absent, the app runs in local browser demo mode using `localStorage`.

## Table Flow

1. Host opens the site and taps **Create Room**.
2. Host enters a nickname, optionally enables Percival/Morgana for 7+ players, and receives a 5-digit room code.
3. Other players open the site, tap **Join Room**, enter the 5-digit room code and nickname. A join URL in the form `/?step=join&code=12345` also opens the join form with the code prefilled.
4. The lobby shows seats, host marker, current player marker, and ready state.
5. Refreshing the same browser restores its current room/player session, and rejoining from the same device reuses the existing seat.
6. Before the game starts, the host can remove stale players from the lobby so abandoned seats do not block start.
7. Host can start only when the room has 5-10 players and every player, including the host, is ready.
8. Starting locks the room, assigns Avalon Lite roles from the actual joined player count, and shows each device its own private reveal.
9. The host can run the Mission MVP from the Table Quest panel: pick the leader's team, record public team vote counts, record mission card counts, and advance the score.

## Share Join

Room screens keep the 5-digit room code prominent for table readout. They also show a readable join link, Copy Link and Copy Code controls, an optional Web Share action when the browser supports it, and a scannable QR code for the join URL. The numeric code remains the fallback.

## Mission MVP Status

Mission flow state is stored in `rooms.settings.missionState` so the existing room subscription updates work without changing the realtime publication. Demo mode updates the local snapshot only and does not write to Supabase.

This MVP is host-driven. Non-host players can view the table state but cannot mutate it. Three failed quests finish with Evil winning. Three successful quests enter a visible placeholder: Good completed three quests, Assassin phase next. The assassin phase itself is not implemented yet.

## Supabase Status

The app is Supabase-ready, but remote project creation is currently blocked by the account free-project limit. No secrets are committed.

Create a local `.env` from `.env.example` when a Supabase project is available:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Schema draft:

```text
supabase/migrations/20260427010500_initial_avalon_host_schema.sql
```

The current RLS policies are intentionally permissive local-prototype drafts. Production needs RPC-based room create/join/start actions, hashed device-token verification, and private role/mission-card access controls before real use.
