import { type MissionState } from '../domain/missionFlow';
import { type RoomGamePlayerResult, type RoomPlayer } from '../services/roomService';
import { formatAllegiance, formatRole, useI18n } from '../i18n';
import { LadyOfTheLakeStatus, QuestRecord, RoleLineup } from './MissionPanel';
import { RoundTable, type RevealedSeatRoles } from './RoundTable';

type SeatMarks = Record<string, 'done' | 'waiting'>;

// Seat progress that is public at a real table: who has voted, and which
// team members have put a card in.
function getSeatMarks(missionState: MissionState, players: RoomPlayer[]): SeatMarks | undefined {
  if (missionState.phase === 'vote') {
    return Object.fromEntries(players.map((player) => [player.id, missionState.teamVotes?.[player.id] ? 'done' : 'waiting']));
  }
  if (missionState.phase === 'mission') {
    const submitted = missionState.missionCardSubmissions?.submittedPlayerIds ?? [];
    return Object.fromEntries(missionState.selectedTeamIds.map((id) => [id, submitted.includes(id) ? 'done' : 'waiting']));
  }
  return undefined;
}

function Legend({ items }: { items: Array<[string, string]> }) {
  const { t } = useI18n();
  return (
    <div className="room-table-legend">
      {items.map(([mark, label]) => (
        <span key={label}><i aria-hidden="true" className={`legend-${mark}`}>{mark === 'tag' ? t('✕') : null}</i>{label}</span>
      ))}
    </div>
  );
}

export function LobbyTableCard({
  players,
  totalSeats,
  currentPlayerId,
  editable,
  busy,
  onSwap,
}: {
  players: RoomPlayer[];
  totalSeats: number;
  currentPlayerId?: string;
  editable: boolean;
  busy: boolean;
  onSwap: (firstPlayerId: string, secondPlayerId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="mission-board-section round-table-section room-table-card" aria-label={t('Round table')}>
      <div className="mission-section-heading">
        <h3>{t('Round table')}</h3>
        <Legend items={[['done', t('Ready')], ['open', t('Open seat')]]} />
      </div>
      <RoundTable
        players={players}
        totalSeats={totalSeats}
        currentPlayerId={currentPlayerId}
        readyPlayerIds={players.filter((player) => player.isReady).map((player) => player.id)}
        editable={editable}
        busy={busy}
        onSwap={onSwap}
      />
    </section>
  );
}

export function GameTableCard({
  missionState,
  players,
  currentPlayerId,
  visibleTeamIds,
  nextGameReadyPlayerIds,
  revealedRoles,
  seatTags,
  departedResults = [],
  editable,
  busy,
  onSwap,
}: {
  missionState: MissionState;
  players: RoomPlayer[];
  currentPlayerId?: string;
  visibleTeamIds: string[];
  nextGameReadyPlayerIds: string[];
  revealedRoles?: RevealedSeatRoles;
  seatTags?: Record<string, string>;
  // Players of the finished game who have since left the room: no seat to show.
  departedResults?: RoomGamePlayerResult[];
  editable: boolean;
  busy: boolean;
  onSwap: (firstPlayerId: string, secondPlayerId: string) => void;
}) {
  const { t, language } = useI18n();
  const finished = missionState.phase === 'finished';
  // The leader only matters while quests are being played.
  const showLeader = missionState.phase !== 'finished' && missionState.phase !== 'assassin';
  const legend: Array<[string, string]> = finished
    ? [
      ['good', formatAllegiance('good', language)],
      ['evil', formatAllegiance('evil', language)],
      ...(seatTags && Object.keys(seatTags).length > 0 ? [['tag', t('Assassinated')] as [string, string]] : []),
      ['done', t('Ready to play again')],
    ]
    : missionState.phase === 'vote'
      ? [['done', t('Voted')], ['waiting', t('Not voted')], ['team', t('On the team')]]
      : missionState.phase === 'mission'
        ? [['done', t('Card played')], ['team', t('On the team')]]
        : showLeader ? [['leader', t('Leader')]] : [];
  return (
    <section className="mission-board-section round-table-section room-table-card" aria-label={t('Round table')}>
      <div className="mission-section-heading">
        <h3>{finished && revealedRoles ? t('Who was who') : t('Round table')}</h3>
        {legend.length > 0 && <Legend items={legend} />}
      </div>
      <RoundTable
        players={players}
        currentPlayerId={currentPlayerId}
        revealedRoles={finished ? revealedRoles : undefined}
        seatTags={finished ? seatTags : undefined}
        leaderId={showLeader ? missionState.leaderPlayerId : undefined}
        teamIds={finished ? [] : visibleTeamIds}
        readyPlayerIds={finished ? nextGameReadyPlayerIds : undefined}
        seatMarks={finished ? undefined : getSeatMarks(missionState, players)}
        centerCaption={finished ? t('Play Again') : undefined}
        editable={editable}
        busy={busy}
        onSwap={onSwap}
      />
      {finished && departedResults.length > 0 && (
        <div className="room-table-departed">
          <span>{t('Left the room')}</span>
          <div>
            {departedResults.map((result) => (
              <span key={result.playerId}>
                {result.displayName}
                <em className={`seat-role ${result.allegiance}`}>{formatRole(result.role, language)}</em>
                {seatTags?.[result.playerId] && <em className="seat-tag-inline">{seatTags[result.playerId]}</em>}
              </span>
            ))}
          </div>
        </div>
      )}
      {!finished && <RoleLineup players={players} />}
      <QuestRecord missionState={missionState} players={players} />
      {missionState.ladyOfTheLake && !finished && <LadyOfTheLakeStatus missionState={missionState} players={players} />}
    </section>
  );
}
