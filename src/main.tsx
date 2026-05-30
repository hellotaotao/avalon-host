import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildRolePreset,
  getPlayerCountRule,
  getRecommendedRolePresetOptions,
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
import {
  buildAiAvalonDecisionRequest,
  findNextAiActor,
  formatMissionReasoningSummaryForHistory,
  mergeAiAgentMemory,
  type AiAvalonDecision,
} from './aiAvalon';
import { getNextRoomAiAction, getRoomAiActionKey, type RoomAiAction } from './services/roomAi';
import { buildJoinUrl, buildStepUrl, parseEntryStep, parseJoinCodeFromUrl, type EntryScreen } from './navigationState';
import {
  applyMissionStateToSnapshot,
  canStartGame,
  createRoom,
  getRoomById,
  getPrivateRoleInfo,
  getStartValidation,
  joinRoom,
  leaveRoom,
  transferHost,
  resetRoomToLobby,
  dissolveRoom,
  normalizeRoomCode,
  proposeMissionTeam,
  readyForNextGame,
  readyForNextGameInSnapshot,
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
  isRoomStaleForExit,
  type RoomPlayer,
  type RoomSnapshot,
} from './services/roomService';
import { getSessionStorageKeys, isDevSessionActive } from './sessionKeys';
import { I18nProvider, formatAllegiance, formatHint, formatRole, useI18n } from './i18n';
import './styles.css';

type Screen = EntryScreen | 'room';

function LanguageSwitcher() {
  const { language, setLanguage, t } = useI18n();
  return (
    <div className="language-switcher" aria-label={t('Language')}>
      <button type="button" className={language === 'en' ? 'selected' : ''} onClick={() => setLanguage('en')}>{t('English')}</button>
      <button type="button" className={language === 'zh' ? 'selected' : ''} onClick={() => setLanguage('zh')}>{t('中文')}</button>
    </div>
  );
}

