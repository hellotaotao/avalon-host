import { type VisibilityInfo } from '../domain/avalon';
import { type RoomPlayer } from '../services/roomService';
import { PrivateSwipeReveal, type LadyOfTheLakeResult } from '../components/PlayerPhone';
import { useI18n } from '../i18n';

export function IdentityCard({
  player,
  privateInfo,
  ladyChecks,
  onTeam,
}: {
  player: RoomPlayer;
  privateInfo: VisibilityInfo;
  ladyChecks?: LadyOfTheLakeResult[];
  onTeam: boolean;
}) {
  const { t } = useI18n();
  if (!player.role) return null;
  return (
    <section className="panel identity-card" aria-labelledby="identity-card-title">
      <div className="identity-card-head">
        <h2 id="identity-card-title">{t('My identity')}</h2>
        <small>{player.displayName} · {t('Seat')} {player.seatIndex + 1}</small>
      </div>
      {onTeam && <span className="phone-team-pill">{t('Selected for this quest')}</span>}
      <PrivateSwipeReveal playerName={player.displayName} role={player.role} privateInfo={privateInfo} ladyChecks={ladyChecks} />
    </section>
  );
}
