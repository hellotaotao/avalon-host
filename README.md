# TableHost / Avalon Lite

Offline-first host prototype for face-to-face Avalon-style gatherings. This MVP is a local React workflow prototype with mock room/device state and no remote backend connection.

## Local Run

```bash
npm install
npm run dev
npm test
npm run build
```

## MVP Scope

- Create room and join room mock flow.
- Host, player, and public table panels.
- Configurable 5-10 player roster.
- Avalon Lite role assignment with Merlin, Assassin, Loyal Servants, and Minions.
- Optional Percival and Morgana for 7+ player tables.
- Private per-player role reveal and night information.
- Team proposal, approve/reject voting, hidden mission card collection, mission result reveal.
- Mission timeline/event log and assassin endgame guess.

This is intentionally a runnable tabletop workflow, not a landing page. State is in-browser only and resets on reload.

## Supabase Status

Supabase is prepared locally only. The repo is not linked to any remote Supabase project, and no project has been created.

Initial schema lives at:

```text
supabase/migrations/20260427010500_initial_tablehost_schema.sql
```

It includes `rooms`, `players`, `game_state`, `private_roles`, `votes`, `mission_actions`, and `events` with RLS enabled. Current policies are permissive local-prototype drafts with TODO comments for room membership and private role access.

## Next Steps

- Add persisted local storage so room flow survives refresh.
- Replace mock device tokens with QR/device-token room join links.
- Move game state writes behind Supabase RPCs to prevent clients from seeing hidden roles/cards.
- Add host recovery and multi-device sync.
- Add Werewolf mode after Avalon Lite is stable.
