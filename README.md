# Avalon Host

Mobile-first room flow for face-to-face Avalon Lite gatherings. One person creates a room at the table, everyone else joins with a four-character code, players mark ready, and the host starts once the lobby is valid.

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
2. Host enters a nickname, optionally enables Percival/Morgana for 7+ players, and receives a room code.
3. Other players open the site, tap **Join Room**, enter the room code and nickname.
4. The lobby shows seats, host marker, current player marker, and ready state.
5. Host can start only when the room has 5-10 players and every player, including the host, is ready.
6. Starting locks the room, assigns Avalon Lite roles from the actual joined player count, and shows each device its own private reveal.

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
