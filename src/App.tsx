import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getRecommendedRolePresetOptions,
  playerCountRange,
  type MissionCard,
  type RolePresetOptions,
  type Vote,
} from './domain/avalon';
import {
  ensureMissionState,
  resolveAssassination,
  submitLadyOfTheLake as submitLadyOfTheLakeToState,
  submitMissionCard as submitMissionCardToState,
  submitTeamProposal,
  submitTeamVote as submitTeamVoteToState,
  type MissionState,
} from './domain/missionFlow';
import { getNextRoomAiAction, getRoomAiActionKey, type RoomAiAction } from './services/roomAi';
import { buildStepUrl, parseEntryStep, parseJoinCodeFromUrl, type EntryScreen } from './navigationState';
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
  releaseSeat,
  removePlayer,
  resolveCreateRoomSeats,
  setReady,
  swapSeats,
  swapSeatsInSnapshot,
  submitAssassination,
  submitLadyOfTheLake,
  submitMissionCard,
  submitTeamVote,
  subscribeToRoom,
  updateNickname,
  updateMissionState,
  isHostedConfigured,
  isRoomStaleForExit,
  type RoomSnapshot,
} from './services/roomService';
import { getSessionStorageKeys, isDevSessionActive } from './sessionKeys';
import { attemptRestore, isStaleSnapshot } from './roomSession';
import { fillText, useI18n } from './i18n';
import { CreateRoomRoleConfig, sanitizeRoleOptions } from './components/CreateRoomRoleConfig';
import { HomeSeoIntro } from './components/HomeSeoIntro';
import { getRoomHeroCopy, getRoomHeroTitle, toRoomAvalonPlayer } from './components/gameText';
import { DemoSimulator } from './demo/DemoSimulator';
import { RoomView } from './room/RoomView';
import { type RoomAiAutomationState } from './room/roomText';

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
  submitLadyOfTheLake: 1200,
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

// What home knows about this device's saved seat: nothing to offer, a
// seat the server could not be reached to confirm, or a confirmed seat.
type SavedSeatState =
  | { kind: 'none' }
  | { kind: 'unreachable' }
  | { kind: 'found'; snapshot: RoomSnapshot; playerId: string };

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

