import React from 'react';
import { getMissionFailThreshold, getTeamSize } from '../domain/avalon';
import { MAX_PROPOSALS_PER_QUEST, type MissionState } from '../domain/missionFlow';
import { getPlannedPlayerCount, type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { fillText, formatAllegiance, useI18n } from '../i18n';
import { formatFailThresholdRule } from '../components/gameText';

type QuestState = 'success' | 'fail' | 'current' | 'pending';

type OpenMore = (opener: HTMLButtonElement) => void;

function questStates(missionState: MissionState): QuestState[] {
  const active = missionState.phase !== 'finished' && missionState.phase !== 'assassin';
  return [0, 1, 2, 3, 4].map((roundIndex) => {
    const result = missionState.missionResults.find((item) => item.roundIndex === roundIndex);
    return result?.outcome ?? (active && roundIndex === missionState.roundIndex ? 'current' : 'pending');
  });
}

function score(missionState: MissionState) {
  const good = missionState.missionResults.filter((result) => result.outcome === 'success').length;
  return { good, evil: missionState.missionResults.length - good };
}

function MoreButton({ moreOpen, onOpenMore }: { moreOpen: boolean; onOpenMore: OpenMore }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="room-more-button"
      aria-haspopup="dialog"
      aria-expanded={moreOpen}
      onClick={(event) => onOpenMore(event.currentTarget)}
    >
      {t('More')}
    </button>
  );
}

// The full header at the top of the room page: the score, the quest track with
// what each number means, and the leader with this quest's rejections. It
// scrolls away with the page; RoomCompactBar takes over once it is out of view.
export const RoomHeader = React.forwardRef<HTMLElement, {
  snapshot: RoomSnapshot;
  missionState?: MissionState;
  playerCount: number;
  moreOpen: boolean;
  onOpenMore: OpenMore;
}>(function RoomHeader({ snapshot, missionState, playerCount, moreOpen, onOpenMore }, ref) {
  const { t, language } = useI18n();
  if (!missionState) {
    const total = getPlannedPlayerCount(snapshot.room.settings);
    const readyCount = snapshot.players.filter((player) => player.isReady).length;
    return (
      <header ref={ref} className="room-header lobby">
        <div className="room-header-row">
          <div className="room-header-code">
            <small>{t('Room Code')}</small>
            <strong>{snapshot.room.code}</strong>
          </div>
          <MoreButton moreOpen={moreOpen} onOpenMore={onOpenMore} />
        </div>
        <div className="room-header-row room-header-facts">
          <span>{fillText(t('{count}-player table'), { count: String(total) })}</span>
          <span>{fillText(t('{count}/{total} seated'), { count: String(snapshot.players.length), total: String(total) })}</span>
          <span>{fillText(t('{count}/{total} ready'), { count: String(readyCount), total: String(total) })}</span>
        </div>
      </header>
    );
  }

  const { good, evil } = score(missionState);
  const leader = snapshot.players.find((player) => player.id === missionState.leaderPlayerId);
  const scoreNote = missionState.phase === 'finished' && missionState.winner
    ? fillText(t('{side} wins'), { side: formatAllegiance(missionState.winner, language) })
    : missionState.phase === 'assassin' ? t('Assassin endgame') : t('First side to three wins');
  const showLeader = missionState.phase !== 'finished' && missionState.phase !== 'assassin';
  return (
    <header ref={ref} className="room-header">
      <div className="room-header-row">
        <div className="room-score">
          <strong aria-label={`${t('Score')}: ${formatAllegiance('good', language)} ${good}, ${formatAllegiance('evil', language)} ${evil}`}>
            <span className="good" aria-hidden="true">{formatAllegiance('good', language)} {good}</span>
            <em aria-hidden="true">:</em>
            <span className="evil" aria-hidden="true">{evil} {formatAllegiance('evil', language)}</span>
          </strong>
          <small>{scoreNote}</small>
        </div>
        <MoreButton moreOpen={moreOpen} onOpenMore={onOpenMore} />
      </div>
      <ol className="room-quest-track" aria-label={t('Quest Track')}>
        {questStates(missionState).map((state, roundIndex) => {
          const teamSize = getTeamSize(playerCount, roundIndex);
          const needsTwoFails = getMissionFailThreshold(playerCount, roundIndex) > 1;
          // The two-fail rule matters most while that quest is being played,
          // so it outranks "in progress"; the gold ring already shows that.
          const note = state === 'success' ? t('Success')
            : state === 'fail' ? t('Fail')
              : needsTwoFails ? t('Needs 2 Fail cards')
                : state === 'current' ? t('In progress') : '';
          const label = [
            fillText(t('Quest {quest}: {size} players'), { quest: String(roundIndex + 1), size: String(teamSize) }),
            state === 'current' ? t('In progress') : state === 'pending' ? '' : note,
            needsTwoFails ? formatFailThresholdRule(2, language) : '',
          ].filter(Boolean).join(', ');
          return (
            <li key={roundIndex} className={`room-quest ${state}`} aria-label={label}>
              <small aria-hidden="true">{fillText(t('Quest {quest}'), { quest: String(roundIndex + 1) })}</small>
              <span aria-hidden="true">{teamSize}{language === 'zh' ? '人' : ''}</span>
              <em aria-hidden="true">{note}</em>
            </li>
          );
        })}
      </ol>
      {showLeader && <LeaderRow leader={leader} missionState={missionState} />}
    </header>
  );
});

