# Avalon Host

Mobile-first room flow for face-to-face Avalon Lite gatherings. One person creates a room at the table, everyone else joins with a 5-digit numeric code or share link, players mark ready, and the host starts once the lobby is valid.

## Local Run

```bash
npm install
npm run dev
npm test
npm run build
```

In production, the app uses Vercel serverless functions backed by Neon Postgres. In local Vite dev, it runs in browser demo mode using `localStorage` unless `VITE_USE_NEON_API=true` is set while a local Vercel API server is running.

## Demo Simulator

The homepage **Try demo** path now opens a local-only tabletop simulator instead of creating a fake room. It does not write to Neon and does not use the live host/join backend.

Demo supports:

- Player counts from 5-10 with normal Avalon Good/Evil counts: 5=3/2, 6=4/2, 7=4/3, 8=5/3, 9=6/3, 10=6/4.
- Role presets with Merlin and Assassin fixed. Normal Loyal Servant/Minion cards fill the remaining slots.
- Optional special-role toggles for Percival, Morgana, Mordred, and Oberon when the selected table has enough Good/Evil slots.
- Avalon Lite quest team sizes; any fail card fails the quest:
  - 5: 2,3,2,3,3
  - 6: 2,3,4,3,4
  - 7: 2,3,3,4,4
  - 8-10: 3,4,4,5,5
- A multi-phone table view where every player has a virtual phone. Each phone can show/hide that player's own role and night information.
- Demo and live play share the same `PlayerPhone` surface for role, night information, and player-facing phase actions. Demo mode controls reveal state persistently for operating many phones; live mode uses protected per-player peek controls.
- Local table state for leader, quest round, team selection, public approve/reject votes, anonymous mission success/fail cards, and score progress.

## Developer 5-Player Simulator

For one-Mac manual testing, run the Vite dev server and open the dev-only simulator:

```bash
npm run dev:multi
```

If the browser does not open automatically, visit:

```text
http://127.0.0.1:5173/dev/multiplayer
```

The simulator embeds five same-origin player panes. They share the local room store but each pane has its own namespaced session identity (`devSession=tao-p1` through `tao-p5`), so Tao can click as five different players without Neon.

Useful controls:

- **Seed 5-Player Lobby** creates a fresh local room with five unready Tao players and binds each pane to a different seat.
- **Reload Players** refreshes the embedded panes without changing local room data.
- **Clear Simulator** removes the local room and simulator session keys.

The route is guarded by `import.meta.env.DEV`, so production builds do not render the test UI. It is intentionally not linked from the normal app.

## Live 5-Tab Demo Script

To watch a full local 5-player room flow on this Mac:

```bash
npm run demo:five-tabs
```

The script starts Vite if needed, opens a headed Chromium window with five independent player tabs, creates a room, joins all five players, marks them ready, starts the game, reveals roles, approves the first quest team, submits mission cards, and leaves the browser open at the resulting table state.

Useful flags:

```bash
npm run demo:five-tabs -- --headless --close
```

That mode verifies the same flow without leaving a visible browser open.

The script uses dev-only `devSession` URL parameters so each tab gets its own player identity while sharing the same local room store. It does not require Neon and does not write production data.

## Automated 5-Player Smoke Test

Run only the five-player smoke:

```bash
npm run test:five-player
```

The smoke test uses the local room service with mocked browser storage. It creates one host, joins four more players, marks all five ready, starts the game, and verifies every player reaches the private role reveal state. No Neon database, secrets, browser install, or network access is required.

## Table Flow

1. Host opens the site and taps **Create Room**.
2. Host enters a nickname, optionally enables Percival/Morgana for 7+ players, and receives a 5-digit room code.
3. Other players open the site, tap **Join Room**, enter the 5-digit room code and nickname. A join URL in the form `/?step=join&code=12345` also opens the join form with the code prefilled.
4. The lobby shows seats, host marker, current player marker, and ready state.
5. Refreshing the same browser restores its current room/player session, and rejoining from the same device reuses the existing seat.
6. Before the game starts, the host can remove stale players from the lobby so abandoned seats do not block start.
7. Host can start once 5-10 players are ready; unready non-host players are left out of that game.
8. Starting locks the room, assigns Avalon Lite roles from the active ready player count, and shows each device its own private reveal.
9. Mission play runs from the players' own phones: the current leader proposes the team, every player votes approve/reject, and selected mission players submit Success/Fail cards. Good players cannot submit Fail.
10. Three successful missions enter the Assassin endgame. Normal missions pause, every player sees the Assassin warning, and the current Assassin can choose a Merlin target from the dedicated Assassin phase panel. Hitting Merlin gives Evil the win; missing Merlin gives Good the win.

Live private reveal and the demo's multi-phone cards now render through the shared `PlayerPhone` component. The live room keeps role/night information behind protected peek covers, while demo mode can keep individual phone reveals open for tabletop simulation.

## Share Join

Room screens keep the 5-digit room code prominent for table readout before the game starts and after it finishes. They also show a readable join link, Copy Link and Copy Code controls, and a scannable QR code for the join URL. The numeric code remains the fallback.

## Mission MVP Status

Mission flow state is stored in `rooms.settings.missionState`. Live room updates are fetched through a Vercel API polling loop; demo mode updates the local snapshot only and does not write to Neon.

Normal live play is phone-driven. The Table Quest panel remains a status surface with host backup controls, but it is no longer the only way to progress proposals, votes, or mission results. Individual team votes are tracked in mission state, and mission cards are stored as submitted-player markers plus an anonymous card pile until every selected player has submitted; only then is the public success/fail aggregate revealed. After three successful quests, the assigned Assassin can submit the Merlin guess from the dedicated Assassin phase panel. Three failed quests finish with Evil winning; an Assassin hit on Merlin also gives Evil the win; an Assassin miss gives Good the win.

## Neon Status

The hosted app uses Neon through Vercel serverless API routes. No database URL or password is exposed to the frontend and no secrets are committed.

Set `DATABASE_URL` in Vercel for production. For local API testing, run through Vercel with `DATABASE_URL` available and opt the Vite frontend into the API:

```bash
DATABASE_URL=postgres://...
VITE_USE_NEON_API=true
```

Apply the schema with:

```bash
npm run db:schema
```

Schema source:

```text
db/schema.sql
```

The current API intentionally preserves the prototype security posture: device tokens are still lightweight seat-rejoin identifiers, and room actions are server-mediated but not a full auth rewrite.

## Neon Cleanup

Rooms are temporary and are cleaned by the scheduled Vercel API route at `/api/cleanup` to keep the Neon Free storage footprint small. The cleanup deletes rooms, relying on the `players.room_id` `ON DELETE CASCADE` foreign key to remove player rows too. It does not store access logs.

Cleanup thresholds:

- Finished rooms: deleted after 7 days without updates.
- Abandoned setup/lobby rooms: deleted after 48 hours without updates.
- Other in-progress rooms (`locked`, `reveal`, `proposal`, `vote`, `mission`, `assassin`): deleted only after 7 days without updates to avoid disrupting active games.

`vercel.json` schedules the cleanup daily at 03:00 UTC. For production, set `CRON_SECRET` in Vercel; Vercel Cron will send `Authorization: Bearer $CRON_SECRET` and the endpoint will require it. If `CRON_SECRET` is not set, the endpoint accepts Vercel's `x-vercel-cron: 1` header for prototype deployments.