export function App() {
  const { t } = useI18n();
  const [screen, setScreen] = useState<Screen>(() => parseEntryStep(window.location.href));
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [currentPlayerId, setCurrentPlayerId] = useState(localStorage.getItem(getSessionStorageKeys().currentPlayerId) ?? '');
  const [deviceToken] = useState(() => getOrCreateDeviceToken());
  const [hostName, setHostName] = useState('');
  const [hostNameTouched, setHostNameTouched] = useState(false);
  const [aiFillEnabled, setAiFillEnabled] = useState(false);
  const [ladyOfTheLake, setLadyOfTheLake] = useState(false);
  const [humanPlayerCount, setHumanPlayerCount] = useState(4);
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
  const [savedSeat, setSavedSeat] = useState<SavedSeatState>({ kind: 'none' });
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  const currentPlayer = snapshot?.players.find((player) => player.id === currentPlayerId);
  const isHostNameMissing = !hostName.trim();
  const showHostNameError = hostNameTouched && isHostNameMissing;
  const isDemoMode = Boolean(snapshot?.room.settings.createdInDemoMode);
  const startValidation = snapshot ? getStartValidation(snapshot.players, snapshot.room.settings) : undefined;
  const privateInfo = useMemo(
    () => (currentPlayer && snapshot ? getPrivateRoleInfo(currentPlayer, snapshot.players) : undefined),
    [currentPlayer, snapshot],
  );

  useEffect(() => {
    const entryScreen = parseEntryStep(window.location.href);
    const invitedCode = parseJoinCodeFromUrl(window.location.href);
    // Home restores the previous room; an invitation link restores the seat
    // only when it points at the room this device is already sitting in.
    if (entryScreen !== 'home' && !(entryScreen === 'join' && invitedCode)) return;

    const sessionKeys = getSessionStorageKeys();
    const storedRoomId = localStorage.getItem(sessionKeys.currentRoomId);
    const storedPlayerId = localStorage.getItem(sessionKeys.currentPlayerId);
    if (!storedRoomId || !storedPlayerId) {
      setSavedSeat({ kind: 'none' });
      return;
    }

    let cancelled = false;
    void attemptRestore(() => getRoomById(storedRoomId), storedPlayerId).then(({ decision, snapshot: restoredSnapshot }) => {
      if (cancelled) return;
      if (decision.action === 'retry') {
        // The saved seat stays put: the server never said it was gone.
        setSavedSeat({ kind: 'unreachable' });
        return;
      }
      setSavedSeat({ kind: 'none' });
      if (decision.action === 'clear') {
        clearSessionBinding();
        setCurrentPlayerId('');
        setSnapshot(undefined);
        if (entryScreen === 'home') {
          setScreen('home');
          setMessage(decision.reason === 'roomGone' ? t('Room expired or was closed.') : t('You were removed from the room.'));
        }
        return;
      }
      if (!restoredSnapshot) return;
      if (entryScreen === 'join') {
        // A different room's invitation leaves this device's seat alone until
        // the player actually joins the new room.
        if (restoredSnapshot.room.code !== invitedCode) return;
        setCurrentPlayerId(storedPlayerId);
        setSnapshot(restoredSnapshot);
        clearEntryStepFromUrl();
        setScreen('room');
        setMessage(t('Welcome back to your seat.'));
        return;
      }
      setSavedSeat({ kind: 'found', snapshot: restoredSnapshot, playerId: storedPlayerId });
    });
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  // Once any room is on screen, an earlier failed lookup no longer describes
  // this device's seat.
  useEffect(() => {
    if (snapshot) setSavedSeat((current) => (current.kind === 'unreachable' ? { kind: 'none' } : current));
  }, [snapshot?.room.id]);

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
      setSnapshot((current) => (isStaleSnapshot(current, nextSnapshot) ? current : nextSnapshot));
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
        const errorMessage = error instanceof Error ? t(error.message) : t('Could not run AI action.');
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
            if (refreshedSnapshot) setSnapshot((current) => (isStaleSnapshot(current, refreshedSnapshot) ? current : refreshedSnapshot));
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
      setHostNameTouched(true);
      hostNameInputRef.current?.focus();
      setMessage('');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await createRoom({
        displayName: hostName,
        ...resolveCreateRoomSeats({ playerCount: plannedPlayerCount, aiFillEnabled, humanPlayerCount }),
        roleOptions: hostRoleOptions,
        ladyOfTheLake,
        deviceToken,
      });
      saveSessionBinding(result.snapshot.room.id, result.currentPlayerId);
      setCurrentPlayerId(result.currentPlayerId);
      setSnapshot(result.snapshot);
      clearEntryStepFromUrl();
      setScreen('room');
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not create room.'));
    } finally {
      setBusy(false);
    }
  }

  function handlePlannedPlayerCount(nextPlayerCount: (typeof playerCountRange)[number]) {
    setPlannedPlayerCount(nextPlayerCount);
    setHostRoleOptions(getRecommendedRolePresetOptions(nextPlayerCount));
    setHumanPlayerCount((current) => Math.min(current, nextPlayerCount - 1));
  }

  function handleAiFillToggle(enabled: boolean) {
    setAiFillEnabled(enabled);
    if (enabled) setHumanPlayerCount(plannedPlayerCount - 1);
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not join room.'));
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not update ready state.'));
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not update nickname.'));
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not update mission flow.'));
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
        setMessage(error instanceof Error ? t(error.message) : t('Could not propose team.'));
      }
      return;
    }
    try {
      setSnapshot(await proposeMissionTeam(snapshot.room.id, currentPlayer.id, selectedTeamIds));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not propose team.'));
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
        setMessage(error instanceof Error ? t(error.message) : t('Could not submit vote.'));
      }
      return;
    }
    try {
      setSnapshot(await submitTeamVote(snapshot.room.id, currentPlayer.id, vote));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not submit vote.'));
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
        setMessage(error instanceof Error ? t(error.message) : t('Could not submit mission card.'));
      }
      return;
    }
    try {
      setSnapshot(await submitMissionCard(snapshot.room.id, currentPlayer.id, card));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not submit mission card.'));
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
        setMessage(error instanceof Error ? t(error.message) : t('Could not submit assassination.'));
      }
      return;
    }
    try {
      setSnapshot(await submitAssassination(snapshot.room.id, currentPlayer.id, targetPlayerId));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not submit assassination.'));
    }
  }

  async function handleLadyOfTheLake(targetPlayerId: string) {
    if (!snapshot || !currentPlayer) return;
    setMessage('');
    if (isDemoMode) {
      try {
        const playerIds = snapshot.players.map((player) => player.id);
        const currentMissionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
        await handleMissionStateChange(submitLadyOfTheLakeToState(currentMissionState, playerIds, currentPlayer.id, targetPlayerId));
      } catch (error) {
        setMessage(error instanceof Error ? t(error.message) : t('Could not use the Lady of the Lake.'));
      }
      return;
    }
    try {
      setSnapshot(await submitLadyOfTheLake(snapshot.room.id, currentPlayer.id, targetPlayerId));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not use the Lady of the Lake.'));
    }
  }

  async function handleReadyForNextGame() {
    if (!snapshot || !currentPlayer || busy) return;
    if (isDemoMode) {
      try {
        setSnapshot(readyForNextGameInSnapshot(cloneRoomSnapshot(snapshot), currentPlayer.id));
      } catch (error) {
        setMessage(error instanceof Error ? t(error.message) : t('Could not ready for next game.'));
      }
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      setSnapshot(await readyForNextGame(snapshot.room.id, currentPlayer.id));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not ready for next game.'));
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not remove player.'));
    }
  }

  async function handleReleaseSeat(targetPlayerId: string) {
    if (!snapshot || !currentPlayer?.isHost || busy) return;
    const target = snapshot.players.find((player) => player.id === targetPlayerId);
    if (!target) return;
    const values = { name: target.displayName, code: snapshot.room.code };
    if (!window.confirm(fillText(t("Release {name}'s seat? They can then rejoin from a new phone or browser with the same nickname."), values))) return;
    setBusy(true);
    setMessage('');
    try {
      setSnapshot(await releaseSeat(snapshot.room.id, currentPlayer.id, targetPlayerId));
      setMessage(fillText(t('Seat released. Ask {name} to join room {code} again with the same nickname.'), values));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not release seat.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSwapSeats(firstPlayerId: string, secondPlayerId: string) {
    if (!snapshot || !currentPlayer?.isHost || busy) return;
    setMessage('');
    if (isDemoMode) {
      try {
        setSnapshot(swapSeatsInSnapshot(cloneRoomSnapshot(snapshot), currentPlayer.id, firstPlayerId, secondPlayerId));
      } catch (error) {
        setMessage(error instanceof Error ? t(error.message) : t('Could not swap seats.'));
      }
      return;
    }
    setBusy(true);
    try {
      setSnapshot(await swapSeats(snapshot.room.id, currentPlayer.id, firstPlayerId, secondPlayerId));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not swap seats.'));
    } finally {
      setBusy(false);
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not transfer host.'));
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not reset game.'));
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not dissolve room.'));
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
      setMessage(error instanceof Error ? t(error.message) : t('Could not leave room.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleLeaveRestorableRoom() {
    if (savedSeat.kind !== 'found' || busy) return;
    if (!window.confirm(getOldRoomLeaveConfirmation(savedSeat.snapshot))) return;
    setBusy(true);
    setMessage('');
    try {
      await leaveRoom(savedSeat.snapshot.room.id, savedSeat.playerId);
      clearSessionBinding();
      setSavedSeat({ kind: 'none' });
      setCurrentPlayerId('');
      setSnapshot(undefined);
      setScreen('home');
      setMessage(t('Old room cleared.'));
    } catch (error) {
      setMessage(error instanceof Error ? t(error.message) : t('Could not leave room.'));
    } finally {
      setBusy(false);
    }
  }

  function handleRestoreRoom() {
    if (savedSeat.kind !== 'found') return;
    setCurrentPlayerId(savedSeat.playerId);
    setSnapshot(savedSeat.snapshot);
    setSavedSeat({ kind: 'none' });
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
        <p className="lede">{screen === 'room' ? getRoomHeroCopy(snapshot, t) : t('For in-person game nights: scan to join, and roles, votes, and scoring are handled for you.')}</p>
      </header>

      {message && <p className="notice">{message}</p>}

      {screen === 'home' && savedSeat.kind === 'unreachable' && (
        <section className="panel restore-panel">
          <p className="eyebrow">{t('Saved seat')}</p>
          <h2>{t('Could not reach the table right now.')}</h2>
          <p>{t('Your seat is still saved on this device. Check the network and try again.')}</p>
          <div className="share-actions">
            <button type="button" className="primary" onClick={() => setRestoreAttempt((current) => current + 1)} disabled={busy}>{t('Try Again')}</button>
          </div>
        </section>
      )}

      {screen === 'home' && savedSeat.kind === 'found' && (
        <section className="panel restore-panel">
          <p className="eyebrow">{t('Previous room found')}</p>
          <h2>{t('You were previously at room')} {savedSeat.snapshot.room.code}</h2>
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
            <div className="home-entry-copy">
              <p className="eyebrow">{t('Start here')}</p>
              <h2 id="choose-path-title">{t('Host a table or join one')}</h2>
            </div>
            {/* Hosting and joining are separate jobs with equal weight; players who
                scan or tap an invite land on the join screen and skip this. */}
            <div className="home-entry-choices">
              <button type="button" className="entry-choice entry-choice-create create-room-action" onClick={() => navigateEntry('create')}>
                <svg className="entry-choice-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 17h16l1-10-5 4-4-6-4 6-5-4 1 10Z" />
                  <path d="M4 20h16" />
                </svg>
                <span className="entry-choice-text">
                  <strong>{t('Host the round')}</strong>
                  <small>{t("I'm the host. Get a room code for the table.")}</small>
                </span>
              </button>
              <button type="button" className="entry-choice entry-choice-join join-room-action" onClick={() => navigateEntry('join')}>
                <svg className="entry-choice-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
                  <path d="M10 8l4 4-4 4" />
                  <path d="M14 12H4" />
                </svg>
                <span className="entry-choice-text">
                  <strong>{t('Join a room')}</strong>
                  <small>{t('I have a 5-digit room code.')}</small>
                </span>
              </button>
            </div>
          </section>
          <section className="learn-more" aria-labelledby="learn-more-title">
            <p className="eyebrow">{t('About Veiled Roundtable')}</p>
            <h2 id="learn-more-title">{t('In-person Avalon: hidden roles and phone-based flow')}</h2>
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
                <p><strong>{t('Host')}</strong> {t('opens a real table room.')} <strong>{t('Join')}</strong> {t('is for players with a 5-digit code.')}</p>
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
          <form className="stack" onSubmit={handleCreateRoom} noValidate>
            <label className={`field-label ${showHostNameError ? 'field-label-error' : ''}`}>
              <span>{t('Your nickname')}</span>
              <input
                ref={hostNameInputRef}
                value={hostName}
                onChange={(event) => setHostName(event.target.value)}
                maxLength={24}
                autoFocus
                required
                aria-invalid={showHostNameError}
                aria-describedby={showHostNameError ? 'host-name-error' : undefined}
              />
              {/* Shown only after a submit, so it never pushes the form down while
                  the player is tapping another control. */}
              {showHostNameError && <small id="host-name-error" className="field-error">{t('Enter a nickname before creating the room.')}</small>}
            </label>
            <CreateRoomRoleConfig
              aiFillEnabled={aiFillEnabled}
              humanPlayerCount={humanPlayerCount}
              playerCount={plannedPlayerCount}
              onAiFillEnabledChange={handleAiFillToggle}
              onHumanPlayerCountChange={setHumanPlayerCount}
              roleOptions={hostRoleOptions}
              ladyOfTheLake={ladyOfTheLake}
              onLadyOfTheLakeChange={setLadyOfTheLake}
              onPlayerCountChange={handlePlannedPlayerCount}
              onToggleRole={handleHostRoleToggle}
            />
            <button type="submit" className="primary" disabled={busy}>
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
          onReleaseSeat={handleReleaseSeat}
          onTransferHost={handleTransferHost}
          onSwapSeats={handleSwapSeats}
          onResetRoomToLobby={handleResetRoomToLobby}
          onDissolveRoom={handleDissolveRoom}
          onLeave={handleLeaveRoom}
          onMissionStateChange={handleMissionStateChange}
          onProposeMissionTeam={handleProposeMissionTeam}
          onSubmitTeamVote={handleSubmitTeamVote}
          onSubmitMissionCard={handleSubmitMissionCard}
          onAssassination={handleAssassination}
          onLadyOfTheLake={handleLadyOfTheLake}
          onReadyForNextGame={handleReadyForNextGame}
          isDemoMode={isDemoMode}
          aiAutomation={aiAutomation}
          showGameStartNotice={showGameStartNotice}
          busy={busy}
        />
      )}

      <footer className="runtime-footer">
        {screen === 'home' && (
          <button type="button" className="footer-link" onClick={() => navigateEntry('demo')}>
            {t('Multi-phone simulator (experimental)')}
          </button>
        )}
        {import.meta.env.DEV && (
          <span>{isHostedConfigured && !isDevSessionActive() ? t('Neon API mode') : t('Local browser demo mode')}</span>
        )}
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
    if (nextScreen === 'create') setHostNameTouched(false);
  }
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
  if (action.type === 'submitLadyOfTheLake') return submitLadyOfTheLake(roomId, action.holderPlayerId, action.targetPlayerId);
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