// The rejections so far this quest are the proposals before the current one;
// the vote track on a real Avalon board counts the same thing.
function LeaderRow({ leader, missionState }: { leader?: RoomPlayer; missionState: MissionState }) {
  const { t } = useI18n();
  const final = missionState.proposalIndex + 1 >= MAX_PROPOSALS_PER_QUEST;
  return (
    <div className="room-header-row room-leader-row">
      <span className="room-leader-name">{t('Leader')} <strong>{leader?.displayName ?? '?'}</strong></span>
      <span className={`room-vote-track ${final ? 'final' : ''}`}>
        <span>{t('Rejections')}</span>
        <span className="room-vote-pips" aria-hidden="true">
          {Array.from({ length: MAX_PROPOSALS_PER_QUEST }, (_, index) => (
            <i key={index} className={index < missionState.proposalIndex ? 'rejected' : index === MAX_PROPOSALS_PER_QUEST - 1 ? 'last' : ''} />
          ))}
        </span>
        <span>{fillText(t('Proposal {count} of {max}'), { count: String(missionState.proposalIndex + 1), max: String(MAX_PROPOSALS_PER_QUEST) })}</span>
      </span>
    </div>
  );
}

// A one-line summary pinned to the top once the full header has scrolled
// away. Tapping the summary goes back to the top, where the header is.
export function RoomCompactBar({
  snapshot,
  missionState,
  playerCount,
  shown,
  moreOpen,
  onOpenMore,
}: {
  snapshot: RoomSnapshot;
  missionState?: MissionState;
  playerCount: number;
  shown: boolean;
  moreOpen: boolean;
  onOpenMore: OpenMore;
}) {
  const { t, language } = useI18n();
  let summary: React.ReactNode;
  // Read out what the bar shows, not just where tapping it goes.
  let spoken: string;
  if (!missionState) {
    const total = getPlannedPlayerCount(snapshot.room.settings);
    const readyCount = snapshot.players.filter((player) => player.isReady).length;
    spoken = [
      `${t('Room Code')} ${snapshot.room.code}`,
      fillText(t('{count}/{total} seated'), { count: String(snapshot.players.length), total: String(total) }),
      fillText(t('{count}/{total} ready'), { count: String(readyCount), total: String(total) }),
    ].join(', ');
    summary = (
      <>
        <strong className="room-compact-code">{snapshot.room.code}</strong>
        <span>{fillText(t('{count}/{total} seated'), { count: String(snapshot.players.length), total: String(total) })}</span>
        <span>{fillText(t('{count}/{total} ready'), { count: String(readyCount), total: String(total) })}</span>
      </>
    );
  } else {
    const { good, evil } = score(missionState);
    const quest = String(missionState.roundIndex + 1);
    const phaseLine = missionState.phase === 'proposal' || missionState.phase === 'vote'
      ? fillText(t('Quest {quest} · proposal {count}/{max}'), { quest, count: String(missionState.proposalIndex + 1), max: String(MAX_PROPOSALS_PER_QUEST) })
      : missionState.phase === 'mission' ? fillText(t('Quest {quest} · on the quest'), { quest })
        : missionState.phase === 'lady' ? t('Lady of the Lake')
          : missionState.phase === 'assassin' ? t('Assassin endgame')
            : missionState.winner ? fillText(t('{side} wins'), { side: formatAllegiance(missionState.winner, language) }) : t('Game over');
    spoken = [
      `${t('Score')}: ${formatAllegiance('good', language)} ${good}, ${formatAllegiance('evil', language)} ${evil}`,
      phaseLine,
    ].join(', ');
    summary = (
      <>
        <strong className="room-compact-score"><span className="good">{good}</span>:<span className="evil">{evil}</span></strong>
        <span className="room-compact-quests">
          {questStates(missionState).map((state, roundIndex) => (
            <i key={roundIndex} className={`room-quest ${state}`}>{getTeamSize(playerCount, roundIndex)}</i>
          ))}
        </span>
        <span className="room-compact-phase">{phaseLine}</span>
      </>
    );
  }
  return (
    <div className={`room-compact-bar ${shown ? 'shown' : ''}`} aria-hidden={!shown}>
      <button type="button" className="room-compact-summary" aria-label={`${spoken}. ${t('Back to top')}`} tabIndex={shown ? 0 : -1} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        {summary}
      </button>
      <MoreButton moreOpen={moreOpen} onOpenMore={onOpenMore} />
    </div>
  );
}
