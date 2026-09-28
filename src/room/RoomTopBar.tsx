import React from 'react';
import { getMissionFailThreshold, getTeamSize } from '../domain/avalon';
import { MAX_PROPOSALS_PER_QUEST, type MissionState } from '../domain/missionFlow';
import { getPlannedPlayerCount, type RoomSnapshot } from '../services/roomService';
import { fillText, formatAllegiance, useI18n } from '../i18n';
import { formatFailThresholdRule, formatFailsOnRule } from '../components/gameText';

// Stays pinned while the page scrolls, so the score and whose step it is are
// always one glance away.
export function RoomTopBar({
  snapshot,
  missionState,
  playerCount,
  moreOpen,
  moreButtonRef,
  onOpenMore,
}: {
  snapshot: RoomSnapshot;
  missionState?: MissionState;
  playerCount: number;
  moreOpen: boolean;
  moreButtonRef: React.RefObject<HTMLButtonElement | null>;
  onOpenMore: () => void;
}) {
  const { t } = useI18n();
  return (
    <header className="room-topbar">
      {missionState ? <QuestDots missionState={missionState} playerCount={playerCount} /> : (
        <div className="room-topbar-code">
          <small>{t('Room Code')}</small>
          <strong>{snapshot.room.code}</strong>
        </div>
      )}
      <div className="room-topbar-meta">
        {missionState ? <GameMeta missionState={missionState} playerCount={playerCount} /> : <LobbyMeta snapshot={snapshot} />}
      </div>
      <button ref={moreButtonRef} type="button" className="room-topbar-more" aria-haspopup="dialog" aria-expanded={moreOpen} onClick={onOpenMore}>
        {t('More')}
      </button>
    </header>
  );
}

function QuestDots({ missionState, playerCount }: { missionState: MissionState; playerCount: number }) {
  const { t, language } = useI18n();
  const active = missionState.phase !== 'finished' && missionState.phase !== 'assassin';
  return (
    <ol className="room-quests" aria-label={t('Quest Track')}>
      {[0, 1, 2, 3, 4].map((roundIndex) => {
        const result = missionState.missionResults.find((item) => item.roundIndex === roundIndex);
        const state = result?.outcome ?? (active && roundIndex === missionState.roundIndex ? 'current' : 'pending');
        const teamSize = getTeamSize(playerCount, roundIndex);
        const needsTwoFails = getMissionFailThreshold(playerCount, roundIndex) > 1;
        const stateLabel = t({ success: 'succeeded', fail: 'failed', current: 'in progress', pending: 'not played yet' }[state]);
        return (
          <li
            key={roundIndex}
            className={`room-quest ${state}`}
            aria-label={`${fillText(t('Quest {quest}: {size} players'), { quest: String(roundIndex + 1), size: String(teamSize) })}, ${stateLabel}${needsTwoFails ? `, ${formatFailThresholdRule(2, language)}` : ''}`}
          >
            <span aria-hidden="true">{teamSize}</span>
            {result && <i aria-hidden="true">{result.outcome === 'success' ? '✓' : '✗'}</i>}
            {needsTwoFails && !result && <em aria-hidden="true">2</em>}
          </li>
        );
      })}
    </ol>
  );
}

function GameMeta({ missionState, playerCount }: { missionState: MissionState; playerCount: number }) {
  const { t, language } = useI18n();
  const quest = String(missionState.roundIndex + 1);
  const size = String(getTeamSize(playerCount, missionState.roundIndex));
  if (missionState.phase === 'proposal' || missionState.phase === 'vote') {
    return (
      <>
        <strong>{fillText(t('Proposal {count}/{max}'), { count: String(missionState.proposalIndex + 1), max: String(MAX_PROPOSALS_PER_QUEST) })}</strong>
        <span>{fillText(t('Quest {quest} · {size} players'), { quest, size })}</span>
      </>
    );
  }
  if (missionState.phase === 'mission') {
    return (
      <>
        <strong>{fillText(t('Quest {quest} · {size} players'), { quest, size })}</strong>
        <span>{formatFailsOnRule(getMissionFailThreshold(playerCount, missionState.roundIndex), t)}</span>
      </>
    );
  }
  if (missionState.phase === 'lady') {
    return (
      <>
        <strong>{t('Lady of the Lake')}</strong>
        <span>{fillText(t('Next: quest {quest}'), { quest })}</span>
      </>
    );
  }
  if (missionState.phase === 'assassin') {
    return (
      <>
        <strong>{t('Assassin endgame')}</strong>
        <span>{t('Good completed three quests')}</span>
      </>
    );
  }
  return (
    <>
      <strong>{missionState.winner ? fillText(t('{side} wins'), { side: formatAllegiance(missionState.winner, language) }) : t('Game over')}</strong>
      <span>{t('Game over')}</span>
    </>
  );
}

function LobbyMeta({ snapshot }: { snapshot: RoomSnapshot }) {
  const { t } = useI18n();
  const total = String(getPlannedPlayerCount(snapshot.room.settings));
  const readyCount = snapshot.players.filter((player) => player.isReady).length;
  return (
    <>
      <strong>{fillText(t('{count}/{total} seated'), { count: String(snapshot.players.length), total })}</strong>
      <span>{fillText(t('{count}/{total} ready'), { count: String(readyCount), total })}</span>
    </>
  );
}
