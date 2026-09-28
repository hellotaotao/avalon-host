import { type Allegiance } from '../domain/avalon';
import { type RoomSnapshot } from '../services/roomService';
import { fillText, formatAllegiance, formatRole, useI18n } from '../i18n';

// A short full-screen beat when the game ends. The result itself stays on the
// page in the action card until the next game starts.
export function GameResultOverlay({ won, winner, onDismiss }: { won: boolean; winner: Allegiance; onDismiss: () => void }) {
  const { t, language } = useI18n();
  return (
    <div className={`game-start-backdrop game-result-overlay ${won ? 'won' : 'lost'}`} role="status" aria-live="polite" onClick={onDismiss}>
      <div className="game-start-card">
        <span className="game-start-sigil" aria-hidden="true" />
        <p>{fillText(t('{side} wins'), { side: formatAllegiance(winner, language) })}</p>
        <h2>{won ? t('You won this game') : t('You lost this game')}</h2>
      </div>
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
