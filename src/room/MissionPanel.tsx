import { useEffect, useRef, useState } from 'react';
import { getMissionFailThreshold, getTeamSize, roleAllegiance } from '../domain/avalon';
import {
  advanceMissionResult,
  MAX_PROPOSALS_PER_QUEST,
  recordTeamVote,
  selectMissionTeam,
  type MissionState,
} from '../domain/missionFlow';
import { type RoomPlayer, type RoomGamePlayerResult } from '../services/roomService';
import { formatAllegiance, formatRole, useI18n } from '../i18n';
import {
  formatFailThresholdRule,
  formatQuestLabel,
  formatRoleCount,
  getMissionPhaseCopy,
  getMissionPhaseLabel,
  isFinalProposal,
  summarizePublicRoleLineup,
} from '../components/gameText';
import {
  type RoomAiAutomationState,
  formatPendingAiMissionAction,
  getPendingAiMissionActor,
  getRoomPlayerNames,
  sortRoomPlayersBySeat,
} from './roomText';

export function FinalRevealPanel({ playerResults, currentPlayerId }: { playerResults: RoomGamePlayerResult[]; currentPlayerId?: string }) {
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

export function TableMakeupSection({ players }: { players: RoomPlayer[] }) {
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

export function QuestTrackSection({
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

export function CurrentExpeditionPanel({
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
          {(missionState.phase === 'proposal' || missionState.phase === 'vote') && (
            <small>{t('Proposal this quest')} {missionState.proposalIndex + 1}/{MAX_PROPOSALS_PER_QUEST}</small>
          )}
        </div>
        <div className="expedition-state-card">
          <span>{phaseLabel}</span>
          <p>{phaseCopy}</p>
          <small>{formatFailThresholdRule(currentFailThreshold, language)}</small>
        </div>
      </div>
      {(missionState.phase === 'proposal' || missionState.phase === 'vote') && isFinalProposal(missionState) && (
        <p className="final-proposal-warning">{t('Fifth proposal this quest: if this crew is rejected, Evil wins.')}</p>
      )}
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

export function MissionPanel({
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
      setFlowError(error instanceof Error ? t(error.message) : t('Could not propose team.'));
    }
  }

  function submitVote() {
    if (!missionState) return;
    try {
      setFlowError('');
      onMissionStateChange(recordTeamVote(missionState, playerIds, Number(approveCount), Number(rejectCount)));
    } catch (error) {
      setFlowError(error instanceof Error ? t(error.message) : t('Could not record vote.'));
    }
  }

  function submitMission() {
    if (!missionState) return;
    try {
      setFlowError('');
      onMissionStateChange(advanceMissionResult(missionState, playerIds, Number(successCount), Number(failCount)));
    } catch (error) {
      setFlowError(error instanceof Error ? t(error.message) : t('Could not record mission.'));
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