function App() {
  const { t } = useI18n();
  const [screen, setScreen] = useState<Screen>(() => parseEntryStep(window.location.href));
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [currentPlayerId, setCurrentPlayerId] = useState(localStorage.getItem(getSessionStorageKeys().currentPlayerId) ?? '');
  const [deviceToken] = useState(() => getOrCreateDeviceToken());
  const [hostName, setHostName] = useState('');
  const [humanPlayerCount, setHumanPlayerCount] = useState(5);
  const [plannedPlayerCount, setPlannedPlayerCount] = useState<(typeof playerCountRange)[number]>(5);
  const [hostRoleOptions, setHostRoleOptions] = useState<RolePresetOptions>(() => getRecommendedRolePresetOptions(5));
  const [joinName, setJoinName] = useState('');
  const [joinCode, setJoinCode] = useState(() => parseJoinCodeFromUrl(window.location.href));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const aiActionKeyRef = useRef('');
  const [restorableSnapshot, setRestorableSnapshot] = useState<RoomSnapshot>();
  const [restorablePlayerId, setRestorablePlayerId] = useState('');

  const currentPlayer = snapshot?.players.find((player) => player.id === currentPlayerId);
  const isDemoMode = Boolean(snapshot?.room.settings.createdInDemoMode);
  const startValidation = snapshot ? getStartValidation(snapshot.players, snapshot.room.settings) : undefined;
  const privateInfo = useMemo(
    () => (currentPlayer && snapshot ? getPrivateRoleInfo(currentPlayer, snapshot.players) : undefined),
    [currentPlayer, snapshot],
  );

  useEffect(() => {
    const explicitEntryScreen = parseEntryStep(window.location.href);
    if (explicitEntryScreen !== 'home') return;

    const sessionKeys = getSessionStorageKeys();
    const storedRoomId = localStorage.getItem(sessionKeys.currentRoomId);
    const storedPlayerId = localStorage.getItem(sessionKeys.currentPlayerId);
    if (!storedRoomId || !storedPlayerId) return;

    let cancelled = false;
    void getRoomById(storedRoomId)
      .then((restoredSnapshot) => {
        if (cancelled) return;
        if (restoredSnapshot?.players.some((player) => player.id === storedPlayerId)) {
          setRestorableSnapshot(restoredSnapshot);
          setRestorablePlayerId(storedPlayerId);
          return;
        }
        clearSessionBinding();
        setCurrentPlayerId('');
        setSnapshot(undefined);
        setScreen('home');
        setMessage(t('You were removed from the room.'));
      })
      .catch((error) => {
        if (cancelled) return;
        clearSessionBinding();
        setCurrentPlayerId('');
        setMessage(error instanceof Error ? error.message : t('Could not restore room.'));
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
      if (!nextSnapshot) {
        clearSessionBinding();
        setCurrentPlayerId('');
        setSnapshot(undefined);
        setScreen('join');
        setMessage(t('Room expired or was closed.'));
        return;
      }
      if (currentPlayerId && !nextSnapshot.players.some((player) => player.id === currentPlayerId)) {
        clearSessionBinding();
        setCurrentPlayerId('');
        setSnapshot(undefined);
        setScreen('join');
        setMessage(t('You were removed from the room.'));
        return;
      }
      setSnapshot(nextSnapshot);
    });
  }, [currentPlayerId, snapshot?.room.id]);

  useEffect(() => {
    if (!snapshot || isDemoMode || !currentPlayer?.isHost) return;
    const action = getNextRoomAiAction(snapshot);
    if (!action) return;
    const actionKey = `${snapshot.room.id}:${snapshot.room.updatedAt ?? ''}:${getRoomAiActionKey(action)}`;
    if (aiActionKeyRef.current === actionKey) return;
    aiActionKeyRef.current = actionKey;
    const timer = window.setTimeout(() => {
      void executeRoomAiAction(snapshot.room.id, action)
        .then(setSnapshot)
        .catch((error) => setMessage(error instanceof Error ? error.message : t('Could not run AI action.')));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [currentPlayer?.id, currentPlayer?.isHost, isDemoMode, snapshot]);

  async function handleCreateRoom(event: React.FormEvent) {
    event.preventDefault();
    if (!hostName.trim()) return setMessage(t('Enter your nickname first.'));
    setBusy(true);
    setMessage('');
    try {
      const result = await createRoom({
        displayName: hostName,
        humanPlayerCount,
        plannedPlayerCount,
        roleOptions: hostRoleOptions,
        deviceToken,
      });
      saveSessionBinding(result.snapshot.room.id, result.currentPlayerId);
      setCurrentPlayerId(result.currentPlayerId);
      setSnapshot(result.snapshot);
      clearEntryStepFromUrl();
      setScreen('room');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not create room.'));
    } finally {
      setBusy(false);
    }
  }

  function handleHumanPlayerCount(nextHumanPlayerCount: number) {
    setHumanPlayerCount(nextHumanPlayerCount);
    if (plannedPlayerCount < nextHumanPlayerCount) {
      const nextPlayerCount = Math.max(5, nextHumanPlayerCount) as (typeof playerCountRange)[number];
      setPlannedPlayerCount(nextPlayerCount);
      setHostRoleOptions(getRecommendedRolePresetOptions(nextPlayerCount));
    }
  }

  function handlePlannedPlayerCount(nextPlayerCount: (typeof playerCountRange)[number]) {
    setPlannedPlayerCount(nextPlayerCount);
    setHostRoleOptions(getRecommendedRolePresetOptions(nextPlayerCount));
  }

  function handleHostRoleToggle(key: keyof RolePresetOptions) {
    setHostRoleOptions((current) => sanitizeRoleOptions(plannedPlayerCount, { ...current, [key]: !current[key] }));
  }

  async function handleJoinRoom(event: React.FormEvent) {
    event.preventDefault();
    const normalizedCode = normalizeRoomCode(joinCode);
    setJoinCode(normalizedCode);
    if (normalizedCode.length !== 5 || !joinName.trim()) return setMessage(t('Enter the 5-digit room code and nickname.'));
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
      setMessage(error instanceof Error ? error.message : t('Could not join room.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleReady() {
    if (!snapshot || !currentPlayer || busy) return;
    if (isDemoMode) {
      setSnapshot({
        ...snapshot,
        players: snapshot.players.map((player) => (player.id === currentPlayer.id ? { ...player, isReady: !player.isReady } : player)),
      });
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      setSnapshot(await setReady(snapshot.room.id, currentPlayer.id, !currentPlayer.isReady));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not update ready state.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !currentPlayer || busy) return;
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
    setBusy(true);
    setMessage('');
    try {
      setSnapshot(await updateNickname(snapshot.room.id, currentPlayer.id, name));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not update nickname.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleStartGame() {
    if (!snapshot || !currentPlayer || startValidation || busy) return;
    if (!currentPlayer.isHost) return setMessage(t('Only the host can start the game.'));
    setBusy(true);
    setMessage('');
    try {
      const result = await startGame(snapshot.room.id, currentPlayer.id);
      if (result.snapshot) setSnapshot(result.snapshot);
      setMessage(result.ok ? '' : result.reason ?? t('Could not start game.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not start game.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleMissionStateChange(nextMissionState: MissionState) {
    if (!snapshot || !currentPlayer) return;
    const nextSnapshot = applyMissionStateToSnapshot(cloneRoomSnapshot(snapshot), nextMissionState);
    if (isDemoMode) {
      setSnapshot(nextSnapshot);
      return;
    }
    try {
      setSnapshot(await updateMissionState(snapshot.room.id, currentPlayer.id, nextMissionState));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not update mission flow.'));
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
        setMessage(error instanceof Error ? error.message : t('Could not propose team.'));
      }
      return;
    }
    try {
      setSnapshot(await proposeMissionTeam(snapshot.room.id, currentPlayer.id, selectedTeamIds));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not propose team.'));
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
        setMessage(error instanceof Error ? error.message : t('Could not submit vote.'));
      }
      return;
    }
    try {
      setSnapshot(await submitTeamVote(snapshot.room.id, currentPlayer.id, vote));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not submit vote.'));
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
        setMessage(error instanceof Error ? error.message : t('Could not submit mission card.'));
      }
      return;
    }
    try {
      setSnapshot(await submitMissionCard(snapshot.room.id, currentPlayer.id, card));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not submit mission card.'));
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
        await handleMissionStateChange(nextMissionState);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t('Could not submit assassination.'));
      }
      return;
    }
    try {
      setSnapshot(await submitAssassination(snapshot.room.id, currentPlayer.id, targetPlayerId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not submit assassination.'));
    }
  }

  async function handleReadyForNextGame() {
    if (!snapshot || !currentPlayer || busy) return;
    if (isDemoMode) {
      try {
        setSnapshot(readyForNextGameInSnapshot(cloneRoomSnapshot(snapshot), currentPlayer.id));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t('Could not ready for next game.'));
      }
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      setSnapshot(await readyForNextGame(snapshot.room.id, currentPlayer.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not ready for next game.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemovePlayer(targetPlayerId: string) {
    if (!snapshot || !currentPlayer?.isHost) return;
    setMessage('');
    if (isDemoMode) return;
    try {
      setSnapshot(await removePlayer(snapshot.room.id, currentPlayer.id, targetPlayerId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not remove player.'));
    }
  }

  async function handleTransferHost(targetPlayerId: string) {
    if (!snapshot || !currentPlayer?.isHost || busy) return;
    if (!window.confirm(t('Transfer host rights to this player?'))) return;
    setBusy(true);
    setMessage('');
    try {
      setSnapshot(await transferHost(snapshot.room.id, currentPlayer.id, targetPlayerId));
      setMessage(t('Host rights transferred.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not transfer host.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetRoomToLobby() {
    if (!snapshot || !currentPlayer?.isHost || busy) return;
    if (!window.confirm(t('Abandon this game and return everyone to the lobby? Roles and mission progress will be cleared.'))) return;
    setBusy(true);
    setMessage('');
    try {
      setSnapshot(await resetRoomToLobby(snapshot.room.id, currentPlayer.id));
      setMessage(t('Game abandoned. Back to lobby.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not reset game.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDissolveRoom() {
    if (!snapshot || !currentPlayer?.isHost || busy) return;
    if (!window.confirm(t('Dissolve this room for everyone? This cannot be undone.'))) return;
    setBusy(true);
    setMessage('');
    try {
      await dissolveRoom(snapshot.room.id, currentPlayer.id);
      clearSessionBinding();
      setCurrentPlayerId('');
      setSnapshot(undefined);
      navigateEntry('home', { replace: true });
      setMessage(t('Room dissolved.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not dissolve room.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleLeaveRoom() {
    if (!snapshot || !currentPlayer) return;
    const started = snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup';
    const finished = snapshot.room.status === 'finished' || snapshot.room.settings.missionState?.phase === 'finished';
    setBusy(true);
    setMessage('');
    if (isDemoMode || (started && !finished)) {
      if (started && !finished && !window.confirm(t('This game has already started. Leave this device and go back home? The table will keep your seat so the active game is not broken.'))) {
        setBusy(false);
        return;
      }
      clearSessionBinding();
      setCurrentPlayerId('');
      setSnapshot(undefined);
      navigateEntry('home', { replace: true });
      setMessage(isDemoMode ? t('You left the demo room.') : t('You left this table on this device.'));
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
      setMessage(t('You left the room.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not leave room.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleLeaveRestorableRoom() {
    if (!restorableSnapshot || !restorablePlayerId || busy) return;
    if (!window.confirm(getOldRoomLeaveConfirmation(restorableSnapshot))) return;
    setBusy(true);
    setMessage('');
    try {
      await leaveRoom(restorableSnapshot.room.id, restorablePlayerId);
      clearSessionBinding();
      setRestorableSnapshot(undefined);
      setRestorablePlayerId('');
      setCurrentPlayerId('');
      setSnapshot(undefined);
      setScreen('home');
      setMessage(t('Old room cleared.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not leave room.'));
    } finally {
      setBusy(false);
    }
  }

  function handleRestoreRoom() {
    if (!restorableSnapshot || !restorablePlayerId) return;
    setCurrentPlayerId(restorablePlayerId);
    setSnapshot(restorableSnapshot);
    setRestorableSnapshot(undefined);
    setRestorablePlayerId('');
    clearEntryStepFromUrl();
    setScreen('room');
    setMessage('');
  }

  async function handleCreateNewFromRestore() {
    if (!restorableSnapshot || !restorablePlayerId || busy) return;
    if (!window.confirm(getOldRoomCreateNewConfirmation(restorableSnapshot))) return;
    setBusy(true);
    setMessage('');
    try {
      await leaveRoom(restorableSnapshot.room.id, restorablePlayerId);
      clearSessionBinding();
      setRestorableSnapshot(undefined);
      setRestorablePlayerId('');
      setCurrentPlayerId('');
      setSnapshot(undefined);
      navigateEntry('create');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Could not leave room.'));
    } finally {
      setBusy(false);
    }
  }

  function getOldRoomLeaveConfirmation(room: RoomSnapshot) {
    return isRoomStaleForExit(room)
      ? t('Leave this old room? You will be removed from its player list. If it was an abandoned active game, the table will be returned to the lobby.')
      : t('This game still looks active. Re-enter the room or ask the host to abandon it before leaving.');
  }

  function getOldRoomCreateNewConfirmation(room: RoomSnapshot) {
    return isRoomStaleForExit(room)
      ? t('Leave the old room and create a new one? You will be removed from the old player list first.')
      : t('This game still looks active. Re-enter the room or ask the host to abandon it before creating a new room.');
  }

  return (
    <main className={[
      'shell',
      screen === 'demo' || screen === 'demoJoin' ? 'demo-shell' : '',
      screen === 'room' ? 'room-shell' : '',
    ].filter(Boolean).join(' ')}>
      <header className="hero">
        <div className="hero-top"><p className="eyebrow">{t('Avalon Host')}</p><LanguageSwitcher /></div>
        <h1>{screen === 'room' ? getRoomHeroTitle(snapshot, t) : t('Gather the Knights of Avalon')}</h1>
        <p className="lede">{screen === 'room' ? getRoomHeroCopy(snapshot, t) : t('Summon a room, let every knight ready at the table, then reveal each secret role on their own phone.')}</p>
      </header>

      {message && <p className="notice">{message}</p>}

      {screen === 'home' && restorableSnapshot && (
        <section className="panel restore-panel">
          <p className="eyebrow">{t('Previous room found')}</p>
          <h2>{t('You were previously at room')} {restorableSnapshot.room.code}</h2>
          <p>{t('Choose whether to re-enter it, leave the old room, or start fresh.')}</p>
          <div className="share-actions">
            <button type="button" className="primary" onClick={handleRestoreRoom} disabled={busy}>{t('Re-enter Room')}</button>
            <button type="button" onClick={handleLeaveRestorableRoom} disabled={busy}>{t('Leave Old Room')}</button>
            <button type="button" onClick={handleCreateNewFromRestore} disabled={busy}>{t('Leave Old Room & Create New Room')}</button>
          </div>
        </section>
      )}

      {screen === 'home' && (
        <section className="entry">
          <div className="entry-intro">
            <h2>{t('Let Merlin handle the hidden-role ritual')}</h2>
            <p>{t('Avalon Host gives the table one magic number, watches the round table fill, and reveals only the secrets each player should know.')}</p>
          </div>
          <section className="path-section" aria-labelledby="choose-path-title">
            <div>
              <p className="eyebrow">{t('Choose your path')}</p>
              <h2 id="choose-path-title">{t('Host / Join / Demo')}</h2>
            </div>
            <div className="path-grid" aria-label={t('Primary actions')}>
              <button type="button" className="path-card primary-path" onClick={() => navigateEntry('create')}>
                <span>{t('Host the round')}</span>
                <small>{t('Create a live 5-digit code for the table.')}</small>
              </button>
              <button type="button" className="path-card" onClick={() => navigateEntry('join')}>
                <span>{t('Join by rune')}</span>
                <small>{t("Enter a host's 5-digit code and ready up.")}</small>
              </button>
              <button type="button" className="path-card demo-button" onClick={() => navigateEntry('demo')}>
                <span>{t('Try demo')}</span>
                <small>{t('Simulate 5-10 phone screens on this laptop.')}</small>
              </button>
            </div>
          </section>
          <div className="workflow-grid" aria-label={t('Live workflow')}>
            <article>
              <strong>{t('1. Host opens the hall')}</strong>
              <span>{t('Share the 5-digit room code with every knight at the table.')}</span>
            </article>
            <article>
              <strong>{t('2. Knights take seats')}</strong>
              <span>{t('The lobby tracks the fellowship and who is ready for the quest.')}</span>
            </article>
            <article>
              <strong>{t('3. Secrets are revealed')}</strong>
              <span>{t("Each phone shows only that player's role and night vision.")}</span>
            </article>
          </div>
          <div className="entry-guide">
            <h2>{t('What each choice means')}</h2>
            <p><strong>{t('Host')}</strong> {t('opens a real table room.')} <strong>{t('Join')}</strong> {t('is for players with a 5-digit code.')} <strong>{t('Demo')}</strong> {t('stays on this device and never connects to Neon.')}</p>
          </div>
        </section>
      )}

      {screen === 'demo' && (
        <section className="demo-panel">
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>{t('Back')}</button>
          <DemoSimulator />
        </section>
      )}

      {screen === 'create' && (
        <section className="panel">
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>{t('Back')}</button>
          <h2>{t('Create Room')}</h2>
          <form className="stack" onSubmit={handleCreateRoom}>
            <label>
              {t('Your nickname')}
              <input value={hostName} onChange={(event) => setHostName(event.target.value)} maxLength={24} autoFocus />
            </label>
            <CreateRoomRoleConfig
              humanPlayerCount={humanPlayerCount}
              playerCount={plannedPlayerCount}
              onHumanPlayerCountChange={handleHumanPlayerCount}
              roleOptions={hostRoleOptions}
              onPlayerCountChange={handlePlannedPlayerCount}
              onToggleRole={handleHostRoleToggle}
            />
            <button type="submit" className="primary" disabled={busy}>{busy ? t('Creating...') : t('Create Room')}</button>
          </form>
        </section>
      )}

      {screen === 'join' && (
        <section className="panel">
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>{t('Back')}</button>
          <h2>{t('Join Room')}</h2>
          <form className="stack" onSubmit={handleJoinRoom}>
            <label>
              {t('5-digit room code')}
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
              {t('Your nickname')}
              <input value={joinName} onChange={(event) => setJoinName(event.target.value)} maxLength={24} />
            </label>
            <button type="submit" className="primary" disabled={busy}>{busy ? t('Joining...') : t('Join Room')}</button>
          </form>
        </section>
      )}

      {screen === 'demoJoin' && (
        <section className="demo-panel">
          <button type="button" className="back-button" onClick={() => navigateEntry('home')}>{t('Back')}</button>
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
          onTransferHost={handleTransferHost}
          onResetRoomToLobby={handleResetRoomToLobby}
          onDissolveRoom={handleDissolveRoom}
          onLeave={handleLeaveRoom}
          onMissionStateChange={handleMissionStateChange}
          onProposeMissionTeam={handleProposeMissionTeam}
          onSubmitTeamVote={handleSubmitTeamVote}
          onSubmitMissionCard={handleSubmitMissionCard}
          onAssassination={handleAssassination}
          onReadyForNextGame={handleReadyForNextGame}
          isDemoMode={isDemoMode}
          busy={busy}
        />
      )}

      <footer className="runtime-footer">
        <span>{isHostedConfigured && !isDevSessionActive() ? t('Neon API mode') : t('Local browser demo mode')}</span>
      </footer>
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

function CreateRoomRoleConfig({
  humanPlayerCount,
  playerCount,
  roleOptions,
  onHumanPlayerCountChange,
  onPlayerCountChange,
  onToggleRole,
}: {
  humanPlayerCount: number;
  playerCount: (typeof playerCountRange)[number];
  roleOptions: RolePresetOptions;
  onHumanPlayerCountChange: (playerCount: number) => void;
  onPlayerCountChange: (playerCount: (typeof playerCountRange)[number]) => void;
  onToggleRole: (key: keyof RolePresetOptions) => void;
}) {
  const { t, language } = useI18n();
  const rule = getPlayerCountRule(playerCount);
  const preset = buildRolePreset(playerCount, roleOptions);
  const goodRoles = preset.roles.filter((role) => roleAllegiance(role) === 'good');
  const evilRoles = preset.roles.filter((role) => roleAllegiance(role) === 'evil');
  const aiCount = Math.max(0, playerCount - humanPlayerCount);

  return (
    <section className="create-role-config" aria-label={t('Role configuration')}>
      <div>
        <h3>{t('Human players')}</h3>
        <div className="segmented" aria-label={t('Human player count')}>
          {Array.from({ length: 9 }, (_, index) => index + 2).map((count) => (
            <button
              key={count}
              type="button"
              className={count === humanPlayerCount ? 'selected' : ''}
              onClick={() => onHumanPlayerCountChange(count)}
            >
              {count}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3>{t('Table size')}</h3>
        <div className="segmented" aria-label={t('Table size')}>
          {playerCountRange.map((count) => (
            <button
              key={count}
              type="button"
              className={count === playerCount ? 'selected' : ''}
              disabled={count < humanPlayerCount}
              onClick={() => onPlayerCountChange(count)}
            >
              {count}
            </button>
          ))}
        </div>
        <p className="create-role-summary">{rule.goodCount} {t('Good')} / {rule.evilCount} {t('Evil')}</p>
        {aiCount > 0 && (
          <div className="ai-fill-note">
            <strong>{humanPlayerCount} {t('humans')} + {aiCount} {t('AI')}</strong>
            <span>{t('AI will fill empty seats and auto-ready/vote/play mission cards.')}</span>
          </div>
        )}
      </div>

      <div>
        <h3>{t('Role setup')}</h3>
        <p className="hint">{t('Recommended defaults update when player count changes. Adjust special roles before creating the room.')}</p>
        <div className="create-role-sides">
          <RoleList title={t('Good roles')} roles={goodRoles} language={language} />
          <RoleList title={t('Evil roles')} roles={evilRoles} language={language} />
        </div>
      </div>

      <div>
        <h3>{t('Special roles')}</h3>
        <div className="role-option-chips" aria-label={t('Special roles')}>
          {optionalRoleControls.map((control) => {
            const checked = Boolean(roleOptions[control.key]);
            const disabled = !checked && !canEnableRoleOption(playerCount, roleOptions, control.key);
            return (
              <button
                key={control.key}
                type="button"
                className={`role-option-chip ${checked ? 'selected' : ''}`}
                aria-pressed={checked}
                disabled={disabled}
                onClick={() => onToggleRole(control.key)}
              >
                <span>{formatRole(control.role, language)}</span>
                <small>{t(control.note)}</small>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function RoleList({ title, roles, language }: { title: string; roles: Role[]; language: ReturnType<typeof useI18n>['language'] }) {
  return (
    <div className="create-role-list">
      <span>{title}</span>
      <div>
        {summarizeRoleEntries(roles).map((item) => (
          <span key={item.role} className={`role-chip ${roleAllegiance(item.role)}`}>
            {formatRoleCount(item.role, item.count, language)}
          </span>
        ))}
      </div>
    </div>
  );
}

type DemoController = 'human' | 'ai';

type DemoMode = 'manual' | 'ai';

interface AgentMemory {
  suspicion: Record<string, number>;
  notes: string[];
  publicClaims: string[];
}

interface DemoPlayer {
  id: string;
  displayName: string;
  seatIndex: number;
  role: Role;
  revealRole: boolean;
  revealNightInfo: boolean;
  controller: DemoController;
  persona?: string;
  memory?: AgentMemory;
  lastReasoningSummary?: string;
  lastPublicSpeech?: string;
  teamVote?: Vote;
  missionCard?: MissionCard;
}

interface DemoMissionResult {
  roundIndex: number;
  outcome: 'success' | 'fail';
  successCount: number;
  failCount: number;
  requiredFails: number;
  selectedTeamIds?: string[];
}

interface DemoHistoryEntry {
  id: string;
  roundIndex: number;
  actorId?: string;
  actorName?: string;
  kind: 'speech' | 'proposal' | 'vote' | 'mission' | 'result' | 'assassin';
  text: string;
}

interface DemoAssassination {
  targetPlayerId: string;
  targetName: string;
  hitMerlin: boolean;
  winner: Allegiance;
}

interface DemoState {
  playerCount: number;
  roleOptions: RolePresetOptions;
  mode: DemoMode;
  humanCount: number;
  players: DemoPlayer[];
  phase: 'setup' | 'proposal' | 'vote' | 'mission' | 'result' | 'assassin' | 'finished';
  roundIndex: number;
  leaderIndex: number;
  selectedTeamIds: string[];
  missionResults: DemoMissionResult[];
  tableHistory: DemoHistoryEntry[];
  aiHistory: DemoHistoryEntry[];
  lastVote?: { approveCount: number; rejectCount: number; passed: boolean };
  lastMission?: DemoMissionResult;
  assassination?: DemoAssassination;
}

const demoNames = ['Arthur', 'Bors', 'Cai', 'Dagonet', 'Elaine', 'Gareth', 'Helena', 'Isolde', 'Lucan', 'Yvain'];
const aiPersonas = ['Cautious analyst', 'Aggressive accuser', 'Quiet observer', 'Social diplomat', 'Chaotic liar', 'Risk-aware captain', 'Pattern hunter', 'Overconfident knight', 'Skeptical voter'];
const optionalRoleControls: Array<{ key: keyof RolePresetOptions; role: Role; label: string; note: string }> = [
  { key: 'includePercival', role: 'Percival', label: 'Percival', note: 'Good, sees Merlin candidates.' },
  { key: 'includeMorgana', role: 'Morgana', label: 'Morgana', note: 'Evil, appears as Merlin candidate.' },
  { key: 'includeMordred', role: 'Mordred', label: 'Mordred', note: 'Evil, hidden from Merlin.' },
  { key: 'includeOberon', role: 'Oberon', label: 'Oberon', note: 'Evil, hidden from other evil.' },
];
const DEMO_RESULT_AUTO_ADVANCE_MS = 2200;

function DemoSimulator() {
  const { t, language } = useI18n();
  const [demo, setDemo] = useState(() => createDemoState(7, getRecommendedRolePresetOptions(7)));
  const [autoAi, setAutoAi] = useState(true);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
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

  useEffect(() => {
    if (demo.mode !== 'ai' || !autoAi || aiBusy || winner || demo.phase === 'setup' || demo.phase === 'result' || demo.phase === 'finished') return undefined;
    if (!hasPendingAiAction(demo)) return undefined;
    const timeout = window.setTimeout(() => {
      void runAiOnce();
    }, 750);
    return () => window.clearTimeout(timeout);
  }, [aiBusy, autoAi, demo, winner]);

  function resetWith(playerCount: number, roleOptions: RolePresetOptions, options: { mode?: DemoMode; humanCount?: number } = {}) {
    setDemo(createDemoState(playerCount, sanitizeRoleOptions(playerCount, roleOptions), {
      mode: options.mode ?? demo.mode,
      humanCount: options.humanCount ?? demo.humanCount,
    }));
  }

  function startTable() {
    setDemo((current) => ({
      ...current,
      phase: 'proposal',
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, undefined, 'result', `${current.mode === 'ai' ? 'AI Table' : 'Manual demo'} started with ${current.playerCount} players.`),
      ],
    }));
  }

  function switchDemoMode(mode: DemoMode) {
    resetWith(demo.playerCount, demo.roleOptions, { mode, humanCount: mode === 'ai' ? Math.min(demo.humanCount, 3) : demo.humanCount });
  }

  function setHumanCount(humanCount: number) {
    resetWith(demo.playerCount, demo.roleOptions, { mode: 'ai', humanCount });
  }

  function toggleOptionalRole(key: keyof RolePresetOptions) {
    resetWith(demo.playerCount, { ...demo.roleOptions, [key]: !demo.roleOptions[key] });
  }

  async function runAiOnce() {
    if (aiBusy || !hasPendingAiAction(demo)) return;
    const actor = findNextAiActor(demo);
    if (!actor) return;
    setAiBusy(true);
    setAiStatus(`${actor.displayName} ${t('is thinking…')}`);
    try {
      const request = buildAiAvalonDecisionRequest(demo, actor.id, actor.persona);
      const response = await fetch('/api/ai-avalon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, locale: language }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error?.message === 'string' ? body.error.message : 'AI provider unavailable; using heuristic fallback.');
      }
      setDemo((current) => applyAiDecision(current, actor.id, body.decision));
      setAiStatus(`${t('AI move from')} ${body.provider ?? 'AI'}${body.model ? ` (${body.model})` : ''}.`);
    } catch (error) {
      setDemo(runNextAiAction);
      setAiStatus(`${error instanceof Error ? error.message : t('AI failed.')} ${t('Used local heuristic fallback.')}`);
    } finally {
      setAiBusy(false);
    }
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
      tableHistory: [
        ...current.tableHistory,
        makeHistory(
          current,
          current.players[current.leaderIndex],
          'proposal',
          `${current.players[current.leaderIndex]?.displayName} proposed ${current.selectedTeamIds.map((id) => current.players.find((player) => player.id === id)?.displayName ?? id).join(', ')}.`,
        ),
      ],
      lastVote: undefined,
      lastMission: undefined,
    }));
  }

  function vote(playerId: string, teamVote: Vote) {
    if (demo.phase !== 'vote') return;
    setDemo((current) => {
      const voter = current.players.find((player) => player.id === playerId);
      const nextPlayers = current.players.map((player) => (player.id === playerId ? { ...player, teamVote } : player));
      const resolved = resolveDemoVoteIfReady(current, nextPlayers);
      return {
        ...current,
        players: resolved.players,
        tableHistory: [...current.tableHistory, makeHistory(current, voter, 'vote', `${voter?.displayName ?? playerId} voted ${teamVote}.`)],
        ...resolved.statePatch,
      };
    });
  }

  function playMissionCard(playerId: string, missionCard: MissionCard) {
    if (demo.phase !== 'mission') return;
    setDemo((current) => {
      const actor = current.players.find((player) => player.id === playerId);
      const nextPlayers = current.players.map((player) => (player.id === playerId ? { ...player, missionCard } : player));
      const next = resolveDemoMissionIfReady(current, nextPlayers);
      return {
        ...next,
        tableHistory: [...next.tableHistory, makeHistory(current, actor, 'mission', `${actor?.displayName ?? playerId} submitted a mission card.`)],
      };
    });
  }

  function chooseAssassinationTarget(targetPlayerId: string) {
    if (demo.phase !== 'assassin') return;
    setDemo((current) => resolveDemoAssassination(current, targetPlayerId));
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
          <p className="eyebrow">{t('Local tabletop simulator')}</p>
          <h2>{t('Multi-phone Demo')}</h2>
        </div>
        <button type="button" onClick={() => resetWith(demo.playerCount, demo.roleOptions)}>{t('Reset table')}</button>
      </div>

      {demo.phase === 'setup' ? (
        <section className="demo-setup">
          <div className="demo-mode-tabs">
            <button type="button" className={demo.mode === 'manual' ? 'selected' : ''} onClick={() => switchDemoMode('manual')}>{t('Manual phones')}</button>
            <button type="button" className={demo.mode === 'ai' ? 'selected' : ''} onClick={() => switchDemoMode('ai')}>{t('AI Table')}</button>
          </div>
          <div className="demo-ai-intro">
            {demo.mode === 'ai' ? (
              <>
                <h3>{t('AI fill seats')}</h3>
                <p>{t('Start solo or keep 2–3 human seats. Each AI player gets only its role-visible information, public table history, and its own private suspicion memory.')}</p>
              </>
            ) : (
              <>
                <h3>{t('Manual multi-phone demo')}</h3>
                <p>{t('Drive every virtual phone yourself to demonstrate reveal, proposal, voting, and mission flow.')}</p>
              </>
            )}
          </div>
          <div>
            <h3>{t('Players')}</h3>
            <div className="segmented" aria-label={t('Player count')}>
              {playerCountRange.map((count) => (
                <button
                  key={count}
                  type="button"
                  className={count === demo.playerCount ? 'selected' : ''}
                  onClick={() => resetWith(count, getRecommendedRolePresetOptions(count))}
                >
                  {count}
                </button>
              ))}
            </div>
            <p>{rule.goodCount} {t('Good')} / {rule.evilCount} {t('Evil')}</p>
          </div>
          {demo.mode === 'ai' && (
            <div>
              <h3>{t('Human seats')}</h3>
              <div className="segmented" aria-label={t('Human seats')}>
                {[1, 2, 3].map((count) => (
                  <button key={count} type="button" className={demo.humanCount === count ? 'selected' : ''} onClick={() => setHumanCount(count)}>
                    {count}
                  </button>
                ))}
              </div>
              <p>{demo.playerCount - demo.humanCount} {t('AI agents will fill the table.')}</p>
            </div>
          )}
          <div>
            <h3>{t('Role setup')}</h3>
            <div className="role-preset">
              <span>{t('Fixed')}: {preset.requiredRoles.map((role) => formatRole(role, language)).join(', ')}</span>
              <span>{t('Fill')}: {summarizeRoles(preset.fillerRoles, language)}</span>
            </div>
            <div className="optional-roles">
              {optionalRoleControls.map((control) => {
                const checked = Boolean(demo.roleOptions[control.key]);
                const disabled = !checked && !canEnableRoleOption(demo.playerCount, demo.roleOptions, control.key);
                return (
                  <label key={control.key} className="check role-toggle">
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleOptionalRole(control.key)} />
                    <span><strong>{formatRole(control.label, language)}</strong><small>{t(control.note)}</small></span>
                  </label>
                );
              })}
            </div>
          </div>
          {demo.mode === 'ai' && (
            <div className="ai-instruction-card">
              <h3>{t('Agent input contract')}</h3>
              <p>{t('On each turn the orchestrator sends: rules + current phase + legal actions + public history + that agent’s role vision + that agent’s private memory. Other agents’ private memory is never included.')}</p>
            </div>
          )}
          <div className="demo-start-row">
            <button type="button" className="primary" onClick={startTable}>{demo.mode === 'ai' ? t('Start AI table') : t('Start tabletop')}</button>
          </div>
        </section>
      ) : (
        <section className="demo-setup-summary" aria-label={t('Demo table setup')}>
          <span>{demo.mode === 'ai' ? t('AI Table') : t('Manual Demo')}</span>
          <span>{demo.playerCount} {t('players')}</span>
          {demo.mode === 'ai' && <span>{demo.humanCount} {t('human')} / {demo.playerCount - demo.humanCount} AI</span>}
          <span>{rule.goodCount} {t('Good')} / {rule.evilCount} {t('Evil')}</span>
          <span>{t('Special roles')}: {includedSpecialRoles.length ? includedSpecialRoles.map((role) => formatRole(role, language)).join(', ') : t('None')}</span>
          <span>{t('Base')}: {preset.requiredRoles.map((role) => formatRole(role, language)).join(', ')}</span>
          <span>{t('Fill')}: {summarizeRoles(preset.fillerRoles, language)}</span>
        </section>
      )}

      <section className="demo-board" aria-label={t('Demo table state')}>
        <div className="quest-track">
          {[0, 1, 2, 3, 4].map((roundIndex) => {
            const result = demo.missionResults.find((item) => item.roundIndex === roundIndex);
            const threshold = rule.failThresholds[roundIndex];
            const teamNames = getDemoQuestTeamNames(demo, result?.selectedTeamIds ?? (roundIndex === demo.roundIndex ? demo.selectedTeamIds : []));
            return (
              <span key={roundIndex} className={result?.outcome ?? (roundIndex === demo.roundIndex ? 'current' : '')}>
                <strong>{formatQuestLabel(roundIndex, language)}: {rule.teamSizes[roundIndex]}{threshold > 1 ? formatFailThresholdLabel(threshold, language) : ''}</strong>
                {teamNames.length > 0 && <small>{teamNames.join(', ')}</small>}
              </span>
            );
          })}
        </div>
        <div className="status">
          <span>{t('Leader')}: {demo.players[demo.leaderIndex]?.displayName}</span>
          <span>{t('Quest')}: {demo.roundIndex + 1} {t('needs')} {teamSize}</span>
          <span>{t('Score')}: {t('Good')} {goodScore} / {t('Evil')} {evilScore}</span>
        </div>
        {demo.lastVote && <p className="hint">Last vote: {demo.lastVote.approveCount} approve, {demo.lastVote.rejectCount} reject. Team {demo.lastVote.passed ? 'approved' : 'rejected'}.</p>}
        {demo.lastMission && <p className="notice">Quest {demo.lastMission.roundIndex + 1} {demo.lastMission.outcome === 'success' ? 'succeeded' : 'failed'} with {demo.lastMission.failCount} fail card(s).</p>}
        {demo.phase === 'assassin' && <p className="notice">Good completed three quests. The Assassin now chooses one Merlin target; only after that guess is resolved is the winner final.</p>}
        {demo.phase === 'finished' && winner && (
          <p className="notice">{winner === 'good' ? 'Good wins: the Assassin missed Merlin.' : demo.assassination?.hitMerlin ? 'Evil wins: the Assassin found Merlin.' : 'Evil wins.'} Reset the table to try another setup.</p>
        )}
        {demo.phase === 'setup' && (
          <div className="mission-step">
            <p>{t('Choose player count and roles, then start the tabletop.')}</p>
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
            <p>{t('Quest result is public on every phone. Next quest starts automatically.')}</p>
          </div>
        )}
        {demo.phase === 'assassin' && (
          <div className="mission-step">
            <p>Good has three successful quests. Assassin chooses one player as Merlin: hit Merlin and Evil wins; miss and Good wins.</p>
          </div>
        )}
        {demo.phase === 'finished' && demo.assassination && (
          <div className="mission-step">
            <p>Assassin targeted {demo.assassination.targetName}. {demo.assassination.hitMerlin ? 'That was Merlin.' : 'That was not Merlin.'}</p>
          </div>
        )}
      </section>

      {demo.mode === 'ai' && demo.phase !== 'setup' && (
        <section className="ai-table-panel" aria-label={t('AI table orchestration')}>
          <div className="ai-table-controls">
            <div>
              <p className="eyebrow">{t('AI Orchestrator')}</p>
              <h3>{t('Independent agents, filtered vision')}</h3>
              <p>{t('AI actions are generated from each player’s own role, legal moves, public history, and private suspicion memory.')}</p>
            </div>
            <div className="choice-row">
              <button type="button" className={autoAi ? 'selected' : ''} onClick={() => setAutoAi(!autoAi)}>{autoAi ? t('Auto AI on') : t('Auto AI off')}</button>
              <button type="button" onClick={() => void runAiOnce()} disabled={aiBusy || !hasPendingAiAction(demo) || Boolean(winner)}>{aiBusy ? t('AI thinking…') : t('Run next AI action')}</button>
            </div>
          </div>
          {aiStatus && <p className="ai-status" aria-live="polite">{aiStatus}</p>}
          <div className="ai-history">
            {demo.tableHistory.slice(-8).map((entry) => (
              <p key={entry.id}><strong>{entry.actorName ?? 'Table'}:</strong> {entry.text}</p>
            ))}
          </div>
          {demo.aiHistory.length > 0 && (
            <div className="ai-history ai-private-history" aria-label={t('AI private reasoning log')}>
              {demo.aiHistory.slice(-5).map((entry) => (
                <p key={entry.id}><strong>{entry.actorName ?? 'AI'}:</strong> {entry.text}</p>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="demo-phone-grid" aria-label={t('Virtual phones')}>
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
            onAssassinate={chooseAssassinationTarget}
            assassination={demo.assassination}
            winner={winner}
            lastMission={demo.lastMission}
            tableMode={demo.mode}
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
  onAssassinate,
  assassination,
  winner,
  lastMission,
  tableMode,
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
  onAssassinate: (targetPlayerId: string) => void;
  assassination?: DemoAssassination;
  winner?: Allegiance;
  lastMission?: DemoMissionResult;
  tableMode: DemoMode;
}) {
  const { t, language } = useI18n();
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
      agentView={tableMode === 'ai' ? getAgentViewSummary(player, privateInfo) : undefined}
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
        onAssassinate,
        assassination,
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
      candidates: PlayerPhonePerson[];
      onAssassinate?: (targetPlayerId: string) => void;
    }
  | {
      kind: 'finished';
      winner?: Allegiance;
      playerWon?: boolean;
      result?: PlayerPhoneResult;
      assassination?: DemoAssassination;
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
  agentView,
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
  agentView?: React.ReactNode;
  action?: PlayerPhoneAction;
}) {
  const { t } = useI18n();
  const isLeader = player.id === leaderId;
  const onTeam = selectedTeamIds.includes(player.id);
  const publicRole = isLeader ? t('Current Leader') : mode === 'live' ? t('Your phone') : t('Table player');
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
        <small>{t('Seat')} {player.seatIndex + 1} · {publicRole}</small>
        {onTeam && <span className="phone-team-pill">{t('Mission team')}</span>}
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
      {agentView}
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
  onAssassinate,
  assassination,
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
  onAssassinate: (targetPlayerId: string) => void;
  assassination?: DemoAssassination;
}): PlayerPhoneAction | undefined {
  const isAiControlled = player.controller === 'ai';
  if (phase === 'proposal') {
    return {
      kind: 'proposal',
      isLeader,
      leaderName: players.find((candidate) => candidate.id === leaderId)?.displayName ?? 'Leader',
      teamSize,
      selectedTeamIds,
      players,
      canEdit: isLeader && !isAiControlled,
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
      onVote: isAiControlled ? undefined : (vote) => onVote(player.id, vote),
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
      onPlayMissionCard: isAiControlled ? undefined : (card) => onPlayMissionCard(player.id, card),
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
  if (phase === 'assassin') {
    return {
      kind: 'assassin',
      isAssassin: player.role === 'Assassin',
      candidates: players.filter((candidate) => candidate.role !== 'Assassin'),
      onAssassinate: player.role === 'Assassin' && !isAiControlled ? onAssassinate : undefined,
    };
  }
  if (phase === 'finished') {
    return {
      kind: 'finished',
      winner,
      playerWon: winner && roleAllegiance(player.role) === winner,
      result: lastMission,
      assassination,
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
    return { kind: 'assassin', isAssassin: player.role === 'Assassin', candidates: players.filter((candidate) => candidate.role !== 'Assassin') };
  }
  return {
    kind: 'finished',
    winner: missionState.winner,
    playerWon: Boolean(missionState.winner && player.role && roleAllegiance(player.role) === missionState.winner),
    result: lastResult,
  };
}

function PlayerPhoneActionPanel({ action }: { action: PlayerPhoneAction }) {
  const { t } = useI18n();
  if (action.kind === 'proposal') {
    const selectedCount = action.selectedTeamIds.length;
    const canAddToTeam = selectedCount < action.teamSize;
    return (
      <div className={`phone-action ${action.canEdit ? '' : 'phone-readonly'}`}>
        <span>{action.canEdit ? `${t('Propose team')} · ${selectedCount}/${action.teamSize}` : t('Proposal')}</span>
        {action.canEdit ? (
          <>
            <p>{t('You can change the crew until you submit. After submission, voting starts and the proposal is locked.')}</p>
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
            <button type="button" className="primary" disabled={selectedCount !== action.teamSize} onClick={action.onProposeTeam}>{t('Propose Team')}</button>
          </>
        ) : (
          <>
            <p>{action.isLeader ? t('You are choosing the quest team.') : `${action.leaderName} ${t('is choosing')} ${action.teamSize} ${t('players')}.`}</p>
            <p>{t('Selected')}: {selectedCount}/{action.teamSize}</p>
          </>
        )}
      </div>
    );
  }

  if (action.kind === 'vote') {
    return (
      <div className={`phone-action ${action.onVote ? '' : 'phone-readonly'}`}>
        <span>{t('Team vote')}</span>
        {action.selectedTeamNames.length > 0 && <p>{t('Team')}: {action.selectedTeamNames.join(', ')}</p>}
        <p>{t('Every player votes on this proposal, including the captain.')}</p>
        {action.onVote ? (
          <>
            <div className="choice-row">
              <button type="button" className={action.currentVote === 'approve' ? 'selected' : ''} onClick={() => action.onVote?.('approve')}>{t('Approve')}</button>
              <button type="button" className={action.currentVote === 'reject' ? 'selected' : ''} onClick={() => action.onVote?.('reject')}>{t('Reject')}</button>
            </div>
            {typeof action.submittedVoteCount === 'number' && action.playerCount && (
              <p>{t('Votes in')}: {action.submittedVoteCount}/{action.playerCount}</p>
            )}
          </>
        ) : action.currentVote ? (
          <>
            <div className={`vote-status-pill ${action.currentVote}`} aria-label={t('Submitted vote')}>
              {action.currentVote === 'approve' ? t('Approve') : t('Reject')}
            </div>
            {typeof action.submittedVoteCount === 'number' && action.playerCount && (
              <p>{t('Votes in')}: {action.submittedVoteCount}/{action.playerCount}</p>
            )}
          </>
        ) : (
          <p>{t('Vote not submitted yet.')} {typeof action.submittedVoteCount === 'number' && action.playerCount ? `${t('Votes in')}: ${action.submittedVoteCount}/${action.playerCount}.` : ''}</p>
        )}
      </div>
    );
  }

  if (action.kind === 'mission') {
    return (
      <div className={`phone-action ${action.onTeam && action.onPlayMissionCard ? '' : 'phone-readonly'}`}>
        <span>{action.onTeam ? t('Mission card') : t('Mission')}</span>
        {action.onTeam && action.onPlayMissionCard ? (
          <>
            <div className="choice-row">
              <button type="button" className={action.currentMissionCard === 'success' ? 'selected' : ''} onClick={() => action.onPlayMissionCard?.('success')}>{t('Success')}</button>
              <button
                type="button"
                className={action.currentMissionCard === 'fail' ? 'selected danger-choice' : ''}
                disabled={!action.canFailMission}
                onClick={() => action.onPlayMissionCard?.('fail')}
              >
                {t('Fail')}
              </button>
            </div>
            {typeof action.submittedCardCount === 'number' && (
              <p>{t('Cards in')}: {action.submittedCardCount}/{action.selectedTeamCount}</p>
            )}
          </>
        ) : (
          <p>
            {action.onTeam
              ? action.missionCardSubmitted
                ? `${t('Card submitted.')} ${t('Cards in')}: ${action.submittedCardCount ?? 0}/${action.selectedTeamCount}.`
                : t('Waiting for your mission card.')
              : `${action.selectedTeamCount} players are on the mission. Wait for their cards.`}
          </p>
        )}
      </div>
    );
  }

  if (action.kind === 'assassin') {
    return (
      <div className={`phone-action ${action.onAssassinate ? '' : 'phone-readonly'}`}>
        <span>{t('Assassin phase')}</span>
        {action.onAssassinate ? (
          <>
            <p>Good completed three quests. Choose Merlin: hit Merlin and Evil wins; miss and Good wins.</p>
            <div className="choice-row">
              {action.candidates.map((candidate) => (
                <button key={candidate.id} type="button" onClick={() => action.onAssassinate?.(candidate.id)}>{candidate.displayName}</button>
              ))}
            </div>
          </>
        ) : (
          <p>{action.isAssassin ? 'Waiting for the AI Assassin to choose Merlin.' : t('Good completed three quests. The Assassin is choosing Merlin.')}</p>
        )}
      </div>
    );
  }

  const isFinished = action.kind === 'finished';
  return (
    <div className={`phone-action ${action.winner ? 'phone-result' : 'phone-readonly'}`}>
      <span>{action.winner || isFinished ? t('Game result') : t('Quest result')}</span>
      {action.result && <MissionResultReveal result={action.result} />}
      {action.kind === 'finished' && action.assassination && (
        <p>Assassin targeted {action.assassination.targetName}. {action.assassination.hitMerlin ? 'Merlin was found.' : 'Merlin survived.'}</p>
      )}
      {action.winner ? (
        <p>{action.playerWon ? t('Victory') : t('Defeat')} · {action.winner === 'good' ? t('Good wins') : t('Evil wins')}</p>
      ) : (
        <p>{isFinished ? t('Game finished.') : t('Next quest starts automatically.')}</p>
      )}
    </div>
  );
}

function MissionResultReveal({ result }: { result: PlayerPhoneResult }) {
  const { t } = useI18n();
  const succeeded = result.outcome === 'success';
  return (
    <div className={`mission-result-reveal ${succeeded ? 'success' : 'fail'}`} aria-live="polite">
      <strong>{succeeded ? t('Quest Success') : t('Quest Failed')}</strong>
      <small>{result.failCount} {t('fail card')}{result.failCount === 1 ? '' : 's'} · {result.requiredFails} {t('needed to fail')}</small>
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
  const { t, language } = useI18n();
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
      coverTitle={t('Role hidden')}
      coverHint={t('Slide to peek')}
      hideLabel={t('Hide role')}
    >
      <strong>{formatRole(role, language)}</strong>
      <span>{formatAllegiance(allegiance, language)}</span>
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
  const { t, language } = useI18n();
  return (
    <PeekRevealCard
      className="phone-info phone-night-info"
      faceClassName="night-info-face"
      revealed={revealed}
      onReveal={onReveal}
      onHide={onHide}
      revealLabel={`Reveal ${playerName}'s hidden night information`}
      coverTitle={t('Night info hidden')}
      coverHint={t('Slide to peek')}
      hideLabel={t('Hide night info')}
    >
      <span>{t('Night info')}</span>
      {privateInfo.sees.length ? (
        <ul>{privateInfo.sees.map((item) => <li key={item.playerId}>{item.name}: {formatHint(item.hint, language)}</li>)}</ul>
      ) : (
        <p>{t('No extra information.')}</p>
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
    selectedTeamIds: [...current.selectedTeamIds],
  };
  const missionResults = [...current.missionResults, result];
  const goodScore = missionResults.filter((item) => item.outcome === 'success').length;
  const evilScore = missionResults.filter((item) => item.outcome === 'fail').length;
  return {
    ...current,
    players,
    phase: evilScore >= 3 ? 'finished' : goodScore >= 3 ? 'assassin' : 'result',
    missionResults,
    selectedTeamIds: goodScore >= 3 || evilScore >= 3 ? [] : current.selectedTeamIds,
    lastMission: result,
    assassination: undefined,
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

function resolveDemoAssassination(current: DemoState, targetPlayerId: string): DemoState {
  if (current.phase !== 'assassin') return current;
  const target = current.players.find((player) => player.id === targetPlayerId);
  if (!target || target.role === 'Assassin') return current;
  const assassin = current.players.find((player) => player.role === 'Assassin');
  const hitMerlin = target.role === 'Merlin';
  const winner: Allegiance = hitMerlin ? 'evil' : 'good';
  const assassination: DemoAssassination = {
    targetPlayerId: target.id,
    targetName: target.displayName,
    hitMerlin,
    winner,
  };
  return {
    ...current,
    phase: 'finished',
    assassination,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, assassin, 'assassin', `${assassin?.displayName ?? 'Assassin'} chose ${target.displayName} as Merlin. ${hitMerlin ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`),
    ],
  };
}

function getDemoWinner(demo: DemoState): Allegiance | undefined {
  const evilScore = demo.missionResults.filter((result) => result.outcome === 'fail').length;
  if (demo.phase === 'finished' && demo.assassination) return demo.assassination.winner;
  if (demo.phase === 'finished' && evilScore >= 3) return 'evil';
  return undefined;
}

function getDemoQuestTeamNames(demo: DemoState, teamIds: string[] = []): string[] {
  return teamIds.map((id) => demo.players.find((player) => player.id === id)?.displayName ?? id);
}

function createAgentMemory(playerIds: string[], selfId: string): AgentMemory {
  return {
    suspicion: Object.fromEntries(playerIds.filter((id) => id !== selfId).map((id) => [id, 0])),
    notes: ['Opening read: no public evidence yet.'],
    publicClaims: [],
  };
}

function makeHistory(demo: DemoState, actor: DemoPlayer | undefined, kind: DemoHistoryEntry['kind'], text: string): DemoHistoryEntry {
  return {
    id: `${Date.now()}-${demo.tableHistory.length}-${kind}`,
    roundIndex: demo.roundIndex,
    actorId: actor?.id,
    actorName: actor?.displayName,
    kind,
    text,
  };
}

function hasPendingAiAction(demo: DemoState): boolean {
  if (demo.mode !== 'ai') return false;
  if (demo.phase === 'proposal') return demo.players[demo.leaderIndex]?.controller === 'ai';
  if (demo.phase === 'vote') return demo.players.some((player) => player.controller === 'ai' && !player.teamVote);
  if (demo.phase === 'mission') return demo.players.some((player) => player.controller === 'ai' && demo.selectedTeamIds.includes(player.id) && !player.missionCard);
  if (demo.phase === 'assassin') return demo.players.some((player) => player.controller === 'ai' && player.role === 'Assassin');
  return false;
}

function runNextAiAction(current: DemoState): DemoState {
  if (current.mode !== 'ai' || current.phase === 'setup' || current.phase === 'result' || current.phase === 'finished' || getDemoWinner(current)) return current;
  if (current.phase === 'proposal') return runAiProposal(current);
  if (current.phase === 'vote') return runAiVote(current);
  if (current.phase === 'mission') return runAiMission(current);
  if (current.phase === 'assassin') return runAiAssassination(current);
  return current;
}

function applyAiDecision(current: DemoState, actorId: string, decision: AiAvalonDecision): DemoState {
  if (current.mode !== 'ai' || current.phase === 'setup' || current.phase === 'result' || current.phase === 'finished' || getDemoWinner(current)) return current;
  const actor = current.players.find((player) => player.id === actorId);
  if (!actor || actor.controller !== 'ai') return current;
  const publicSpeech = buildAiSpeech(current, actor, decision.publicSpeech);
  const rememberedActor = rememberAgentFromDecision(actor, current, decision, publicSpeech);

  if (current.phase === 'proposal' && current.players[current.leaderIndex]?.id === actor.id && decision.action.type === 'proposeTeam') {
    const teamSize = getTeamSize(current.playerCount, current.roundIndex);
    const teamIds = [...new Set(decision.action.teamIds)].filter((id) => current.players.some((player) => player.id === id)).slice(0, teamSize);
    if (teamIds.length !== teamSize) return runAiProposal(current);
    const players = current.players.map((player) => (player.id === actor.id ? rememberedActor : { ...player, teamVote: undefined, missionCard: undefined }));
    const proposedState = { ...current, phase: 'vote' as const, selectedTeamIds: teamIds, players, lastVote: undefined, lastMission: undefined };
    return {
      ...proposedState,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, rememberedActor, 'speech', publicSpeech),
        makeHistory(current, rememberedActor, 'proposal', `${rememberedActor.displayName} proposed ${teamIds.map((id) => playerName(current, id)).join(', ')}.`),
      ],
    };
  }

  if (current.phase === 'vote' && !actor.teamVote && decision.action.type === 'vote') {
    const vote = decision.action.vote;
    const playersWithVote = current.players.map((player) => (
      player.id === actor.id ? { ...rememberedActor, teamVote: vote } : player
    ));
    const resolved = resolveDemoVoteIfReady(current, playersWithVote);
    return {
      ...current,
      players: resolved.players,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, actor, 'speech', publicSpeech),
        makeHistory(current, actor, 'vote', `${actor.displayName} voted ${vote}.`),
      ],
      ...resolved.statePatch,
    };
  }

  if (current.phase === 'mission' && current.selectedTeamIds.includes(actor.id) && !actor.missionCard && decision.action.type === 'missionCard') {
    const legalCard = decision.action.card === 'fail' && roleAllegiance(actor.role) !== 'evil' ? 'success' : decision.action.card;
    const playersWithCard = current.players.map((player) => (
      player.id === actor.id ? { ...rememberedActor, missionCard: legalCard } : player
    ));
    const next = resolveDemoMissionIfReady(current, playersWithCard);
    return {
      ...next,
      tableHistory: [
        ...next.tableHistory,
        makeHistory(current, actor, 'speech', publicSpeech),
        makeHistory(current, actor, 'mission', `${actor.displayName} submitted a mission card.`),
      ],
      aiHistory: [
        ...next.aiHistory,
        makeHistory(current, actor, 'mission', formatMissionReasoningSummaryForHistory(decision.privateReasoningSummary)),
      ],
    };
  }

  const decisionAction = decision.action;
  if (current.phase === 'assassin' && actor.role === 'Assassin' && decisionAction.type === 'assassinate') {
    const target = current.players.find((player) => player.id === decisionAction.targetPlayerId && player.role !== 'Assassin');
    if (!target) return runAiAssassination(current);
    const rememberedPlayers = current.players.map((player) => (player.id === actor.id ? rememberedActor : player));
    const resolved = resolveDemoAssassination({ ...current, players: rememberedPlayers }, target.id);
    return {
      ...resolved,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, rememberedActor, 'speech', publicSpeech),
        makeHistory(current, rememberedActor, 'assassin', `${rememberedActor.displayName} chose ${target.displayName} as Merlin. ${target.role === 'Merlin' ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`),
      ],
      aiHistory: [
        ...current.aiHistory,
        makeHistory(current, rememberedActor, 'assassin', `Assassin reasoning: ${decision.privateReasoningSummary}`),
      ],
    };
  }

  return runNextAiAction(current);
}

function rememberAgentFromDecision(player: DemoPlayer, current: DemoState, decision: AiAvalonDecision, publicSpeech: string): DemoPlayer {
  const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
  const nextMemory = mergeAiAgentMemory(memory, decision.memoryUpdate, decision.privateReasoningSummary, publicSpeech);
  return {
    ...player,
    memory: nextMemory,
    lastReasoningSummary: decision.privateReasoningSummary,
    lastPublicSpeech: publicSpeech,
  };
}

function runAiProposal(current: DemoState): DemoState {
  const leader = current.players[current.leaderIndex];
  if (!leader || leader.controller !== 'ai') return current;
  const teamSize = getTeamSize(current.playerCount, current.roundIndex);
  const teamIds = chooseAiTeam(current, leader, teamSize);
  const publicSpeech = buildAiSpeech(current, leader, `I want to test ${teamIds.map((id) => playerName(current, id)).join(', ')}. This team gives us information without overloading one suspicious seat.`);
  const reasoning = `As ${leader.role}, choose a team that includes self when useful, favours lower suspicion, and ${roleAllegiance(leader.role) === 'evil' ? 'keeps evil options live' : 'avoids suspicious seats'}.`;
  const updatedLeader = rememberAgent(leader, current, reasoning, publicSpeech);
  const players = current.players.map((player) => (player.id === leader.id ? updatedLeader : { ...player, teamVote: undefined, missionCard: undefined }));
  const proposedState = {
    ...current,
    phase: 'vote' as const,
    selectedTeamIds: teamIds,
    players,
    lastVote: undefined,
    lastMission: undefined,
  };
  return {
    ...proposedState,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, updatedLeader, 'speech', publicSpeech),
      makeHistory(current, updatedLeader, 'proposal', `${updatedLeader.displayName} proposed ${teamIds.map((id) => playerName(current, id)).join(', ')}.`),
    ],
  };
}

function runAiVote(current: DemoState): DemoState {
  const voter = current.players.find((player) => player.controller === 'ai' && !player.teamVote);
  if (!voter) return current;
  const vote = chooseAiVote(current, voter);
  const selectedNames = current.selectedTeamIds.map((id) => playerName(current, id)).join(', ');
  const publicSpeech = buildAiSpeech(current, voter, vote === 'approve' ? `I can approve ${selectedNames}; the table composition is acceptable for this quest.` : `I reject ${selectedNames}; this team does not give me enough confidence.`);
  const visibleEvil = visibleEvilPlayersOnCurrentDemoTeam(current, voter);
  const reasoning = visibleEvil.length
    ? `Vote ${vote}; role-visible info flags ${visibleEvil.map((player) => player.name).join(', ')} as evil on the current team, so avoid approving without exposing certainty.`
    : `Vote ${vote}; team suspicion score ${scoreTeamSuspicion(current, voter, current.selectedTeamIds)}.`;
  const playersWithVote = current.players.map((player) => (
    player.id === voter.id ? { ...rememberAgent(voter, current, reasoning, publicSpeech), teamVote: vote } : player
  ));
  const resolved = resolveDemoVoteIfReady(current, playersWithVote);
  return {
    ...current,
    players: resolved.players,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, voter, 'speech', publicSpeech),
      makeHistory(current, voter, 'vote', `${voter.displayName} voted ${vote}.`),
    ],
    ...resolved.statePatch,
  };
}

function runAiMission(current: DemoState): DemoState {
  const actor = current.players.find((player) => player.controller === 'ai' && current.selectedTeamIds.includes(player.id) && !player.missionCard);
  if (!actor) return current;
  const card: MissionCard = roleAllegiance(actor.role) === 'evil' ? chooseEvilMissionCard(current, actor) : 'success';
  const publicSpeech = buildAiSpeech(current, actor, 'Mission card submitted. We will learn from the result.');
  const reasoning = roleAllegiance(actor.role) === 'evil'
    ? 'Mission choice weighs sabotage pressure against staying hidden; early stacked evil teams may hide to avoid linking allies.'
    : 'Good roles must submit success, so the mission choice is forced.';
  const playersWithCard = current.players.map((player) => (
    player.id === actor.id ? { ...rememberAgent(actor, current, reasoning, publicSpeech), missionCard: card } : player
  ));
  const next = resolveDemoMissionIfReady(current, playersWithCard);
  return {
    ...next,
    tableHistory: [
      ...next.tableHistory,
      makeHistory(current, actor, 'speech', publicSpeech),
      makeHistory(current, actor, 'mission', `${actor.displayName} submitted a mission card.`),
    ],
    aiHistory: [
      ...next.aiHistory,
      makeHistory(current, actor, 'mission', formatMissionReasoningSummaryForHistory(reasoning)),
    ],
  };
}

function runAiAssassination(current: DemoState): DemoState {
  const assassin = current.players.find((player) => player.controller === 'ai' && player.role === 'Assassin');
  if (!assassin) return current;
  const target = chooseAiAssassinationTarget(current, assassin);
  const publicSpeech = buildAiSpeech(current, assassin, `I choose ${target.displayName} as Merlin.`);
  const reasoning = `Assassin heuristic: target the good player with the strongest Merlin signals from private suspicion memory and public quest history; selected ${target.displayName}.`;
  const rememberedAssassin = rememberAgent(assassin, current, reasoning, publicSpeech);
  const withMemory = { ...current, players: current.players.map((player) => (player.id === assassin.id ? rememberedAssassin : player)) };
  const resolved = resolveDemoAssassination(withMemory, target.id);
  return {
    ...resolved,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, rememberedAssassin, 'speech', publicSpeech),
      makeHistory(current, rememberedAssassin, 'assassin', `${rememberedAssassin.displayName} chose ${target.displayName} as Merlin. ${target.role === 'Merlin' ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`),
    ],
    aiHistory: [
      ...current.aiHistory,
      makeHistory(current, rememberedAssassin, 'assassin', reasoning),
    ],
  };
}

function chooseAiTeam(current: DemoState, leader: DemoPlayer, teamSize: number): string[] {
  const bySuspicion = [...current.players].sort((left, right) => suspicionFor(leader, left.id) - suspicionFor(leader, right.id));
  const team = new Set<string>();
  if (roleAllegiance(leader.role) === 'evil') {
    team.add(leader.id);
    const ally = current.players.find((player) => player.id !== leader.id && roleAllegiance(player.role) === 'evil' && player.role !== 'Oberon');
    if (ally && team.size < teamSize) team.add(ally.id);
  } else if (teamSize > 1) {
    team.add(leader.id);
  }
  bySuspicion.forEach((player) => {
    if (team.size < teamSize) team.add(player.id);
  });
  return [...team].slice(0, teamSize);
}

function chooseAiVote(current: DemoState, voter: DemoPlayer): Vote {
  const selfOnTeam = current.selectedTeamIds.includes(voter.id);
  const suspicionScore = scoreTeamSuspicion(current, voter, current.selectedTeamIds);
  if (roleAllegiance(voter.role) === 'evil') return selfOnTeam || suspicionScore > -30 ? 'approve' : 'reject';
  if (visibleEvilPlayersOnCurrentDemoTeam(current, voter).length) return 'reject';
  return suspicionScore <= 45 || selfOnTeam ? 'approve' : 'reject';
}

function visibleEvilPlayersOnCurrentDemoTeam(current: DemoState, viewer: DemoPlayer): Array<{ playerId: string; name: string; hint: string }> {
  const currentTeamIds = new Set(current.selectedTeamIds);
  return getVisibilityInfo(
    { id: viewer.id, name: viewer.displayName, role: viewer.role },
    current.players.map((player) => ({ id: player.id, name: player.displayName, role: player.role })),
  ).sees.filter((item) => item.hint === 'Evil player' && currentTeamIds.has(item.playerId));
}

function chooseEvilMissionCard(current: DemoState, actor: DemoPlayer): MissionCard {
  const evilOnTeam = current.selectedTeamIds.filter((id) => roleAllegiance(current.players.find((player) => player.id === id)?.role ?? 'Loyal Servant') === 'evil').length;
  if (current.roundIndex === 0 && evilOnTeam > 1 && actor.role !== 'Assassin') return 'success';
  return 'fail';
}

function chooseAiAssassinationTarget(current: DemoState, assassin: DemoPlayer): DemoPlayer {
  const goodCandidates = current.players.filter((player) => player.role !== 'Assassin');
  const successfulTeamIds = current.missionResults
    .filter((result) => result.outcome === 'success')
    .flatMap((result) => result.selectedTeamIds ?? []);
  const successfulTeamCounts = successfulTeamIds.reduce<Record<string, number>>((counts, id) => {
    counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  }, {});
  return [...goodCandidates].sort((left, right) => {
    const rightScore = suspicionFor(assassin, right.id) + (successfulTeamCounts[right.id] ?? 0) * 12 - (right.role === 'Percival' ? 8 : 0);
    const leftScore = suspicionFor(assassin, left.id) + (successfulTeamCounts[left.id] ?? 0) * 12 - (left.role === 'Percival' ? 8 : 0);
    return rightScore - leftScore || left.seatIndex - right.seatIndex;
  })[0] ?? goodCandidates[0] ?? current.players[0];
}

function rememberAgent(player: DemoPlayer, current: DemoState, reasoning: string, publicSpeech: string): DemoPlayer {
  if (player.controller !== 'ai') return player;
  const nextMemory = updateAgentMemory(player, current, reasoning, publicSpeech);
  return {
    ...player,
    memory: nextMemory,
    lastReasoningSummary: reasoning,
    lastPublicSpeech: publicSpeech,
  };
}

function updateAgentMemory(player: DemoPlayer, current: DemoState, reasoning: string, publicSpeech: string): AgentMemory {
  const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
  const suspicion = { ...memory.suspicion };
  if (current.lastMission?.outcome === 'fail') {
    current.selectedTeamIds.forEach((id) => {
      if (id !== player.id) suspicion[id] = (suspicion[id] ?? 0) + 18;
    });
  }
  current.selectedTeamIds.forEach((id) => {
    if (id !== player.id && roleAllegiance(player.role) === 'evil' && roleAllegiance(current.players.find((candidate) => candidate.id === id)?.role ?? 'Loyal Servant') === 'evil') {
      suspicion[id] = -35;
    }
  });
  return {
    suspicion,
    notes: [...memory.notes.slice(-3), reasoning],
    publicClaims: [...memory.publicClaims.slice(-3), publicSpeech],
  };
}

function scoreTeamSuspicion(current: DemoState, voter: DemoPlayer, teamIds: string[]): number {
  return teamIds.reduce((score, id) => score + suspicionFor(voter, id), 0);
}

function suspicionFor(viewer: DemoPlayer, targetId: string): number {
  if (targetId === viewer.id) return roleAllegiance(viewer.role) === 'evil' ? -20 : -12;
  return viewer.memory?.suspicion[targetId] ?? 0;
}

function buildAiSpeech(_current: DemoState, player: DemoPlayer, fallback: string): string {
  if (player.role === 'Merlin' && fallback.includes('confidence')) return fallback.replace('confidence', 'behavioural confidence');
  if (player.persona?.includes('Aggressive')) return fallback.replace('I ', 'I strongly ');
  return fallback;
}

function playerName(current: DemoState, playerId: string): string {
  return current.players.find((player) => player.id === playerId)?.displayName ?? playerId;
}

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const copy = [...items];
  let state = [...seed].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) >>> 0, 2166136261);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function getAgentViewSummary(player: DemoPlayer, privateInfo: VisibilityInfo): React.ReactNode {
  if (player.controller !== 'ai') return <div className="agent-card human-card"><span>Human seat</span><p>You make this player's decisions.</p></div>;
  const suspicionEntries = Object.entries(player.memory?.suspicion ?? {})
    .sort(([, left], [, right]) => right - left)
    .slice(0, 2);
  return (
    <div className="agent-card">
      <span>AI Agent · {player.persona}</span>
      <p><strong>Visible info:</strong> {privateInfo.sees.length ? privateInfo.sees.map((item) => `${item.name} (${item.hint})`).join(', ') : 'No private identity info.'}</p>
      {player.lastPublicSpeech && <p><strong>Public:</strong> “{player.lastPublicSpeech}”</p>}
      {player.lastReasoningSummary && <p><strong>Reasoning summary:</strong> {player.lastReasoningSummary}</p>}
      {suspicionEntries.length > 0 && <p><strong>Memory:</strong> {suspicionEntries.map(([id, score]) => `${id.replace('demo-player-', 'P')} ${score > 0 ? '+' : ''}${score}`).join(', ')}</p>}
    </div>
  );
}

function createDemoState(
  playerCount: number,
  roleOptions: RolePresetOptions,
  options: { mode?: DemoMode; humanCount?: number } = {},
): DemoState {
  const sanitizedOptions = sanitizeRoleOptions(playerCount, roleOptions);
  const mode = options.mode ?? 'manual';
  const humanCount = mode === 'ai' ? Math.min(Math.max(options.humanCount ?? 1, 1), Math.min(3, playerCount)) : playerCount;
  const basePlayers = demoNames.slice(0, playerCount).map((name, index) => ({ id: `demo-player-${index + 1}`, name }));
  const presetRoles = buildRolePreset(playerCount, sanitizedOptions).roles;
  const roles = mode === 'ai' ? deterministicShuffle(presetRoles, `ai-table-${playerCount}-${JSON.stringify(sanitizedOptions)}`) : presetRoles;
  const assignedPlayers = basePlayers.map((player, index) => ({ ...player, role: roles[index] }));
  return {
    playerCount,
    roleOptions: sanitizedOptions,
    mode,
    humanCount,
    players: assignedPlayers.map((player, index) => {
      const controller: DemoController = mode === 'ai' && index >= humanCount ? 'ai' : 'human';
      return {
        id: player.id,
        displayName: controller === 'ai' ? `${player.name} AI` : player.name,
        seatIndex: index,
        role: player.role ?? 'Loyal Servant',
        revealRole: false,
        revealNightInfo: false,
        controller,
        persona: controller === 'ai' ? aiPersonas[(index - humanCount + aiPersonas.length) % aiPersonas.length] : undefined,
        memory: controller === 'ai' ? createAgentMemory(basePlayers.map((candidate) => candidate.id), player.id) : undefined,
      };
    }),
    phase: 'setup',
    roundIndex: 0,
    leaderIndex: 0,
    selectedTeamIds: [],
    missionResults: [],
    tableHistory: [],
    aiHistory: [],
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

function summarizeRoles(roles: Role[], language: ReturnType<typeof useI18n>['language'] = 'en'): string {
  return summarizeRoleEntries(roles)
    .map((item) => formatRoleCount(item.role, item.count, language))
    .join(', ');
}

function summarizeRoleEntries(roles: Role[]): Array<{ role: Role; count: number }> {
  const counts = roles.reduce<Record<string, number>>((summary, role) => {
    summary[role] = (summary[role] ?? 0) + 1;
    return summary;
  }, {});
  return Object.entries(counts)
    .map(([role, count]) => ({ role: role as Role, count }));
}

function formatRoleCount(role: Role, count: number, language: ReturnType<typeof useI18n>['language']): string {
  const roleName = formatRole(role, language);
  return count > 1 ? `${roleName} x${count}` : roleName;
}

function formatQuestLabel(roundIndex: number, language: ReturnType<typeof useI18n>['language']): string {
  return language === 'zh' ? `任务 ${roundIndex + 1}` : `Q${roundIndex + 1}`;
}

function formatFailThresholdLabel(threshold: number, language: ReturnType<typeof useI18n>['language']): string {
  return language === 'zh' ? ` · ${threshold} 张失败牌才失败` : ` / ${threshold} fails`;
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

function getMissionPhaseLabel(missionState: MissionState): string {
  if (missionState.phase === 'proposal') return 'Choosing crew';
  if (missionState.phase === 'vote') return 'Council vote';
  if (missionState.phase === 'mission') return 'Quest underway';
  if (missionState.phase === 'assassin') return 'Assassin endgame';
  return missionState.winner === 'evil' ? 'Evil victory' : 'Good victory';
}

function getRoomHeroTitle(snapshot: RoomSnapshot | undefined, t: (text: string) => string): string {
  if (!snapshot) return t('Round Table Lobby');
  const missionState = snapshot.room.settings.missionState;
  if (snapshot.room.status === 'lobby' || snapshot.room.status === 'setup') return t('Round Table Lobby');
  if (snapshot.room.status === 'reveal') return t('The Merlin Reveal');
  if (!missionState) return t('Table Quest');
  if (missionState.phase === 'proposal') return t('Choosing crew');
  if (missionState.phase === 'vote') return t('Council vote');
  if (missionState.phase === 'mission') return t('Quest underway');
  if (missionState.phase === 'assassin') return t('Assassin endgame');
  return missionState.winner === 'evil' ? t('Evil victory') : t('Good victory');
}

function getRoomHeroCopy(snapshot: RoomSnapshot | undefined, t: (text: string) => string): string {
  if (!snapshot) return t('Summon a room, let every knight ready at the table, then reveal each secret role on their own phone.');
  const missionState = snapshot.room.settings.missionState;
  if (snapshot.room.status === 'lobby' || snapshot.room.status === 'setup') return t('Summon a room, let every knight ready at the table, then reveal each secret role on their own phone.');
  if (snapshot.room.status === 'reveal') return t('Each player can privately reveal their role and night information before the first quest.');
  if (!missionState) return t('The shared board tracks proposals, votes, mission cards, and quest results.');
  if (missionState.phase === 'proposal') return t('The current captain picks a crew, then every player votes on that proposal.');
  if (missionState.phase === 'vote') return t('Every player votes, including the captain who proposed the crew.');
  if (missionState.phase === 'mission') return t('Only the selected crew submits mission cards; results stay anonymous.');
  if (missionState.phase === 'assassin') return t('Good has three successful quests. The Assassin must guess Merlin before the winner is final.');
  return t('The table is finished. Review the result or reset for the next game.');
}

function getMissionPhaseCopy({
  missionState,
  currentTeamSize,
  submittedVoteCount,
  submittedCardCount,
  playerCount,
  t,
}: {
  missionState: MissionState;
  currentTeamSize: number;
  submittedVoteCount: number;
  submittedCardCount: number;
  playerCount: number;
  t: (text: string) => string;
}): string {
  if (missionState.phase === 'proposal') {
    return `${t('The captain is choosing exactly')} ${currentTeamSize} ${t('players before the table votes.')}`;
  }
  if (missionState.phase === 'vote') {
    return `${submittedVoteCount}/${playerCount} ${t('phones have voted on the proposed crew.')}`;
  }
  if (missionState.phase === 'mission') {
    return `${submittedCardCount}/${missionState.selectedTeamIds.length} ${t('mission cards are in. The quest resolves when the crew is done.')}`;
  }
  if (missionState.phase === 'assassin') {
    return t('Good reached three successful quests. The Assassin now chooses a Merlin target.');
  }
  if (missionState.assassination) {
    return missionState.winner === 'evil' ? t('The Assassin found Merlin and stole the endgame.') : t('Merlin survived the final guess.');
  }
  return missionState.winner === 'evil' ? t('Evil wins after three failed quests.') : t('Good wins after three successful quests.');
}

function toDemoAvalonPlayer(player: DemoPlayer): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}

function toRoomAvalonPlayer(player: RoomPlayer): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}

function AssassinPhaseBanner() {
  const { t } = useI18n();
  return (
    <section className="assassin-phase-banner" aria-live="assertive">
      <p className="eyebrow">{t('Mandatory endgame')}</p>
      <h2>{t('Assassin is choosing a target')}</h2>
      <p>{t('Good has completed three quests. Normal mission play is paused until the Assassin resolves the Merlin guess.')}</p>
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
  const { t } = useI18n();
  return (
    <section className="panel assassin-action-panel" aria-labelledby="assassin-action-title">
      <p className="eyebrow">{t('Assassin phase action')}</p>
      <h2 id="assassin-action-title">{t('Choose Merlin')}</h2>
      <p>{t('Pick one target. Hitting Merlin gives Evil the win; missing Merlin gives Good the win.')}</p>
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
        {t('Confirm Assassination')}
      </button>
    </section>
  );
}

function AssassinationResultBanner({ missionState, players }: { missionState: MissionState; players: RoomPlayer[] }) {
  const { t } = useI18n();
  const target = players.find((player) => player.id === missionState.assassination?.targetPlayerId);
  const assassin = players.find((player) => player.id === missionState.assassination?.assassinPlayerId);
  const hitMerlin = Boolean(missionState.assassination?.hitMerlin);
  return (
    <section className={`assassin-result-banner ${missionState.winner === 'evil' ? 'evil-win' : 'good-win'}`} aria-live="polite">
      <p className="eyebrow">{t('Assassination resolved')}</p>
      <h2>{missionState.winner === 'evil' ? t('Evil Wins') : t('Good Wins')}</h2>
      <p>
        {assassin?.displayName ?? t('The Assassin')} {t('chose')} {target?.displayName ?? t('an unknown target')}.
        {' '}
        {hitMerlin ? t('The target was Merlin.') : t('The target was not Merlin.')}
      </p>
    </section>
  );
}

function GameResultModal({
  missionState,
  currentPlayer,
  playerResult,
  readyCount,
  playerCount,
  alreadyReady,
  busy,
  onReadyForNextGame,
}: {
  missionState: MissionState;
  currentPlayer: RoomPlayer;
  playerResult?: { allegiance: Allegiance; role: Role; won: boolean };
  readyCount: number;
  playerCount: number;
  alreadyReady: boolean;
  busy: boolean;
  onReadyForNextGame: () => void;
}) {
  const { t, language } = useI18n();
  const winner = missionState.winner;
  const won = playerResult?.won ?? Boolean(winner && currentPlayer.role && roleAllegiance(currentPlayer.role) === winner);
  return (
    <div className="result-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="game-result-title">
      <section className={`result-modal ${won ? 'won' : 'lost'}`}>
        <p className="eyebrow">{won ? t('Victory') : t('Defeat')}</p>
        <h2 id="game-result-title">{won ? t('You won this game') : t('You lost this game')}</h2>
        <div className="result-summary-grid">
          <div>
            <span>{t('Winner')}</span>
            <strong>{winner ? formatAllegiance(winner, language) : t('Unknown')}</strong>
          </div>
          <div>
            <span>{t('Your side')}</span>
            <strong>{playerResult ? formatAllegiance(playerResult.allegiance, language) : t('Unknown')}</strong>
          </div>
          <div>
            <span>{t('Your role')}</span>
            <strong>{playerResult ? formatRole(playerResult.role, language) : t('Role hidden')}</strong>
          </div>
        </div>
        <p className="hint">
          {alreadyReady
            ? `${t('Waiting for everyone to play again.')} ${readyCount}/${playerCount}`
            : t('Stay in this room and ready up for another game.')}
        </p>
        <button type="button" className="primary" disabled={busy || alreadyReady} onClick={onReadyForNextGame}>
          {alreadyReady ? t('Ready for next game') : t('Play Again')}
        </button>
      </section>
    </div>
  );
}

function RoomHistoryPanel({ snapshot, currentPlayerId }: { snapshot: RoomSnapshot; currentPlayerId?: string }) {
  const { t, language } = useI18n();
  const history = snapshot.room.settings.gameHistory ?? [];
  if (history.length === 0) return null;
  return (
    <section className="panel room-history-panel" aria-labelledby="room-history-title">
      <div className="panel-header">
        <h2 id="room-history-title">{t('Room history')}</h2>
        <span className="history-count">{history.length} {t('games')}</span>
      </div>
      <ol className="game-history-list">
        {history.map((entry) => {
          const playerResult = entry.playerResults.find((result) => result.playerId === currentPlayerId);
          return (
            <li key={entry.gameNumber}>
              <div>
                <strong>{t('Game')} {entry.gameNumber}: {formatAllegiance(entry.winner, language)} {t('won')}</strong>
                <small>{t(getEndReasonLabel(entry.endReason))}</small>
              </div>
              {playerResult && (
                <p>
                  {t('You were')} {formatAllegiance(playerResult.allegiance, language)}
                  {' · '}
                  {formatRole(playerResult.role, language)}
                  {' · '}
                  {playerResult.won ? t('Victory') : t('Defeat')}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function getEndReasonLabel(reason: string) {
  return {
    assassination_hit: 'Assassin found Merlin',
    assassination_miss: 'Assassin missed Merlin',
    three_failed_quests: 'Three failed quests',
    three_successful_quests: 'Three successful quests',
  }[reason] ?? 'Game finished';
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
  onTransferHost,
  onResetRoomToLobby,
  onDissolveRoom,
  onLeave,
  onMissionStateChange,
  onProposeMissionTeam,
  onSubmitTeamVote,
  onSubmitMissionCard,
  onAssassination,
  onReadyForNextGame,
  isDemoMode,
  busy,
}: {
  snapshot: RoomSnapshot;
  currentPlayer?: RoomPlayer;
  privateInfo?: ReturnType<typeof getPrivateRoleInfo>;
  startValidation?: string;
  onReady: () => void;
  onStart: () => void;
  onRename: (event: React.FormEvent<HTMLFormElement>) => void;
  onRemovePlayer: (targetPlayerId: string) => void;
  onTransferHost: (targetPlayerId: string) => void;
  onResetRoomToLobby: () => void;
  onDissolveRoom: () => void;
  onLeave: () => void;
  onMissionStateChange: (missionState: MissionState) => void;
  onProposeMissionTeam: (selectedTeamIds: string[]) => void;
  onSubmitTeamVote: (vote: Vote) => void;
  onSubmitMissionCard: (card: MissionCard) => void;
  onAssassination: (targetPlayerId: string) => void;
  onReadyForNextGame: () => void;
  isDemoMode: boolean;
  busy: boolean;
}) {
  const { t } = useI18n();
  const started = snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup';
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = started && snapshot.players.length >= 5 ? ensureMissionState(snapshot.room.settings.missionState, playerIds) : undefined;
  const currentTeamSize = missionState ? getTeamSize(snapshot.players.length, missionState.roundIndex) : 0;
  const [assassinationTargetId, setAssassinationTargetId] = useState('');
  const readyCount = snapshot.players.filter((player) => player.isReady).length;
  const canStart = Boolean(currentPlayer?.isHost) && canStartGame(snapshot.players, snapshot.room.settings);
  const isFinished = snapshot.room.status === 'finished' || missionState?.phase === 'finished';
  const showJoinPanel = !started;
  const joinLinkPath = buildJoinUrl(window.location.href, snapshot.room.code);
  const joinLink = `${window.location.origin}${joinLinkPath}`;
  const assassinationTargets = snapshot.players.filter((player) => player.id !== currentPlayer?.id);
  const [liveSelectedTeamIds, setLiveSelectedTeamIds] = useState<string[]>([]);
  const latestGame = snapshot.room.settings.gameHistory?.at(-1);
  const currentPlayerResult = latestGame?.playerResults.find((result) => result.playerId === currentPlayer?.id);
  const nextGameReadyPlayerIds = snapshot.room.settings.nextGameReadyPlayerIds ?? [];
  const currentPlayerReadyForNextGame = Boolean(currentPlayer && nextGameReadyPlayerIds.includes(currentPlayer.id));
  const startValidationCopy = formatStartValidation(startValidation, t);

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
    <section className={[
      'room-grid',
      started ? 'started-room-grid' : 'lobby-room-grid',
      currentPlayer?.isHost ? 'has-host-authority' : 'guest-room-grid',
    ].join(' ')}>
      {missionState?.phase === 'finished' && currentPlayer && (
        <GameResultModal
          missionState={missionState}
          currentPlayer={currentPlayer}
          playerResult={currentPlayerResult}
          readyCount={nextGameReadyPlayerIds.length}
          playerCount={snapshot.players.length}
          alreadyReady={currentPlayerReadyForNextGame}
          busy={busy}
          onReadyForNextGame={onReadyForNextGame}
        />
      )}
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
              <span>{isDemoMode ? t('Demo Room Code') : t('Room Code')}</span>
              <strong>{snapshot.room.code}</strong>
              <p>
                {isFinished
                  ? t('Game finished. The room code is visible again for the next table.')
                  : isDemoMode
                    ? t('Sandbox demo with bot players. This is not a real shareable room.')
                    : t('Share this code with players at the table.')}
              </p>
            </div>
            <QrCodePanel value={joinLink} />
          </div>
          <div className="share-panel">
            <input value={joinLink} readOnly aria-label={t('Join link')} onFocus={(event) => event.currentTarget.select()} />
            <div className="share-actions">
              <button type="button" onClick={() => copyText(joinLink)}>{t('Copy Link')}</button>
              <button type="button" onClick={() => copyText(snapshot.room.code)}>{t('Copy Code')}</button>
            </div>
          </div>
        </div>
      )}

      <RoomHistoryPanel snapshot={snapshot} currentPlayerId={currentPlayer?.id} />

      <section className={`panel private-room-panel ${started ? 'started' : 'lobby'}`}>
        <div className="panel-header">
          <h2>{started ? t('Private Reveal') : t('Current Room')}</h2>
          <div className="room-header-actions">
            {currentPlayer && (
              <button type="button" className="secondary-control room-leave" onClick={onLeave} disabled={busy}>
                {started && !isFinished ? t('Exit Table') : t('Leave Room')}
              </button>
            )}
          </div>
        </div>

        {currentPlayer && !started && (
          <>
            <form className="inline-form" onSubmit={onRename}>
              <input name="displayName" defaultValue={currentPlayer.displayName} maxLength={24} aria-label={t('Nickname')} />
              <button type="submit" disabled={busy}>{t('Save')}</button>
            </form>
            <button type="button" className={currentPlayer.isReady ? 'active-soft' : 'primary'} onClick={onReady} disabled={busy}>
              {currentPlayer.isReady ? t('Ready') : t('Set Ready')}
            </button>
          </>
        )}

        {!started && (
          <>
            <div className="next-step">
              <strong>{canStart ? t('Ready players can start.') : t('Waiting to start')}</strong>
              <span>
                {canStart
                  ? t('Starting now will leave unready players out of this game.')
                  : startValidationCopy}
              </span>
            </div>
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

      <HostAuthorityPanel
        players={snapshot.players}
        currentPlayer={currentPlayer}
        started={started}
        canStart={canStart}
        startValidation={startValidation}
        isDemoMode={isDemoMode}
        busy={busy}
        onStart={onStart}
        onResetRoomToLobby={onResetRoomToLobby}
        onDissolveRoom={onDissolveRoom}
        onRemovePlayer={onRemovePlayer}
        onTransferHost={onTransferHost}
      />

      {!started && (
        <section className="panel players-panel">
          <h2>{t('Players')}</h2>
          <p className="hint">{readyCount}/{snapshot.players.length} {t('ready. Minimum 5 ready players.')}</p>
          <ol className="players">
            {snapshot.players.map((player) => {
              return (
                <li key={player.id} className={player.id === currentPlayer?.id ? 'me' : ''}>
                  <div className="player-identity">
                    <span>{player.displayName} {player.isAi && <em className="ai-player-badge">{t('AI')}</em>}</span>
                    <small>{player.isHost ? t('Host') : player.isAi ? t('AI seat') : `${t('Seat')} ${player.seatIndex + 1}`}</small>
                  </div>
                  <div className="player-row-meta">
                    <strong>{player.isReady ? t('Ready') : t('Waiting')}</strong>
                  </div>
                </li>
              );
            })}
          </ol>
          {!currentPlayer?.isHost && (
            <p className="hint">{t('Waiting for the host to start the game.')}</p>
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

function HostAuthorityPanel({
  players,
  currentPlayer,
  started,
  canStart,
  startValidation,
  isDemoMode,
  busy,
  onStart,
  onResetRoomToLobby,
  onDissolveRoom,
  onRemovePlayer,
  onTransferHost,
}: {
  players: RoomPlayer[];
  currentPlayer?: RoomPlayer;
  started: boolean;
  canStart: boolean;
  startValidation?: string;
  isDemoMode: boolean;
  busy: boolean;
  onStart: () => void;
  onResetRoomToLobby: () => void;
  onDissolveRoom: () => void;
  onRemovePlayer: (targetPlayerId: string) => void;
  onTransferHost: (targetPlayerId: string) => void;
}) {
  const { t } = useI18n();
  if (!currentPlayer?.isHost) return null;

  const manageablePlayers = players.filter((player) => !player.isHost && !player.isAi && !isDemoMode);
  const startValidationCopy = formatStartValidation(startValidation, t);

  return (
    <section className="panel host-authority-panel" aria-labelledby="host-authority-title">
      <div className="host-authority-heading">
        <p className="eyebrow">{t('Room owner')}</p>
        <h2 id="host-authority-title">{t('Host permissions')}</h2>
        <p>{t('You are the room host on this device.')}</p>
      </div>

      {!started && (
        <div className="host-action-group">
          <h3>{t('Start this game')}</h3>
          <p>{canStart ? t('Ready players can start.') : startValidationCopy}</p>
          <button
            type="button"
            className="primary"
            disabled={!canStart || busy}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onStart();
            }}
          >
            {canStart ? t('Start Game') : startValidationCopy}
          </button>
        </div>
      )}

      {started && (
        <div className="host-action-group">
          <h3>{t('Current game')}</h3>
          <p>{t('Use this only when this round should be cancelled for everyone.')}</p>
          <button type="button" className="secondary-control" onClick={onResetRoomToLobby} disabled={busy}>{t('Abandon Game')}</button>
        </div>
      )}

      {manageablePlayers.length > 0 && (
        <div className="host-action-group">
          <h3>{t('Manage players')}</h3>
          <div className="host-player-actions">
            {manageablePlayers.map((player) => (
              <div key={player.id} className="host-player-action-row">
                <span>{player.displayName}</span>
                <div>
                  <button type="button" className="secondary-control" onClick={() => onTransferHost(player.id)} disabled={busy}>{t('Make Host')}</button>
                  <button type="button" className="small-danger" onClick={() => onRemovePlayer(player.id)} disabled={busy}>{t('Remove')}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="host-action-group danger-zone">
        <h3>{t('Room controls')}</h3>
        <p>{t('Dissolve the room only when the table is done or created by mistake.')}</p>
        <button type="button" className="small-danger dissolve-room" onClick={onDissolveRoom} disabled={busy}>{t('Dissolve Room')}</button>
      </div>
    </section>
  );
}

function formatStartValidation(message: string | undefined, t: (text: string) => string): string | undefined {
  if (!message) return undefined;
  const neededMatch = message.match(/^Need (\d+) more ready players? to start\.$/);
  if (neededMatch) return `${neededMatch[1]} ${t('more ready players needed to start.')}`;
  const plannedCountMatch = message.match(/^This room is set for (\d+) players\.$/);
  if (plannedCountMatch) return `${t('This room is set for')} ${plannedCountMatch[1]} ${t('players.')}`;
  return t(message);
}

function getRoomPlayerNames(players: RoomPlayer[], playerIds: string[] = []): string[] {
  return playerIds.map((id) => {
    const player = players.find((candidate) => candidate.id === id);
    if (!player) return id;
    return player.isAi ? `${player.displayName} (AI)` : player.displayName;
  });
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
  const { t, language } = useI18n();
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

  const leaderName = players.find((player) => player.id === missionState.leaderPlayerId)?.displayName ?? t('Unknown captain');
  const selectedTeamNames = missionState.selectedTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id);
  const visibleTeamIds = missionState.phase === 'proposal' && selectedTeamIds.length > 0 ? selectedTeamIds : missionState.selectedTeamIds;
  const visibleTeamNames = visibleTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id);
  const roleSummary = summarizePublicRoleLineup(players);
  const phaseLabel = t(getMissionPhaseLabel(missionState));
  const phaseCopy = getMissionPhaseCopy({
    missionState,
    currentTeamSize,
    submittedVoteCount,
    submittedCardCount,
    playerCount: players.length,
    t,
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
      setFlowError(error instanceof Error ? error.message : t('Could not propose team.'));
    }
  }

  function submitVote() {
    if (!missionState) return;
    try {
      setFlowError('');
      onMissionStateChange(recordTeamVote(missionState, playerIds, Number(approveCount), Number(rejectCount)));
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : t('Could not record vote.'));
    }
  }

  function submitMission() {
    if (!missionState) return;
    try {
      setFlowError('');
      onMissionStateChange(advanceMissionResult(missionState, playerIds, Number(successCount), Number(failCount)));
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : t('Could not record mission.'));
    }
  }

  return (
    <section className="panel mission-panel">
      <div className="mission-panel-heading">
        <div>
          <p className="eyebrow">{t('Shared board')}</p>
          <h2>{t('Table Quest')}</h2>
        </div>
        <span className={`phase-badge phase-${missionState.phase}`}>{phaseLabel}</span>
      </div>

      <section className="mission-board-section table-makeup" aria-label={t('Game setup and table makeup')}>
        <div className="mission-section-heading">
          <h3>{t('Table Makeup')}</h3>
          <span>{players.length} {t('players')}</span>
        </div>
        <div className="role-lineup" aria-label={t('Public role lineup')}>
          <span>{t('Roles in play')}</span>
          <div>
            {roleSummary.map((item) => (
              <span key={item.role} className={`role-chip ${roleAllegiance(item.role)}`}>
                {formatRoleCount(item.role, item.count, language)}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="mission-board-section" aria-label={t('Quest track')}>
        <div className="mission-section-heading">
          <h3>{t('Quest Track')}</h3>
          <span>{t('First side to three wins')}</span>
        </div>
        <div className="quest-track mission-quest-track">
          {[0, 1, 2, 3, 4].map((roundIndex) => {
            const result = missionState.missionResults.find((item) => item.roundIndex === roundIndex);
            const state = result?.outcome ?? (roundIndex === missionState.roundIndex && missionState.phase !== 'finished' ? 'current' : 'pending');
            const questTeamNames = getRoomPlayerNames(players, result?.selectedTeamIds ?? (state === 'current' ? visibleTeamIds : []));
            return (
              <div key={roundIndex} className={`quest-card ${state}`}>
                <span>{formatQuestLabel(roundIndex, language)}</span>
                <strong>{getTeamSize(players.length, roundIndex)}</strong>
                <small>
                  {result
                    ? result.outcome === 'success' ? t('Good won') : t('Evil won')
                    : roundIndex === missionState.roundIndex && missionState.phase !== 'finished' ? t('Current') : t('Pending')}
                </small>
                {questTeamNames.length > 0 && (
                  <div className="quest-team-chips" aria-label={t('Quest team')}>
                    {questTeamNames.map((name) => <span key={name}>{name}</span>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="mission-board-section expedition-board" aria-label={t('Current expedition')}>
        <div className="mission-section-heading">
          <h3>{t('Current Expedition')}</h3>
          <span>{t('Quest')} {missionState.roundIndex + 1} {t('of 5')}</span>
        </div>
        <div className="expedition-summary">
          <div className="captain-card">
            <span>{t('Captain')}</span>
            <strong>{leaderName}</strong>
          </div>
          <div className="expedition-state-card">
            <span>{phaseLabel}</span>
            <p>{phaseCopy}</p>
          </div>
        </div>
        <div className="team-roster">
          <div className="team-roster-heading">
            <span>{missionState.phase === 'proposal' ? t('Proposed crew') : t('Locked crew')}</span>
            <strong>{visibleTeamNames.length}/{currentTeamSize}</strong>
          </div>
          {visibleTeamNames.length > 0 ? (
            <div className="member-chips">
              {visibleTeamNames.map((name) => <span key={name}>{name}</span>)}
            </div>
          ) : (
            <p className="empty-team">{t('No crew is on the board yet.')}</p>
          )}
        </div>
        {missionState.phase === 'vote' && (
          <div className="progress-rune" aria-label={t('Vote progress')}>
            <span style={{ width: `${Math.round((submittedVoteCount / players.length) * 100)}%` }} />
            <strong>{submittedVoteCount}/{players.length} {t('phones voted')}</strong>
          </div>
        )}
        {missionState.phase === 'mission' && (
          <div className="progress-rune" aria-label={t('Mission card progress')}>
            <span style={{ width: `${Math.round((submittedCardCount / Math.max(1, missionState.selectedTeamIds.length)) * 100)}%` }} />
            <strong>{submittedCardCount}/{missionState.selectedTeamIds.length} {t('cards submitted')}</strong>
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
            <h3>{t('Host Backup')}</h3>
            <span>{t('Admin override')}</span>
          </div>
          {missionState.phase === 'proposal' && (
            <div className="mission-step">
              <p>{t('Use only if the captain phone cannot submit.')} {t('Quest')} {missionState.roundIndex + 1} {t('needs exactly')} {currentTeamSize} {t('crew members.')} </p>
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
              <button type="button" className="primary" onClick={submitTeam}>{t('Submit Backup Proposal')}</button>
            </div>
          )}

          {missionState.phase === 'vote' && (
            <div className="mission-step">
              <p>{t('Use only if phone votes need manual recovery.')} {t('Crew')}: {selectedTeamNames.join(', ')}.</p>
              <div className="count-row">
                <input value={approveCount} onChange={(event) => setApproveCount(event.target.value)} inputMode="numeric" placeholder={t('Approve')} aria-label={t('Approve count')} />
                <input value={rejectCount} onChange={(event) => setRejectCount(event.target.value)} inputMode="numeric" placeholder={t('Reject')} aria-label={t('Reject count')} />
                <button type="button" className="primary" onClick={submitVote}>{t('Record Vote')}</button>
              </div>
            </div>
          )}

          {missionState.phase === 'mission' && (
            <div className="mission-step">
              <p>{t('Use only if mission cards need manual recovery after the crew has acted.')}</p>
              <div className="count-row">
                <input value={successCount} onChange={(event) => setSuccessCount(event.target.value)} inputMode="numeric" placeholder={t('Success')} aria-label={t('Success cards')} />
                <input value={failCount} onChange={(event) => setFailCount(event.target.value)} inputMode="numeric" placeholder={t('Fail')} aria-label={t('Fail cards')} />
                <button type="button" className="primary" onClick={submitMission}>{t('Record Mission')}</button>
              </div>
            </div>
          )}
        </section>
      ) : (
        missionState.phase !== 'finished' && <p className="hint">{t('Use your private phone area for any action assigned to you.')}</p>
      )}
    </section>
  );
}

function QrCodePanel({ value }: { value: string }) {
  const { t } = useI18n();
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=176x176&margin=10&data=${encodeURIComponent(value)}`;
  return (
    <a className="qr-code" href={value} aria-label={t('Scan QR code to join this Avalon room')}>
      <img src={qrUrl} alt={t('QR code for the Avalon room join link')} width="176" height="176" loading="lazy" />
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

function cloneRoomSnapshot(snapshot: RoomSnapshot): RoomSnapshot {
  return {
    room: {
      ...snapshot.room,
      settings: { ...snapshot.room.settings },
    },
    players: snapshot.players.map((player) => ({ ...player })),
  };
}

function clearEntryStepFromUrl() {
  window.history.replaceState({ step: 'home' }, '', buildStepUrl(window.location.href, 'home'));
}

async function executeRoomAiAction(roomId: string, action: RoomAiAction): Promise<RoomSnapshot> {
  if (action.type === 'proposeTeam') return proposeMissionTeam(roomId, action.leaderPlayerId, action.selectedTeamIds);
  if (action.type === 'submitTeamVote') return submitTeamVote(roomId, action.playerId, action.vote);
  if (action.type === 'submitMissionCard') return submitMissionCard(roomId, action.playerId, action.card);
  return submitAssassination(roomId, action.assassinPlayerId, action.targetPlayerId);
}

const root = createRoot(document.getElementById('root')!);

if (import.meta.env.DEV && window.location.pathname === '/dev/multiplayer') {
  void import('./dev/DevMultiplayerSimulator').then(({ DevMultiplayerSimulator }) => {
    root.render(<I18nProvider><DevMultiplayerSimulator /></I18nProvider>);
  });
} else {
  root.render(<I18nProvider><App /></I18nProvider>);
}
