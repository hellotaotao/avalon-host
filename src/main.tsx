import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildRolePreset,
  getMissionFailThreshold,
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
  updateAiBeliefAfterFormalAction,
  updateAiBeliefAfterMissionResult,
  type AiAvalonDecision,
  type AiAgentMemory,
  type AiBeliefAudit,
  type AiEvidenceItem,
  type AiFormalActionBeliefEvent,
  type AiPlayerBeliefProfile,
} from './aiAvalon';
import { getNextRoomAiAction, getRoomAiActionKey, type RoomAiAction } from './services/roomAi';
import { buildJoinUrl, buildStepUrl, parseEntryStep, parseJoinCodeFromUrl, type EntryScreen } from './navigationState';
import {
  applyMissionStateToSnapshot,
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
  type RoomGamePlayerResult,
} from './services/roomService';
import { getSessionStorageKeys, isDevSessionActive } from './sessionKeys';
import { I18nProvider, formatAllegiance, formatHint, formatRole, formatRoleDescription, useI18n, type Language } from './i18n';
import './styles.css';

type Screen = EntryScreen | 'room';

const ROOM_AI_RETRY_DELAY_MS = 3500;
const ROOM_AI_REQUEST_TIMEOUT_MS = 10000;
const ROOM_AI_RETRY_TICK_MS = 1000;

// AI players pause before acting so a human host can follow the table instead of
// seeing every bot resolve at once. Each action type gets its own "thinking"
// base, plus jitter so several AIs in a row stagger naturally rather than firing
// in lockstep.
const ROOM_AI_THINK_BASE_MS: Record<RoomAiAction['type'], number> = {
  proposeTeam: 1000,
  submitTeamVote: 650,
  submitMissionCard: 800,
  submitAssassination: 1400,
};
const ROOM_AI_THINK_JITTER_MS = 600;

function getRoomAiThinkingDelay(action: RoomAiAction): number {
  const base = ROOM_AI_THINK_BASE_MS[action.type] ?? 800;
  return base + Math.round(Math.random() * ROOM_AI_THINK_JITTER_MS);
}

function clearAiThinkTimer(ref: { current: number | undefined }) {
  if (ref.current !== undefined) {
    window.clearTimeout(ref.current);
    ref.current = undefined;
  }
}

type RoomAiAutomationState = {
  actionKey: string;
  attempt: number;
  lastError?: string;
  waitingForRetry: boolean;
};

