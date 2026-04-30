import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getTeamSize } from './domain/avalon';
import {
  advanceMissionResult,
  ensureMissionState,
  recordTeamVote,
  selectMissionTeam,
  type MissionState,
} from './domain/missionFlow';
import { buildJoinUrl, buildStepUrl, parseEntryStep, parseJoinCodeFromUrl, type EntryScreen } from './navigationState';
import { isSupabaseConfigured } from './services/supabaseClient';
import {
  createHostDemoRoom,
  createJoinDemoRoom,
  canStartGame,
  createRoom,
  DEMO_JOIN_ROOM_CODE,
  getRoomById,
  getPrivateRoleInfo,
  getStartValidation,
  joinRoom,
  leaveRoom,
  normalizeRoomCode,
  removePlayer,
  setReady,
  startGame,
  startDemoSnapshot,
  subscribeToRoom,
  updateNickname,
  updateMissionState,
  type RoomPlayer,
  type RoomSnapshot,
} from './services/roomService';
import { getSessionStorageKeys, isDevSessionActive } from './sessionKeys';
import './styles.css';

type Screen = EntryScreen | 'room';

function App() {
  const [screen, setScreen] = useState<Screen>(() => parseEntryStep(window.location.href));
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [currentPlayerId, setCurrentPlayerId] = useState(localStorage.getItem(getSessionStorageKeys().currentPlayerId) ?? '');
  const [deviceToken] = useState(() => getOrCreateDeviceToken());
  const [hostName, setHostName] = useState('');
  const [joinName, setJoinName] = useState('');
  const [joinCode, setJoinCode] = useState(() => parseJoinCodeFromUrl(window.location.href));
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
    const sessionKeys = getSessionStorageKeys();
    const storedRoomId = localStorage.getItem(sessionKeys.currentRoomId);
    const storedPlayerId = localStorage.getItem(sessionKeys.currentPlayerId);
    if (!storedRoomId || !storedPlayerId) return;

    let cancelled = false;
    void getRoomById(storedRoomId)
      .then((restoredSnapshot) => {
        if (cancelled) return;
        if (restoredSnapshot?.players.some((player) => player.id === storedPlayerId)) {
          setCurrentPlayerId(storedPlayerId);
          setSnapshot(restoredSnapshot);
          clearEntryStepFromUrl();
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
    function handlePopState() {
      setScreen((currentScreen) => {
        if (currentScreen === 'room') return currentScreen;
        return parseEntryStep(window.location.href);
      });
      setMessage('');
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (screen !== 'demoJoin') return;
    setJoinCode(DEMO_JOIN_ROOM_CODE);
    setJoinName((current) => current || 'Demo Guest');
  }, [screen]);

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
      clearEntryStepFromUrl();
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
    clearEntryStepFromUrl();
    setScreen('room');
  }

  function openJoinDemo() {
    setJoinCode(DEMO_JOIN_ROOM_CODE);
    setJoinName((current) => current || 'Demo Guest');
    setMessage('');
    navigateEntry('demoJoin');
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
    clearEntryStepFromUrl();
    setScreen('room');
  }

  async function handleJoinRoom(event: React.FormEvent) {
    event.preventDefault();
    const normalizedCode = normalizeRoomCode(joinCode);
    setJoinCode(normalizedCode);
    if (normalizedCode.length !== 5 || !joinName.trim()) return setMessage('Enter the 5-digit room code and nickname.');
    setBusy(true);
    setMessage('');
    try {
      const result = await joinRoom({ code: normalizedCode, displayName: joinName, deviceToken });
      saveSessionBinding(result.snapshot.room.id, result.currentPlayerId);
      setCurrentPlayerId(result.currentPlayerId);
      setSnapshot(result.snapshot);
      clearEntryStepFromUrl();
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
    if (!snapshot || !currentPlayer || startValidation) return;
    const result = isDemoMode ? startDemoSnapshot(snapshot) : await startGame(snapshot.room.id);
    if (result.snapshot) setSnapshot(result.snapshot);
    setMessage(result.ok ? '' : result.reason ?? 'Could not start game.');
  }

  async function handleMissionStateChange(nextMissionState: MissionState) {
    if (!snapshot || !currentPlayer?.isHost) return;
    const nextSnapshot = {
      ...snapshot,
      room: {
        ...snapshot.room,
        status: nextMissionState.phase,
        settings: { ...snapshot.room.settings, missionState: nextMissionState },
      },
    };
    if (isDemoMode) {
      setSnapshot(nextSnapshot);
      return;
    }
    try {
      setSnapshot(await updateMissionState(snapshot.room.id, nextMissionState));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update mission flow.');
    }
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
      navigateEntry('home', { replace: true });
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
      navigateEntry('home', { replace: true });
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
        <h1>{screen === 'room' ? (snapshot?.room.status === 'reveal' ? 'The Merlin Reveal' : 'Round Table Lobby') : 'Gather the Knights of Avalon'}</h1>
        <p className="lede">Summon a room, let every knight ready at the table, then reveal each secret role on their own phone.</p>
        <p className="mode">{isSupabaseConfigured && !isDevSessionActive() ? 'Supabase realtime mode' : 'Local browser demo mode'}</p>
      </header>

      {message && <p className="notice">{message}</p>}

      {screen === 'home' && (
        <section className="entry">
          <div className="panel entry-intro">
            <h2>Let Merlin handle the hidden-role ritual</h2>
            <p>Avalon Host gives the table one magic number, watches the round table fill, and reveals only the secrets each player should know.</p>
          </div>
          <div className="workflow-grid" aria-label="Live workflow">
            <article>
              <strong>1. Host opens the hall</strong>
              <span>Share the 5-digit room code with every knight at the table.</span>
            </article>
            <article>
              <strong>2. Knights take seats</strong>
              <span>The lobby tracks the fellowship and who is ready for the quest.</span>
            </article>
            <article>
              <strong>3. Secrets are revealed</strong>
              <span>Each phone shows only that player's role and night vision.</span>
            </article>
          </div>
          <div className="path-grid" aria-label="Primary actions">
            <button type="button" className="path-card primary-path" onClick={() => navigateEntry('create')}>
              <span>Host the round</span>
              <small>Create a live 5-digit code and become the table herald.</small>
            </button>
            <button type="button" className="path-card" onClick={() => navigateEntry('join')}>
              <span>Join by rune</span>
              <small>Enter the host's 5-digit code and ready up.</small>
            </button>
            <button type="button" className="path-card demo-button" onClick={() => navigateEntry('demo')}>
              <span>Try demo</span>
              <small>Use local sample knights and jump straight to reveal.</small>
            </button>
          </div>
          <div className="panel entry-guide">
            <h2>Choose your path</h2>
            <p><strong>Host</strong> opens a real table room. <strong>Join</strong> is for players with a 5-digit code. <strong>Demo</strong> stays on this device and never connects to Supabase.</p>
          </div>
        </section>
      )}

      {screen === 'demo' && (
        <section className="panel demo-panel">
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>Back</button>
          <h2>Try Demo</h2>
          <p>Demo mode uses bot knights and does not create a real shareable room.</p>
          <div className="demo-options">
            <form className="stack" onSubmit={handleHostDemo}>
              <h3>Host demo</h3>
              <p>Create a sandbox hall with ready bot players, then auto-start the reveal flow.</p>
              <label>
                Your nickname
                <input value={hostName} onChange={(event) => setHostName(event.target.value)} maxLength={24} autoFocus />
              </label>
              <button type="submit" className="primary">Start Host Demo</button>
            </form>
            <div className="stack">
              <h3>Join demo</h3>
              <p>Join a sandbox room that already has a host and ready demo players.</p>
              <button type="button"
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
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>Back</button>
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
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>Back</button>
          <h2>Join Room</h2>
          <form className="stack" onSubmit={handleJoinRoom}>
            <label>
              5-digit room code
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(normalizeRoomCode(event.target.value))}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                placeholder="12345"
                autoComplete="one-time-code"
                autoFocus
              />
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
          <button type="button" className="back-button" onClick={() => navigateEntry('demo')}>Back</button>
          <h2>Join Demo</h2>
          <p>Demo mode uses bot knights and does not create a real shareable room.</p>
          <form className="stack" onSubmit={handleJoinDemo}>
            <label>
              Demo room code
              <input value={joinCode} readOnly aria-label="Demo room code" inputMode="numeric" maxLength={5} />
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
          onMissionStateChange={handleMissionStateChange}
          isDemoMode={isDemoMode}
        />
      )}
    </main>
  );

  function navigateEntry(nextScreen: EntryScreen, options: { replace?: boolean } = {}) {
    const nextUrl = buildStepUrl(window.location.href, nextScreen);
    if (options.replace) {
      window.history.replaceState({ step: nextScreen }, '', nextUrl);
    } else {
      window.history.pushState({ step: nextScreen }, '', nextUrl);
    }
    setScreen(nextScreen);
    setMessage('');
  }
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
  onMissionStateChange,
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
  onMissionStateChange: (missionState: MissionState) => void;
  isDemoMode: boolean;
}) {
  const started = snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup';
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = started && snapshot.players.length >= 5 ? ensureMissionState(snapshot.room.settings.missionState, playerIds) : undefined;
  const currentTeamSize = missionState ? getTeamSize(snapshot.players.length, missionState.roundIndex) : 0;
  const readyCount = snapshot.players.filter((player) => player.isReady).length;
  const neededPlayers = Math.max(0, 5 - snapshot.players.length);
  const canStart = canStartGame(snapshot.players);
  const joinLinkPath = buildJoinUrl(window.location.href, snapshot.room.code);
  const joinLink = `${window.location.origin}${joinLinkPath}`;

  return (
    <section className="room-grid">
      <div className="room-code">
        <span>{isDemoMode ? 'Demo Room Code' : 'Room Code'}</span>
        <strong>{snapshot.room.code}</strong>
        <p>
          {started
            ? 'Room is locked for private role reveal.'
            : isDemoMode
              ? 'Sandbox demo with bot players. This is not a real shareable room.'
              : 'Share this code with players at the table.'}
        </p>
        <div className="share-panel">
          <input value={joinLink} readOnly aria-label="Join link" onFocus={(event) => event.currentTarget.select()} />
          <div className="share-actions">
            <button type="button" onClick={() => copyText(joinLink)}>Copy Link</button>
            <button type="button" onClick={() => copyText(snapshot.room.code)}>Copy Code</button>
            {'share' in navigator && (
              <button type="button" onClick={() => void navigator.share({ title: 'Join Avalon Host', text: `Avalon room ${snapshot.room.code}`, url: joinLink })}>
                Share
              </button>
            )}
          </div>
          <QrCodePanel value={joinLink} />
        </div>
        {currentPlayer && !started && (
          <button type="button" className="small-danger room-leave" onClick={onLeave}>Leave Room</button>
        )}
      </div>

      <section className="panel">
        <h2>{started ? 'Private Reveal' : 'Current Room'}</h2>
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

        {!started && (
          <div className="next-step">
            <strong>{canStart ? 'Everyone is ready.' : 'Waiting to start'}</strong>
            <span>
              {canStart
                ? 'Any ready player can start the game now.'
                : neededPlayers > 0
                  ? `${neededPlayers} more player${neededPlayers === 1 ? '' : 's'} needed.`
                  : startValidation}
            </span>
          </div>
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
        {!started && <p className="hint">{readyCount}/{snapshot.players.length} ready. Minimum 5 players.</p>}
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
        {!started && currentPlayer && (
          <button type="button"
            className="primary"
            disabled={!canStart}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onStart();
            }}
          >
            {canStart ? 'Start Game' : startValidation}
          </button>
        )}
      </section>

      {started && (
        <MissionPanel
          missionState={missionState}
          players={snapshot.players}
          currentPlayer={currentPlayer}
          currentTeamSize={currentTeamSize}
          onMissionStateChange={onMissionStateChange}
        />
      )}
    </section>
  );
}

