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
  type Vote,
} from './domain/avalon';
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
  canStartGame,
  createRoom,
  getRoomById,
  getPrivateRoleInfo,
  getStartValidation,
  joinRoom,
  leaveRoom,
  normalizeRoomCode,
  removePlayer,
  setReady,
  startGame,
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
    <main className={`shell ${screen === 'demo' || screen === 'demoJoin' ? 'demo-shell' : ''}`}>
      <header className="hero">
        <p className="eyebrow">Avalon Host</p>
        <h1>{screen === 'room' ? (snapshot?.room.status === 'reveal' ? 'The Merlin Reveal' : 'Round Table Lobby') : 'Gather the Knights of Avalon'}</h1>
        <p className="lede">Summon a room, let every knight ready at the table, then reveal each secret role on their own phone.</p>
        <p className="mode">{isSupabaseConfigured && !isDevSessionActive() ? 'Supabase realtime mode' : 'Local browser demo mode'}</p>
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
            <p><strong>Host</strong> opens a real table room. <strong>Join</strong> is for players with a 5-digit code. <strong>Demo</strong> stays on this device and never connects to Supabase.</p>
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
  const winner = goodScore >= 3 ? 'good' : evilScore >= 3 ? 'evil' : undefined;
  const includedSpecialRoles = optionalRoleControls
    .filter((control) => demo.roleOptions[control.key])
    .map((control) => control.label);

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

  function nextQuest() {
    if (winner || demo.roundIndex >= 4) return;
    setDemo((current) => ({
      ...current,
      phase: 'proposal',
      roundIndex: current.roundIndex + 1,
      leaderIndex: (current.leaderIndex + 1) % current.playerCount,
      selectedTeamIds: [],
      players: current.players.map((player) => ({ ...player, teamVote: undefined, missionCard: undefined })),
      lastVote: undefined,
    }));
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
            <p>Quest result is public. The current leader can start the next quest from their phone.</p>
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
            onNextQuest={nextQuest}
            winner={winner}
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
  onNextQuest,
  winner,
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
  onNextQuest: () => void;
  winner?: Allegiance;
}) {
  const isLeader = player.id === leaderId;
  const onTeam = selectedTeamIds.includes(player.id);
  const selectedCount = selectedTeamIds.length;
  const canAddToTeam = selectedCount < teamSize;
  const publicRole = isLeader ? 'Current Leader' : 'Table player';
  const outcomeClass = winner ? (roleAllegiance(player.role) === winner ? 'phone-winner' : 'phone-loser') : '';
  const privateInfo = getVisibilityInfo(
    { id: player.id, name: player.displayName, role: player.role },
    players.map(toDemoAvalonPlayer),
  );
  const canFailMission = roleAllegiance(player.role) === 'evil';

  return (
    <article className={`demo-phone ${isLeader ? 'leader-phone' : ''} ${outcomeClass}`}>
      <div className="phone-top">
        <strong>{player.displayName}</strong>
        <small>Seat {player.seatIndex + 1} · {publicRole}</small>
        {onTeam && <span className="phone-team-pill">Mission team</span>}
      </div>
      <RoleRevealCard player={player} onToggleRoleReveal={onToggleRoleReveal} />
      <NightInfoRevealCard
        player={player}
        privateInfo={privateInfo}
        onToggleNightInfoReveal={onToggleNightInfoReveal}
      />
      {phase === 'proposal' && isLeader && (
        <div className="phone-action">
          <span>Propose team · {selectedCount}/{teamSize}</span>
          {players.map((candidate) => (
            <label key={candidate.id} className="check">
              <input
                type="checkbox"
                checked={selectedTeamIds.includes(candidate.id)}
                disabled={!selectedTeamIds.includes(candidate.id) && !canAddToTeam}
                onChange={() => onToggleTeamPlayer(candidate.id)}
              />
              {candidate.displayName}
            </label>
          ))}
          <button type="button" className="primary" disabled={selectedCount !== teamSize} onClick={onProposeTeam}>Propose Team</button>
        </div>
      )}
      {phase === 'proposal' && !isLeader && (
        <div className="phone-action phone-readonly">
          <span>Proposal</span>
          <p>{players.find((candidate) => candidate.id === leaderId)?.displayName ?? 'Leader'} is choosing {teamSize} players.</p>
          <p>Selected: {selectedCount}/{teamSize}</p>
        </div>
      )}
      {phase === 'vote' && (
        <div className="phone-action">
          <span>Team vote</span>
          <div className="choice-row">
            <button type="button" className={player.teamVote === 'approve' ? 'selected' : ''} onClick={() => onVote(player.id, 'approve')}>Approve</button>
            <button type="button" className={player.teamVote === 'reject' ? 'selected' : ''} onClick={() => onVote(player.id, 'reject')}>Reject</button>
          </div>
        </div>
      )}
      {phase === 'mission' && (
        <div className="phone-action">
          <span>{onTeam ? 'Mission card' : 'Mission'}</span>
          {onTeam ? (
            <div className="choice-row">
              <button type="button" className={player.missionCard === 'success' ? 'selected' : ''} onClick={() => onPlayMissionCard(player.id, 'success')}>Success</button>
              <button
                type="button"
                className={player.missionCard === 'fail' ? 'selected danger-choice' : ''}
                disabled={!canFailMission}
                onClick={() => onPlayMissionCard(player.id, 'fail')}
              >
                Fail
              </button>
            </div>
          ) : (
            <p>{selectedTeamIds.length} players are on the mission. Wait for their cards.</p>
          )}
        </div>
      )}
      {phase === 'result' && (
        <div className={`phone-action ${winner ? 'phone-result' : 'phone-readonly'}`}>
          <span>{winner ? 'Game result' : 'Quest result'}</span>
          {winner ? (
            <p>{roleAllegiance(player.role) === winner ? 'Victory' : 'Defeat'} · {winner === 'good' ? 'Good wins' : 'Evil wins'}</p>
          ) : (
            <>
              <p>Quest resolved. Score is on the table board.</p>
              {isLeader && <button type="button" className="primary" onClick={onNextQuest}>Next Quest</button>}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function RoleRevealCard({
  player,
  onToggleRoleReveal,
}: {
  player: DemoPlayer;
  onToggleRoleReveal: (playerId: string) => void;
}) {
  const allegiance = roleAllegiance(player.role);

  return (
    <PeekRevealCard
      className="phone-role"
      revealedClassName={`revealed ${allegiance}`}
      coveredClassName="covered"
      faceClassName="role-face"
      revealed={player.revealRole}
      onReveal={() => onToggleRoleReveal(player.id)}
      onHide={() => onToggleRoleReveal(player.id)}
      revealLabel={`Reveal ${player.displayName}'s hidden role`}
      coverTitle="Role hidden"
      coverHint="Slide to peek"
      hideLabel="Hide role"
    >
      <strong>{player.role}</strong>
      <span>{allegiance === 'good' ? 'Good' : 'Evil'}</span>
    </PeekRevealCard>
  );
}

function NightInfoRevealCard({
  player,
  privateInfo,
  onToggleNightInfoReveal,
}: {
  player: DemoPlayer;
  privateInfo: ReturnType<typeof getVisibilityInfo>;
  onToggleNightInfoReveal: (playerId: string) => void;
}) {
  return (
    <PeekRevealCard
      className="phone-info phone-night-info"
      faceClassName="night-info-face"
      revealed={player.revealNightInfo}
      onReveal={() => onToggleNightInfoReveal(player.id)}
      onHide={() => onToggleNightInfoReveal(player.id)}
      revealLabel={`Reveal ${player.displayName}'s hidden night information`}
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

function toDemoAvalonPlayer(player: DemoPlayer): Player {
  return { id: player.id, name: player.displayName, role: player.role };
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