type RoomAiAttemptState = {
  actionKey: string;
  attempt: number;
  nextAttemptAt: number;
  lastError?: string;
};

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
  const [aiRetryTick, setAiRetryTick] = useState(0);
  const [aiAutomation, setAiAutomation] = useState<RoomAiAutomationState>();
  const [showGameStartNotice, setShowGameStartNotice] = useState(false);
  const hostNameInputRef = useRef<HTMLInputElement>(null);
  const aiActionAttemptRef = useRef<RoomAiAttemptState | undefined>(undefined);
  const aiActionInFlightRef = useRef('');
  const aiThinkTimerRef = useRef<number | undefined>(undefined);
  const previousRoomStatusRef = useRef(snapshot?.room.status);
  const [restorableSnapshot, setRestorableSnapshot] = useState<RoomSnapshot>();
  const [restorablePlayerId, setRestorablePlayerId] = useState('');

  const currentPlayer = snapshot?.players.find((player) => player.id === currentPlayerId);
  const isHostNameMissing = !hostName.trim();
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
    const previousStatus = previousRoomStatusRef.current;
    const nextStatus = snapshot?.room.status;
    previousRoomStatusRef.current = nextStatus;
    if (!previousStatus || !nextStatus) return undefined;
    if ((previousStatus === 'lobby' || previousStatus === 'setup') && nextStatus !== 'lobby' && nextStatus !== 'setup') {
      setShowGameStartNotice(true);
      const timer = window.setTimeout(() => setShowGameStartNotice(false), 1800);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [snapshot?.room.status]);

  useEffect(() => {
    if (!snapshot || isDemoMode || !currentPlayer?.isHost) return undefined;
    const timer = window.setInterval(() => setAiRetryTick((current) => current + 1), ROOM_AI_RETRY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [currentPlayer?.isHost, isDemoMode, snapshot?.room.id]);

  useEffect(() => {
    if (!snapshot || isDemoMode || !currentPlayer?.isHost) {
      clearAiThinkTimer(aiThinkTimerRef);
      aiActionAttemptRef.current = undefined;
      aiActionInFlightRef.current = '';
      setAiAutomation((current) => current ? undefined : current);
      return;
    }
    const action = getNextRoomAiAction(snapshot);
    if (!action) {
      clearAiThinkTimer(aiThinkTimerRef);
      aiActionAttemptRef.current = undefined;
      aiActionInFlightRef.current = '';
      setAiAutomation((current) => current ? undefined : current);
      return;
    }

    const actionKey = getRoomAiAutomationActionKey(snapshot, action);
    const now = Date.now();
    let attemptState = aiActionAttemptRef.current;
    if (attemptState?.actionKey !== actionKey) {
      const thinkingDelay = getRoomAiThinkingDelay(action);
      attemptState = {
        actionKey,
        attempt: 0,
        nextAttemptAt: now + thinkingDelay,
      };
      aiActionAttemptRef.current = attemptState;
      setAiAutomation({ actionKey, attempt: 0, waitingForRetry: false });
      // Wake the loop exactly when the thinking pause ends, so the delay is
      // honored precisely instead of waiting for the next 1s retry tick.
      clearAiThinkTimer(aiThinkTimerRef);
      aiThinkTimerRef.current = window.setTimeout(() => {
        aiThinkTimerRef.current = undefined;
        setAiRetryTick((current) => current + 1);
      }, thinkingDelay);
    }

    if (aiActionInFlightRef.current === actionKey || now < attemptState.nextAttemptAt) return;

    attemptState.attempt += 1;
    attemptState.nextAttemptAt = now + ROOM_AI_REQUEST_TIMEOUT_MS + ROOM_AI_RETRY_DELAY_MS;
    aiActionInFlightRef.current = actionKey;
    setAiAutomation({
      actionKey,
      attempt: attemptState.attempt,
      lastError: attemptState.lastError,
      waitingForRetry: false,
    });

    void withTimeout(
      executeRoomAiAction(snapshot.room.id, action),
      ROOM_AI_REQUEST_TIMEOUT_MS,
      t('AI action timed out.'),
    )
      .then((nextSnapshot) => {
        if (aiActionAttemptRef.current?.actionKey === actionKey) {
          aiActionAttemptRef.current = undefined;
          setAiAutomation(undefined);
        }
        setSnapshot(nextSnapshot);
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : t('Could not run AI action.');
        const currentAttemptState = aiActionAttemptRef.current;
        if (currentAttemptState?.actionKey === actionKey) {
          currentAttemptState.lastError = errorMessage;
          currentAttemptState.nextAttemptAt = Date.now() + ROOM_AI_RETRY_DELAY_MS;
          setAiAutomation({
            actionKey,
            attempt: currentAttemptState.attempt,
            lastError: errorMessage,
            waitingForRetry: true,
          });
        }
        setMessage(t('AI action stalled. Retrying automatically.'));
        void getRoomById(snapshot.room.id)
          .then((refreshedSnapshot) => {
            if (refreshedSnapshot) setSnapshot(refreshedSnapshot);
          })
          .catch(() => {
            // The retry loop will keep trying the pending AI action.
          });
      })
      .finally(() => {
        if (aiActionInFlightRef.current === actionKey) aiActionInFlightRef.current = '';
      });
  }, [aiRetryTick, currentPlayer?.id, currentPlayer?.isHost, isDemoMode, snapshot, t]);

  async function handleCreateRoom(event: React.FormEvent) {
    event.preventDefault();
    if (isHostNameMissing) {
      hostNameInputRef.current?.focus();
      setMessage('');
      return;
    }
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

  function getOldRoomLeaveConfirmation(room: RoomSnapshot) {
    return isRoomStaleForExit(room)
      ? t('Leave this old room? You will be removed from its player list. If it was an abandoned active game, the table will be returned to the lobby.')
      : t('This game still looks active. Re-enter the room or ask the host to abandon it before leaving.');
  }

  return (
    <main className={[
      'shell',
      screen === 'demo' || screen === 'demoJoin' ? 'demo-shell' : '',
      screen === 'room' ? 'room-shell' : '',
    ].filter(Boolean).join(' ')}>
      <header className="hero">
        <div className="hero-top"><p className="eyebrow">{t('Avalon room assistant')}</p><LanguageSwitcher /></div>
        <h1>{screen === 'room' ? getRoomHeroTitle(snapshot, t) : t('Veiled Roundtable')}</h1>
        <p className="lede">{screen === 'room' ? getRoomHeroCopy(snapshot, t) : t('Guide the Avalon game from setup to finish, with AI ready to fill empty seats when needed.')}</p>
      </header>

      {message && <p className="notice">{message}</p>}

      {screen === 'home' && restorableSnapshot && (
        <section className="panel restore-panel">
          <p className="eyebrow">{t('Previous room found')}</p>
          <h2>{t('You were previously at room')} {restorableSnapshot.room.code}</h2>
          <p>{t('Choose whether to re-enter it or leave the old room.')}</p>
          <div className="share-actions">
            <button type="button" className="primary" onClick={handleRestoreRoom} disabled={busy}>{t('Re-enter Room')}</button>
            <button type="button" onClick={handleLeaveRestorableRoom} disabled={busy}>{t('Leave Old Room')}</button>
          </div>
        </section>
      )}

      {screen === 'home' && (
        <section className="entry">
          <section className="path-section" aria-labelledby="choose-path-title">
            <div className="home-join-copy">
              <p className="eyebrow">{t('Start here')}</p>
              <h2 id="choose-path-title">{t('Join a room')}</h2>
              <p>{t('Enter the host code here and join the table directly.')}</p>
            </div>
            <form className="home-join-form" onSubmit={handleJoinRoom}>
              <label className="join-code-field">
                {t('5-digit room code')}
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(normalizeRoomCode(event.target.value))}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={5}
                  placeholder="12345"
                  autoComplete="one-time-code"
                />
              </label>
              <label className="join-name-field">
                {t('Your nickname')}
                <input value={joinName} onChange={(event) => setJoinName(event.target.value)} maxLength={24} />
              </label>
              <button type="submit" className="primary" disabled={busy}>{busy ? t('Joining...') : t('Join Room')}</button>
            </form>
            <div className="secondary-entry-actions" aria-label={t('Other options')}>
              <button type="button" className="path-card secondary-path create-room-action" onClick={() => navigateEntry('create')}>
                <span>{t('Host the round')}</span>
                <small>{t('Create a live 5-digit code for the table.')}</small>
              </button>
              <button type="button" className="path-card secondary-path demo-button demo-entry-action" onClick={() => navigateEntry('demo')}>
                <span>{t('Try demo')}</span>
                <small>{t('Simulate 5-10 phone screens on this laptop.')}</small>
              </button>
            </div>
          </section>
          <section className="learn-more" aria-labelledby="learn-more-title">
            <p className="eyebrow">{t('About Veiled Roundtable')}</p>
            <h2 id="learn-more-title">{t('For short Avalon tables, hidden roles, and phone-based flow')}</h2>
            <HomeSeoIntro />
            <details className="home-details">
              <summary>{t('View flow and option details')}</summary>
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
            </details>
          </section>
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
            <label className={`field-label ${isHostNameMissing ? 'field-label-error' : ''}`}>
              <span>{t('Your nickname')}</span>
              <input
                ref={hostNameInputRef}
                value={hostName}
                onChange={(event) => setHostName(event.target.value)}
                maxLength={24}
                autoFocus
                required
                aria-invalid={isHostNameMissing}
                aria-describedby={isHostNameMissing ? 'host-name-error' : undefined}
              />
              {isHostNameMissing && <small id="host-name-error" className="field-error">{t('Enter a nickname before creating the room.')}</small>}
            </label>
            <CreateRoomRoleConfig
              humanPlayerCount={humanPlayerCount}
              playerCount={plannedPlayerCount}
              onHumanPlayerCountChange={handleHumanPlayerCount}
              roleOptions={hostRoleOptions}
              onPlayerCountChange={handlePlannedPlayerCount}
              onToggleRole={handleHostRoleToggle}
            />
            <button type="submit" className="primary" disabled={busy || isHostNameMissing} title={isHostNameMissing ? t('Enter a nickname before creating the room.') : undefined}>
              {busy ? t('Creating...') : t('Create Room')}
            </button>
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
          aiAutomation={aiAutomation}
          showGameStartNotice={showGameStartNotice}
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

function HomeSeoIntro() {
  const { t } = useI18n();

  return (
    <section className="home-seo" aria-labelledby="home-seo-title">
      <div className="home-seo-copy">
        <p className="eyebrow">{t('Medieval table, modern phones')}</p>
        <h2 id="home-seo-title">{t('AI fill-ins for short tables')}</h2>
        <p>{t('Veiled Roundtable is a mobile Avalon board game assistant for hidden identities, quest voting, and the Merlin assassination endgame.')}</p>
        <p>{t('When the Avalon room is short on people or you want to test and practice a flow, AI players can fill empty seats so the table can start sooner.')}</p>
        <div className="seo-tags" aria-label={t('Avalon assistant highlights')}>
          <span>{t('Round table setup')}</span>
          <span>{t('Private phone reveals')}</span>
          <span>{t('Quest votes and Merlin endgame')}</span>
          <span>{t('AI player fill-ins')}</span>
        </div>
      </div>
      <figure className="home-seo-art">
        <img
          src="/seo/avalon-phone-table.jpg"
          alt={t('Phones around a candlelit Avalon round table')}
          loading="lazy"
          width="1448"
          height="1086"
        />
        <img
          className="home-seo-castle"
          src="/seo/veiled-roundtable-room.jpg"
          alt={t('Misty castle council room with a round table')}
          loading="lazy"
          width="1672"
          height="941"
        />
      </figure>
    </section>
  );
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
          {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
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
            <strong>{humanPlayerCount} {t(humanPlayerCount === 1 ? 'human' : 'humans')} + {aiCount} {t('AI')}</strong>
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

type AgentMemory = AiAgentMemory;

interface DemoPlayer {
  id: string;
  displayName: string;
  seatIndex: number;
  role: Role;
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
  audit?: AiBeliefAudit;
  data?: {
    teamIds?: string[];
    vote?: Vote;
    missionCard?: MissionCard;
    targetPlayerId?: string;
    action?: AiAvalonDecision['action'];
  };
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
  const [demo, setDemo] = useState(() => createDemoState(7, getRecommendedRolePresetOptions(7), { humanCount: 0 }));
  const [pauseAfterAiQuest, setPauseAfterAiQuest] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [demoLogCopied, setDemoLogCopied] = useState(false);
  const rule = getPlayerCountRule(demo.playerCount);
  const preset = buildRolePreset(demo.playerCount, demo.roleOptions);
  const isPureAiDemo = demo.mode === 'ai' && demo.humanCount === 0;
  const shouldPauseAfterAiQuest = isPureAiDemo && pauseAfterAiQuest;
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
    if (shouldPauseAfterAiQuest) return undefined;
    const timeout = window.setTimeout(() => {
      setDemo((current) => {
        if (current.phase !== 'result' || getDemoWinner(current) || current.roundIndex >= 4) return current;
        return advanceDemoToNextQuest(current);
      });
    }, DEMO_RESULT_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timeout);
  }, [demo.phase, demo.roundIndex, demo.missionResults.length, shouldPauseAfterAiQuest, winner]);

  useEffect(() => {
    if (demo.mode !== 'ai' || aiBusy || winner || demo.phase === 'setup' || demo.phase === 'result' || demo.phase === 'finished') return undefined;
    if (!hasPendingAiAction(demo)) return undefined;
    const timeout = window.setTimeout(() => {
      void runAiOnce();
    }, 750);
    return () => window.clearTimeout(timeout);
  }, [aiBusy, demo, winner]);

  function resetWith(playerCount: number, roleOptions: RolePresetOptions, options: { humanCount?: number } = {}) {
    const nextHumanCount = options.humanCount ?? (demo.humanCount === demo.playerCount ? playerCount : Math.min(demo.humanCount, playerCount));
    setDemoLogCopied(false);
    setDemo(createDemoState(playerCount, sanitizeRoleOptions(playerCount, roleOptions), {
      humanCount: nextHumanCount,
    }));
  }

  function startTable() {
    setDemoLogCopied(false);
    setDemo((current) => ({
      ...current,
      phase: 'proposal',
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, undefined, 'result', `Demo roundtable started with ${current.playerCount} players and ${current.playerCount - current.humanCount} AI fill-ins.`),
      ],
    }));
  }

  function setManualSeatCount(humanCount: number) {
    resetWith(demo.playerCount, demo.roleOptions, { humanCount });
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
      setDemo((current) => runNextAiAction(current, language));
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
          undefined,
          { teamIds: [...current.selectedTeamIds] },
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
        tableHistory: [...current.tableHistory, makeHistory(current, voter, 'vote', `${voter?.displayName ?? playerId} voted ${teamVote}.`, undefined, { vote: teamVote })],
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
      return applyMissionResultBeliefUpdates({
        ...next,
        tableHistory: [...next.tableHistory, makeHistory(current, actor, 'mission', `${actor?.displayName ?? playerId} submitted a mission card.`, undefined, { missionCard })],
      });
    });
  }

  function chooseAssassinationTarget(targetPlayerId: string) {
    if (demo.phase !== 'assassin') return;
    setDemo((current) => resolveDemoAssassination(current, targetPlayerId));
  }

  function continueAfterAiQuestPause() {
    setDemo((current) => {
      if (current.phase !== 'result' || getDemoWinner(current) || current.roundIndex >= 4) return current;
      return advanceDemoToNextQuest(current);
    });
  }

  async function copyDemoLog() {
    await copyText(buildDemoLog(demo, language));
    setDemoLogCopied(true);
  }

  return (
    <div className="demo-simulator">
      <div className="demo-heading">
        <div>
          <p className="eyebrow">{t('Not a live game')}</p>
          <h2>{t('Demo mode')}</h2>
        </div>
        <button type="button" className="demo-reset-button" onClick={() => resetWith(demo.playerCount, demo.roleOptions)}>{t('Reset table')}</button>
      </div>

      {demo.phase === 'setup' ? (
        <section className="demo-setup">
          <div className="demo-ai-intro">
            <h3>{t('Demo roundtable')}</h3>
            <p>{t('Choose the table size and manual seats. AI fills the rest; set manual seats to 0 to watch a full AI table play itself.')}</p>
          </div>
          <div>
            <h3>{t('Table size')}</h3>
            <div className="segmented" aria-label={t('Table size')}>
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
          <div>
            <h3>{t('Manual seats')}</h3>
            <div className="segmented" aria-label={t('Manual seats')}>
              {Array.from({ length: demo.playerCount + 1 }, (_, count) => (
                <button key={count} type="button" className={demo.humanCount === count ? 'selected' : ''} onClick={() => setManualSeatCount(count)}>
                  {count}
                </button>
              ))}
            </div>
            <p>{formatDemoSeatMix(demo.humanCount, demo.playerCount - demo.humanCount, t, language)}</p>
          </div>
          <div className="demo-role-setup">
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
          {demo.playerCount > demo.humanCount && (
            <div className="ai-instruction-card">
              <h3>{t('Agent input contract')}</h3>
              <p>{t('On each turn the orchestrator sends: rules + current phase + legal actions + public history + that agent’s role vision + that agent’s private memory. Other agents’ private memory is never included.')}</p>
            </div>
          )}
          <div className="demo-start-row">
            <button type="button" className="primary" onClick={startTable}>{t('Start demo')}</button>
          </div>
        </section>
      ) : (
        <section className="demo-setup-summary" aria-label={t('Demo table setup')}>
          <span>{t('Demo roundtable')}</span>
          <span>{demo.playerCount} {t('players')}</span>
          <span>{formatDemoSeatMix(demo.humanCount, demo.playerCount - demo.humanCount, t, language)}</span>
          <span>{rule.goodCount} {t('Good')} / {rule.evilCount} {t('Evil')}</span>
          <span>{t('Special roles')}: {includedSpecialRoles.length ? includedSpecialRoles.map((role) => formatRole(role, language)).join(', ') : t('None')}</span>
          <span>{t('Base')}: {preset.requiredRoles.map((role) => formatRole(role, language)).join(', ')}</span>
          <span>{t('Fill')}: {summarizeRoles(preset.fillerRoles, language)}</span>
        </section>
      )}

      <section className="demo-progress-sticky" aria-label={t('Quest track')}>
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
      </section>

      <section className="demo-board" aria-label={t('Demo table state')}>
        {demo.lastVote && (
          <p className="hint">
            {t('Last vote')}: {demo.lastVote.approveCount} {t('approve')}, {demo.lastVote.rejectCount} {t('reject')}.
            {' '}
            {t('Team')} {t(demo.lastVote.passed ? 'approved' : 'rejected')}.
          </p>
        )}
        {demo.lastMission && (
          <p className="notice">
            {formatQuestLabel(demo.lastMission.roundIndex, language)} {t(demo.lastMission.outcome === 'success' ? 'succeeded' : 'failed')};
            {' '}
            {demo.lastMission.failCount} {t('fail card')}.
          </p>
        )}
        {demo.phase === 'assassin' && <p className="notice">{t('Good completed three quests. The Assassin is choosing Merlin.')}</p>}
        {demo.phase === 'finished' && winner && (
          <div className="demo-result-actions">
            <p className="notice">
              {winner === 'good'
                ? t('Good wins: the Assassin missed Merlin.')
                : demo.assassination?.hitMerlin
                  ? t('Evil wins: the Assassin found Merlin.')
                  : t('Evil wins.')}
              {' '}
              {t('Reset the table to try another setup.')}
            </p>
            <button type="button" className="primary" onClick={copyDemoLog}>{t('Copy demo log')}</button>
            {demoLogCopied && <span className="copy-status" aria-live="polite">{t('Demo log copied.')}</span>}
          </div>
        )}
        {demo.phase === 'setup' && (
          <div className="mission-step">
            <p>{t('Choose player count and roles, then start the tabletop.')}</p>
          </div>
        )}
        {demo.phase === 'proposal' && (
          <div className="mission-step">
            <p>
              {demo.players[demo.leaderIndex]?.displayName} {t('is choosing')} {teamSize} {t('players')}.
              {' '}
              {t('Selected')}: {selectedPlayers.length ? selectedPlayers.join(', ') : t('None')}.
            </p>
          </div>
        )}
        {demo.phase === 'vote' && (
          <div className="mission-step">
            <p>
              {t('Everyone votes on')} {selectedPlayers.join(', ')}.
              {' '}
              {t('Votes in')}: {votedCount}/{demo.playerCount}; {t('The table advances when every player has voted.')}
            </p>
          </div>
        )}
        {demo.phase === 'mission' && (
          <div className="mission-step">
            <p>
              {t('Mission team plays cards anonymously.')} {t('Cards in')}: {missionCards.length}/{demo.selectedTeamIds.length};
              {' '}
              {t('The quest resolves when the team is done.')}
            </p>
          </div>
        )}
        {demo.phase === 'result' && !winner && (
          <div className="mission-step">
            <p>{shouldPauseAfterAiQuest ? t('Quest result is public. Review the table history, then continue when ready.') : t('Quest result is public on every phone. Next quest starts automatically.')}</p>
          </div>
        )}
        {demo.phase === 'assassin' && (
          <div className="mission-step">
            <p>{t('Good has three successful quests. Assassin chooses one player as Merlin: hit Merlin and Evil wins; miss and Good wins.')}</p>
          </div>
        )}
        {demo.phase === 'finished' && demo.assassination && (
          <div className="mission-step">
            <p>
              {t('Assassin targeted')} {demo.assassination.targetName}.
              {' '}
              {demo.assassination.hitMerlin ? t('That was Merlin.') : t('That was not Merlin.')}
            </p>
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
            {isPureAiDemo && (
              <div className="choice-row">
                <div className="ai-pause-option">
                  <button
                    type="button"
                    className={`ai-state-switch ${pauseAfterAiQuest ? 'is-on' : 'is-off'}`}
                    role="switch"
                    aria-checked={pauseAfterAiQuest}
                    aria-label={t('Pause after AI quests')}
                    aria-describedby="ai-pause-help"
                    onClick={() => setPauseAfterAiQuest(!pauseAfterAiQuest)}
                  >
                    <span>{t('Pause after AI quests')}</span>
                    <strong>{pauseAfterAiQuest ? t('On') : t('Off')}</strong>
                  </button>
                  <p id="ai-pause-help" className="ai-pause-help">{t('AI pauses after each quest result so you can review the log before continuing.')}</p>
                </div>
              </div>
            )}
          </div>
          {aiStatus && <p className="ai-status" aria-live="polite">{aiStatus}</p>}
          <DemoHistoryLog entries={demo.tableHistory.slice(-8)} />
          {demo.aiHistory.length > 0 && (
            <DemoHistoryLog entries={demo.aiHistory.slice(-5)} privateLog ariaLabel={t('AI private reasoning log')} />
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

      {shouldPauseAfterAiQuest && demo.phase === 'result' && !winner && (
        <div className="ai-round-pause" role="dialog" aria-modal="false" aria-labelledby="ai-round-pause-title">
          <div>
            <p className="eyebrow">{t('AI demo paused')}</p>
            <h3 id="ai-round-pause-title">{t('Review this round?')}</h3>
            <p>{t('The AI table will wait here until you start the next round.')}</p>
          </div>
          <button type="button" className="primary" onClick={continueAfterAiQuestPause}>{t('Enter next round')}</button>
        </div>
      )}
    </div>
  );
}

function DemoHistoryLog({ entries, privateLog = false, ariaLabel }: { entries: DemoHistoryEntry[]; privateLog?: boolean; ariaLabel?: string }) {
  const { language } = useI18n();

  return (
    <div className={`ai-history ${privateLog ? 'ai-private-history' : ''}`} aria-label={ariaLabel}>
      {entries.map((entry) => {
        const display = formatDemoHistoryEntry(entry, language);
        return (
          <article key={entry.id} className={`ai-history-entry history-${display.tone}`}>
            <div className="ai-history-meta">
              <span className="ai-history-label">{display.label}</span>
              <strong>{entry.actorName ?? display.actorFallback}</strong>
            </div>
            <p>{display.text}</p>
          </article>
        );
      })}
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
      agentView={tableMode === 'ai' ? getAgentViewSummary(player, privateInfo, t, language) : undefined}
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
  agentView?: React.ReactNode;
  action?: PlayerPhoneAction;
}) {
  const { t } = useI18n();
  const isLeader = player.id === leaderId;
  const onTeam = selectedTeamIds.includes(player.id);
  const playerMeta = [
    `${t('Seat')} ${player.seatIndex + 1}`,
    t('Leader rotation order'),
    isLeader ? t('Current Leader') : undefined,
  ].filter(Boolean).join(' · ');
  const outcomeClass = [
    winner && player.role ? (roleAllegiance(player.role) === winner ? 'phone-winner' : 'phone-loser') : '',
    result ? `mission-${result.outcome}-phone` : '',
  ].filter(Boolean).join(' ');

  return (
    <article className={`player-phone ${mode === 'demo' ? 'demo-phone' : 'live-player-phone'} ${isLeader ? 'leader-phone' : ''} ${outcomeClass}`}>
      <div className="phone-top">
        <div className="phone-player-row">
          <strong>{player.displayName}</strong>
          <small>{playerMeta}</small>
        </div>
        {onTeam && <span className="phone-team-pill">{t('Selected for this quest')}</span>}
      </div>
      {player.role && (
        <PrivateSwipeReveal
          playerName={player.displayName}
          role={player.role}
          privateInfo={privateInfo}
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
              : `${action.selectedTeamCount} ${t('players are on the mission. Wait for their cards.')}`}
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
            <p>{t('Good completed three quests. Choose Merlin: hit Merlin and Evil wins; miss and Good wins.')}</p>
            <div className="choice-row">
              {action.candidates.map((candidate) => (
                <button key={candidate.id} type="button" onClick={() => action.onAssassinate?.(candidate.id)}>{candidate.displayName}</button>
              ))}
            </div>
          </>
        ) : (
          <p>{action.isAssassin ? t('Waiting for the AI Assassin to choose Merlin.') : t('Good completed three quests. The Assassin is choosing Merlin.')}</p>
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
        <p>
          {t('Assassin targeted')} {action.assassination.targetName}.
          {' '}
          {action.assassination.hitMerlin ? t('Merlin was found.') : t('Merlin survived.')}
        </p>
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
  const { t, language } = useI18n();
  const succeeded = result.outcome === 'success';
  const failCardLabel = language === 'zh' ? t('fail card') : `${t('fail card')}${result.failCount === 1 ? '' : 's'}`;
  return (
    <div className={`mission-result-reveal ${succeeded ? 'success' : 'fail'}`} aria-live="polite">
      <strong>{succeeded ? t('Quest Success') : t('Quest Failed')}</strong>
      <small>{result.failCount} {failCardLabel} · {result.requiredFails} {t('needed to fail')}</small>
    </div>
  );
}

type PrivateRevealSide = 'left' | 'right';

function PrivateSwipeReveal({
  playerName,
  role,
  privateInfo,
}: {
  playerName: string;
  role: Role;
  privateInfo?: VisibilityInfo;
}) {
  const { t, language } = useI18n();
  const allegiance = roleAllegiance(role);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | undefined>(undefined);
  const [activeSide, setActiveSide] = useState<PrivateRevealSide | undefined>();
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  function maxRevealOffset() {
    return Math.max(96, (trackRef.current?.clientWidth ?? 112) - 18);
  }

  function reveal(side: PrivateRevealSide) {
    const maxOffset = maxRevealOffset();
    setActiveSide(side);
    setDragOffset(side === 'left' ? maxOffset : -maxOffset);
  }

  function resetReveal() {
    dragStartX.current = undefined;
    setIsDragging(false);
    setActiveSide(undefined);
    setDragOffset(0);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragStartX.current = event.clientX;
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStartX.current === undefined) return;
    const maxOffset = maxRevealOffset();
    const nextOffset = Math.max(-maxOffset, Math.min(maxOffset, event.clientX - dragStartX.current));
    setDragOffset(nextOffset);
    if (Math.abs(nextOffset) < 8) {
      setActiveSide(undefined);
      return;
    }
    setActiveSide(nextOffset > 0 ? 'left' : 'right');
  }

  function handleButtonKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, side: PrivateRevealSide) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    reveal(side);
  }

  const swipeStyle = { '--swipe-x': `${dragOffset}px` } as React.CSSProperties;
  const roleRevealLabel = language === 'zh' ? `${t('Reveal hidden role for')}${playerName}` : `Reveal ${playerName}'s hidden role`;
  const nightRevealLabel = language === 'zh' ? `${t('Reveal hidden night information for')}${playerName}` : `Reveal ${playerName}'s hidden night information`;
  const fullRevealLabel = language === 'zh' ? `${roleRevealLabel} / ${nightRevealLabel}` : `Reveal hidden role and night information for ${playerName}`;

  return (
    <div
      className={`phone-private-swipe ${activeSide ? `reveal-${activeSide}` : 'reveal-hidden'} ${isDragging ? 'dragging' : ''}`}
      ref={trackRef}
      role="group"
      aria-label={fullRevealLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={resetReveal}
      onPointerCancel={resetReveal}
      onLostPointerCapture={resetReveal}
    >
      <div className={`private-swipe-panel private-swipe-left phone-role revealed ${allegiance}`} aria-hidden={activeSide !== 'left'}>
        <span className="private-swipe-label">{t('Identity')}</span>
        <div className="role-face">
          <strong>{formatRole(role, language)}</strong>
          <span>{formatAllegiance(allegiance, language)}</span>
          <p className="role-summary">{formatRoleDescription(role, language)}</p>
        </div>
      </div>

      <div className="private-swipe-slider" style={swipeStyle}>
        <div className="private-swipe-neutral">
          <span>{t('Swipe left or right to peek')}</span>
          <div className="private-swipe-actions">
            <button
              type="button"
              onPointerDown={() => reveal('left')}
              onPointerUp={resetReveal}
              onPointerCancel={resetReveal}
              onKeyDown={(event) => handleButtonKeyDown(event, 'left')}
              onKeyUp={resetReveal}
              aria-label={roleRevealLabel}
            >
              {t('Identity')}
            </button>
            <button
              type="button"
              onPointerDown={() => reveal('right')}
              onPointerUp={resetReveal}
              onPointerCancel={resetReveal}
              onKeyDown={(event) => handleButtonKeyDown(event, 'right')}
              onKeyUp={resetReveal}
              aria-label={nightRevealLabel}
            >
              {t('Night info')}
            </button>
          </div>
        </div>

        <div className="private-swipe-panel private-swipe-right phone-info phone-night-info" aria-hidden={activeSide !== 'right'}>
          <span>{t('Night info')}</span>
          <div className="night-info-face">
            {privateInfo?.sees.length ? (
              <ul>{privateInfo.sees.map((item) => <li key={item.playerId}>{item.name}: {formatHint(item.hint, language)}</li>)}</ul>
            ) : (
              <p>{t('No extra information.')}</p>
            )}
          </div>
        </div>
      </div>
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
      makeHistory(
        current,
        assassin,
        'assassin',
        `${assassin?.displayName ?? 'Assassin'} chose ${target.displayName} as Merlin. ${hitMerlin ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`,
        undefined,
        { targetPlayerId: target.id },
      ),
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

function buildDemoLog(demo: DemoState, language: Language): string {
  const winner = getDemoWinner(demo);
  const lines = [
    '# Avalon demo log',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Players: ${demo.playerCount}`,
    `Mode: ${demo.mode}`,
    `Manual seats: ${demo.humanCount}`,
    `AI seats: ${demo.playerCount - demo.humanCount}`,
    `Current phase: ${demo.phase}`,
    `Winner: ${winner ? formatAllegiance(winner, language) : 'not decided'}`,
  ];

  lines.push('', '## Players, identities, and role vision');
  demo.players.forEach((player) => {
    const visibleInfo = getVisibilityInfo(
      { id: player.id, name: player.displayName, role: player.role },
      demo.players.map(toDemoAvalonPlayer),
    );
    lines.push(
      '',
      `### Seat ${player.seatIndex + 1}: ${player.displayName}`,
      `- Controller: ${player.controller}`,
      `- Role: ${formatRole(player.role, language)} (${formatAllegiance(roleAllegiance(player.role), language)})`,
      `- Persona: ${player.persona ?? 'human-controlled'}`,
      `- Role vision: ${visibleInfo.sees.length ? visibleInfo.sees.map((item) => `${item.name} = ${formatHint(item.hint, language)}`).join('; ') : 'none'}`,
    );
    if (player.memory) {
      lines.push(`- Suspicion memory: ${formatSuspicionMemory(player.memory.suspicion, demo)}`);
      lines.push(`- Memory notes: ${player.memory.notes.length ? player.memory.notes.join(' | ') : 'none'}`);
      lines.push('- Speech policy: ignored by design; formal actions only are used as evidence.');
      lines.push(`- Belief audit entries: ${player.memory.beliefAudit?.length ?? 0}`);
      lines.push(`- Belief profiles: ${player.memory.beliefProfiles ? Object.keys(player.memory.beliefProfiles).length : 0}`);
    }
    if (player.lastPublicSpeech) lines.push(`- Last public speech: ${player.lastPublicSpeech}`);
    if (player.lastReasoningSummary) lines.push(`- Last private reasoning: ${player.lastReasoningSummary}`);
  });

  lines.push('', '## AI belief profiles');
  const aiPlayersWithProfiles = demo.players.filter((player) => player.controller === 'ai' && player.memory?.beliefProfiles);
  if (!aiPlayersWithProfiles.length) {
    lines.push('No structured belief profiles yet.');
  }
  aiPlayersWithProfiles.forEach((actor) => {
    lines.push('', `### ${actor.displayName}'s formal-action beliefs`);
    Object.values(actor.memory?.beliefProfiles ?? {})
      .sort((left, right) => right.pEvil - left.pEvil || right.suspicionScore - left.suspicionScore || left.player.localeCompare(right.player))
      .forEach((profile) => {
        lines.push(
          '',
          `#### ${playerName(demo, profile.playerId)}`,
          `- pEvil: ${profile.pEvil.toFixed(2)}`,
          `- suspicionScore: ${profile.suspicionScore >= 0 ? '+' : ''}${profile.suspicionScore}`,
          `- Evidence for evil: ${formatEvidenceItems(profile.evidenceForEvil)}`,
          `- Evidence against evil: ${formatEvidenceItems(profile.evidenceAgainstEvil)}`,
          `- Uncertainty: ${profile.uncertainty.length ? profile.uncertainty.join(' | ') : 'none'}`,
        );
      });
  });

  lines.push('', '## Quest rounds');
  const roundIndexes = [...new Set([
    ...demo.tableHistory.map((entry) => entry.roundIndex),
    ...demo.aiHistory.map((entry) => entry.roundIndex),
    ...demo.missionResults.map((result) => result.roundIndex),
  ])].sort((left, right) => left - right);

  if (!roundIndexes.length) {
    lines.push('No rounds have been played.');
  }

  roundIndexes.forEach((roundIndex) => {
    const mission = demo.missionResults.find((result) => result.roundIndex === roundIndex);
    const teamNames = mission?.selectedTeamIds?.map((id) => playerName(demo, id)) ?? [];
    lines.push('', `### Quest ${roundIndex + 1}`);
    if (teamNames.length) lines.push(`- Team: ${teamNames.join(', ')}`);
    if (mission) {
      lines.push(`- Result: ${mission.outcome}; success cards: ${mission.successCount}; fail cards: ${mission.failCount}; required fails: ${mission.requiredFails}`);
    }
    const publicEntries = demo.tableHistory.filter((entry) => entry.roundIndex === roundIndex);
    const privateEntries = demo.aiHistory.filter((entry) => entry.roundIndex === roundIndex);
    lines.push('- Public table history:');
    if (publicEntries.length) {
      publicEntries.forEach((entry) => {
        const display = formatDemoHistoryEntry(entry, language);
        lines.push(`  - ${display.label} | ${entry.actorName ?? display.actorFallback}: ${display.text}`);
      });
    } else {
      lines.push('  - none');
    }
    lines.push('- AI private reasoning:');
    if (privateEntries.length) {
      privateEntries.forEach((entry) => {
        const display = formatDemoHistoryEntry(entry, language);
        lines.push(`  - ${display.label} | ${entry.actorName ?? display.actorFallback}: ${display.text}`);
        if (entry.audit) lines.push(...formatAuditForLog(entry.audit, demo, '    '));
      });
    } else {
      lines.push('  - none');
    }
  });

  lines.push('', '## Structured audit events');
  lines.push('```json');
  lines.push(JSON.stringify(buildStructuredAuditExport(demo), null, 2));
  lines.push('```');

  if (demo.lastVote) {
    lines.push('', '## Last vote snapshot', `- Approve: ${demo.lastVote.approveCount}`, `- Reject: ${demo.lastVote.rejectCount}`, `- Passed: ${demo.lastVote.passed}`);
  }
  if (demo.assassination) {
    lines.push('', '## Assassination', `- Target: ${demo.assassination.targetName}`, `- Hit Merlin: ${demo.assassination.hitMerlin}`, `- Winner: ${formatAllegiance(demo.assassination.winner, language)}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatSuspicionMemory(suspicion: Record<string, number>, demo: DemoState): string {
  const entries = Object.entries(suspicion);
  if (!entries.length) return 'none';
  return entries.map(([playerId, score]) => `${playerName(demo, playerId)} ${score >= 0 ? '+' : ''}${score}`).join(', ');
}

function formatEvidenceItems(items: Array<{ event: string; reason: string }>): string {
  if (!items.length) return 'none';
  return items.map((item) => `${item.event}: ${item.reason}`).join(' | ');
}

function formatAuditForLog(audit: AiBeliefAudit, demo: DemoState, indent: string): string[] {
  return [
    `${indent}- Audit event: ${audit.eventType}`,
    `${indent}- Evidence mode: ${audit.evidenceMode}`,
    `${indent}- Speech policy: ${audit.speechPolicy}`,
    `${indent}- Information used: ${audit.informationUsed.join(' | ')}`,
    `${indent}- Deductions: ${audit.deductions.join(' | ')}`,
    `${indent}- Belief before: ${formatSuspicionMemory(audit.beliefBefore, demo)}`,
    `${indent}- Belief after: ${formatSuspicionMemory(audit.beliefAfter, demo)}`,
    `${indent}- Belief deltas: ${formatSuspicionMemory(audit.beliefDeltas, demo)}`,
    `${indent}- Profile updates: ${formatProfileUpdates(audit.beliefProfilesAfter)}`,
    `${indent}- Uncertainty: ${audit.uncertainty.join(' | ')}`,
  ];
}

function formatProfileUpdates(profiles?: Record<string, AiPlayerBeliefProfile>): string {
  if (!profiles) return 'none';
  const updated = Object.values(profiles)
    .filter((profile) => profile.evidenceForEvil.length || profile.evidenceAgainstEvil.length || profile.uncertainty.length)
    .sort((left, right) => right.pEvil - left.pEvil || right.suspicionScore - left.suspicionScore)
    .slice(0, 4);
  if (!updated.length) return 'none';
  return updated.map((profile) => `${profile.player}: pEvil ${profile.pEvil.toFixed(2)}, suspicionScore ${profile.suspicionScore >= 0 ? '+' : ''}${profile.suspicionScore}`).join(' | ');
}

function buildStructuredAuditExport(demo: DemoState) {
  const idFor = createCompactPlayerIdLookup(demo.players);
  const usedRules = new Set<string>();
  const rememberRules = (rules: string[]) => rules.forEach((rule) => usedRules.add(rule));
  const beliefEvents = demo.aiHistory
    .filter((entry) => entry.audit && Object.keys(entry.audit.beliefDeltas).length)
    .map((entry, index) => {
      const audit = entry.audit as AiBeliefAudit;
      const rules = ruleCodesForAudit(audit);
      rememberRules(rules);
      return {
        id: compactEventId('be', entry, idFor, index),
        actor: entry.actorId ? idFor(entry.actorId) : undefined,
        event: `q${entry.roundIndex + 1}.${compactEventKind(entry.kind, audit.eventType)}`,
        beforeScore: compactChangedScores(audit.beliefBefore, audit.beliefDeltas, idFor),
        delta: compactNumericPlayerMap(audit.beliefDeltas, idFor),
        afterScore: compactChangedScores(audit.beliefAfter, audit.beliefDeltas, idFor),
        constraintsAdded: constraintsAddedForAudit(demo, audit, entry.actorId, idFor),
        rules,
      };
    });
  const decisions = demo.aiHistory
    .filter((entry) => entry.audit?.eventType === 'decision')
    .map((entry, index) => {
      const rules = ruleCodesForAudit(entry.audit as AiBeliefAudit);
      rememberRules(rules);
      return {
        id: compactEventId('d', entry, idFor, index),
        actor: entry.actorId ? idFor(entry.actorId) : undefined,
        phase: entry.kind,
        q: entry.roundIndex + 1,
        action: entry.data?.action ? compactActionForExport(entry.data.action, idFor) : undefined,
        used: ['formal_history', 'role_vision', 'belief_state'],
        rules,
      };
    });
  const finalBeliefs = buildCompactFinalBeliefs(demo, idFor, rememberRules);

  return {
    schema: 'avalon-audit.v2',
    exports: {
      human: 'avalon-log.md',
      machine: 'avalon-audit.compact.json',
      debug: 'avalon-audit.debug.jsonl.gz',
      debugDefault: false,
    },
    policy: {
      evidence: 'formal_actions_only',
      speech: 'ui_only',
    },
    players: Object.fromEntries(demo.players.map((player) => [idFor(player.id), {
      name: player.displayName,
      role: player.role,
      alignment: roleAllegiance(player.role),
      controller: player.controller,
    }])),
    vision: buildCompactVision(demo, idFor),
    quests: buildCompactQuests(demo, idFor),
    beliefEvents,
    decisions,
    finalBeliefs,
    ruleText: Object.fromEntries([...usedRules].sort().map((rule) => [rule, COMPACT_AUDIT_RULE_TEXT[rule] ?? rule])),
  };
}

function createCompactPlayerIdLookup(players: DemoPlayer[]) {
  const ids = new Map(players.map((player) => [player.id, `p${player.seatIndex + 1}`]));
  return (playerId: string) => ids.get(playerId) ?? playerId;
}

function compactNumericPlayerMap(values: Record<string, number>, idFor: (playerId: string) => string): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([playerId, value]) => [idFor(playerId), value]));
}

function compactChangedScores(values: Record<string, number>, deltas: Record<string, number>, idFor: (playerId: string) => string): Record<string, number> {
  return Object.fromEntries(Object.keys(deltas).map((playerId) => [idFor(playerId), values[playerId] ?? 0]));
}

function buildCompactVision(demo: DemoState, idFor: (playerId: string) => string) {
  return Object.fromEntries(
    demo.players
      .map((player) => {
        const visibility = getVisibilityInfo(
          { id: player.id, name: player.displayName, role: player.role },
          demo.players.map((candidate) => ({ id: candidate.id, name: candidate.displayName, role: candidate.role })),
        ).sees.map((item) => ({ target: idFor(item.playerId), label: compactVisionLabel(item.hint) }));
        return [idFor(player.id), visibility] as const;
      })
      .filter(([, visibility]) => visibility.length),
  );
}

function compactVisionLabel(hint: string): string {
  if (hint === 'Evil player') return 'evil';
  if (hint === 'Merlin candidate') return 'merlin_candidate';
  if (hint === 'Evil teammate') return 'evil_teammate';
  return hint.toLowerCase().replaceAll(' ', '_');
}

function buildCompactQuests(demo: DemoState, idFor: (playerId: string) => string) {
  return demo.missionResults.map((result) => {
    const entries = demo.tableHistory.filter((entry) => entry.roundIndex === result.roundIndex);
    const proposals: Array<{ leader?: string; team: string[]; votes: Record<string, Vote>; passed?: boolean }> = [];
    entries.forEach((entry) => {
      if (entry.kind === 'proposal' && entry.data?.teamIds) {
        proposals.push({ leader: entry.actorId ? idFor(entry.actorId) : undefined, team: entry.data.teamIds.map(idFor), votes: {} });
      }
      if (entry.kind === 'vote' && entry.actorId && entry.data?.vote && proposals.length) {
        proposals[proposals.length - 1].votes[idFor(entry.actorId)] = entry.data.vote;
      }
    });
    proposals.forEach((proposal) => {
      const votes = Object.values(proposal.votes);
      if (votes.length === demo.playerCount) proposal.passed = votes.filter((vote) => vote === 'approve').length > demo.playerCount / 2;
    });
    const finalProposal = [...proposals].reverse().find((proposal) => proposal.passed) ?? proposals.at(-1);
    const missionCardsDebug = Object.fromEntries(
      entries
        .filter((entry) => entry.kind === 'mission' && entry.actorId && entry.data?.missionCard)
        .map((entry) => [idFor(entry.actorId as string), entry.data?.missionCard as MissionCard]),
    );
    return {
      q: result.roundIndex + 1,
      leader: finalProposal?.leader,
      team: finalProposal?.team ?? result.selectedTeamIds?.map(idFor) ?? [],
      votes: finalProposal?.votes ?? {},
      result: {
        outcome: result.outcome,
        success: result.successCount,
        fail: result.failCount,
        requiredFails: result.requiredFails,
      },
      missionCardsDebug,
      proposals: proposals.length > 1 ? proposals : undefined,
    };
  });
}

function buildCompactFinalBeliefs(
  demo: DemoState,
  idFor: (playerId: string) => string,
  rememberRules: (rules: string[]) => void,
) {
  return demo.players
    .filter((player) => player.controller === 'ai' && player.memory?.beliefProfiles)
    .reduce<Record<string, Record<string, { pEvil: number; score: number; reason: string[]; counter?: string[] }>>>((beliefsByActor, player) => {
      beliefsByActor[idFor(player.id)] = Object.fromEntries(
        Object.values(player.memory?.beliefProfiles ?? {}).map((profile) => {
          const reason = uniqueRules(profile.evidenceForEvil.map(ruleCodeForEvidence));
          const counter = uniqueRules(profile.evidenceAgainstEvil.map(ruleCodeForEvidence));
          rememberRules([...reason, ...counter]);
          return [idFor(profile.playerId), {
            pEvil: profile.pEvil,
            score: profile.suspicionScore,
            reason,
            counter: counter.length ? counter : undefined,
          }];
        }),
      );
      return beliefsByActor;
    }, {});
}

function compactEventId(prefix: string, entry: DemoHistoryEntry, idFor: (playerId: string) => string, index: number): string {
  return `${prefix}.${index + 1}.q${entry.roundIndex + 1}.${entry.kind}.${entry.actorId ? idFor(entry.actorId) : 'table'}`;
}

function compactEventKind(kind: DemoHistoryEntry['kind'], eventType: AiBeliefAudit['eventType']): string {
  if (eventType === 'missionResult') return 'result';
  if (eventType === 'decision') return `${kind}.decision`;
  return kind;
}

function compactActionForExport(action: AiAvalonDecision['action'], idFor: (playerId: string) => string) {
  if (action.type === 'proposeTeam') return { proposeTeam: action.teamIds.map(idFor) };
  if (action.type === 'vote') return { vote: action.vote };
  if (action.type === 'missionCard') return { missionCard: action.card };
  return { assassinate: idFor(action.targetPlayerId) };
}

function constraintsAddedForAudit(demo: DemoState, audit: AiBeliefAudit, actorId: string | undefined, idFor: (playerId: string) => string) {
  if (audit.eventType !== 'missionResult') return [];
  const mission = demo.missionResults.find((result) => result.roundIndex === audit.roundIndex);
  if (!mission || mission.outcome !== 'fail' || !mission.selectedTeamIds?.length) return [];
  const rules = ruleCodesForAudit(audit);
  const candidateIds = rules.includes('GOOD_SELF_SUCCESS') && actorId
    ? mission.selectedTeamIds.filter((id) => id !== actorId)
    : mission.selectedTeamIds;
  return [{ type: 'at_least_n_evil', players: candidateIds.map(idFor), n: mission.requiredFails }];
}

function ruleCodesForAudit(audit: AiBeliefAudit): string[] {
  const text = [...audit.informationUsed, ...audit.deductions, ...audit.uncertainty].join(' ');
  const rules = ['FORMAL_ACTIONS_ONLY'];
  if (audit.eventType === 'decision') rules.push('AI_DECISION');
  if (audit.eventType === 'proposal') rules.push('PROPOSAL_BEHAVIOR');
  if (audit.eventType === 'vote') rules.push('VOTE_BEHAVIOR');
  if (audit.eventType === 'missionResult') rules.push(text.includes('Mission succeeded') ? 'SUCCESSFUL_MISSION' : 'FAILED_MISSION');
  if (text.includes("Actor's own mission card: success")) rules.push('GOOD_SELF_SUCCESS');
  if (text.includes('Role-visible players on team:') && !text.includes('Role-visible players on team: none')) rules.push('ROLE_VISION');
  if (text.includes('hidden evil/Mordred')) rules.push('MERLIN_MORDRED_HIDDEN');
  if (text.includes('Known evil teammate') || text.includes('evil teammates')) rules.push('EVIL_TEAM_VISION');
  if (text.includes('Public speech is ignored')) rules.push('SPEECH_IGNORED');
  return uniqueRules(rules);
}

function ruleCodeForEvidence(item: AiEvidenceItem): string {
  if (item.event === 'ROLE_VISION') return 'ROLE_VISION';
  if (item.event === 'EVIL_TEAM_VISION') return 'EVIL_TEAM_VISION';
  if (item.reason.includes('no Merlin-visible evil') || item.reason.includes('hidden evil/Mordred')) return 'MERLIN_MORDRED_HIDDEN';
  if (item.reason.includes('knows their own card was success')) return 'GOOD_SELF_SUCCESS';
  if (item.reason.includes('Approved a team that later failed')) return 'APPROVED_LATER_FAILED_TEAM';
  if (item.reason.includes('Rejected a team that later failed')) return 'REJECTED_LATER_FAILED_TEAM';
  if (item.reason.includes('Approved a team that succeeded')) return 'APPROVED_SUCCESSFUL_TEAM';
  if (item.reason.includes('Rejected a team that succeeded')) return 'REJECTED_SUCCESSFUL_TEAM';
  if (item.reason.includes('Proposed a team that later failed')) return 'PROPOSED_LATER_FAILED_TEAM';
  if (item.reason.includes('Proposed a team that succeeded')) return 'PROPOSED_SUCCESSFUL_TEAM';
  if (item.reason.includes('role-visible evil')) return 'ROLE_VISIBLE_EVIL_ON_TEAM';
  if (item.reason.includes('successful mission')) return 'SUCCESSFUL_MISSION';
  if (item.reason.includes('failed mission')) return 'FAILED_MISSION';
  if (item.reason.includes('low-risk team')) return 'LOW_RISK_TEAM_ACTION';
  if (item.reason.includes('suspicious')) return 'SUSPICIOUS_TEAM_ACTION';
  return item.event;
}

function uniqueRules(rules: string[]): string[] {
  return [...new Set(rules.filter(Boolean))];
}

const COMPACT_AUDIT_RULE_TEXT: Record<string, string> = {
  AI_DECISION: 'AI made a legal action from its current information set.',
  APPROVED_LATER_FAILED_TEAM: 'Approved a team that later failed.',
  APPROVED_SUCCESSFUL_TEAM: 'Approved a team that succeeded.',
  EVIL_TEAM_VISION: 'Actor has private evil-team information.',
  FAILED_MISSION: 'Mission failed, so at least the required number of fail cards came from the team.',
  FORMAL_ACTIONS_ONLY: 'Only proposals, votes, mission cards/results, and private role vision are evidence.',
  GOOD_SELF_SUCCESS: 'Good actor knows their own mission card was Success.',
  LOW_RISK_TEAM_ACTION: 'Acted on a team that looked low-risk by current belief.',
  MERLIN_MORDRED_HIDDEN: 'Merlin saw no visible evil on a failed team, so hidden evil/Mordred remains possible.',
  PROPOSAL_BEHAVIOR: 'Leader chose the mission team.',
  PROPOSED_LATER_FAILED_TEAM: 'Proposed a team that later failed.',
  PROPOSED_SUCCESSFUL_TEAM: 'Proposed a team that succeeded.',
  REJECTED_LATER_FAILED_TEAM: 'Rejected a team that later failed.',
  REJECTED_SUCCESSFUL_TEAM: 'Rejected a team that succeeded.',
  ROLE_VISIBLE_EVIL_ON_TEAM: 'Action involved a team containing role-visible evil.',
  ROLE_VISION: 'Actor used private role vision.',
  SPEECH_IGNORED: 'Speech is UI-only and ignored as evidence.',
  SUCCESSFUL_MISSION: 'Mission succeeded; this is weak positive evidence only.',
  SUSPICIOUS_TEAM_ACTION: 'Acted on a team already carrying formal-action suspicion.',
  VOTE_BEHAVIOR: 'Player approved or rejected a proposed team.',
};

function createAgentMemory(playerIds: string[], selfId: string): AgentMemory {
  return {
    suspicion: Object.fromEntries(playerIds.filter((id) => id !== selfId).map((id) => [id, 0])),
    notes: ['Opening read: no public evidence yet.'],
    publicClaims: [],
    beliefAudit: [],
    beliefProfiles: Object.fromEntries(
      playerIds
        .filter((id) => id !== selfId)
        .map((id) => [id, createEmptyBeliefProfile(id, id)]),
    ),
  };
}

function createEmptyBeliefProfile(playerId: string, player: string): AiPlayerBeliefProfile {
  return {
    playerId,
    player,
    pEvil: 0.5,
    suspicionScore: 0,
    evidenceForEvil: [],
    evidenceAgainstEvil: [],
    uncertainty: [],
  };
}

function applyMissionResultBeliefUpdates(current: DemoState): DemoState {
  if (!current.lastMission) return current;
  const players: DemoPlayer[] = [];
  const aiHistory = [...current.aiHistory];

  current.players.forEach((player) => {
    if (player.controller !== 'ai') {
      players.push(player);
      return;
    }
    const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
    const update = updateAiBeliefAfterMissionResult(memory, current, player.id);
    players.push({ ...player, memory: update.memory });
    if (update.audit) {
      aiHistory.push(makeHistory(
        current,
        player,
        'result',
        `Belief update: ${formatBeliefDeltas(update.audit, current)}`,
        update.audit,
      ));
    }
  });

  return { ...current, players, aiHistory };
}

function applyFormalActionBeliefUpdates(current: DemoState, event: AiFormalActionBeliefEvent): DemoState {
  const players: DemoPlayer[] = [];
  const aiHistory = [...current.aiHistory];

  current.players.forEach((player) => {
    if (player.controller !== 'ai') {
      players.push(player);
      return;
    }
    const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
    const update = updateAiBeliefAfterFormalAction(memory, current, player.id, event);
    players.push({ ...player, memory: update.memory });
    if (update.audit) {
      aiHistory.push(makeHistory(
        current,
        player,
        event.type,
        `Belief update: ${formatBeliefDeltas(update.audit, current)}`,
        update.audit,
      ));
    }
  });

  return { ...current, players, aiHistory };
}

function makeDecisionAudit(current: DemoState, before: DemoPlayer, after: DemoPlayer, deduction: string): AiBeliefAudit {
  const beliefBefore = getPlayerBeliefSnapshot(current, before);
  const beliefAfter = getPlayerBeliefSnapshot(current, after);
  const beliefProfilesBefore = before.memory?.beliefProfiles;
  const beliefProfilesAfter = after.memory?.beliefProfiles;
  return {
    eventType: 'decision',
    roundIndex: current.roundIndex,
    evidenceMode: 'formal_actions_only',
    speechPolicy: 'ignored_by_design',
    informationUsed: [
      `Phase: ${current.phase}.`,
      `Quest: ${current.roundIndex + 1}.`,
      `Selected team: ${current.selectedTeamIds.length ? current.selectedTeamIds.map((id) => playerName(current, id)).join(', ') : 'none yet'}.`,
      `Role vision: ${formatDemoRoleVision(current, before)}.`,
      `Formal action history entries available: ${current.tableHistory.filter((entry) => entry.kind !== 'speech').length}.`,
    ],
    deductions: [deduction],
    beliefDeltas: computeBeliefDeltas(beliefBefore, beliefAfter),
    uncertainty: ['Decision audit v1 records the summary and belief state; it does not expose free-form chain-of-thought.', 'Public speech is ignored by design; only verified formal actions are evidence.'],
    beliefBefore,
    beliefAfter,
    beliefProfilesBefore,
    beliefProfilesAfter,
  };
}

function getPlayerBeliefSnapshot(current: DemoState, player: DemoPlayer): Record<string, number> {
  return Object.fromEntries(
    current.players
      .filter((candidate) => candidate.id !== player.id)
      .map((candidate) => [candidate.id, player.memory?.suspicion[candidate.id] ?? 0]),
  );
}

function computeBeliefDeltas(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(after)
      .map((id) => [id, after[id] - (before[id] ?? 0)] as const)
      .filter(([, delta]) => delta !== 0),
  );
}

function formatBeliefDeltas(audit: AiBeliefAudit, demo: DemoState): string {
  const entries = Object.entries(audit.beliefDeltas);
  if (!entries.length) return `Quest ${audit.roundIndex + 1}: no suspicion changes.`;
  return entries.map(([id, delta]) => `${playerName(demo, id)} ${delta >= 0 ? '+' : ''}${delta}`).join(', ');
}

function formatDemoRoleVision(current: DemoState, player: DemoPlayer): string {
  const visibility = getVisibilityInfo(
    { id: player.id, name: player.displayName, role: player.role },
    current.players.map(toDemoAvalonPlayer),
  );
  return visibility.sees.length
    ? visibility.sees.map((item) => `${item.name} (${item.hint})`).join(', ')
    : 'none';
}

function makeHistory(
  demo: DemoState,
  actor: DemoPlayer | undefined,
  kind: DemoHistoryEntry['kind'],
  text: string,
  audit?: AiBeliefAudit,
  data?: DemoHistoryEntry['data'],
): DemoHistoryEntry {
  return {
    id: `${Date.now()}-${demo.tableHistory.length}-${demo.aiHistory.length}-${actor?.id ?? 'table'}-${kind}`,
    roundIndex: demo.roundIndex,
    actorId: actor?.id,
    actorName: actor?.displayName,
    kind,
    text,
    audit,
    data,
  };
}

type DemoHistoryTone = 'speech' | 'action' | 'reasoning' | 'result';

function formatDemoHistoryEntry(entry: DemoHistoryEntry, language: Language): { label: string; text: string; tone: DemoHistoryTone; actorFallback: string } {
  const isZh = language === 'zh';
  const actorFallback = isZh ? '牌桌' : 'Table';
  const rawText = stripHistoryActorPrefix(entry.text, entry.actorName);

  if (entry.kind === 'speech') {
    return { label: isZh ? '发言' : 'Speech', text: rawText, tone: 'speech', actorFallback };
  }

  if (rawText.startsWith('Mission reasoning:')) {
    return {
      label: isZh ? '任务推理' : 'Mission reasoning',
      text: rawText.replace(/^Mission reasoning:\s*/, ''),
      tone: 'reasoning',
      actorFallback: isZh ? 'AI' : 'AI',
    };
  }

  if (rawText.startsWith('Assassin reasoning:') || rawText.startsWith('Assassin heuristic:') || rawText.startsWith('刺客推理：')) {
    return {
      label: isZh ? '刺客推理' : 'Assassin reasoning',
      text: rawText.replace(/^(Assassin reasoning:|Assassin heuristic:|刺客推理：)\s*/, ''),
      tone: 'reasoning',
      actorFallback: isZh ? 'AI' : 'AI',
    };
  }

  if (rawText.startsWith('Private reasoning:') || rawText.startsWith('私有推理：')) {
    return {
      label: isZh ? '私有推理' : 'Private reasoning',
      text: rawText.replace(/^(Private reasoning:|私有推理：)\s*/, ''),
      tone: 'reasoning',
      actorFallback: isZh ? 'AI' : 'AI',
    };
  }

  if (entry.kind === 'proposal') {
    const team = rawText.match(/^proposed (.+)\.$/i)?.[1] ?? rawText.match(/^.+? proposed (.+)\.$/i)?.[1];
    return {
      label: isZh ? '操作' : 'Action',
      text: team ? (isZh ? `提议任务队伍：${team.replace(/, /g, '、')}` : `Proposed quest team: ${team}.`) : rawText,
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'vote') {
    const vote = rawText.match(/^voted (approve|reject)\.$/i)?.[1] ?? rawText.match(/^.+? voted (approve|reject)\.$/i)?.[1];
    return {
      label: isZh ? '操作' : 'Action',
      text: vote ? (isZh ? `投票：${vote === 'approve' ? '赞成' : '反对'}` : `Voted ${vote}.`) : rawText,
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'mission' && /submitted a mission card\./i.test(rawText)) {
    return {
      label: isZh ? '操作' : 'Action',
      text: isZh ? '已提交任务票。' : 'Submitted a mission card.',
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'assassin') {
    const target = rawText.match(/^chose (.+) as Merlin\./i)?.[1] ?? rawText.match(/^.+? chose (.+) as Merlin\./i)?.[1];
    const hitMerlin = /Merlin was found/i.test(rawText);
    const merlinSurvived = /Merlin survived/i.test(rawText);
    return {
      label: isZh ? '操作' : 'Action',
      text: target && (hitMerlin || merlinSurvived)
        ? isZh
          ? `刺杀梅林：选择 ${target}。${hitMerlin ? '刺中梅林，坏人获胜。' : '梅林存活，好人获胜。'}`
          : `Chose ${target} as Merlin. ${hitMerlin ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`
        : rawText,
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'result') {
    const start = rawText.match(/^Demo roundtable started with (\d+) players and (\d+) AI fill-ins\.$/);
    return {
      label: isZh ? '进度' : 'Progress',
      text: start && isZh ? `演示圆桌开始：${start[1]} 名玩家，${start[2]} 个 AI 补位。` : rawText,
      tone: 'result',
      actorFallback,
    };
  }

  return { label: isZh ? '操作' : 'Action', text: rawText, tone: 'action', actorFallback };
}

function stripHistoryActorPrefix(text: string, actorName?: string): string {
  if (!actorName) return text;
  const prefix = `${actorName} `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function formatPrivateReasoningSummaryForHistory(summary: string): string {
  return `Private reasoning: ${summary}`;
}

function hasPendingAiAction(demo: DemoState): boolean {
  if (demo.mode !== 'ai') return false;
  if (demo.phase === 'proposal') return demo.players[demo.leaderIndex]?.controller === 'ai';
  if (demo.phase === 'vote') return demo.players.some((player) => player.controller === 'ai' && !player.teamVote);
  if (demo.phase === 'mission') return demo.players.some((player) => player.controller === 'ai' && demo.selectedTeamIds.includes(player.id) && !player.missionCard);
  if (demo.phase === 'assassin') return demo.players.some((player) => player.controller === 'ai' && player.role === 'Assassin');
  return false;
}

function runNextAiAction(current: DemoState, language: Language = 'en'): DemoState {
  if (current.mode !== 'ai' || current.phase === 'setup' || current.phase === 'result' || current.phase === 'finished' || getDemoWinner(current)) return current;
  if (current.phase === 'proposal') return runAiProposal(current, language);
  if (current.phase === 'vote') return runAiVote(current, language);
  if (current.phase === 'mission') return runAiMission(current, language);
  if (current.phase === 'assassin') return runAiAssassination(current, language);
  return current;
}

function applyAiDecision(current: DemoState, actorId: string, decision: AiAvalonDecision): DemoState {
  if (current.mode !== 'ai' || current.phase === 'setup' || current.phase === 'result' || current.phase === 'finished' || getDemoWinner(current)) return current;
  const actor = current.players.find((player) => player.id === actorId);
  if (!actor || actor.controller !== 'ai') return current;
  const publicSpeech = buildAiSpeech(current, actor, decision.publicSpeech);
  const rememberedActor = rememberAgentFromDecision(actor, current, decision, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, actor, rememberedActor, decision.privateReasoningSummary);

  if (current.phase === 'proposal' && current.players[current.leaderIndex]?.id === actor.id && decision.action.type === 'proposeTeam') {
    const teamSize = getTeamSize(current.playerCount, current.roundIndex);
    const teamIds = [...new Set(decision.action.teamIds)].filter((id) => current.players.some((player) => player.id === id)).slice(0, teamSize);
    if (teamIds.length !== teamSize) return runAiProposal(current);
    const players = current.players.map((player) => (player.id === actor.id ? rememberedActor : { ...player, teamVote: undefined, missionCard: undefined }));
    const proposedState = { ...current, phase: 'vote' as const, selectedTeamIds: teamIds, players, lastVote: undefined, lastMission: undefined };
    const withHistory = {
      ...proposedState,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, rememberedActor, 'speech', publicSpeech),
        makeHistory(current, rememberedActor, 'proposal', `${rememberedActor.displayName} proposed ${teamIds.map((id) => playerName(current, id)).join(', ')}.`, undefined, { teamIds }),
      ],
      aiHistory: [
        ...current.aiHistory,
        makeHistory(current, rememberedActor, 'proposal', formatPrivateReasoningSummaryForHistory(decision.privateReasoningSummary), decisionAudit, { action: decision.action }),
      ],
    };
    return applyFormalActionBeliefUpdates(withHistory, { type: 'proposal', roundIndex: current.roundIndex, leaderId: rememberedActor.id, teamIds });
  }

  if (current.phase === 'vote' && !actor.teamVote && decision.action.type === 'vote') {
    const vote = decision.action.vote;
    const playersWithVote = current.players.map((player) => (
      player.id === actor.id ? { ...rememberedActor, teamVote: vote } : player
    ));
    const resolved = resolveDemoVoteIfReady(current, playersWithVote);
    const withHistory = {
      ...current,
      players: resolved.players,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, actor, 'speech', publicSpeech),
        makeHistory(current, actor, 'vote', `${actor.displayName} voted ${vote}.`, undefined, { vote }),
      ],
      aiHistory: [
        ...current.aiHistory,
        makeHistory(current, rememberedActor, 'vote', formatPrivateReasoningSummaryForHistory(decision.privateReasoningSummary), decisionAudit, { action: decision.action }),
      ],
      ...resolved.statePatch,
    };
    if (!resolved.statePatch.lastVote) return withHistory;
    return applyFormalActionBeliefUpdates(withHistory, {
      type: 'vote',
      roundIndex: current.roundIndex,
      teamIds: [...current.selectedTeamIds],
      passed: resolved.statePatch.lastVote.passed,
      votes: playersWithVote
        .filter((player): player is DemoPlayer & { teamVote: Vote } => Boolean(player.teamVote))
        .map((player) => ({ playerId: player.id, vote: player.teamVote })),
    });
  }

  if (current.phase === 'mission' && current.selectedTeamIds.includes(actor.id) && !actor.missionCard && decision.action.type === 'missionCard') {
    const legalCard = decision.action.card === 'fail' && roleAllegiance(actor.role) !== 'evil' ? 'success' : decision.action.card;
    const playersWithCard = current.players.map((player) => (
      player.id === actor.id ? { ...rememberedActor, missionCard: legalCard } : player
    ));
    const next = resolveDemoMissionIfReady(current, playersWithCard);
    return applyMissionResultBeliefUpdates({
      ...next,
      tableHistory: [
        ...next.tableHistory,
        makeHistory(current, actor, 'speech', publicSpeech),
        makeHistory(current, actor, 'mission', `${actor.displayName} submitted a mission card.`, undefined, { missionCard: legalCard }),
      ],
      aiHistory: [
        ...next.aiHistory,
        makeHistory(current, actor, 'mission', formatMissionReasoningSummaryForHistory(decision.privateReasoningSummary), decisionAudit, { action: decision.action }),
      ],
    });
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
        makeHistory(current, rememberedActor, 'assassin', `${rememberedActor.displayName} chose ${target.displayName} as Merlin. ${target.role === 'Merlin' ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`, undefined, { targetPlayerId: target.id }),
      ],
      aiHistory: [
        ...current.aiHistory,
        makeHistory(current, rememberedActor, 'assassin', `Assassin reasoning: ${decision.privateReasoningSummary}`, decisionAudit, { action: decision.action }),
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

function runAiProposal(current: DemoState, language: Language = 'en'): DemoState {
  const leader = current.players[current.leaderIndex];
  if (!leader || leader.controller !== 'ai') return current;
  const teamSize = getTeamSize(current.playerCount, current.roundIndex);
  const teamIds = chooseAiTeam(current, leader, teamSize);
  const teamNames = teamIds.map((id) => playerName(current, id)).join(language === 'zh' ? '、' : ', ');
  const publicSpeech = buildAiSpeech(current, leader, localizeDemoText(language, `I want to test ${teamNames}. This team gives us information without overloading one suspicious seat.`, `我想先试 ${teamNames}。这队能给桌面信息，也不会把压力都压在一个可疑座位上。`));
  const reasoning = localizeDemoText(
    language,
    `As ${leader.role}, choose a team that includes self when useful, favours lower suspicion, and ${roleAllegiance(leader.role) === 'evil' ? 'keeps evil options live' : 'avoids suspicious seats'}.`,
    `作为 ${formatRole(leader.role, language)}，优先选择可控且怀疑度较低的队伍；${roleAllegiance(leader.role) === 'evil' ? '同时保留坏人行动空间。' : '尽量避开可疑座位。'}`,
  );
  const updatedLeader = rememberAgent(leader, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, leader, updatedLeader, reasoning);
  const players = current.players.map((player) => (player.id === leader.id ? updatedLeader : { ...player, teamVote: undefined, missionCard: undefined }));
  const proposedState = {
    ...current,
    phase: 'vote' as const,
    selectedTeamIds: teamIds,
    players,
    lastVote: undefined,
    lastMission: undefined,
  };
  const withHistory = {
    ...proposedState,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, updatedLeader, 'speech', publicSpeech),
      makeHistory(current, updatedLeader, 'proposal', `${updatedLeader.displayName} proposed ${teamIds.map((id) => playerName(current, id)).join(', ')}.`, undefined, { teamIds }),
    ],
    aiHistory: [
      ...current.aiHistory,
      makeHistory(current, updatedLeader, 'proposal', formatPrivateReasoningSummaryForHistory(reasoning), decisionAudit, { action: { type: 'proposeTeam', teamIds } }),
    ],
  };
  return applyFormalActionBeliefUpdates(withHistory, { type: 'proposal', roundIndex: current.roundIndex, leaderId: updatedLeader.id, teamIds });
}

function runAiVote(current: DemoState, language: Language = 'en'): DemoState {
  const voter = current.players.find((player) => player.controller === 'ai' && !player.teamVote);
  if (!voter) return current;
  const vote = chooseAiVote(current, voter);
  const selectedNames = current.selectedTeamIds.map((id) => playerName(current, id)).join(language === 'zh' ? '、' : ', ');
  const publicSpeech = buildAiSpeech(
    current,
    voter,
    vote === 'approve'
      ? localizeDemoText(language, `I can approve ${selectedNames}; the table composition is acceptable for this quest.`, `我可以赞成 ${selectedNames}；这个任务队伍目前可以接受。`)
      : localizeDemoText(language, `I reject ${selectedNames}; this team does not give me enough confidence.`, `我反对 ${selectedNames}；这队现在还不能让我放心。`),
  );
  const visibleEvil = visibleEvilPlayersOnCurrentDemoTeam(current, voter);
  const reasoning = visibleEvil.length
    ? localizeDemoText(
      language,
      `Vote ${vote}; role-visible info flags ${visibleEvil.map((player) => player.name).join(', ')} as evil on the current team, so avoid approving without exposing certainty.`,
      `投票${vote === 'approve' ? '赞成' : '反对'}；身份视野显示当前队伍里 ${visibleEvil.map((player) => player.name).join('、')} 是坏人，因此不能轻易赞成，也要避免公开暴露确定信息。`,
    )
    : localizeDemoText(language, `Vote ${vote}; team suspicion score ${scoreTeamSuspicion(current, voter, current.selectedTeamIds)}.`, `投票${vote === 'approve' ? '赞成' : '反对'}；当前队伍怀疑分为 ${scoreTeamSuspicion(current, voter, current.selectedTeamIds)}。`);
  const rememberedVoter = rememberAgent(voter, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, voter, rememberedVoter, reasoning);
  const playersWithVote = current.players.map((player) => (
    player.id === voter.id ? { ...rememberedVoter, teamVote: vote } : player
  ));
  const resolved = resolveDemoVoteIfReady(current, playersWithVote);
  const withHistory = {
    ...current,
    players: resolved.players,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, voter, 'speech', publicSpeech),
      makeHistory(current, voter, 'vote', `${voter.displayName} voted ${vote}.`, undefined, { vote }),
    ],
    aiHistory: [
      ...current.aiHistory,
      makeHistory(current, voter, 'vote', formatPrivateReasoningSummaryForHistory(reasoning), decisionAudit, { action: { type: 'vote', vote } }),
    ],
    ...resolved.statePatch,
  };
  if (!resolved.statePatch.lastVote) return withHistory;
  return applyFormalActionBeliefUpdates(withHistory, {
    type: 'vote',
    roundIndex: current.roundIndex,
    teamIds: [...current.selectedTeamIds],
    passed: resolved.statePatch.lastVote.passed,
    votes: playersWithVote
      .filter((player): player is DemoPlayer & { teamVote: Vote } => Boolean(player.teamVote))
      .map((player) => ({ playerId: player.id, vote: player.teamVote })),
  });
}

function runAiMission(current: DemoState, language: Language = 'en'): DemoState {
  const actor = current.players.find((player) => player.controller === 'ai' && current.selectedTeamIds.includes(player.id) && !player.missionCard);
  if (!actor) return current;
  const card: MissionCard = roleAllegiance(actor.role) === 'evil' ? chooseEvilMissionCard(current, actor) : 'success';
  const publicSpeech = buildAiSpeech(current, actor, localizeDemoText(language, 'Mission card submitted. We will learn from the result.', '任务票已提交。等结果出来再继续判断。'));
  const reasoning = roleAllegiance(actor.role) === 'evil'
    ? localizeDemoText(language, 'Mission choice weighs sabotage pressure against staying hidden; early stacked evil teams may hide to avoid linking allies.', '任务票选择要权衡破坏任务和隐藏身份；早期坏人扎堆时可以先藏，避免把队友连在一起。')
    : localizeDemoText(language, 'Good roles must submit success, so the mission choice is forced.', '好人必须提交成功票，所以任务票选择是固定的。');
  const rememberedActor = rememberAgent(actor, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, actor, rememberedActor, reasoning);
  const playersWithCard = current.players.map((player) => (
    player.id === actor.id ? { ...rememberedActor, missionCard: card } : player
  ));
  const next = resolveDemoMissionIfReady(current, playersWithCard);
  return applyMissionResultBeliefUpdates({
    ...next,
    tableHistory: [
      ...next.tableHistory,
      makeHistory(current, actor, 'speech', publicSpeech),
      makeHistory(current, actor, 'mission', `${actor.displayName} submitted a mission card.`, undefined, { missionCard: card }),
    ],
    aiHistory: [
      ...next.aiHistory,
      makeHistory(current, actor, 'mission', formatMissionReasoningSummaryForHistory(reasoning), decisionAudit, { action: { type: 'missionCard', card } }),
    ],
  });
}

function runAiAssassination(current: DemoState, language: Language = 'en'): DemoState {
  const assassin = current.players.find((player) => player.controller === 'ai' && player.role === 'Assassin');
  if (!assassin) return current;
  const target = chooseAiAssassinationTarget(current, assassin);
  const publicSpeech = buildAiSpeech(current, assassin, localizeDemoText(language, `I choose ${target.displayName} as Merlin.`, `我选择 ${target.displayName} 作为梅林目标。`));
  const reasoning = localizeDemoText(language, `Assassin heuristic: target the good player with the strongest Merlin signals from private suspicion memory and public quest history; selected ${target.displayName}.`, `刺客推理：根据私有怀疑记忆和公开任务历史，选择最像梅林的好人；目标是 ${target.displayName}。`);
  const rememberedAssassin = rememberAgent(assassin, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, assassin, rememberedAssassin, reasoning);
  const withMemory = { ...current, players: current.players.map((player) => (player.id === assassin.id ? rememberedAssassin : player)) };
  const resolved = resolveDemoAssassination(withMemory, target.id);
  return {
    ...resolved,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, rememberedAssassin, 'speech', publicSpeech),
      makeHistory(current, rememberedAssassin, 'assassin', `${rememberedAssassin.displayName} chose ${target.displayName} as Merlin. ${target.role === 'Merlin' ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`, undefined, { targetPlayerId: target.id }),
    ],
    aiHistory: [
      ...current.aiHistory,
      makeHistory(current, rememberedAssassin, 'assassin', reasoning, decisionAudit, { action: { type: 'assassinate', targetPlayerId: target.id } }),
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

function updateAgentMemory(player: DemoPlayer, current: DemoState, reasoning: string, _publicSpeech: string): AgentMemory {
  const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
  const suspicion = { ...memory.suspicion };
  current.selectedTeamIds.forEach((id) => {
    if (id !== player.id && roleAllegiance(player.role) === 'evil' && roleAllegiance(current.players.find((candidate) => candidate.id === id)?.role ?? 'Loyal Servant') === 'evil') {
      suspicion[id] = -35;
    }
  });
  return {
    suspicion,
    notes: [...memory.notes.slice(-3), reasoning],
    publicClaims: [...memory.publicClaims].slice(-3),
    beliefAudit: memory.beliefAudit?.slice(-8) ?? [],
    beliefProfiles: memory.beliefProfiles,
  };
}

function scoreTeamSuspicion(current: DemoState, voter: DemoPlayer, teamIds: string[]): number {
  return teamIds.reduce((score, id) => score + suspicionFor(voter, id), 0);
}

function suspicionFor(viewer: DemoPlayer, targetId: string): number {
  if (targetId === viewer.id) return roleAllegiance(viewer.role) === 'evil' ? -20 : -12;
  const target = viewer.memory?.beliefProfiles?.[targetId];
  if (target && roleAllegiance(viewer.role) !== 'evil') return Math.round(target.suspicionScore * 8);
  return viewer.memory?.suspicion[targetId] ?? 0;
}

function buildAiSpeech(_current: DemoState, player: DemoPlayer, fallback: string): string {
  if (player.role === 'Merlin' && fallback.includes('confidence')) return fallback.replace('confidence', 'behavioural confidence');
  if (player.persona?.includes('Aggressive')) return fallback.replace('I ', 'I strongly ');
  return fallback;
}

function localizeDemoText(language: Language, en: string, zh: string): string {
  return language === 'zh' ? zh : en;
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

function getAgentViewSummary(player: DemoPlayer, privateInfo: VisibilityInfo, t: (text: string) => string, language: ReturnType<typeof useI18n>['language']): React.ReactNode {
  if (player.controller !== 'ai') return <div className="agent-card human-card"><span>{t('Human seat')}</span><p>{t("You make this player's decisions.")}</p></div>;
  return (
    <div className="agent-card">
      <span>{t('AI Agent')} · {player.persona}</span>
      <div className="agent-visible-info">
        <strong>{t('Visible info')}:</strong>
        {privateInfo.sees.length ? (
          <ul>
            {privateInfo.sees.map((item) => (
              <li key={item.playerId}>{item.name}{language === 'zh' ? '：' : ': '}{formatHint(item.hint, language)}</li>
            ))}
          </ul>
        ) : (
          <p>{t('No private identity info.')}</p>
        )}
      </div>
      {player.lastPublicSpeech && <p><strong>{t('Public')}:</strong> "{player.lastPublicSpeech}"</p>}
      {player.lastReasoningSummary && <p><strong>{t('Reasoning summary')}:</strong> {player.lastReasoningSummary}</p>}
    </div>
  );
}

function formatDemoSeatMix(humanCount: number, aiCount: number, t: (text: string) => string, language: ReturnType<typeof useI18n>['language']): string {
  if (language === 'zh') {
    if (aiCount === 0) return `${humanCount} 个手动座位，无 AI 补位`;
    if (humanCount === 0) return `0 个手动座位，观战 ${aiCount} 个 AI 玩家`;
    return `${humanCount} 个手动座位 + ${aiCount} 个 AI 补位`;
  }
  if (aiCount === 0) return `${humanCount} ${t('manual seats')}, ${t('no AI fill-ins')}`;
  if (humanCount === 0) return `${t('Watch')} ${aiCount} ${t('AI players')}`;
  return `${humanCount} ${t('manual seats')} + ${aiCount} ${t('AI fill-ins')}`;
}

function createDemoState(
  playerCount: number,
  roleOptions: RolePresetOptions,
  options: { humanCount?: number } = {},
): DemoState {
  const sanitizedOptions = sanitizeRoleOptions(playerCount, roleOptions);
  const humanCount = Math.min(Math.max(options.humanCount ?? playerCount, 0), playerCount);
  const mode: DemoMode = humanCount === playerCount ? 'manual' : 'ai';
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
  return language === 'zh' ? `第${roundIndex + 1}轮` : `Q${roundIndex + 1}`;
}

function formatFailThresholdLabel(threshold: number, language: ReturnType<typeof useI18n>['language']): string {
  return language === 'zh' ? ` · ${threshold} 张失败票才失败` : ` / ${threshold} fails`;
}

function formatFailThresholdRule(threshold: number, language: ReturnType<typeof useI18n>['language']): string {
  return language === 'zh'
    ? `需要 ${threshold} 张失败票才失败`
    : `${threshold} Fail ${threshold === 1 ? 'card' : 'cards'} to fail`;
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
  return missionState?.phase === 'finished' ? t('Game result') : t('Game Progress');
}

function getRoomHeroCopy(snapshot: RoomSnapshot | undefined, t: (text: string) => string): string {
  if (!snapshot) return t('Create a room, let every player ready at the table, then reveal each secret role on their own phone.');
  const missionState = snapshot.room.settings.missionState;
  if (snapshot.room.status === 'lobby' || snapshot.room.status === 'setup') return t('Create a room, let every player ready at the table, then reveal each secret role on their own phone.');
  if (snapshot.room.status === 'reveal') return t('Check your private identity first; the shared board below keeps the table moving through teams, votes, quests, and results.');
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
  onDismiss,
}: {
  missionState: MissionState;
  currentPlayer: RoomPlayer;
  playerResult?: { allegiance: Allegiance; role: Role; won: boolean };
  readyCount: number;
  playerCount: number;
  alreadyReady: boolean;
  busy: boolean;
  onReadyForNextGame: () => void;
  onDismiss: () => void;
}) {
  const { t, language } = useI18n();
  const winner = missionState.winner;
  const won = playerResult?.won ?? Boolean(winner && currentPlayer.role && roleAllegiance(currentPlayer.role) === winner);
  return (
    <div
      className="result-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-result-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <section className={`result-modal ${won ? 'won' : 'lost'}`}>
        <button type="button" className="result-modal-close" onClick={onDismiss} aria-label={t('Close result summary')}>×</button>
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
        <div className="result-modal-actions">
          <button type="button" className="primary" disabled={busy || alreadyReady} onClick={onReadyForNextGame}>
            {alreadyReady ? t('Ready for next game') : t('Play Again')}
          </button>
          <button type="button" className="result-modal-secondary" onClick={onDismiss}>
            {t('View full results')}
          </button>
        </div>
      </section>
    </div>
  );
}

function RoomHistoryPanel({ snapshot, currentPlayerId }: { snapshot: RoomSnapshot; currentPlayerId?: string }) {
  const { t, language } = useI18n();
  const history = snapshot.room.settings.gameHistory ?? [];
  const isBetweenGames = snapshot.room.status === 'lobby'
    || snapshot.room.status === 'setup'
    || snapshot.room.status === 'finished'
    || snapshot.room.settings.missionState?.phase === 'finished';
  if (history.length === 0 || !isBetweenGames) return null;
  return (
    <section className="panel room-history-panel" aria-labelledby="room-history-title">
      <div className="panel-header">
        <h2 id="room-history-title">{t('Room history')}</h2>
        <span className="history-count">{history.length} {t('games')}</span>
      </div>
      <ol className="game-history-list">
        {history.map((entry) => {
          const playerResult = entry.playerResults.find((result) => result.playerId === currentPlayerId);
          const isAssassinationEnd = entry.endReason === 'assassination_hit' || entry.endReason === 'assassination_miss';
          return (
            <li key={entry.gameNumber} className={isAssassinationEnd ? 'assassination-endgame' : undefined}>
              <div className="game-history-title-row">
                <strong>{t('Game')} {entry.gameNumber}: {formatAllegiance(entry.winner, language)} {t('won')}</strong>
              </div>
              <p className={`game-history-end-reason ${isAssassinationEnd ? 'prominent' : ''}`}>
                <span>{isAssassinationEnd ? t('Assassination endgame') : t('End reason')}</span>
                {t(getEndReasonLabel(entry.endReason))}
              </p>
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

function GameStartOverlay() {
  const { t } = useI18n();
  return (
    <div className="game-start-backdrop" role="status" aria-live="polite">
      <div className="game-start-card">
        <span className="game-start-sigil" aria-hidden="true" />
        <p>{t('Everyone is ready')}</p>
        <h2>{t('The game begins')}</h2>
      </div>
    </div>
  );
}

function RoomView({
  snapshot,
  currentPlayer,
  privateInfo,
  startValidation,
  onReady,
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
  aiAutomation,
  showGameStartNotice,
  busy,
}: {
  snapshot: RoomSnapshot;
  currentPlayer?: RoomPlayer;
  privateInfo?: ReturnType<typeof getPrivateRoleInfo>;
  startValidation?: string;
  onReady: () => void;
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
  aiAutomation?: RoomAiAutomationState;
  showGameStartNotice: boolean;
  busy: boolean;
}) {
  const { t } = useI18n();
  const started = snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup';
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = started && snapshot.players.length >= 5 ? ensureMissionState(snapshot.room.settings.missionState, playerIds) : undefined;
  const currentTeamSize = missionState ? getTeamSize(snapshot.players.length, missionState.roundIndex) : 0;
  const [assassinationTargetId, setAssassinationTargetId] = useState('');
  const [resultModalDismissed, setResultModalDismissed] = useState(false);
  const readyCount = snapshot.players.filter((player) => player.isReady).length;
  const allPlayersReady = readyCount === snapshot.players.length;
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
  const visibleMissionTeamIds = missionState?.phase === 'proposal'
    && currentPlayer?.id === missionState.leaderPlayerId
    && liveSelectedTeamIds.length > 0
    ? liveSelectedTeamIds
    : missionState?.selectedTeamIds ?? [];

  useEffect(() => {
    setAssassinationTargetId('');
  }, [missionState?.phase, currentPlayer?.id]);

  useEffect(() => {
    if (missionState?.phase !== 'finished') setResultModalDismissed(false);
  }, [missionState?.phase]);

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
      {showGameStartNotice && <GameStartOverlay />}
      {missionState?.phase === 'finished' && currentPlayer && !resultModalDismissed && (
        <GameResultModal
          missionState={missionState}
          currentPlayer={currentPlayer}
          playerResult={currentPlayerResult}
          readyCount={nextGameReadyPlayerIds.length}
          playerCount={snapshot.players.length}
          alreadyReady={currentPlayerReadyForNextGame}
          busy={busy}
          onReadyForNextGame={onReadyForNextGame}
          onDismiss={() => setResultModalDismissed(true)}
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

      {isFinished && latestGame && (
        <FinalRevealPanel playerResults={latestGame.playerResults} currentPlayerId={currentPlayer?.id} />
      )}

      {started && missionState && (
        <>
          <TableMakeupSection players={snapshot.players} />
          <QuestTrackSection missionState={missionState} players={snapshot.players} visibleTeamIds={visibleMissionTeamIds} />
        </>
      )}

      <section className={`panel private-room-panel ${started ? 'started' : 'lobby'}`}>
        <div className="panel-header">
          <h2>{started ? t('Your Player Area') : t('Current Room')}</h2>
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
              <strong>{allPlayersReady ? t('All players are ready.') : t('Waiting for everyone to get ready')}</strong>
              <span>
                {allPlayersReady ? t('Starting the game now.') : startValidationCopy}
              </span>
            </div>
          </>
        )}

        {started && isFinished && currentPlayer && (
          <div className="finished-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || currentPlayerReadyForNextGame}
              onClick={onReadyForNextGame}
            >
              {currentPlayerReadyForNextGame ? t('Ready for next game') : t('Play Again')}
            </button>
            {currentPlayerReadyForNextGame && (
              <p className="hint">{t('Waiting for everyone to play again.')} {nextGameReadyPlayerIds.length}/{snapshot.players.length}</p>
            )}
          </div>
        )}

        {started && currentPlayer && privateInfo && (
          <>
            {missionState && !isFinished && (
              <CurrentExpeditionPanel
                missionState={missionState}
                players={snapshot.players}
                currentTeamSize={currentTeamSize}
                visibleTeamIds={visibleMissionTeamIds}
                aiAutomation={aiAutomation}
              />
            )}
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
          </>
        )}
      </section>

      <HostAuthorityPanel
        players={snapshot.players}
        currentPlayer={currentPlayer}
        started={started}
        isDemoMode={isDemoMode}
        busy={busy}
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
            <p className="hint">{t('The game starts automatically when everyone is ready.')}</p>
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
  isDemoMode,
  busy,
  onResetRoomToLobby,
  onDissolveRoom,
  onRemovePlayer,
  onTransferHost,
}: {
  players: RoomPlayer[];
  currentPlayer?: RoomPlayer;
  started: boolean;
  isDemoMode: boolean;
  busy: boolean;
  onResetRoomToLobby: () => void;
  onDissolveRoom: () => void;
  onRemovePlayer: (targetPlayerId: string) => void;
  onTransferHost: (targetPlayerId: string) => void;
}) {
  const { t } = useI18n();
  if (!currentPlayer?.isHost) return null;

  const manageablePlayers = players.filter((player) => !player.isHost && !player.isAi && !isDemoMode);

  const controls = (
    <>
      {started && (
        <div className="host-action-group host-start-action">
          <div>
            <h3>{t('Current game')}</h3>
            <p>{t('Use this only when this round should be cancelled for everyone.')}</p>
          </div>
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

      <div className="host-action-group danger-zone compact-danger-zone">
        <div>
          <h3>{t('Room controls')}</h3>
          <p>{t('Dissolve the room only when the table is done or created by mistake.')}</p>
        </div>
        <button type="button" className="small-danger dissolve-room" onClick={onDissolveRoom} disabled={busy}>{t('Dissolve Room')}</button>
      </div>
    </>
  );

  // In-game the host panel is rarely needed, so collapse it to keep the play
  // surface short. In the lobby it stays open — space is not tight there.
  if (started) {
    return (
      <details className="panel host-authority-panel host-authority-disclosure">
        <summary className="host-authority-heading">
          <h2 id="host-authority-title">{t('Host permissions')}</h2>
          <span className="disclosure-hint">{t('Tap to manage')}</span>
        </summary>
        {controls}
      </details>
    );
  }

  return (
    <section className="panel host-authority-panel" aria-labelledby="host-authority-title">
      <div className="host-authority-heading">
        <h2 id="host-authority-title">{t('Host permissions')}</h2>
      </div>
      {controls}
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

function sortRoomPlayersBySeat(players: RoomPlayer[]): RoomPlayer[] {
  return [...players].sort((left, right) => left.seatIndex - right.seatIndex);
}

function getPendingAiMissionActor(missionState: MissionState, players: RoomPlayer[]): RoomPlayer | undefined {
  const orderedPlayers = sortRoomPlayersBySeat(players);
  if (missionState.phase === 'proposal') {
    const leader = orderedPlayers.find((player) => player.id === missionState.leaderPlayerId);
    return leader?.isAi ? leader : undefined;
  }
  if (missionState.phase === 'vote') {
    return orderedPlayers.find((player) => player.isAi && !missionState.teamVotes?.[player.id]);
  }
  if (missionState.phase === 'mission') {
    const submittedPlayerIds = missionState.missionCardSubmissions?.submittedPlayerIds ?? [];
    return orderedPlayers.find((player) => player.isAi && missionState.selectedTeamIds.includes(player.id) && !submittedPlayerIds.includes(player.id));
  }
  if (missionState.phase === 'assassin') {
    return orderedPlayers.find((player) => player.isAi && player.role === 'Assassin');
  }
  return undefined;
}

function formatPendingAiMissionAction(missionState: MissionState, player: RoomPlayer, t: (text: string) => string): string {
  if (missionState.phase === 'proposal') return `${player.displayName} ${t('is choosing the crew.')}`;
  if (missionState.phase === 'vote') return `${player.displayName} ${t('is thinking about the vote.')}`;
  if (missionState.phase === 'mission') return `${player.displayName} ${t('is preparing a mission card.')}`;
  if (missionState.phase === 'assassin') return `${player.displayName} ${t('is choosing Merlin.')}`;
  return '';
}

function FinalRevealPanel({ playerResults, currentPlayerId }: { playerResults: RoomGamePlayerResult[]; currentPlayerId?: string }) {
  const { t, language } = useI18n();
  if (playerResults.length === 0) return null;
  return (
    <section className="mission-board-section final-reveal" aria-label={t('Final role reveal')}>
      <div className="mission-section-heading">
        <h3>{t('Who was who')}</h3>
        <span>{playerResults.length} {t('players')}</span>
      </div>
      <p className="final-reveal-caption">{t('Every player\'s secret role this game.')}</p>
      <ul className="final-reveal-list">
        {playerResults.map((result) => (
          <li key={result.playerId} className={`final-reveal-row ${result.allegiance} ${result.playerId === currentPlayerId ? 'me' : ''}`}>
            <div className="final-reveal-identity">
              <strong>{result.displayName}</strong>
              {result.playerId === currentPlayerId && <em className="final-reveal-you">{t('You')}</em>}
            </div>
            <div className="final-reveal-role">
              <span className={`role-chip ${result.allegiance}`}>{formatRole(result.role, language)}</span>
              <small>{formatAllegiance(result.allegiance, language)}</small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TableMakeupSection({ players }: { players: RoomPlayer[] }) {
  const { t, language } = useI18n();
  const roleSummary = summarizePublicRoleLineup(players);
  return (
    <section className="mission-board-section table-makeup started-table-makeup" aria-label={t('Game setup and table makeup')}>
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
  );
}

function QuestTrackSection({
  missionState,
  players,
  visibleTeamIds,
}: {
  missionState: MissionState;
  players: RoomPlayer[];
  visibleTeamIds: string[];
}) {
  const { t, language } = useI18n();
  const sectionRef = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return undefined;
    const stickyTop = parseFloat(window.getComputedStyle(node).top) || 0;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setStuck(node.getBoundingClientRect().top <= stickyTop + 0.5);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    measure();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section ref={sectionRef} className={`mission-board-section mission-progress-sticky ${stuck ? 'stuck' : ''}`} aria-label={t('Quest track')}>
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
  );
}

function CurrentExpeditionPanel({
  missionState,
  players,
  currentTeamSize,
  visibleTeamIds,
  aiAutomation,
}: {
  missionState: MissionState;
  players: RoomPlayer[];
  currentTeamSize: number;
  visibleTeamIds: string[];
  aiAutomation?: RoomAiAutomationState;
}) {
  const { t, language } = useI18n();
  const submittedVoteCount = Object.keys(missionState.teamVotes ?? {}).length;
  const submittedCardCount = missionState.missionCardSubmissions?.submittedPlayerIds.length ?? 0;
  const leaderName = players.find((player) => player.id === missionState.leaderPlayerId)?.displayName ?? t('Unknown captain');
  const visibleTeamNames = visibleTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id);
  const orderedPlayers = sortRoomPlayersBySeat(players);
  const votedPlayers = missionState.phase === 'vote' ? orderedPlayers.filter((player) => Boolean(missionState.teamVotes?.[player.id])) : [];
  const waitingVotePlayers = missionState.phase === 'vote' ? orderedPlayers.filter((player) => !missionState.teamVotes?.[player.id]) : [];
  const pendingAiActor = getPendingAiMissionActor(missionState, players);
  const pendingAiAction = pendingAiActor ? formatPendingAiMissionAction(missionState, pendingAiActor, t) : '';
  const phaseLabel = t(getMissionPhaseLabel(missionState));
  const currentFailThreshold = getMissionFailThreshold(players.length, missionState.roundIndex);
  const phaseCopy = getMissionPhaseCopy({
    missionState,
    currentTeamSize,
    submittedVoteCount,
    submittedCardCount,
    playerCount: players.length,
    t,
  });

  return (
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
          <small>{formatFailThresholdRule(currentFailThreshold, language)}</small>
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
      {missionState.phase === 'vote' && (
        <div className="vote-submission-card" aria-label={t('Team vote players')}>
          <div className="vote-submission-group">
            <div className="vote-submission-heading">
              <span>{t('Voted')}</span>
              <strong>{votedPlayers.length}</strong>
            </div>
            {votedPlayers.length > 0 ? (
              <div className="vote-player-chips">
                {votedPlayers.map((player) => (
                  <span key={player.id} className={player.isAi ? 'ai' : ''}>
                    {player.displayName}
                    {player.isAi && <em>{t('AI')}</em>}
                  </span>
                ))}
              </div>
            ) : (
              <p>{t('No one yet')}</p>
            )}
          </div>
          <div className="vote-submission-group waiting">
            <div className="vote-submission-heading">
              <span>{t('Waiting to vote')}</span>
              <strong>{waitingVotePlayers.length}</strong>
            </div>
            <div className="vote-player-chips">
              {waitingVotePlayers.map((player) => (
                <span key={player.id} className={player.isAi ? 'ai waiting-ai' : ''}>
                  {player.displayName}
                  {player.isAi && <em>{t('AI')}</em>}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      {pendingAiAction && (
        <div className="ai-action-status" aria-live="polite">
          <span aria-hidden="true" />
          <div>
            <strong>{t('AI in progress')}</strong>
            <p>{pendingAiAction}</p>
            {aiAutomation && (
              <small>
                {aiAutomation.waitingForRetry
                  ? `${t('AI action stalled. Retrying automatically.')} ${t('Attempt')} ${Math.max(1, aiAutomation.attempt + 1)}`
                  : aiAutomation.attempt > 1
                    ? `${t('Retrying AI action.')} ${t('Attempt')} ${aiAutomation.attempt}`
                    : t('Usually completes in a few seconds.')}
              </small>
            )}
          </div>
        </div>
      )}
      {missionState.phase === 'mission' && (
        <div className="progress-rune" aria-label={t('Mission card progress')}>
          <span style={{ width: `${Math.round((submittedCardCount / Math.max(1, missionState.selectedTeamIds.length)) * 100)}%` }} />
          <strong>{submittedCardCount}/{missionState.selectedTeamIds.length} {t('cards submitted')}</strong>
        </div>
      )}
      {missionState.teamVote && missionState.phase !== 'vote' && missionState.phase !== 'mission' && (
        <p className="hint">
          {t('Last proposal')}: {missionState.teamVote.approveCount} {t('approve')}, {missionState.teamVote.rejectCount} {t('reject')}.
          {' '}
          {t('Crew')} {t(missionState.teamVote.passed ? 'approved' : 'rejected')}.
        </p>
      )}
      {missionState.phase === 'finished' && missionState.assassination && (
        <p className="hint">
          {t('Assassin target')}: {players.find((player) => player.id === missionState.assassination?.targetPlayerId)?.displayName ?? t('Unknown')}.
          {' '}
          {missionState.assassination.hitMerlin ? t('Merlin was found.') : t('Merlin survived.')}
        </p>
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
  const { t } = useI18n();
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [approveCount, setApproveCount] = useState('');
  const [rejectCount, setRejectCount] = useState('');
  const [successCount, setSuccessCount] = useState('');
  const [failCount, setFailCount] = useState('');
  const [flowError, setFlowError] = useState('');
  const canEdit = Boolean(currentPlayer?.isHost && missionState && missionState.phase !== 'assassin' && missionState.phase !== 'finished');
  const playerIds = players.map((player) => player.id);

  useEffect(() => {
    setSelectedTeamIds(missionState?.selectedTeamIds ?? []);
    setApproveCount('');
    setRejectCount('');
    setSuccessCount('');
    setFailCount('');
  }, [missionState?.phase, missionState?.roundIndex, missionState?.selectedTeamIds.join('|')]);

  if (!missionState) return null;

  const selectedTeamNames = missionState.selectedTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id);
  const phaseLabel = t(getMissionPhaseLabel(missionState));

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

      {flowError && <p className="notice">{flowError}</p>}

      {canEdit ? (
        <details className="mission-admin">
          <summary>
            <span>
              <strong>{t('Recovery controls')}</strong>
              <small>{t('Only open this if a player phone cannot submit a required action.')}</small>
            </span>
            <em>{t('Host-only fallback')}</em>
          </summary>
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
        </details>
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
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
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

function getRoomAiAutomationActionKey(snapshot: RoomSnapshot, action: RoomAiAction): string {
  const missionState = snapshot.room.settings.missionState;
  return [
    snapshot.room.id,
    missionState?.phase ?? 'none',
    missionState?.roundIndex ?? 'none',
    missionState?.proposalIndex ?? 'none',
    missionState?.selectedTeamIds.join('|') ?? 'none',
    Object.entries(missionState?.teamVotes ?? {}).map(([playerId, vote]) => `${playerId}:${vote}`).sort().join('|'),
    missionState?.missionCardSubmissions?.submittedPlayerIds.join('|') ?? '',
    getRoomAiActionKey(action),
  ].join(':');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

const root = createRoot(document.getElementById('root')!);

if (import.meta.env.DEV && window.location.pathname === '/dev/multiplayer') {
  void import('./dev/DevMultiplayerSimulator').then(({ DevMultiplayerSimulator }) => {
    root.render(<I18nProvider><DevMultiplayerSimulator /></I18nProvider>);
  });
} else {
  root.render(<I18nProvider><App /></I18nProvider>);
}
