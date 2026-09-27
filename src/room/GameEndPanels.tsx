import { roleAllegiance, type Allegiance, type Role } from '../domain/avalon';
import { type MissionState } from '../domain/missionFlow';
import { type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { formatAllegiance, formatRole, useI18n } from '../i18n';
import { getGameEndCopy } from '../components/gameText';

export function AssassinPhaseBanner() {
  const { t } = useI18n();
  return (
    <section className="assassin-phase-banner" aria-live="assertive">
      <p className="eyebrow">{t('Mandatory endgame')}</p>
      <h2>{t('Assassin is choosing a target')}</h2>
      <p>{t('Good has completed three quests. Normal mission play is paused until the Assassin resolves the Merlin guess.')}</p>
    </section>
  );
}

export function AssassinPhaseActionPanel({
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

export function AssassinationResultBanner({ missionState, players }: { missionState: MissionState; players: RoomPlayer[] }) {
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

export function GameResultModal({
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
        <p className="result-modal-reason">{getGameEndCopy(missionState, t)}</p>
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
        {currentPlayer.isHost && !alreadyReady && (
          <p className="hint">{t('If anyone changed seats, close this and swap them on the round table first.')}</p>
        )}
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

export function RoomHistoryPanel({ snapshot, currentPlayerId }: { snapshot: RoomSnapshot; currentPlayerId?: string }) {
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
    five_rejected_proposals: 'Five proposals rejected',
  }[reason] ?? 'Game finished';
}

export function GameStartOverlay() {
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
