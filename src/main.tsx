import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getTeamSize } from './domain/avalon';
import { isSupabaseConfigured } from './services/supabaseClient';
import {
  createHostDemoRoom,
  createJoinDemoRoom,
  createRoom,
  DEMO_JOIN_ROOM_CODE,
  getRoomById,
  getPrivateRoleInfo,
  getStartValidation,
  joinRoom,
  leaveRoom,
  removePlayer,
  setReady,
  startGame,
  startDemoSnapshot,
  subscribeToRoom,
  updateNickname,
  type RoomPlayer,
  type RoomSnapshot,
} from './services/roomService';
import './styles.css';

type Screen = 'home' | 'create' | 'join' | 'demo' | 'demoJoin' | 'room';
const CURRENT_PLAYER_ID_KEY = 'avalon-host.currentPlayerId';
const CURRENT_ROOM_ID_KEY = 'avalon-host.currentRoomId';

function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [currentPlayerId, setCurrentPlayerId] = useState(localStorage.getItem(CURRENT_PLAYER_ID_KEY) ?? '');
  const [deviceToken] = useState(() => getOrCreateDeviceToken());
  const [hostName, setHostName] = useState('');
  const [joinName, setJoinName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [includePercivalMorgana, setIncludePercivalMorgana] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const currentPlayer = snapshot?.players.find((player) => player.id === currentPlayerId);
  const isDemoMode = Boolean(snapshot?.room.settings.createdInDemoMode);
  const startValidation = snapshot ? getStartValidation(snapshot.players) : undefined;
  const privateInfo = useMemo(
    () => (currentPlayer && snapshot ? getPrivateRoleInfo(currentPlayer, snapshot.players) : undefined),
    [currentPlayer, snapshot],
  );

  useEffect(() => {
    const storedRoomId = localStorage.getItem(CURRENT_ROOM_ID_KEY);
    const storedPlayerId = localStorage.getItem(CURRENT_PLAYER_ID_KEY);
    if (!storedRoomId || !storedPlayerId) return;

    let cancelled = false;
    void getRoomById(storedRoomId)
      .then((restoredSnapshot) => {
        if (cancelled) return;
        if (restoredSnapshot?.players.some((player) => player.id === storedPlayerId)) {
          setCurrentPlayerId(storedPlayerId);
          setSnapshot(restoredSnapshot);
          setScreen('room');
          return;
        }
        clearSessionBinding();
        setCurrentPlayerId('');
        setSnapshot(undefined);
        setScreen('join');
        setMessage('You were removed from the room.');
      })
      .catch((error) => {
        if (cancelled) return;
        clearSessionBinding();
        setCurrentPlayerId('');
        setMessage(error instanceof Error ? error.message : 'Could not restore room.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!snapshot || snapshot.room.settings.createdInDemoMode) return undefined;
    return subscribeToRoom(snapshot.room.id, (nextSnapshot) => {
      if (!nextSnapshot) return;
      if (currentPlayerId && !nextSnapshot.players.some((player) => player.id === currentPlayerId)) {
        clearSessionBinding();
        setCurrentPlayerId('');
        setSnapshot(undefined);
        setScreen('join');
        setMessage('You were removed from the room.');
        return;
      }
      setSnapshot(nextSnapshot);
    });
  }, [currentPlayerId, snapshot?.room.id]);

  async function handleCreateRoom(event: React.FormEvent) {
    event.preventDefault();
    if (!hostName.trim()) return setMessage('Enter your nickname first.');
    setBusy(true);
    setMessage('');
    try {
      const result = await createRoom({ displayName: hostName, includePercivalMorgana, deviceToken });
      saveSessionBinding(result.snapshot.room.id, result.currentPlayerId);
      setCurrentPlayerId(result.currentPlayerId);
      setSnapshot(result.snapshot);
      setScreen('room');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create room.');
    } finally {
      setBusy(false);
    }
  }

  function handleHostDemo(event: React.FormEvent) {
    event.preventDefault();
    if (!hostName.trim()) return setMessage('Enter your nickname first.');
    setMessage('');
    const result = createHostDemoRoom(hostName);
    const startedDemo = startDemoSnapshot(result.snapshot);
    clearSessionBinding();
    setCurrentPlayerId(result.currentPlayerId);
    setSnapshot(startedDemo.snapshot ?? result.snapshot);
    setMessage(startedDemo.ok ? 'Demo room auto-started so you can see the reveal flow.' : startedDemo.reason ?? 'Demo room is ready.');
    setScreen('room');
  }

  function openJoinDemo() {
    setJoinCode(DEMO_JOIN_ROOM_CODE);
    setJoinName((current) => current || 'Demo Guest');
    setMessage('');
    setScreen('demoJoin');
  }

  function handleJoinDemo(event: React.FormEvent) {
    event.preventDefault();
    if (!joinName.trim()) return setMessage('Enter your nickname first.');
    const result = createJoinDemoRoom(joinName);
    const startedDemo = startDemoSnapshot(result.snapshot);
    clearSessionBinding();
    setCurrentPlayerId(result.currentPlayerId);
    setSnapshot(startedDemo.snapshot ?? result.snapshot);
    setMessage(startedDemo.ok ? 'Demo room auto-started so you can see the reveal flow.' : startedDemo.reason ?? 'Demo room is ready.');
    setScreen('room');
  }

  async function handleJoinRoom(event: React.FormEvent) {
    event.preventDefault();
    if (!joinCode.trim() || !joinName.trim()) return setMessage('Enter room code and nickname.');
    setBusy(true);
    setMessage('');
    try {
      const result = await joinRoom({ code: joinCode, displayName: joinName, deviceToken });
      saveSessionBinding(result.snapshot.room.id, result.currentPlayerId);
      setCurrentPlayerId(result.currentPlayerId);
      setSnapshot(result.snapshot);
      setScreen('room');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not join room.');
    } finally {
      setBusy(false);
    }
  }

  async function handleReady() {
    if (!snapshot || !currentPlayer) return;
    if (isDemoMode) {
      setSnapshot({
        ...snapshot,
        players: snapshot.players.map((player) => (player.id === currentPlayer.id ? { ...player, isReady: !player.isReady } : player)),
      });
      return;
    }
    setSnapshot(await setReady(snapshot.room.id, currentPlayer.id, !currentPlayer.isReady));
  }

  async function handleRename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !currentPlayer) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('displayName') ?? '').trim();
    if (!name) return;
    if (isDemoMode) {
      setSnapshot({
        ...snapshot,
        players: snapshot.players.map((player) => (player.id === currentPlayer.id ? { ...player, displayName: name } : player)),
      });
      return;
    }
    setSnapshot(await updateNickname(snapshot.room.id, currentPlayer.id, name));
  }

  async function handleStartGame() {
    if (!snapshot || !currentPlayer?.isHost) return;
    const result = isDemoMode ? startDemoSnapshot(snapshot) : await startGame(snapshot.room.id);
    if (result.snapshot) setSnapshot(result.snapshot);
    setMessage(result.ok ? '' : result.reason ?? 'Could not start game.');
  }

  async function handleRemovePlayer(targetPlayerId: string) {
    if (!snapshot || !currentPlayer?.isHost) return;
    setMessage('');
    if (isDemoMode) return;
    try {
      setSnapshot(await removePlayer(snapshot.room.id, currentPlayer.id, targetPlayerId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not remove player.');
    }
  }

  async function handleLeaveRoom() {
    if (!snapshot || !currentPlayer) return;
    setBusy(true);
    setMessage('');
    if (isDemoMode) {
      setCurrentPlayerId('');
      setSnapshot(undefined);
      setScreen('home');
      setMessage('You left the demo room.');
      setBusy(false);
      return;
    }
    const roomId = snapshot.room.id;
    const playerId = currentPlayer.id;
    try {
      await leaveRoom(roomId, playerId);
      clearSessionBinding();
      setCurrentPlayerId('');
      setSnapshot(undefined);
      setScreen('home');
      setMessage('You left the room.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not leave room.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Avalon Host</p>
        <h1>Room Flow</h1>
        {screen !== 'room' && (
          <div className="hero-actions" aria-label="Primary actions">
            <button type="button" className="primary" onClick={() => setScreen('create')}>Create Room</button>
            <button type="button" onClick={() => setScreen('join')}>Join Room</button>
            <button type="button" className="demo-button" onClick={() => setScreen('demo')}>Try Demo</button>
          </div>
        )}
        <p className="lede">Create a table room, share the four-character code, ready up, then reveal roles on each phone.</p>
        <p className="mode">{isSupabaseConfigured ? 'Supabase realtime mode' : 'Local browser demo mode'}</p>
      </header>

      {message && <p className="notice">{message}</p>}

      {screen === 'home' && (
        <section className="panel">
          <h2>Start at the table</h2>
          <p>One player creates the room and becomes host. Everyone else joins from their own phone with the room code.</p>
        </section>
      )}

      {screen === 'demo' && (
        <section className="panel demo-panel">
          <h2>Try Demo</h2>
          <p>Demo mode uses bot players and does not create a real shareable room.</p>
          <div className="demo-options">
            <form className="stack" onSubmit={handleHostDemo}>
              <h3>Host demo</h3>
              <p>Create a sandbox room with ready bot players, then auto-start the reveal flow.</p>
              <label>
                Your nickname
                <input value={hostName} onChange={(event) => setHostName(event.target.value)} maxLength={24} autoFocus />
              </label>
              <button type="submit" className="primary">Start Host Demo</button>
            </form>
            <div className="stack">
              <h3>Join demo</h3>
              <p>Join a sandbox room that already has a host and other ready demo players.</p>
              <button
                type="button"
                className="primary"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openJoinDemo();
                }}
              >
                Open Join Demo
              </button>
            </div>
          </div>
        </section>
      )}

      {screen === 'create' && (
        <section className="panel">
          <h2>Create Room</h2>
          <form className="stack" onSubmit={handleCreateRoom}>
            <label>
              Your nickname
              <input value={hostName} onChange={(event) => setHostName(event.target.value)} maxLength={24} autoFocus />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={includePercivalMorgana}
                onChange={(event) => setIncludePercivalMorgana(event.target.checked)}
              />
              Include Percival and Morgana when 7+ players join
            </label>
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating...' : 'Create Room'}</button>
          </form>
        </section>
      )}

      {screen === 'join' && (
        <section className="panel">
          <h2>Join Room</h2>
          <form className="stack" onSubmit={handleJoinRoom}>
            <label>
              Room code
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} maxLength={4} autoFocus />
            </label>
            <label>
              Your nickname
              <input value={joinName} onChange={(event) => setJoinName(event.target.value)} maxLength={24} />
            </label>
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Joining...' : 'Join Room'}</button>
          </form>
        </section>
      )}

      {screen === 'demoJoin' && (
        <section className="panel demo-panel">
          <h2>Join Demo</h2>
          <p>Demo mode uses bot players and does not create a real shareable room.</p>
          <form className="stack" onSubmit={handleJoinDemo}>
            <label>
              Demo room code
              <input value={joinCode} readOnly aria-label="Demo room code" />
            </label>
            <label>
              Your nickname
              <input value={joinName} onChange={(event) => setJoinName(event.target.value)} maxLength={24} autoFocus />
            </label>
            <button type="submit" className="primary">Confirm Demo Join</button>
          </form>
        </section>
      )}

      {screen === 'room' && snapshot && (
        <RoomView
          snapshot={snapshot}
          currentPlayer={currentPlayer}
          privateInfo={privateInfo}
          startValidation={startValidation}
          onReady={handleReady}
          onStart={handleStartGame}
          onRename={handleRename}
          onRemovePlayer={handleRemovePlayer}
          onLeave={handleLeaveRoom}
          isDemoMode={isDemoMode}
        />
      )}
    </main>
  );
}

function RoomView({
  snapshot,
  currentPlayer,
  privateInfo,
  startValidation,
  onReady,
  onStart,
  onRename,
  onRemovePlayer,
  onLeave,
  isDemoMode,
}: {
  snapshot: RoomSnapshot;
  currentPlayer?: RoomPlayer;
  privateInfo?: ReturnType<typeof getPrivateRoleInfo>;
  startValidation?: string;
  onReady: () => void;
  onStart: () => void;
  onRename: (event: React.FormEvent<HTMLFormElement>) => void;
  onRemovePlayer: (targetPlayerId: string) => void;
  onLeave: () => void;
  isDemoMode: boolean;
}) {
  const started = snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup';
  const currentTeamSize = snapshot.players.length >= 5 && snapshot.players.length <= 10 ? getTeamSize(snapshot.players.length, 0) : 0;

  return (
    <section className="room-grid">
      <div className="room-code">
        <span>{isDemoMode ? 'Demo Room Code' : 'Room Code'}</span>
        <strong>{snapshot.room.code}</strong>
        {isDemoMode && <p>Sandbox demo with bot players. This is not a real shareable room.</p>}
        {currentPlayer && !started && (
          <button type="button" className="small-danger" onClick={onLeave}>Leave Room</button>
        )}
      </div>

      <section className="panel">
        <h2>{started ? 'Private Reveal' : isDemoMode ? 'Demo Lobby' : 'Lobby'}</h2>
        {currentPlayer && !started && (
          <>
            <form className="inline-form" onSubmit={onRename}>
              <input name="displayName" defaultValue={currentPlayer.displayName} maxLength={24} aria-label="Nickname" />
              <button type="submit">Save</button>
            </form>
            <button type="button" className={currentPlayer.isReady ? 'active-soft' : 'primary'} onClick={onReady}>
              {currentPlayer.isReady ? 'Ready' : 'Set Ready'}
            </button>
          </>
        )}

        {started && privateInfo && (
          <div className="role-box">
            <p className="eyebrow">Only for {currentPlayer?.displayName}</p>
            <h3>{privateInfo.role}</h3>
            <p>{privateInfo.allegiance === 'good' ? 'Good team' : 'Evil team'}</p>
            <h4>Night information</h4>
            {privateInfo.sees.length ? (
              <ul>{privateInfo.sees.map((item) => <li key={item.playerId}>{item.name}: {item.hint}</li>)}</ul>
            ) : (
              <p>No extra night information.</p>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Players</h2>
        <ol className="players">
          {snapshot.players.map((player) => (
            <li key={player.id} className={player.id === currentPlayer?.id ? 'me' : ''}>
              <span>{player.displayName}</span>
              <small>{player.isHost ? 'Host' : `Seat ${player.seatIndex + 1}`}</small>
              <strong>{started ? (player.id === currentPlayer?.id ? player.role : 'Locked') : player.isReady ? 'Ready' : 'Waiting'}</strong>
              {!started && currentPlayer?.isHost && !player.isHost && !isDemoMode && (
                <button type="button" className="small-danger" onClick={() => onRemovePlayer(player.id)}>Remove</button>
              )}
            </li>
          ))}
        </ol>
        {!started && <p className="hint">{startValidation ?? 'All set. Host can start now.'}</p>}
        {!started && currentPlayer?.isHost && (
          <button
            type="button"
            className="primary"
            disabled={Boolean(startValidation)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onStart();
            }}
          >
            Start Game
          </button>
        )}
      </section>

      {started && (
        <section className="panel">
          <h2>Table State</h2>
          <div className="status">
            <span>Status: {snapshot.room.status}</span>
            <span>Players: {snapshot.players.length}</span>
            <span>Mission 1 team: {currentTeamSize || '-'}</span>
          </div>
          <p>Room is locked. Continue with the Avalon Lite table flow using the revealed roles.</p>
        </section>
      )}
    </section>
  );
}

function getOrCreateDeviceToken() {
  const key = 'avalon-host.deviceToken';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const token = crypto.randomUUID();
  localStorage.setItem(key, token);
  return token;
}

function saveSessionBinding(roomId: string, playerId: string) {
  localStorage.setItem(CURRENT_ROOM_ID_KEY, roomId);
  localStorage.setItem(CURRENT_PLAYER_ID_KEY, playerId);
}

function clearSessionBinding() {
  localStorage.removeItem(CURRENT_ROOM_ID_KEY);
  localStorage.removeItem(CURRENT_PLAYER_ID_KEY);
}

createRoot(document.getElementById('root')!).render(<App />);
