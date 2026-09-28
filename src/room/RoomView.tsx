import React, { useEffect, useRef, useState } from 'react';
import { getTeamSize, roleAllegiance, type MissionCard, type Vote } from '../domain/avalon';
import { ensureMissionState, type MissionState } from '../domain/missionFlow';
import { buildJoinUrl } from '../navigationState';
import { canArrangeSeats, getPlannedPlayerCount, getPrivateRoleInfo, isTableFull, type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { useI18n } from '../i18n';
import { getLadyOfTheLakeResults } from '../components/PlayerPhone';
import { getRoomHeroTitle } from '../components/gameText';
import { GameResultOverlay, GameStartOverlay, RoomHistoryPanel } from './GameEndPanels';
import { IdentityCard } from './IdentityCard';
import { GameActionCard, LobbyActionCard } from './RoomActionCard';
import { RoomMoreSheet } from './RoomMoreSheet';
import { RoomTopBar } from './RoomTopBar';
import { GameTableCard, LobbyTableCard } from './RoundTableCard';
import { type RoomAiAutomationState } from './roomText';

const RESULT_OVERLAY_MS = 2400;

// Every phase uses the same skeleton, top to bottom: status bar, the action
// card (what this player does now), the round table, and their own identity.
// Everything rarely needed opens from the top bar's "More" as a sheet.
export function RoomView({
  snapshot,
  currentPlayer,
  privateInfo,
  onReady,
  onRename,
  onRemovePlayer,
  onReleaseSeat,
  onTransferHost,
  onSwapSeats,
  onResetRoomToLobby,
  onDissolveRoom,
  onLeave,
  onMissionStateChange,
  onProposeMissionTeam,
  onSubmitTeamVote,
  onSubmitMissionCard,
  onAssassination,
  onLadyOfTheLake,
  onReadyForNextGame,
  isDemoMode,
  aiAutomation,
  showGameStartNotice,
  busy,
}: {
  snapshot: RoomSnapshot;
  currentPlayer?: RoomPlayer;
  privateInfo?: ReturnType<typeof getPrivateRoleInfo>;
  onReady: () => void;
  onRename: (event: React.FormEvent<HTMLFormElement>) => void;
  onRemovePlayer: (targetPlayerId: string) => void;
  onReleaseSeat: (targetPlayerId: string) => void;
  onTransferHost: (targetPlayerId: string) => void;
  onSwapSeats: (firstPlayerId: string, secondPlayerId: string) => void;
  onResetRoomToLobby: () => void;
  onDissolveRoom: () => void;
  onLeave: () => void;
  onMissionStateChange: (missionState: MissionState) => void;
  onProposeMissionTeam: (selectedTeamIds: string[]) => void;
  onSubmitTeamVote: (vote: Vote) => void;
  onSubmitMissionCard: (card: MissionCard) => void;
  onAssassination: (targetPlayerId: string) => void;
  onLadyOfTheLake: (targetPlayerId: string) => void;
  onReadyForNextGame: () => void;
  isDemoMode: boolean;
  aiAutomation?: RoomAiAutomationState;
  showGameStartNotice: boolean;
  busy: boolean;
}) {
  const { t, language } = useI18n();
  const started = snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup';
  const playerIds = snapshot.players.map((player) => player.id);
  const storedMissionState = snapshot.room.settings.missionState;
  // A finished game keeps its record on screen even after someone leaves the room.
  const missionState = started && (storedMissionState || snapshot.players.length >= 5) ? ensureMissionState(storedMissionState, playerIds) : undefined;
  const isFinished = snapshot.room.status === 'finished' || missionState?.phase === 'finished';
  const joinLink = `${window.location.origin}${buildJoinUrl(snapshot.room.code, language)}`;
  const latestGame = snapshot.room.settings.gameHistory?.at(-1);
  // Quest sizes follow the table the game was played at, not who is still here.
  const gamePlayerCount = isFinished && latestGame ? latestGame.playerResults.length : snapshot.players.length;
  const currentTeamSize = missionState && gamePlayerCount >= 5 ? getTeamSize(gamePlayerCount, missionState.roundIndex) : 0;
  const nextGameReadyPlayerIds = snapshot.room.settings.nextGameReadyPlayerIds ?? [];
  const canEditSeats = Boolean(currentPlayer?.isHost) && canArrangeSeats(snapshot);
  // The host checks the seats inside the action card once the table is full.
  const lobbyTableInCard = !started && Boolean(currentPlayer?.isHost) && isTableFull(snapshot);
  const inviteInCard = !started && Boolean(currentPlayer?.isHost) && !isTableFull(snapshot);
  const [draftTeamIds, setDraftTeamIds] = useState<string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [showResultOverlay, setShowResultOverlay] = useState(false);
  const previousPhaseRef = useRef(missionState?.phase);
  const isLeaderDrafting = missionState?.phase === 'proposal' && currentPlayer?.id === missionState.leaderPlayerId;
  const visibleTeamIds = isLeaderDrafting ? draftTeamIds : missionState?.selectedTeamIds ?? [];

  useEffect(() => {
    if (missionState?.phase !== 'proposal') setDraftTeamIds([]);
  }, [missionState?.phase, missionState?.roundIndex, missionState?.proposalIndex]);

  // A game that ends while the page is open gets a short result beat; a page
  // opened on a finished game just shows the result card.
  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = missionState?.phase;
    if (missionState?.phase !== 'finished') {
      setShowResultOverlay(false);
      return undefined;
    }
    if (!previousPhase || previousPhase === 'finished') return undefined;
    setShowResultOverlay(true);
    const timer = window.setTimeout(() => setShowResultOverlay(false), RESULT_OVERLAY_MS);
    return () => window.clearTimeout(timer);
  }, [missionState?.phase]);

  function toggleDraftPlayer(playerId: string) {
    setDraftTeamIds((current) => (current.includes(playerId) ? current.filter((id) => id !== playerId) : [...current, playerId]));
  }

  const won = Boolean(missionState?.winner && currentPlayer?.role && roleAllegiance(currentPlayer.role) === missionState.winner);
  // After a game, who was who is shown on the seats rather than as a list.
  const revealedRoles = isFinished && latestGame
    ? Object.fromEntries(latestGame.playerResults.map((result) => [result.playerId, { role: result.role, allegiance: result.allegiance }]))
    : undefined;
  const assassinationTargetId = missionState?.assassination?.targetPlayerId;
  const seatTags = isFinished && assassinationTargetId ? { [assassinationTargetId]: t('Assassinated') } : undefined;
  const departedResults = isFinished && latestGame
    ? latestGame.playerResults.filter((result) => !snapshot.players.some((player) => player.id === result.playerId))
    : [];

  return (
    <section className={`room-grid ${started ? 'started-room-grid' : 'lobby-room-grid'}`}>
      <h1 className="visually-hidden">{getRoomHeroTitle(snapshot, t)}</h1>
      {showGameStartNotice && <GameStartOverlay />}
      {showResultOverlay && missionState?.winner && currentPlayer && (
        <GameResultOverlay won={won} winner={missionState.winner} onDismiss={() => setShowResultOverlay(false)} />
      )}

      <RoomTopBar
        snapshot={snapshot}
        missionState={missionState}
        playerCount={gamePlayerCount}
        moreOpen={moreOpen}
        moreButtonRef={moreButtonRef}
        onOpenMore={() => setMoreOpen(true)}
      />

      {currentPlayer && !started && (
        <LobbyActionCard
          snapshot={snapshot}
          currentPlayer={currentPlayer}
          isDemoMode={isDemoMode}
          joinLink={joinLink}
          canEditSeats={canEditSeats}
          busy={busy}
          onReady={onReady}
          onRename={onRename}
          onSwapSeats={onSwapSeats}
        />
      )}
      {currentPlayer && missionState && (
        <GameActionCard
          snapshot={snapshot}
          missionState={missionState}
          currentPlayer={currentPlayer}
          gamePlayerCount={gamePlayerCount}
          busy={busy}
          aiAutomation={aiAutomation}
          draftTeamIds={draftTeamIds}
          nextGameReadyPlayerIds={nextGameReadyPlayerIds}
          onToggleDraftPlayer={toggleDraftPlayer}
          onProposeTeam={() => onProposeMissionTeam(draftTeamIds)}
          onVote={onSubmitTeamVote}
          onPlayMissionCard={onSubmitMissionCard}
          onLadyOfTheLake={onLadyOfTheLake}
          onAssassinate={onAssassination}
          onReadyForNextGame={onReadyForNextGame}
        />
      )}

      {!started && !lobbyTableInCard && (
        <LobbyTableCard
          players={snapshot.players}
          totalSeats={getPlannedPlayerCount(snapshot.room.settings)}
          currentPlayerId={currentPlayer?.id}
          editable={canEditSeats}
          busy={busy}
          onSwap={onSwapSeats}
        />
      )}

      {missionState && (
        <GameTableCard
          missionState={missionState}
          players={snapshot.players}
          currentPlayerId={currentPlayer?.id}
          visibleTeamIds={visibleTeamIds}
          nextGameReadyPlayerIds={nextGameReadyPlayerIds}
          revealedRoles={revealedRoles}
          seatTags={seatTags}
          departedResults={departedResults}
          editable={canEditSeats}
          busy={busy}
          onSwap={onSwapSeats}
        />
      )}

      {started && !isFinished && currentPlayer && privateInfo && (
        <IdentityCard
          player={currentPlayer}
          privateInfo={privateInfo}
          ladyChecks={missionState ? getLadyOfTheLakeResults(missionState, snapshot.players, currentPlayer.id) : undefined}
          onTeam={Boolean(missionState && (missionState.phase === 'vote' || missionState.phase === 'mission') && missionState.selectedTeamIds.includes(currentPlayer.id))}
        />
      )}

      <RoomHistoryPanel snapshot={snapshot} currentPlayerId={currentPlayer?.id} />

      {moreOpen && (
        <RoomMoreSheet
          snapshot={snapshot}
          currentPlayer={currentPlayer}
          missionState={missionState}
          started={started}
          isFinished={isFinished}
          isDemoMode={isDemoMode}
          joinLink={joinLink}
          showInvite={!inviteInCard}
          currentTeamSize={currentTeamSize}
          busy={busy}
          returnFocusRef={moreButtonRef}
          onClose={() => setMoreOpen(false)}
          onLeave={onLeave}
          onResetRoomToLobby={onResetRoomToLobby}
          onDissolveRoom={onDissolveRoom}
          onRemovePlayer={onRemovePlayer}
          onReleaseSeat={onReleaseSeat}
          onTransferHost={onTransferHost}
          onMissionStateChange={onMissionStateChange}
        />
      )}
    </section>
  );
}
