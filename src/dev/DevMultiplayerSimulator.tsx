import { useMemo, useState } from 'react';
import { LOCAL_ROOMS_STORAGE_KEY, type RoomSnapshot } from '../services/roomService';
import { getStorageKeysForDevSession } from '../sessionKeys';
import './DevMultiplayerSimulator.css';
import { createSimulatorSnapshot, DEV_SESSIONS, removeSimulatorRooms, replaceSimulatorRooms } from './simulatorStorage';

const DEV_ROUTE = '/dev/multiplayer';

export function isDevMultiplayerRoute(location: Location): boolean {
  return location.pathname === DEV_ROUTE;
}

export function DevMultiplayerSimulator() {
  const [reloadKey, setReloadKey] = useState(() => String(Date.now()));
  const frameUrls = useMemo(
    () => DEV_SESSIONS.map((session) => buildPlayerFrameUrl(session.id, reloadKey)),
    [reloadKey],
  );

  function reloadPlayers() {
    setReloadKey(String(Date.now()));
  }

  function seedLobby() {
    const runId = crypto.randomUUID().slice(0, 8);
    const snapshot = createSimulatorSnapshot(runId);

    const data = readLocalRooms();
    localStorage.setItem(LOCAL_ROOMS_STORAGE_KEY, JSON.stringify({ rooms: replaceSimulatorRooms(data.rooms, snapshot) }));
    DEV_SESSIONS.forEach((session, index) => {
      const keys = getStorageKeysForDevSession(session.id);
      localStorage.setItem(keys.currentRoomId, snapshot.room.id);
      localStorage.setItem(keys.currentPlayerId, snapshot.players[index].id);
      localStorage.setItem(keys.deviceToken, snapshot.players[index].deviceToken ?? '');
    });
    window.dispatchEvent(new StorageEvent('storage', { key: LOCAL_ROOMS_STORAGE_KEY }));
    reloadPlayers();
  }

  function clearSimulator() {
    const data = readLocalRooms();
    localStorage.setItem(LOCAL_ROOMS_STORAGE_KEY, JSON.stringify({ rooms: removeSimulatorRooms(data.rooms) }));
    DEV_SESSIONS.forEach((session) => {
      const keys = getStorageKeysForDevSession(session.id);
      localStorage.removeItem(keys.currentRoomId);
      localStorage.removeItem(keys.currentPlayerId);
      localStorage.removeItem(keys.deviceToken);
    });
    window.dispatchEvent(new StorageEvent('storage', { key: LOCAL_ROOMS_STORAGE_KEY }));
    reloadPlayers();
  }

  return (
    <main className="dev-sim-shell">
      <header className="dev-sim-header">
        <div>
          <p className="eyebrow">Developer Tool</p>
          <h1>5-Player Simulator</h1>
        </div>
        <div className="dev-sim-actions">
          <button type="button" className="primary" onClick={seedLobby}>Seed 5-Player Lobby</button>
          <button type="button" onClick={reloadPlayers}>Reload Players</button>
          <button type="button" className="small-danger" onClick={clearSimulator}>Clear Simulator</button>
        </div>
      </header>

      <section className="dev-sim-note">
        <strong>Local-only:</strong> this route is rendered only by Vite dev mode. Each pane uses a separate
        namespaced session identity while sharing the same local room store.
      </section>

      <section className="dev-sim-grid" aria-label="Five isolated Avalon player sessions">
        {DEV_SESSIONS.map((session, index) => (
          <article className="dev-sim-frame" key={session.id}>
            <div className="dev-sim-frame-title">
              <strong>{session.label}</strong>
              <span>{session.role}</span>
            </div>
            <iframe
              title={`${session.label} Avalon session`}
              src={frameUrls[index]}
              sandbox="allow-forms allow-modals allow-same-origin allow-scripts allow-popups"
            />
          </article>
        ))}
      </section>
    </main>
  );
}

function buildPlayerFrameUrl(sessionId: string, reloadKey: string): string {
  const url = new URL('/', window.location.href);
  url.searchParams.set('devSession', sessionId);
  url.searchParams.set('reload', reloadKey);
  return `${url.pathname}${url.search}`;
}

function readLocalRooms(): { rooms: RoomSnapshot[] } {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_ROOMS_STORAGE_KEY) ?? '{"rooms":[]}') as { rooms: RoomSnapshot[] };
  } catch {
    return { rooms: [] };
  }
}