function MissionPanel({
  missionState,
  players,
  currentPlayer,
  currentTeamSize,
  onMissionStateChange,
}: {
  missionState?: MissionState;
  players: RoomPlayer[];
  currentPlayer?: RoomPlayer;
  currentTeamSize: number;
  onMissionStateChange: (missionState: MissionState) => void;
}) {
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [approveCount, setApproveCount] = useState('');
  const [rejectCount, setRejectCount] = useState('');
  const [successCount, setSuccessCount] = useState('');
  const [failCount, setFailCount] = useState('');
  const [flowError, setFlowError] = useState('');
  const canEdit = Boolean(currentPlayer?.isHost && missionState && missionState.phase !== 'assassin' && missionState.phase !== 'finished');
  const playerIds = players.map((player) => player.id);
  const successes = missionState?.missionResults.filter((result) => result.outcome === 'success').length ?? 0;
  const fails = missionState?.missionResults.filter((result) => result.outcome === 'fail').length ?? 0;

  useEffect(() => {
    setSelectedTeamIds(missionState?.selectedTeamIds ?? []);
    setApproveCount('');
    setRejectCount('');
    setSuccessCount('');
    setFailCount('');
  }, [missionState?.phase, missionState?.roundIndex, missionState?.selectedTeamIds.join('|')]);

  if (!missionState) return null;

  function togglePlayer(playerId: string) {
    setSelectedTeamIds((current) => (current.includes(playerId) ? current.filter((id) => id !== playerId) : [...current, playerId]));
  }

  function submitTeam() {
    if (!missionState) return;
    try {
      setFlowError('');
      onMissionStateChange(selectMissionTeam(missionState, playerIds, selectedTeamIds));
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Could not propose team.');
    }
  }

  function submitVote() {
    if (!missionState) return;
    try {
      setFlowError('');
      onMissionStateChange(recordTeamVote(missionState, playerIds, Number(approveCount), Number(rejectCount)));
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Could not record vote.');
    }
  }

  function submitMission() {
    if (!missionState) return;
    try {
      setFlowError('');
      onMissionStateChange(advanceMissionResult(missionState, playerIds, Number(successCount), Number(failCount)));
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : 'Could not record mission.');
    }
  }

  return (
    <section className="panel mission-panel">
      <h2>Table Quest</h2>
      <div className="quest-track">
        {[0, 1, 2, 3, 4].map((roundIndex) => {
          const result = missionState.missionResults.find((item) => item.roundIndex === roundIndex);
          return (
            <span key={roundIndex} className={result?.outcome ?? (roundIndex === missionState.roundIndex ? 'current' : '')}>
              Q{roundIndex + 1}: {getTeamSize(players.length, roundIndex)}
            </span>
          );
        })}
      </div>
      <div className="status">
        <span>Phase: {missionState.phase}</span>
        <span>Score: Good {successes} / Evil {fails}</span>
        <span>Leader: {players.find((player) => player.id === missionState.leaderPlayerId)?.displayName ?? 'Unknown'}</span>
      </div>
      {flowError && <p className="notice">{flowError}</p>}

      {missionState.phase === 'proposal' && (
        <div className="mission-step">
          <p>Quest {missionState.roundIndex + 1} needs exactly {currentTeamSize} team members.</p>
          <div className="team-picker">
            {players.map((player) => (
              <label key={player.id} className="check">
                <input
                  type="checkbox"
                  checked={selectedTeamIds.includes(player.id)}
                  disabled={!canEdit}
                  onChange={() => togglePlayer(player.id)}
                />
                {player.displayName}
              </label>
            ))}
          </div>
          {canEdit && <button type="button" className="primary" onClick={submitTeam}>Propose Team</button>}
        </div>
      )}

      {missionState.phase === 'vote' && (
        <div className="mission-step">
          <p>Team: {missionState.selectedTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id).join(', ')}</p>
          {canEdit && (
            <div className="count-row">
              <input value={approveCount} onChange={(event) => setApproveCount(event.target.value)} inputMode="numeric" placeholder="Approve" aria-label="Approve count" />
              <input value={rejectCount} onChange={(event) => setRejectCount(event.target.value)} inputMode="numeric" placeholder="Reject" aria-label="Reject count" />
              <button type="button" className="primary" onClick={submitVote}>Record Vote</button>
            </div>
          )}
        </div>
      )}

      {missionState.phase === 'mission' && (
        <div className="mission-step">
          <p>Team approved. Record the mission cards from the table.</p>
          {canEdit && (
            <div className="count-row">
              <input value={successCount} onChange={(event) => setSuccessCount(event.target.value)} inputMode="numeric" placeholder="Success" aria-label="Success cards" />
              <input value={failCount} onChange={(event) => setFailCount(event.target.value)} inputMode="numeric" placeholder="Fail" aria-label="Fail cards" />
              <button type="button" className="primary" onClick={submitMission}>Record Mission</button>
            </div>
          )}
        </div>
      )}

      {missionState.phase === 'assassin' && <p>Good completed three quests - Assassin phase next.</p>}
      {missionState.phase === 'finished' && <p>{missionState.winner === 'evil' ? 'Evil wins after three failed quests.' : 'Good wins.'}</p>}
      {!currentPlayer?.isHost && <p className="hint">Only the host can update the table quest flow.</p>}
    </section>
  );
}

