import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildRolePreset,
  getPlayerCountRule,
  getTeamSize,
  getVisibilityInfo,
  playerCountRange,
  resolveMission,
  roleAllegiance,
  type Allegiance,
  type MissionCard,
  type Player,
  type Role,
  type RolePresetOptions,
  type VisibilityInfo,
  type Vote,
} from './domain/avalon';
import {
  advanceMissionResult,
  ensureMissionState,
  recordTeamVote,
  resolveAssassination,
  selectMissionTeam,
  submitMissionCard as submitMissionCardToState,
  submitTeamProposal,
  submitTeamVote as submitTeamVoteToState,
  type MissionResultState,
  type MissionState,
} from './domain/missionFlow';
import { buildJoinUrl, buildStepUrl, parseEntryStep, parseJoinCodeFromUrl, type EntryScreen } from './navigationState';
import {
  canStartGame,
  createRoom,
  getRoomById,
  getPrivateRoleInfo,
  getStartValidation,
  joinRoom,
  leaveRoom,
  normalizeRoomCode,
  proposeMissionTeam,
  removePlayer,
  setReady,
  startGame,
  submitAssassination,
  submitMissionCard,
  submitTeamVote,
  subscribeToRoom,
  updateNickname,
  updateMissionState,
  isHostedConfigured,
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
    const result = await startGame(snapshot.room.id);
    if (result.snapshot) setSnapshot(result.snapshot);
    setMessage(result.ok ? '' : result.reason ?? 'Could not start game.');
  }

  async function handleMissionStateChange(nextMissionState: MissionState) {
    if (!snapshot || !currentPlayer) return;
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

  async function handleProposeMissionTeam(selectedTeamIds: string[]) {
    if (!snapshot || !currentPlayer) return;
    setMessage('');
    if (isDemoMode) {
      try {
        const playerIds = snapshot.players.map((player) => player.id);
        const currentMissionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
        const nextMissionState = submitTeamProposal(currentMissionState, playerIds, currentPlayer.id, selectedTeamIds);
        await handleMissionStateChange(nextMissionState);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not propose team.');
      }
      return;
    }
    try {
      setSnapshot(await proposeMissionTeam(snapshot.room.id, currentPlayer.id, selectedTeamIds));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not propose team.');
    }
  }

  async function handleSubmitTeamVote(vote: Vote) {
    if (!snapshot || !currentPlayer) return;
    setMessage('');
    if (isDemoMode) {
      try {
        const playerIds = snapshot.players.map((player) => player.id);
        const currentMissionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
        const nextMissionState = submitTeamVoteToState(currentMissionState, playerIds, currentPlayer.id, vote);
        await handleMissionStateChange(nextMissionState);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not submit vote.');
      }
      return;
    }
    try {
      setSnapshot(await submitTeamVote(snapshot.room.id, currentPlayer.id, vote));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not submit vote.');
    }
  }

  async function handleSubmitMissionCard(card: MissionCard) {
    if (!snapshot || !currentPlayer) return;
    setMessage('');
    if (isDemoMode) {
      try {
        const playerIds = snapshot.players.map((player) => player.id);
        const currentMissionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
        const nextMissionState = submitMissionCardToState(currentMissionState, playerIds, snapshot.players.map(toRoomAvalonPlayer), currentPlayer.id, card);
        await handleMissionStateChange(nextMissionState);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not submit mission card.');
      }
      return;
    }
    try {
      setSnapshot(await submitMissionCard(snapshot.room.id, currentPlayer.id, card));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not submit mission card.');
    }
  }

  async function handleAssassination(targetPlayerId: string) {
    if (!snapshot || !currentPlayer) return;
    setMessage('');
    if (isDemoMode) {
      try {
        const playerIds = snapshot.players.map((player) => player.id);
        const currentMissionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
        const nextMissionState = resolveAssassination(currentMissionState, snapshot.players.map(toRoomAvalonPlayer), currentPlayer.id, targetPlayerId);
        setSnapshot({
          ...snapshot,
          room: {
            ...snapshot.room,
            status: nextMissionState.phase,
            settings: { ...snapshot.room.settings, missionState: nextMissionState },
          },
        });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not submit assassination.');
      }
      return;
    }
    try {
      setSnapshot(await submitAssassination(snapshot.room.id, currentPlayer.id, targetPlayerId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not submit assassination.');
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
    <main className={`shell ${screen === 'demo' || screen === 'demoJoin' ? 'demo-shell' : ''}`}>
      <header className="hero">
        <p className="eyebrow">Avalon Host</p>
        <h1>{screen === 'room' ? (snapshot?.room.status === 'reveal' ? 'The Merlin Reveal' : 'Round Table Lobby') : 'Gather the Knights of Avalon'}</h1>
        <p className="lede">Summon a room, let every knight ready at the table, then reveal each secret role on their own phone.</p>
        <p className="mode">{isHostedConfigured && !isDevSessionActive() ? 'Neon API mode' : 'Local browser demo mode'}</p>
      </header>

      {message && <p className="notice">{message}</p>}

      {screen === 'home' && (
        <section className="entry">
          <div className="entry-intro">
            <h2>Let Merlin handle the hidden-role ritual</h2>
            <p>Avalon Host gives the table one magic number, watches the round table fill, and reveals only the secrets each player should know.</p>
          </div>
          <section className="path-section" aria-labelledby="choose-path-title">
            <div>
              <p className="eyebrow">Choose your path</p>
              <h2 id="choose-path-title">Host / Join / Demo</h2>
            </div>
            <div className="path-grid" aria-label="Primary actions">
              <button type="button" className="path-card primary-path" onClick={() => navigateEntry('create')}>
                <span>Host the round</span>
                <small>Create a live 5-digit code for the table.</small>
              </button>
              <button type="button" className="path-card" onClick={() => navigateEntry('join')}>
                <span>Join by rune</span>
                <small>Enter a host's 5-digit code and ready up.</small>
              </button>
              <button type="button" className="path-card demo-button" onClick={() => navigateEntry('demo')}>
                <span>Try demo</span>
                <small>Simulate 5-10 phone screens on this laptop.</small>
              </button>
            </div>
          </section>
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
          <div className="entry-guide">
            <h2>What each choice means</h2>
            <p><strong>Host</strong> opens a real table room. <strong>Join</strong> is for players with a 5-digit code. <strong>Demo</strong> stays on this device and never connects to Neon.</p>
          </div>
        </section>
      )}

      {screen === 'demo' && (
        <section className="demo-panel">
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>Back</button>
          <DemoSimulator />
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
        <section className="demo-panel">
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>Back</button>
          <DemoSimulator />
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
          onProposeMissionTeam={handleProposeMissionTeam}
          onSubmitTeamVote={handleSubmitTeamVote}
          onSubmitMissionCard={handleSubmitMissionCard}
          onAssassination={handleAssassination}
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

interface DemoPlayer {
  id: string;
  displayName: string;
  seatIndex: number;
  role: Role;
  revealRole: boolean;
  revealNightInfo: boolean;
  teamVote?: Vote;
  missionCard?: MissionCard;
}

interface DemoMissionResult {
  roundIndex: number;
  outcome: 'success' | 'fail';
  successCount: number;
  failCount: number;
  requiredFails: number;
}

interface DemoState {
  playerCount: number;
  roleOptions: RolePresetOptions;
  players: DemoPlayer[];
  phase: 'setup' | 'proposal' | 'vote' | 'mission' | 'result';
  roundIndex: number;
  leaderIndex: number;
  selectedTeamIds: string[];
  missionResults: DemoMissionResult[];
  lastVote?: { approveCount: number; rejectCount: number; passed: boolean };
  lastMission?: DemoMissionResult;
}

const demoNames = ['Arthur', 'Bors', 'Cai', 'Dagonet', 'Elaine', 'Gareth', 'Helena', 'Isolde', 'Lucan', 'Yvain'];
const optionalRoleControls: Array<{ key: keyof RolePresetOptions; role: Role; label: string; note: string }> = [
  { key: 'includePercival', role: 'Percival', label: 'Percival', note: 'Good, sees Merlin candidates.' },
  { key: 'includeMorgana', role: 'Morgana', label: 'Morgana', note: 'Evil, appears as Merlin candidate.' },
  { key: 'includeMordred', role: 'Mordred', label: 'Mordred', note: 'Evil, hidden from Merlin.' },
  { key: 'includeOberon', role: 'Oberon', label: 'Oberon', note: 'Evil, hidden from other evil.' },
];
const DEMO_RESULT_AUTO_ADVANCE_MS = 2200;

function DemoSimulator() {
  const [demo, setDemo] = useState(() => createDemoState(7, { includeMorgana: true }));
  const rule = getPlayerCountRule(demo.playerCount);
  const preset = buildRolePreset(demo.playerCount, demo.roleOptions);
  const teamSize = getTeamSize(demo.playerCount, demo.roundIndex);
  const selectedPlayers = demo.selectedTeamIds.map((id) => demo.players.find((player) => player.id === id)?.displayName ?? id);
  const approveCount = demo.players.filter((player) => player.teamVote === 'approve').length;
  const rejectCount = demo.players.filter((player) => player.teamVote === 'reject').length;
  const votedCount = approveCount + rejectCount;
  const missionCards = demo.players.filter((player) => demo.selectedTeamIds.includes(player.id) && player.missionCard);
  const goodScore = demo.missionResults.filter((result) => result.outcome === 'success').length;
  const evilScore = demo.missionResults.filter((result) => result.outcome === 'fail').length;
  const winner = getDemoWinner(demo);
  const includedSpecialRoles = optionalRoleControls
    .filter((control) => demo.roleOptions[control.key])
    .map((control) => control.label);

  useEffect(() => {
    if (demo.phase !== 'result' || winner || demo.roundIndex >= 4) return undefined;
    const timeout = window.setTimeout(() => {
      setDemo((current) => {
        if (current.phase !== 'result' || getDemoWinner(current) || current.roundIndex >= 4) return current;
        return advanceDemoToNextQuest(current);
      });
    }, DEMO_RESULT_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timeout);
  }, [demo.phase, demo.roundIndex, demo.missionResults.length, winner]);

  function resetWith(playerCount: number, roleOptions: RolePresetOptions) {
    setDemo(createDemoState(playerCount, sanitizeRoleOptions(playerCount, roleOptions)));
  }

  function startTable() {
    setDemo((current) => ({ ...current, phase: 'proposal' }));
  }

  function toggleOptionalRole(key: keyof RolePresetOptions) {
    resetWith(demo.playerCount, { ...demo.roleOptions, [key]: !demo.roleOptions[key] });
  }

  function toggleTeamPlayer(playerId: string) {
    if (demo.phase !== 'proposal') return;
    setDemo((current) => {
      const selectedTeamIds = current.selectedTeamIds.includes(playerId)
        ? current.selectedTeamIds.filter((id) => id !== playerId)
        : [...current.selectedTeamIds, playerId];
      return { ...current, selectedTeamIds };
    });
  }

  function proposeTeam() {
    if (demo.selectedTeamIds.length !== teamSize) return;
    setDemo((current) => ({
      ...current,
      phase: 'vote',
      players: current.players.map((player) => ({ ...player, teamVote: undefined, missionCard: undefined })),
      lastVote: undefined,
      lastMission: undefined,
    }));
  }

  function vote(playerId: string, teamVote: Vote) {
    if (demo.phase !== 'vote') return;
    setDemo((current) => {
      const nextPlayers = current.players.map((player) => (player.id === playerId ? { ...player, teamVote } : player));
      const resolved = resolveDemoVoteIfReady(current, nextPlayers);
      return { ...current, players: resolved.players, ...resolved.statePatch };
    });
  }

  function playMissionCard(playerId: string, missionCard: MissionCard) {
    if (demo.phase !== 'mission') return;
    setDemo((current) => {
      const nextPlayers = current.players.map((player) => (player.id === playerId ? { ...player, missionCard } : player));
      return resolveDemoMissionIfReady(current, nextPlayers);
    });
  }

  function toggleRoleReveal(playerId: string) {
    setDemo((current) => ({
      ...current,
      players: current.players.map((player) => (
        player.id === playerId ? { ...player, revealRole: !player.revealRole } : player
      )),
    }));
  }

  function toggleNightInfoReveal(playerId: string) {
    setDemo((current) => ({
      ...current,
      players: current.players.map((player) => (
        player.id === playerId ? { ...player, revealNightInfo: !player.revealNightInfo } : player
      )),
    }));
  }

  return (
    <div className="demo-simulator">
      <div className="demo-heading">
        <div>
          <p className="eyebrow">Local tabletop simulator</p>
          <h2>Multi-phone Demo</h2>
        </div>
        <button type="button" onClick={() => resetWith(demo.playerCount, demo.roleOptions)}>Reset table</button>
      </div>

      {demo.phase === 'setup' ? (
        <section className="demo-setup">
          <div>
            <h3>Players</h3>
            <div className="segmented" aria-label="Player count">
              {playerCountRange.map((count) => (
                <button
                  key={count}
                  type="button"
                  className={count === demo.playerCount ? 'selected' : ''}
                  onClick={() => resetWith(count, demo.roleOptions)}
                >
                  {count}
                </button>
              ))}
            </div>
            <p>{rule.goodCount} Good / {rule.evilCount} Evil</p>
          </div>
          <div>
            <h3>Role setup</h3>
            <div className="role-preset">
              <span>Fixed: {preset.requiredRoles.join(', ')}</span>
              <span>Fill: {summarizeRoles(preset.fillerRoles)}</span>
            </div>
            <div className="optional-roles">
              {optionalRoleControls.map((control) => {
                const checked = Boolean(demo.roleOptions[control.key]);
                const disabled = !checked && !canEnableRoleOption(demo.playerCount, demo.roleOptions, control.key);
                return (
                  <label key={control.key} className="check role-toggle">
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleOptionalRole(control.key)} />
                    <span><strong>{control.label}</strong><small>{control.note}</small></span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="demo-start-row">
            <button type="button" className="primary" onClick={startTable}>Start tabletop</button>
          </div>
        </section>
      ) : (
        <section className="demo-setup-summary" aria-label="Demo table setup">
          <span>{demo.playerCount} players</span>
          <span>{rule.goodCount} Good / {rule.evilCount} Evil</span>
          <span>Special roles: {includedSpecialRoles.length ? includedSpecialRoles.join(', ') : 'None'}</span>
          <span>Base: {preset.requiredRoles.join(', ')}</span>
          <span>Fill: {summarizeRoles(preset.fillerRoles)}</span>
        </section>
      )}

      <section className="demo-board" aria-label="Demo table state">
        <div className="quest-track">
          {[0, 1, 2, 3, 4].map((roundIndex) => {
            const result = demo.missionResults.find((item) => item.roundIndex === roundIndex);
            const threshold = rule.failThresholds[roundIndex];
            return (
              <span key={roundIndex} className={result?.outcome ?? (roundIndex === demo.roundIndex ? 'current' : '')}>
                Q{roundIndex + 1}: {rule.teamSizes[roundIndex]}{threshold > 1 ? ` / ${threshold} fails` : ''}
              </span>
            );
          })}
        </div>
        <div className="status">
          <span>Leader: {demo.players[demo.leaderIndex]?.displayName}</span>
          <span>Quest: {demo.roundIndex + 1} needs {teamSize}</span>
          <span>Score: Good {goodScore} / Evil {evilScore}</span>
        </div>
        {demo.lastVote && <p className="hint">Last vote: {demo.lastVote.approveCount} approve, {demo.lastVote.rejectCount} reject. Team {demo.lastVote.passed ? 'approved' : 'rejected'}.</p>}
        {demo.lastMission && <p className="notice">Quest {demo.lastMission.roundIndex + 1} {demo.lastMission.outcome === 'success' ? 'succeeded' : 'failed'} with {demo.lastMission.failCount} fail card(s).</p>}
        {winner && <p className="notice">{winner === 'good' ? 'Good' : 'Evil'} has reached three quests. Reset the table to try another setup.</p>}
        {demo.phase === 'setup' && (
          <div className="mission-step">
            <p>Choose player count and roles, then start the tabletop.</p>
          </div>
        )}
        {demo.phase === 'proposal' && (
          <div className="mission-step">
            <p>{demo.players[demo.leaderIndex]?.displayName} is choosing exactly {teamSize} players. Selected: {selectedPlayers.length ? selectedPlayers.join(', ') : 'none'}.</p>
          </div>
        )}
        {demo.phase === 'vote' && (
          <div className="mission-step">
            <p>Everyone votes on {selectedPlayers.join(', ')}. Votes in: {votedCount}/{demo.playerCount}; the table advances when every phone has voted.</p>
          </div>
        )}
        {demo.phase === 'mission' && (
          <div className="mission-step">
            <p>Mission team plays cards anonymously. Cards in: {missionCards.length}/{demo.selectedTeamIds.length}; the quest resolves when the team is done.</p>
          </div>
        )}
        {demo.phase === 'result' && !winner && (
          <div className="mission-step">
            <p>Quest result is public on every phone. Next quest starts automatically.</p>
          </div>
        )}
      </section>

      <section className="demo-phone-grid" aria-label="Virtual phones">
        {demo.players.map((player) => (
          <DemoPhone
            key={player.id}
            player={player}
            players={demo.players}
            leaderId={demo.players[demo.leaderIndex]?.id}
            phase={demo.phase}
            selectedTeamIds={demo.selectedTeamIds}
            teamSize={teamSize}
            onToggleRoleReveal={toggleRoleReveal}
            onToggleNightInfoReveal={toggleNightInfoReveal}
            onToggleTeamPlayer={toggleTeamPlayer}
            onVote={vote}
            onPlayMissionCard={playMissionCard}
            onProposeTeam={proposeTeam}
            winner={winner}
            lastMission={demo.lastMission}
          />
        ))}
      </section>
    </div>
  );
}

function DemoPhone({
  player,
  players,
  leaderId,
  phase,
  selectedTeamIds,
  teamSize,
  onToggleRoleReveal,
  onToggleNightInfoReveal,
  onToggleTeamPlayer,
  onVote,
  onPlayMissionCard,
  onProposeTeam,
  winner,
  lastMission,
}: {
  player: DemoPlayer;
  players: DemoPlayer[];
  leaderId?: string;
  phase: DemoState['phase'];
  selectedTeamIds: string[];
  teamSize: number;
  onToggleRoleReveal: (playerId: string) => void;
  onToggleNightInfoReveal: (playerId: string) => void;
  onToggleTeamPlayer: (playerId: string) => void;
  onVote: (playerId: string, vote: Vote) => void;
  onPlayMissionCard: (playerId: string, card: MissionCard) => void;
  onProposeTeam: () => void;
  winner?: Allegiance;
  lastMission?: DemoMissionResult;
}) {
  const isLeader = player.id === leaderId;
  const onTeam = selectedTeamIds.includes(player.id);
  const privateInfo = getVisibilityInfo(
    { id: player.id, name: player.displayName, role: player.role },
    players.map(toDemoAvalonPlayer),
  );
  const canFailMission = roleAllegiance(player.role) === 'evil';

  return (
    <PlayerPhone
      mode="demo"
      player={player}
      privateInfo={privateInfo}
      leaderId={leaderId}
      selectedTeamIds={selectedTeamIds}
      winner={winner}
      result={phase === 'result' ? lastMission : undefined}
      roleReveal={{ revealed: player.revealRole, onToggle: onToggleRoleReveal }}
      nightInfoReveal={{ revealed: player.revealNightInfo, onToggle: onToggleNightInfoReveal }}
      action={getDemoPhoneAction({
        player,
        players,
        leaderId,
        phase,
        isLeader,
        onTeam,
        selectedTeamIds,
        teamSize,
        canFailMission,
        winner,
        lastMission,
        onToggleTeamPlayer,
        onVote,
        onPlayMissionCard,
        onProposeTeam,
      })}
    />
  );
}

interface PlayerPhonePerson {
  id: string;
  displayName: string;
  seatIndex: number;
  role?: Role;
  teamVote?: Vote;
  missionCard?: MissionCard;
}

type PlayerPhoneMode = 'demo' | 'live';
type PlayerPhoneResult = DemoMissionResult | MissionResultState;

interface PlayerPhoneRevealControl {
  revealed?: boolean;
  onToggle?: (playerId: string) => void;
}

type PlayerPhoneAction =
  | {
      kind: 'proposal';
      isLeader: boolean;
      leaderName: string;
      teamSize: number;
      selectedTeamIds: string[];
      players: PlayerPhonePerson[];
      canEdit: boolean;
      onToggleTeamPlayer?: (playerId: string) => void;
      onProposeTeam?: () => void;
    }
  | {
      kind: 'vote';
      selectedTeamNames: string[];
      currentVote?: Vote;
      submittedVoteCount?: number;
      playerCount?: number;
      onVote?: (vote: Vote) => void;
    }
  | {
      kind: 'mission';
      onTeam: boolean;
      selectedTeamCount: number;
      canFailMission: boolean;
      currentMissionCard?: MissionCard;
      missionCardSubmitted?: boolean;
      submittedCardCount?: number;
      onPlayMissionCard?: (card: MissionCard) => void;
    }
  | {
      kind: 'result';
      winner?: Allegiance;
      playerWon?: boolean;
      result?: PlayerPhoneResult;
    }
  | {
      kind: 'assassin';
      isAssassin: boolean;
    }
  | {
      kind: 'finished';
      winner?: Allegiance;
      playerWon?: boolean;
      result?: PlayerPhoneResult;
    };

function PlayerPhone({
  mode,
  player,
  privateInfo,
  leaderId,
  selectedTeamIds = [],
  winner,
  result,
  roleReveal,
  nightInfoReveal,
  action,
}: {
  mode: PlayerPhoneMode;
  player: PlayerPhonePerson;
  privateInfo?: VisibilityInfo;
  leaderId?: string;
  selectedTeamIds?: string[];
  winner?: Allegiance;
  result?: PlayerPhoneResult;
  roleReveal?: PlayerPhoneRevealControl;
  nightInfoReveal?: PlayerPhoneRevealControl;
  action?: PlayerPhoneAction;
}) {
  const isLeader = player.id === leaderId;
  const onTeam = selectedTeamIds.includes(player.id);
  const publicRole = isLeader ? 'Current Leader' : mode === 'live' ? 'Your phone' : 'Table player';
  const outcomeClass = [
    winner && player.role ? (roleAllegiance(player.role) === winner ? 'phone-winner' : 'phone-loser') : '',
    result ? `mission-${result.outcome}-phone` : '',
  ].filter(Boolean).join(' ');
  const [rolePeekOpen, setRolePeekOpen] = useState(false);
  const [nightInfoPeekOpen, setNightInfoPeekOpen] = useState(false);
  const roleRevealed = roleReveal?.revealed ?? rolePeekOpen;
  const nightInfoRevealed = nightInfoReveal?.revealed ?? nightInfoPeekOpen;

  useEffect(() => {
    if (mode !== 'live') return;
    setRolePeekOpen(false);
    setNightInfoPeekOpen(false);
  }, [mode, player.id, player.role]);

  function setRoleRevealed(nextRevealed: boolean) {
    if (roleReveal?.onToggle) {
      if (roleRevealed !== nextRevealed) roleReveal.onToggle(player.id);
      return;
    }
    setRolePeekOpen(nextRevealed);
  }

  function setNightInfoRevealed(nextRevealed: boolean) {
    if (nightInfoReveal?.onToggle) {
      if (nightInfoRevealed !== nextRevealed) nightInfoReveal.onToggle(player.id);
      return;
    }
    setNightInfoPeekOpen(nextRevealed);
  }

  return (
    <article className={`player-phone ${mode === 'demo' ? 'demo-phone' : 'live-player-phone'} ${isLeader ? 'leader-phone' : ''} ${outcomeClass}`}>
      <div className="phone-top">
        <strong>{player.displayName}</strong>
        <small>Seat {player.seatIndex + 1} · {publicRole}</small>
        {onTeam && <span className="phone-team-pill">Mission team</span>}
      </div>
      {player.role && (
        <RoleRevealCard
          playerName={player.displayName}
          role={player.role}
          revealed={roleRevealed}
          onReveal={() => setRoleRevealed(true)}
          onHide={() => setRoleRevealed(false)}
        />
      )}
      {privateInfo && (
        <NightInfoRevealCard
          playerName={player.displayName}
          privateInfo={privateInfo}
          revealed={nightInfoRevealed}
          onReveal={() => setNightInfoRevealed(true)}
          onHide={() => setNightInfoRevealed(false)}
        />
      )}
      {action && <PlayerPhoneActionPanel action={action} />}
    </article>
  );
}

function getDemoPhoneAction({
  player,
  players,
  leaderId,
  phase,
  isLeader,
  onTeam,
  selectedTeamIds,
  teamSize,
  canFailMission,
  winner,
  lastMission,
  onToggleTeamPlayer,
  onVote,
  onPlayMissionCard,
  onProposeTeam,
}: {
  player: DemoPlayer;
  players: DemoPlayer[];
  leaderId?: string;
  phase: DemoState['phase'];
  isLeader: boolean;
  onTeam: boolean;
  selectedTeamIds: string[];
  teamSize: number;
  canFailMission: boolean;
  winner?: Allegiance;
  lastMission?: DemoMissionResult;
  onToggleTeamPlayer: (playerId: string) => void;
  onVote: (playerId: string, vote: Vote) => void;
  onPlayMissionCard: (playerId: string, card: MissionCard) => void;
  onProposeTeam: () => void;
}): PlayerPhoneAction | undefined {
  if (phase === 'proposal') {
    return {
      kind: 'proposal',
      isLeader,
      leaderName: players.find((candidate) => candidate.id === leaderId)?.displayName ?? 'Leader',
      teamSize,
      selectedTeamIds,
      players,
      canEdit: isLeader,
      onToggleTeamPlayer,
      onProposeTeam,
    };
  }
  if (phase === 'vote') {
    return {
      kind: 'vote',
      selectedTeamNames: selectedTeamIds.map((id) => players.find((candidate) => candidate.id === id)?.displayName ?? id),
      currentVote: player.teamVote,
      submittedVoteCount: players.filter((candidate) => candidate.teamVote).length,
      playerCount: players.length,
      onVote: (vote) => onVote(player.id, vote),
    };
  }
  if (phase === 'mission') {
    return {
      kind: 'mission',
      onTeam,
      selectedTeamCount: selectedTeamIds.length,
      canFailMission,
      currentMissionCard: player.missionCard,
      missionCardSubmitted: Boolean(player.missionCard),
      submittedCardCount: players.filter((candidate) => selectedTeamIds.includes(candidate.id) && candidate.missionCard).length,
      onPlayMissionCard: (card) => onPlayMissionCard(player.id, card),
    };
  }
  if (phase === 'result') {
    return {
      kind: 'result',
      winner,
      playerWon: winner && roleAllegiance(player.role) === winner,
      result: lastMission,
    };
  }
  return undefined;
}

function getLivePhoneAction({
  player,
  players,
  missionState,
  currentTeamSize,
  draftSelectedTeamIds,
  onToggleTeamPlayer,
  onProposeTeam,
  onVote,
  onPlayMissionCard,
}: {
  player: RoomPlayer;
  players: RoomPlayer[];
  missionState?: MissionState;
  currentTeamSize: number;
  draftSelectedTeamIds: string[];
  onToggleTeamPlayer: (playerId: string) => void;
  onProposeTeam: () => void;
  onVote: (vote: Vote) => void;
  onPlayMissionCard: (card: MissionCard) => void;
}): PlayerPhoneAction | undefined {
  if (!missionState) return undefined;
  const selectedTeamNames = missionState.selectedTeamIds.map((id) => players.find((candidate) => candidate.id === id)?.displayName ?? id);
  const lastResult = missionState.missionResults.at(-1);
  const submittedMissionCardIds = missionState.missionCardSubmissions?.submittedPlayerIds ?? [];
  if (missionState.phase === 'proposal') {
    const isLeader = missionState.leaderPlayerId === player.id;
    return {
      kind: 'proposal',
      isLeader,
      leaderName: players.find((candidate) => candidate.id === missionState.leaderPlayerId)?.displayName ?? 'Leader',
      teamSize: currentTeamSize,
      selectedTeamIds: isLeader ? draftSelectedTeamIds : missionState.selectedTeamIds,
      players,
      canEdit: isLeader,
      onToggleTeamPlayer,
      onProposeTeam,
    };
  }
  if (missionState.phase === 'vote') {
    return {
      kind: 'vote',
      selectedTeamNames,
      currentVote: missionState.teamVotes?.[player.id],
      submittedVoteCount: Object.keys(missionState.teamVotes ?? {}).length,
      playerCount: players.length,
      onVote,
    };
  }
  if (missionState.phase === 'mission') {
    const onTeam = missionState.selectedTeamIds.includes(player.id);
    const missionCardSubmitted = submittedMissionCardIds.includes(player.id);
    return {
      kind: 'mission',
      onTeam,
      selectedTeamCount: missionState.selectedTeamIds.length,
      canFailMission: player.role ? roleAllegiance(player.role) === 'evil' : false,
      missionCardSubmitted,
      submittedCardCount: submittedMissionCardIds.length,
      onPlayMissionCard: onTeam && !missionCardSubmitted ? onPlayMissionCard : undefined,
    };
  }
  if (missionState.phase === 'assassin') {
    return { kind: 'assassin', isAssassin: player.role === 'Assassin' };
  }
  return {
    kind: 'finished',
    winner: missionState.winner,
    playerWon: Boolean(missionState.winner && player.role && roleAllegiance(player.role) === missionState.winner),
    result: lastResult,
  };
}

function PlayerPhoneActionPanel({ action }: { action: PlayerPhoneAction }) {
  if (action.kind === 'proposal') {
    const selectedCount = action.selectedTeamIds.length;
    const canAddToTeam = selectedCount < action.teamSize;
    return (
      <div className={`phone-action ${action.canEdit ? '' : 'phone-readonly'}`}>
        <span>{action.canEdit ? `Propose team · ${selectedCount}/${action.teamSize}` : 'Proposal'}</span>
        {action.canEdit ? (
          <>
            {action.players.map((candidate) => (
              <label key={candidate.id} className="check">
                <input
                  type="checkbox"
                  checked={action.selectedTeamIds.includes(candidate.id)}
                  disabled={!action.selectedTeamIds.includes(candidate.id) && !canAddToTeam}
                  onChange={() => action.onToggleTeamPlayer?.(candidate.id)}
                />
                {candidate.displayName}
              </label>
            ))}
            <button type="button" className="primary" disabled={selectedCount !== action.teamSize} onClick={action.onProposeTeam}>Propose Team</button>
          </>
        ) : (
          <>
            <p>{action.isLeader ? 'You are choosing the quest team.' : `${action.leaderName} is choosing ${action.teamSize} players.`}</p>
            <p>Selected: {selectedCount}/{action.teamSize}</p>
          </>
        )}
      </div>
    );
  }

  if (action.kind === 'vote') {
    return (
      <div className={`phone-action ${action.onVote ? '' : 'phone-readonly'}`}>
        <span>Team vote</span>
        {action.selectedTeamNames.length > 0 && <p>Team: {action.selectedTeamNames.join(', ')}</p>}
        {action.onVote ? (
          <>
            <div className="choice-row">
              <button type="button" className={action.currentVote === 'approve' ? 'selected' : ''} onClick={() => action.onVote?.('approve')}>Approve</button>
              <button type="button" className={action.currentVote === 'reject' ? 'selected' : ''} onClick={() => action.onVote?.('reject')}>Reject</button>
            </div>
            {typeof action.submittedVoteCount === 'number' && action.playerCount && (
              <p>Votes in: {action.submittedVoteCount}/{action.playerCount}</p>
            )}
          </>
        ) : (
          <p>Waiting for all players to vote.</p>
        )}
      </div>
    );
  }

  if (action.kind === 'mission') {
    return (
      <div className={`phone-action ${action.onTeam && action.onPlayMissionCard ? '' : 'phone-readonly'}`}>
        <span>{action.onTeam ? 'Mission card' : 'Mission'}</span>
        {action.onTeam && action.onPlayMissionCard ? (
          <>
            <div className="choice-row">
              <button type="button" className={action.currentMissionCard === 'success' ? 'selected' : ''} onClick={() => action.onPlayMissionCard?.('success')}>Success</button>
              <button
                type="button"
                className={action.currentMissionCard === 'fail' ? 'selected danger-choice' : ''}
                disabled={!action.canFailMission}
                onClick={() => action.onPlayMissionCard?.('fail')}
              >
                Fail
              </button>
            </div>
            {typeof action.submittedCardCount === 'number' && (
              <p>Cards in: {action.submittedCardCount}/{action.selectedTeamCount}</p>
            )}
          </>
        ) : (
          <p>
            {action.onTeam
              ? action.missionCardSubmitted
                ? `Card submitted. Cards in: ${action.submittedCardCount ?? 0}/${action.selectedTeamCount}.`
                : 'Waiting for your mission card.'
              : `${action.selectedTeamCount} players are on the mission. Wait for their cards.`}
          </p>
        )}
      </div>
    );
  }

  if (action.kind === 'assassin') {
    return (
      <div className="phone-action phone-readonly">
        <span>Assassin phase</span>
        <p>{action.isAssassin ? 'Choose Merlin from the Assassin panel.' : 'Good completed three quests. The Assassin is choosing Merlin.'}</p>
      </div>
    );
  }

  const isFinished = action.kind === 'finished';
  return (
    <div className={`phone-action ${action.winner ? 'phone-result' : 'phone-readonly'}`}>
      <span>{action.winner || isFinished ? 'Game result' : 'Quest result'}</span>
      {action.result && <MissionResultReveal result={action.result} />}
      {action.winner ? (
        <p>{action.playerWon ? 'Victory' : 'Defeat'} · {action.winner === 'good' ? 'Good wins' : 'Evil wins'}</p>
      ) : (
        <p>{isFinished ? 'Game finished.' : 'Next quest starts automatically.'}</p>
      )}
    </div>
  );
}

function MissionResultReveal({ result }: { result: PlayerPhoneResult }) {
  const succeeded = result.outcome === 'success';
  return (
    <div className={`mission-result-reveal ${succeeded ? 'success' : 'fail'}`} aria-live="polite">
      <strong>{succeeded ? 'Quest Success' : 'Quest Failed'}</strong>
      <small>{result.failCount} fail card{result.failCount === 1 ? '' : 's'} · {result.requiredFails} needed to fail</small>
    </div>
  );
}

function RoleRevealCard({
  playerName,
  role,
  revealed,
  onReveal,
  onHide,
}: {
  playerName: string;
  role: Role;
  revealed: boolean;
  onReveal: () => void;
  onHide: () => void;
}) {
  const allegiance = roleAllegiance(role);

  return (
    <PeekRevealCard
      className="phone-role"
      revealedClassName={`revealed ${allegiance}`}
      coveredClassName="covered"
      faceClassName="role-face"
      revealed={revealed}
      onReveal={onReveal}
      onHide={onHide}
      revealLabel={`Reveal ${playerName}'s hidden role`}
      coverTitle="Role hidden"
      coverHint="Slide to peek"
      hideLabel="Hide role"
    >
      <strong>{role}</strong>
      <span>{allegiance === 'good' ? 'Good' : 'Evil'}</span>
    </PeekRevealCard>
  );
}

function NightInfoRevealCard({
  playerName,
  privateInfo,
  revealed,
  onReveal,
  onHide,
}: {
  playerName: string;
  privateInfo: VisibilityInfo;
  revealed: boolean;
  onReveal: () => void;
  onHide: () => void;
}) {
  return (
    <PeekRevealCard
      className="phone-info phone-night-info"
      faceClassName="night-info-face"
      revealed={revealed}
      onReveal={onReveal}
      onHide={onHide}
      revealLabel={`Reveal ${playerName}'s hidden night information`}
      coverTitle="Night info hidden"
      coverHint="Slide to peek"
      hideLabel="Hide night info"
    >
      <span>Night info</span>
      {privateInfo.sees.length ? (
        <ul>{privateInfo.sees.map((item) => <li key={item.playerId}>{item.name}: {item.hint}</li>)}</ul>
      ) : (
        <p>No extra information.</p>
      )}
    </PeekRevealCard>
  );
}

function PeekRevealCard({
  children,
  className,
  revealedClassName = 'revealed',
  coveredClassName = 'covered',
  faceClassName,
  revealed,
  onReveal,
  onHide,
  revealLabel,
  coverTitle,
  coverHint,
  hideLabel,
}: {
  children: React.ReactNode;
  className: string;
  revealedClassName?: string;
  coveredClassName?: string;
  faceClassName: string;
  revealed: boolean;
  onReveal: () => void;
  onHide: () => void;
  revealLabel: string;
  coverTitle: string;
  coverHint: string;
  hideLabel: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | undefined>(undefined);
  const dragged = useRef(false);
  const [coverOffset, setCoverOffset] = useState(revealed ? 100 : 0);

  useEffect(() => {
    setCoverOffset(revealed ? 100 : 0);
  }, [revealed]);

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (revealed) return;
    dragStartX.current = event.clientX;
    dragged.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (dragStartX.current === undefined || revealed) return;
    const width = Math.max(1, cardRef.current?.clientWidth ?? 1);
    const nextOffset = Math.min(100, Math.max(0, ((event.clientX - dragStartX.current) / width) * 100));
    dragged.current = dragged.current || nextOffset > 4;
    setCoverOffset(nextOffset);
  }

  function handlePointerUp() {
    if (dragStartX.current === undefined || revealed) return;
    dragStartX.current = undefined;
    if (coverOffset >= 58) {
      onReveal();
      return;
    }
    setCoverOffset(0);
  }

  function handleCoverClick() {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onReveal();
  }

  return (
    <div className={`${className} ${revealed ? revealedClassName : coveredClassName}`} ref={cardRef}>
      <div className={faceClassName} aria-hidden={!revealed}>
        {children}
      </div>
      {!revealed && (
        <button
          type="button"
          className="peek-cover"
          style={{ transform: `translateX(${coverOffset}%)` }}
          onClick={handleCoverClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          aria-label={revealLabel}
        >
          <strong>{coverTitle}</strong>
          <span>{coverHint}</span>
        </button>
      )}
      {revealed && (
        <button type="button" className="peek-hide-button" onClick={onHide}>{hideLabel}</button>
      )}
    </div>
  );
}

function resolveDemoVoteIfReady(
  current: DemoState,
  players: DemoPlayer[],
): { players: DemoPlayer[]; statePatch: Partial<DemoState> } {
  const approveCount = players.filter((player) => player.teamVote === 'approve').length;
  const rejectCount = players.filter((player) => player.teamVote === 'reject').length;
  if (approveCount + rejectCount !== current.playerCount) return { players, statePatch: {} };
  const passed = approveCount > current.playerCount / 2;
  return {
    players: players.map((player) => ({ ...player, missionCard: undefined })),
    statePatch: {
      phase: passed ? 'mission' : 'proposal',
      leaderIndex: passed ? current.leaderIndex : (current.leaderIndex + 1) % current.playerCount,
      selectedTeamIds: passed ? current.selectedTeamIds : [],
      lastVote: { approveCount, rejectCount, passed },
    },
  };
}

function resolveDemoMissionIfReady(current: DemoState, players: DemoPlayer[]): DemoState {
  const missionCards = players.filter((player) => current.selectedTeamIds.includes(player.id) && player.missionCard);
  if (missionCards.length !== current.selectedTeamIds.length) return { ...current, players };
  const cards = current.selectedTeamIds.map((id) => players.find((player) => player.id === id)?.missionCard ?? 'success');
  const resolved = resolveMission(cards, current.playerCount, current.roundIndex);
  const result: DemoMissionResult = {
    roundIndex: current.roundIndex,
    outcome: resolved.outcome,
    successCount: cards.filter((card) => card === 'success').length,
    failCount: resolved.failCount,
    requiredFails: resolved.requiredFails,
  };
  return {
    ...current,
    players,
    phase: 'result',
    missionResults: [...current.missionResults, result],
    lastMission: result,
  };
}

function advanceDemoToNextQuest(current: DemoState): DemoState {
  return {
    ...current,
    phase: 'proposal',
    roundIndex: current.roundIndex + 1,
    leaderIndex: (current.leaderIndex + 1) % current.playerCount,
    selectedTeamIds: [],
    players: current.players.map((player) => ({ ...player, teamVote: undefined, missionCard: undefined })),
    lastVote: undefined,
  };
}

function getDemoWinner(demo: DemoState): Allegiance | undefined {
  const goodScore = demo.missionResults.filter((result) => result.outcome === 'success').length;
  const evilScore = demo.missionResults.filter((result) => result.outcome === 'fail').length;
  if (goodScore >= 3) return 'good';
  if (evilScore >= 3) return 'evil';
  return undefined;
}

function createDemoState(playerCount: number, roleOptions: RolePresetOptions): DemoState {
  const sanitizedOptions = sanitizeRoleOptions(playerCount, roleOptions);
  const preset = buildRolePreset(playerCount, sanitizedOptions);
  return {
    playerCount,
    roleOptions: sanitizedOptions,
    players: preset.roles.map((role, index) => ({
      id: `demo-player-${index + 1}`,
      displayName: demoNames[index],
      seatIndex: index,
      role,
      revealRole: false,
      revealNightInfo: false,
    })),
    phase: 'setup',
    roundIndex: 0,
    leaderIndex: 0,
    selectedTeamIds: [],
    missionResults: [],
  };
}

function sanitizeRoleOptions(playerCount: number, roleOptions: RolePresetOptions): RolePresetOptions {
  return optionalRoleControls.reduce<RolePresetOptions>((next, control) => {
    if (!roleOptions[control.key]) return next;
    const candidate = { ...next, [control.key]: true };
    try {
      buildRolePreset(playerCount, candidate);
      return candidate;
    } catch {
      return next;
    }
  }, {});
}

function canEnableRoleOption(playerCount: number, roleOptions: RolePresetOptions, key: keyof RolePresetOptions): boolean {
  try {
    buildRolePreset(playerCount, { ...roleOptions, [key]: true });
    return true;
  } catch {
    return false;
  }
}

function summarizeRoles(roles: Role[]): string {
  const counts = roles.reduce<Record<string, number>>((summary, role) => {
    summary[role] = (summary[role] ?? 0) + 1;
    return summary;
  }, {});
  return Object.entries(counts)
    .map(([role, count]) => `${count} ${role}`)
    .join(', ');
}

const publicRoleOrder: Role[] = ['Merlin', 'Percival', 'Loyal Servant', 'Assassin', 'Morgana', 'Mordred', 'Oberon', 'Minion'];

function summarizePublicRoleLineup(players: RoomPlayer[]): Array<{ role: Role; count: number }> {
  const roles = players.map((player) => player.role).filter((role): role is Role => Boolean(role));
  const fallbackRoles = roles.length === players.length ? roles : buildRolePreset(players.length).roles;
  const counts = fallbackRoles.reduce<Map<Role, number>>((summary, role) => {
    summary.set(role, (summary.get(role) ?? 0) + 1);
    return summary;
  }, new Map<Role, number>());
  return publicRoleOrder
    .filter((role) => counts.has(role))
    .map((role) => ({ role, count: counts.get(role) ?? 0 }));
}

function summarizeAllegianceCounts(players: RoomPlayer[]): { good?: number; evil?: number } {
  const roles = players.map((player) => player.role).filter((role): role is Role => Boolean(role));
  if (roles.length !== players.length) return {};
  return {
    good: roles.filter((role) => roleAllegiance(role) === 'good').length,
    evil: roles.filter((role) => roleAllegiance(role) === 'evil').length,
  };
}

function getMissionPhaseLabel(missionState: MissionState): string {
  if (missionState.phase === 'proposal') return 'Choosing crew';
  if (missionState.phase === 'vote') return 'Council vote';
  if (missionState.phase === 'mission') return 'Quest underway';
  if (missionState.phase === 'assassin') return 'Assassin endgame';
  return missionState.winner === 'evil' ? 'Evil victory' : 'Good victory';
}

function getMissionPhaseCopy({
  missionState,
  currentTeamSize,
  submittedVoteCount,
  submittedCardCount,
  playerCount,
}: {
  missionState: MissionState;
  currentTeamSize: number;
  submittedVoteCount: number;
  submittedCardCount: number;
  playerCount: number;
}): string {
  if (missionState.phase === 'proposal') {
    return `The captain is choosing exactly ${currentTeamSize} players before the table votes.`;
  }
  if (missionState.phase === 'vote') {
    return `${submittedVoteCount}/${playerCount} phones have voted on the proposed crew.`;
  }
  if (missionState.phase === 'mission') {
    return `${submittedCardCount}/${missionState.selectedTeamIds.length} mission cards are in. The quest resolves when the crew is done.`;
  }
  if (missionState.phase === 'assassin') {
    return 'Good reached three successful quests. The Assassin now chooses a Merlin target.';
  }
  if (missionState.assassination) {
    return missionState.winner === 'evil' ? 'The Assassin found Merlin and stole the endgame.' : 'Merlin survived the final guess.';
  }
  return missionState.winner === 'evil' ? 'Evil wins after three failed quests.' : 'Good wins after three successful quests.';
}

function toDemoAvalonPlayer(player: DemoPlayer): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}

function toRoomAvalonPlayer(player: RoomPlayer): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}

function AssassinPhaseBanner() {
  return (
    <section className="assassin-phase-banner" aria-live="assertive">
      <p className="eyebrow">Mandatory endgame</p>
      <h2>Assassin is choosing a target</h2>
      <p>Good has completed three quests. Normal mission play is paused until the Assassin resolves the Merlin guess.</p>
    </section>
  );
}

function AssassinPhaseActionPanel({
  targets,
  selectedTargetId,
  onSelectTarget,
  onAssassination,
}: {
  targets: RoomPlayer[];
  selectedTargetId: string;
  onSelectTarget: (targetPlayerId: string) => void;
  onAssassination: (targetPlayerId: string) => void;
}) {
  return (
    <section className="panel assassin-action-panel" aria-labelledby="assassin-action-title">
      <p className="eyebrow">Assassin phase action</p>
      <h2 id="assassin-action-title">Choose Merlin</h2>
      <p>Pick one target. Hitting Merlin gives Evil the win; missing Merlin gives Good the win.</p>
      <div className="assassination-targets">
        {targets.map((player) => (
          <label key={player.id} className="check">
            <input
              type="radio"
              name="assassinationTarget"
              checked={selectedTargetId === player.id}
              onChange={() => onSelectTarget(player.id)}
            />
            {player.displayName}
          </label>
        ))}
      </div>
      <button
        type="button"
        className="primary"
        disabled={!selectedTargetId}
        onClick={() => onAssassination(selectedTargetId)}
      >
        Confirm Assassination
      </button>
    </section>
  );
}

function AssassinationResultBanner({ missionState, players }: { missionState: MissionState; players: RoomPlayer[] }) {
  const target = players.find((player) => player.id === missionState.assassination?.targetPlayerId);
  const assassin = players.find((player) => player.id === missionState.assassination?.assassinPlayerId);
  const hitMerlin = Boolean(missionState.assassination?.hitMerlin);
  return (
    <section className={`assassin-result-banner ${missionState.winner === 'evil' ? 'evil-win' : 'good-win'}`} aria-live="polite">
      <p className="eyebrow">Assassination resolved</p>
      <h2>{missionState.winner === 'evil' ? 'Evil Wins' : 'Good Wins'}</h2>
      <p>
        {assassin?.displayName ?? 'The Assassin'} chose {target?.displayName ?? 'an unknown target'}.
        {' '}
        {hitMerlin ? 'The target was Merlin.' : 'The target was not Merlin.'}
      </p>
    </section>
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
  onMissionStateChange,
  onProposeMissionTeam,
  onSubmitTeamVote,
  onSubmitMissionCard,
  onAssassination,
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
  onProposeMissionTeam: (selectedTeamIds: string[]) => void;
  onSubmitTeamVote: (vote: Vote) => void;
  onSubmitMissionCard: (card: MissionCard) => void;
  onAssassination: (targetPlayerId: string) => void;
  isDemoMode: boolean;
}) {
  const started = snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup';
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = started && snapshot.players.length >= 5 ? ensureMissionState(snapshot.room.settings.missionState, playerIds) : undefined;
  const currentTeamSize = missionState ? getTeamSize(snapshot.players.length, missionState.roundIndex) : 0;
  const [assassinationTargetId, setAssassinationTargetId] = useState('');
  const readyCount = snapshot.players.filter((player) => player.isReady).length;
  const canStart = canStartGame(snapshot.players);
  const isFinished = snapshot.room.status === 'finished' || missionState?.phase === 'finished';
  const showJoinPanel = !started || isFinished;
  const joinLinkPath = buildJoinUrl(window.location.href, snapshot.room.code);
  const joinLink = `${window.location.origin}${joinLinkPath}`;
  const assassinationTargets = snapshot.players.filter((player) => player.id !== currentPlayer?.id);
  const [liveSelectedTeamIds, setLiveSelectedTeamIds] = useState<string[]>([]);

  useEffect(() => {
    setAssassinationTargetId('');
  }, [missionState?.phase, currentPlayer?.id]);

  useEffect(() => {
    if (missionState?.phase !== 'proposal') setLiveSelectedTeamIds([]);
  }, [missionState?.phase, missionState?.roundIndex, missionState?.proposalIndex]);

  function toggleLiveTeamPlayer(playerId: string) {
    setLiveSelectedTeamIds((current) => (current.includes(playerId) ? current.filter((id) => id !== playerId) : [...current, playerId]));
  }

  return (
    <section className="room-grid">
      {missionState?.phase === 'assassin' && (
        <AssassinPhaseBanner />
      )}
      {missionState?.phase === 'assassin' && privateInfo?.role === 'Assassin' && (
        <AssassinPhaseActionPanel
          targets={assassinationTargets}
          selectedTargetId={assassinationTargetId}
          onSelectTarget={setAssassinationTargetId}
          onAssassination={onAssassination}
        />
      )}
      {missionState?.phase === 'finished' && missionState.assassination && (
        <AssassinationResultBanner missionState={missionState} players={snapshot.players} />
      )}
      {showJoinPanel && (
        <div className="room-code">
          <div className="room-code-top">
            <div className="room-code-copy">
              <span>{isDemoMode ? 'Demo Room Code' : 'Room Code'}</span>
              <strong>{snapshot.room.code}</strong>
              <p>
                {isFinished
                  ? 'Game finished. The room code is visible again for the next table.'
                  : isDemoMode
                    ? 'Sandbox demo with bot players. This is not a real shareable room.'
                    : 'Share this code with players at the table.'}
              </p>
            </div>
            <QrCodePanel value={joinLink} />
          </div>
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
          </div>
        </div>
      )}

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
          <>
            <div className="next-step">
              <strong>{canStart ? 'Ready players can start.' : 'Waiting to start'}</strong>
              <span>
                {canStart
                  ? 'Starting now will leave unready players out of this game.'
                  : startValidation}
              </span>
            </div>
            {currentPlayer && (
              <button type="button" className="small-danger room-leave" onClick={onLeave}>Leave Room</button>
            )}
          </>
        )}

        {started && currentPlayer && privateInfo && (
          <PlayerPhone
            mode="live"
            player={currentPlayer}
            privateInfo={privateInfo}
            leaderId={missionState?.leaderPlayerId}
            selectedTeamIds={missionState?.selectedTeamIds}
            winner={missionState?.winner}
            result={missionState?.phase === 'finished' ? missionState.missionResults.at(-1) : undefined}
            action={getLivePhoneAction({
              player: currentPlayer,
              players: snapshot.players,
              missionState,
              currentTeamSize,
              draftSelectedTeamIds: liveSelectedTeamIds,
              onToggleTeamPlayer: toggleLiveTeamPlayer,
              onProposeTeam: () => onProposeMissionTeam(liveSelectedTeamIds),
              onVote: onSubmitTeamVote,
              onPlayMissionCard: onSubmitMissionCard,
            })}
          />
        )}
      </section>

      {!started && (
        <section className="panel">
          <h2>Players</h2>
          <p className="hint">{readyCount}/{snapshot.players.length} ready. Minimum 5 ready players.</p>
          <ol className="players">
            {snapshot.players.map((player) => (
              <li key={player.id} className={player.id === currentPlayer?.id ? 'me' : ''}>
                <span>{player.displayName}</span>
                <small>{player.isHost ? 'Host' : `Seat ${player.seatIndex + 1}`}</small>
                <strong>{player.isReady ? 'Ready' : 'Waiting'}</strong>
                {currentPlayer?.isHost && !player.isHost && !isDemoMode && (
                  <button type="button" className="small-danger" onClick={() => onRemovePlayer(player.id)}>Remove</button>
                )}
              </li>
            ))}
          </ol>
          {currentPlayer && (
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
      )}

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
  const submittedVoteCount = Object.keys(missionState?.teamVotes ?? {}).length;
  const submittedCardCount = missionState?.missionCardSubmissions?.submittedPlayerIds.length ?? 0;

  useEffect(() => {
    setSelectedTeamIds(missionState?.selectedTeamIds ?? []);
    setApproveCount('');
    setRejectCount('');
    setSuccessCount('');
    setFailCount('');
  }, [missionState?.phase, missionState?.roundIndex, missionState?.selectedTeamIds.join('|')]);

  if (!missionState) return null;

  const rule = getPlayerCountRule(players.length);
  const leaderName = players.find((player) => player.id === missionState.leaderPlayerId)?.displayName ?? 'Unknown captain';
  const selectedTeamNames = missionState.selectedTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id);
  const visibleTeamIds = missionState.phase === 'proposal' && selectedTeamIds.length > 0 ? selectedTeamIds : missionState.selectedTeamIds;
  const visibleTeamNames = visibleTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id);
  const roleSummary = summarizePublicRoleLineup(players);
  const allegianceCounts = summarizeAllegianceCounts(players);
  const phaseLabel = getMissionPhaseLabel(missionState);
  const phaseCopy = getMissionPhaseCopy({
    missionState,
    currentTeamSize,
    submittedVoteCount,
    submittedCardCount,
    playerCount: players.length,
  });

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
      <div className="mission-panel-heading">
        <div>
          <p className="eyebrow">Shared board</p>
          <h2>Table Quest</h2>
        </div>
        <span className={`phase-badge phase-${missionState.phase}`}>{phaseLabel}</span>
      </div>

      <section className="mission-board-section table-makeup" aria-label="Game setup and table makeup">
        <div className="mission-section-heading">
          <h3>Table Makeup</h3>
          <span>{players.length} players</span>
        </div>
        <div className="makeup-grid">
          <div className="makeup-tile">
            <span>Total</span>
            <strong>{players.length}</strong>
            <small>at the table</small>
          </div>
          <div className="makeup-tile good-tile">
            <span>Good</span>
            <strong>{allegianceCounts.good ?? rule.goodCount}</strong>
            <small>loyal side</small>
          </div>
          <div className="makeup-tile evil-tile">
            <span>Evil</span>
            <strong>{allegianceCounts.evil ?? rule.evilCount}</strong>
            <small>hidden side</small>
          </div>
        </div>
        <div className="role-lineup" aria-label="Public role lineup">
          <span>Roles in play</span>
          <div>
            {roleSummary.map((item) => (
              <span key={item.role} className={`role-chip ${roleAllegiance(item.role)}`}>
                {item.count > 1 ? `${item.count} ${item.role}` : item.role}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="mission-board-section" aria-label="Quest track">
        <div className="mission-section-heading">
          <h3>Quest Track</h3>
          <span>First side to three wins</span>
        </div>
        <div className="quest-track mission-quest-track">
          {[0, 1, 2, 3, 4].map((roundIndex) => {
            const result = missionState.missionResults.find((item) => item.roundIndex === roundIndex);
            const state = result?.outcome ?? (roundIndex === missionState.roundIndex && missionState.phase !== 'finished' ? 'current' : 'pending');
            return (
              <div key={roundIndex} className={`quest-card ${state}`}>
                <span>Q{roundIndex + 1}</span>
                <strong>{getTeamSize(players.length, roundIndex)}</strong>
                <small>
                  {result
                    ? result.outcome === 'success' ? 'Good won' : 'Evil won'
                    : roundIndex === missionState.roundIndex && missionState.phase !== 'finished' ? 'Current' : 'Pending'}
                </small>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mission-board-section expedition-board" aria-label="Current expedition">
        <div className="mission-section-heading">
          <h3>Current Expedition</h3>
          <span>Quest {missionState.roundIndex + 1} of 5</span>
        </div>
        <div className="expedition-summary">
          <div className="captain-card">
            <span>Captain</span>
            <strong>{leaderName}</strong>
          </div>
          <div className="expedition-state-card">
            <span>{phaseLabel}</span>
            <p>{phaseCopy}</p>
          </div>
        </div>
        <div className="team-roster">
          <div className="team-roster-heading">
            <span>{missionState.phase === 'proposal' ? 'Proposed crew' : 'Locked crew'}</span>
            <strong>{visibleTeamNames.length}/{currentTeamSize}</strong>
          </div>
          {visibleTeamNames.length > 0 ? (
            <div className="member-chips">
              {visibleTeamNames.map((name) => <span key={name}>{name}</span>)}
            </div>
          ) : (
            <p className="empty-team">No crew is on the board yet.</p>
          )}
        </div>
        {missionState.phase === 'vote' && (
          <div className="progress-rune" aria-label="Vote progress">
            <span style={{ width: `${Math.round((submittedVoteCount / players.length) * 100)}%` }} />
            <strong>{submittedVoteCount}/{players.length} phones voted</strong>
          </div>
        )}
        {missionState.phase === 'mission' && (
          <div className="progress-rune" aria-label="Mission card progress">
            <span style={{ width: `${Math.round((submittedCardCount / Math.max(1, missionState.selectedTeamIds.length)) * 100)}%` }} />
            <strong>{submittedCardCount}/{missionState.selectedTeamIds.length} cards submitted</strong>
          </div>
        )}
        {missionState.teamVote && missionState.phase !== 'vote' && missionState.phase !== 'mission' && (
          <p className="hint">Last proposal: {missionState.teamVote.approveCount} approve, {missionState.teamVote.rejectCount} reject. Crew {missionState.teamVote.passed ? 'approved' : 'rejected'}.</p>
        )}
        {missionState.phase === 'finished' && missionState.assassination && (
          <p className="hint">
            Assassin target: {players.find((player) => player.id === missionState.assassination?.targetPlayerId)?.displayName ?? 'Unknown'}.
            {' '}
            {missionState.assassination.hitMerlin ? 'Merlin was found.' : 'Merlin survived.'}
          </p>
        )}
      </section>

      {flowError && <p className="notice">{flowError}</p>}

      {canEdit ? (
        <section className="mission-admin">
          <div className="mission-section-heading">
            <h3>Host Backup</h3>
            <span>Admin override</span>
          </div>
          {missionState.phase === 'proposal' && (
            <div className="mission-step">
              <p>Use only if the captain phone cannot submit. Quest {missionState.roundIndex + 1} needs exactly {currentTeamSize} crew members.</p>
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
              <button type="button" className="primary" onClick={submitTeam}>Submit Backup Proposal</button>
            </div>
          )}

          {missionState.phase === 'vote' && (
            <div className="mission-step">
              <p>Use only if phone votes need manual recovery. Crew: {selectedTeamNames.join(', ')}.</p>
              <div className="count-row">
                <input value={approveCount} onChange={(event) => setApproveCount(event.target.value)} inputMode="numeric" placeholder="Approve" aria-label="Approve count" />
                <input value={rejectCount} onChange={(event) => setRejectCount(event.target.value)} inputMode="numeric" placeholder="Reject" aria-label="Reject count" />
                <button type="button" className="primary" onClick={submitVote}>Record Vote</button>
              </div>
            </div>
          )}

          {missionState.phase === 'mission' && (
            <div className="mission-step">
              <p>Use only if mission cards need manual recovery after the crew has acted.</p>
              <div className="count-row">
                <input value={successCount} onChange={(event) => setSuccessCount(event.target.value)} inputMode="numeric" placeholder="Success" aria-label="Success cards" />
                <input value={failCount} onChange={(event) => setFailCount(event.target.value)} inputMode="numeric" placeholder="Fail" aria-label="Fail cards" />
                <button type="button" className="primary" onClick={submitMission}>Record Mission</button>
              </div>
            </div>
          )}
        </section>
      ) : (
        missionState.phase !== 'finished' && <p className="hint">Use your private phone area for any action assigned to you.</p>
      )}
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
