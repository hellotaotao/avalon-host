import React, { useEffect, useState } from 'react';
import { getTeamSize, type MissionCard, type Vote } from '../domain/avalon';
import { ensureMissionState, type MissionState } from '../domain/missionFlow';
import { buildJoinUrl } from '../navigationState';
import { getPrivateRoleInfo, canArrangeSeats, type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { useI18n } from '../i18n';
import { PlayerPhone, getLadyOfTheLakeResults, getLivePhoneAction } from '../components/PlayerPhone';
import {
  AssassinPhaseActionPanel,
  AssassinPhaseBanner,
  AssassinationResultBanner,
  GameResultModal,
  GameStartOverlay,
  RoomHistoryPanel,
} from './GameEndPanels';
import { HostAuthorityPanel } from './HostAuthorityPanel';
import { InviteSharePanel, QrCodePanel } from './InviteSharePanel';
import {
  CurrentExpeditionPanel,
  FinalRevealPanel,
  MissionPanel,
  QuestTrackSection,
  TableMakeupSection,
} from './MissionPanel';
import { RoundTable } from './RoundTable';
import { type RoomAiAutomationState, formatStartValidation } from './roomText';

export function RoomView({
  snapshot,
  currentPlayer,
  privateInfo,
  startValidation,
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
  startValidation?: string;
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
  const missionState = started && snapshot.players.length >= 5 ? ensureMissionState(snapshot.room.settings.missionState, playerIds) : undefined;
  const currentTeamSize = missionState ? getTeamSize(snapshot.players.length, missionState.roundIndex) : 0;
  const [assassinationTargetId, setAssassinationTargetId] = useState('');
  const [resultModalDismissed, setResultModalDismissed] = useState(false);
  const readyCount = snapshot.players.filter((player) => player.isReady).length;
  const allPlayersReady = readyCount === snapshot.players.length;
  const isFinished = snapshot.room.status === 'finished' || missionState?.phase === 'finished';
  const showJoinPanel = !started;
  const joinLinkPath = buildJoinUrl(snapshot.room.code, language);
  const joinLink = `${window.location.origin}${joinLinkPath}`;
  const assassinationTargets = snapshot.players.filter((player) => player.id !== currentPlayer?.id);
  const aiSeatCount = snapshot.players.filter((player) => player.isAi).length;
  const plannedHumanCount = (snapshot.room.settings.plannedPlayerCount ?? snapshot.players.length) - aiSeatCount;
  const [liveSelectedTeamIds, setLiveSelectedTeamIds] = useState<string[]>([]);
  const latestGame = snapshot.room.settings.gameHistory?.at(-1);
  const currentPlayerResult = latestGame?.playerResults.find((result) => result.playerId === currentPlayer?.id);
  const nextGameReadyPlayerIds = snapshot.room.settings.nextGameReadyPlayerIds ?? [];
  const currentPlayerReadyForNextGame = Boolean(currentPlayer && nextGameReadyPlayerIds.includes(currentPlayer.id));
  const startValidationCopy = formatStartValidation(startValidation, t);
  const canEditSeats = Boolean(currentPlayer?.isHost) && canArrangeSeats(snapshot);
  const unreadyPlayers = snapshot.players.filter((player) => !player.isReady);
  const waitingOnHostSeats = !started
    && snapshot.players.length === (snapshot.room.settings.plannedPlayerCount ?? snapshot.players.length)
    && unreadyPlayers.length === 1
    && unreadyPlayers[0].isHost;
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
          <InviteSharePanel joinLink={joinLink} code={snapshot.room.code} />
        </div>
      )}

      <RoomHistoryPanel snapshot={snapshot} currentPlayerId={currentPlayer?.id} />

      {isFinished && latestGame && (
        <FinalRevealPanel playerResults={latestGame.playerResults} currentPlayerId={currentPlayer?.id} />
      )}

      {started && missionState && (
        <>
          <TableMakeupSection players={snapshot.players} />
          <section className="mission-board-section round-table-section" aria-label={t('Round table')}>
            <div className="mission-section-heading">
              <h3>{t('Round table')}</h3>
              <span>{isFinished ? t('Seats unlocked') : t('Seats locked')}</span>
            </div>
            <RoundTable
              players={snapshot.players}
              currentPlayerId={currentPlayer?.id}
              leaderId={isFinished ? undefined : missionState.leaderPlayerId}
              teamIds={isFinished ? [] : visibleMissionTeamIds}
              readyPlayerIds={isFinished ? nextGameReadyPlayerIds : undefined}
              centerCaption={isFinished ? t('Play Again') : undefined}
              editable={canEditSeats}
              busy={busy}
              onSwap={onSwapSeats}
            />
          </section>
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
              {currentPlayer.isReady ? t('Ready') : currentPlayer.isHost ? t('Confirm seats and ready') : t('Set Ready')}
            </button>
          </>
        )}

        {!started && (
          <>
            <div className="next-step">
              <strong>
                {allPlayersReady
                  ? t('All players are ready.')
                  : waitingOnHostSeats ? t('Waiting for the host to confirm seats') : t('Waiting for everyone to get ready')}
              </strong>
              <span>
                {allPlayersReady
                  ? t('Starting the game now.')
                  : waitingOnHostSeats ? t('The host checks the round table matches where everyone sits, then taps ready.') : startValidationCopy}
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
            {currentPlayer.isHost && !currentPlayerReadyForNextGame && (
              <p className="hint">{t('If anyone changed seats, swap them on the round table before playing again.')}</p>
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
              ladyChecks={missionState ? getLadyOfTheLakeResults(missionState, snapshot.players, currentPlayer.id) : undefined}
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
                onLadyOfTheLake,
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
        onReleaseSeat={onReleaseSeat}
        onTransferHost={onTransferHost}
      />

      {!started && (
        <section className="panel players-panel">
          <h2>{t('Players')}</h2>
          <p className="hint">{readyCount}/{snapshot.players.length} {t('ready. Minimum 5 ready players.')}</p>
          {aiSeatCount > 0 && !isDemoMode && (
            <div className="ai-fill-note ai-room-note">
              <strong>
                {t('AI fill-ins (experimental)')} · {plannedHumanCount} {t(plannedHumanCount === 1 ? 'human' : 'humans')} + {aiSeatCount} {t('AI')}
              </strong>
              <span>
                {t('Seats marked AI are played automatically.')}
                {currentPlayer?.isHost && ` ${t('AI moves run from this page, so keep it open during the game.')}`}
              </span>
            </div>
          )}
          <RoundTable
            players={snapshot.players}
            totalSeats={snapshot.room.settings.plannedPlayerCount}
            currentPlayerId={currentPlayer?.id}
            readyPlayerIds={snapshot.players.filter((player) => player.isReady).map((player) => player.id)}
            editable={canEditSeats}
            busy={busy}
            onSwap={onSwapSeats}
          />
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