function QrCodePanel({ value }: { value: string }) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=176x176&margin=10&data=${encodeURIComponent(value)}`;
  return (
    <a className="qr-code" href={value} aria-label="Scan QR code to join this Avalon room">
      <img src={qrUrl} alt="QR code for the Avalon room join link" width="176" height="176" loading="lazy" />
    </a>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('input');
  input.value = text;
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function getOrCreateDeviceToken() {
  const key = getSessionStorageKeys().deviceToken;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const token = crypto.randomUUID();
  localStorage.setItem(key, token);
  return token;
}

function saveSessionBinding(roomId: string, playerId: string) {
  const sessionKeys = getSessionStorageKeys();
  localStorage.setItem(sessionKeys.currentRoomId, roomId);
  localStorage.setItem(sessionKeys.currentPlayerId, playerId);
}

function clearSessionBinding() {
  const sessionKeys = getSessionStorageKeys();
  localStorage.removeItem(sessionKeys.currentRoomId);
  localStorage.removeItem(sessionKeys.currentPlayerId);
}

function clearEntryStepFromUrl() {
  window.history.replaceState({ step: 'home' }, '', buildStepUrl(window.location.href, 'home'));
}

const root = createRoot(document.getElementById('root')!);

if (import.meta.env.DEV && window.location.pathname === '/dev/multiplayer') {
  void import('./dev/DevMultiplayerSimulator').then(({ DevMultiplayerSimulator }) => {
    root.render(<DevMultiplayerSimulator />);
  });
} else {
  root.render(<App />);
}
