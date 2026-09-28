import { useEffect, useState } from 'react';
import { roleAllegiance } from '../domain/avalon';
import {
  advanceMissionResult,
  getLadyOfTheLakeHolderId,
  recordTeamVote,
  selectMissionTeam,
  type MissionState,
} from '../domain/missionFlow';
import { type RoomPlayer } from '../services/roomService';
import { fillText, useI18n } from '../i18n';
import { formatQuestLabel, formatRoleCount, summarizePublicRoleLineup } from '../components/gameText';
import { getRoomPlayerNames } from './roomText';

export function RoleLineup({ players }: { players: RoomPlayer[] }) {
  const { t, language } = useI18n();
  return (
    <div className="role-lineup" aria-label={t('Public role lineup')}>
      <span>{t('Roles in play')}</span>
      <div>
        {summarizePublicRoleLineup(players).map((item) => (
          <span key={item.role} className={`role-chip ${roleAllegiance(item.role)}`}>
            {formatRoleCount(item.role, item.count, language)}
          </span>
        ))}
      </div>
    </div>
  );
}

// Who went on each finished quest and how it went: the record the table
// argues over when hunting for Evil.
export function QuestRecord({ missionState, players }: { missionState: MissionState; players: RoomPlayer[] }) {
  const { t, language } = useI18n();
  if (missionState.missionResults.length === 0) return null;
  return (
    <div className="quest-record" aria-label={t('Quest record')}>
      <span>{t('Quest record')}</span>
      <ol>
        {missionState.missionResults.map((result) => (
          <li key={result.roundIndex} className={result.outcome}>
            <strong>{formatQuestLabel(result.roundIndex, language)}</strong>
            <em>{result.outcome === 'success' ? t('Success') : t('Fail')}</em>
            <small>{fillText(t('{count} Fail cards'), { count: String(result.failCount) })}</small>
            <span>{getRoomPlayerNames(players, result.selectedTeamIds).join(language === 'zh' ? '、' : ', ')}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// Who holds the Lady and who examined whom is public; the results are not.
export function LadyOfTheLakeStatus({ missionState, players }: { missionState: MissionState; players: RoomPlayer[] }) {
  const { t } = useI18n();
  const nameOf = (playerId: string) => players.find((player) => player.id === playerId)?.displayName ?? playerId;
  const holderId = getLadyOfTheLakeHolderId(missionState);
  const checks = missionState.ladyOfTheLake?.checks ?? [];
  return (
    <div className="team-roster lady-status" aria-label={t('Lady of the Lake')}>
      <div className="team-roster-heading">
        <span>{t('Lady of the Lake')}</span>
        <strong>{holderId ? nameOf(holderId) : ''}</strong>
      </div>
      {checks.length > 0 ? (
        <div className="member-chips">
          {checks.map((check) => (
            <span key={`${check.afterRoundIndex}-${check.targetPlayerId}`}>{nameOf(check.holderPlayerId)} → {nameOf(check.targetPlayerId)}</span>
          ))}
        </div>
      ) : (
        <p className="empty-team">{t('Used after quests 2, 3, and 4.')}</p>
      )}
    </div>
  );
}

// Host-only fallback for when a player's phone cannot submit its own action.
export function MissionRecoveryControls({
  missionState,
  players,
  currentTeamSize,
  onMissionStateChange,
}: {
  missionState: MissionState;
  players: RoomPlayer[];
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
  const playerIds = players.map((player) => player.id);

  useEffect(() => {
    setSelectedTeamIds(missionState.selectedTeamIds);
    setApproveCount('');
    setRejectCount('');
    setSuccessCount('');
    setFailCount('');
  }, [missionState.phase, missionState.roundIndex, missionState.selectedTeamIds.join('|')]);

  if (missionState.phase !== 'proposal' && missionState.phase !== 'vote' && missionState.phase !== 'mission') return null;

  const selectedTeamNames = missionState.selectedTeamIds.map((id) => players.find((player) => player.id === id)?.displayName ?? id);

  function run(next: () => MissionState, fallbackError: string) {
    try {
      setFlowError('');
      onMissionStateChange(next());
    } catch (error) {
      setFlowError(error instanceof Error ? t(error.message) : t(fallbackError));
    }
  }

  function togglePlayer(playerId: string) {
    setSelectedTeamIds((current) => (current.includes(playerId) ? current.filter((id) => id !== playerId) : [...current, playerId]));
  }

  return (
    <div className="host-action-group mission-recovery">
      <div>
        <h3>{t('Recovery controls')}</h3>
        <p>{t('Only open this if a player phone cannot submit a required action.')}</p>
      </div>
      {flowError && <p className="notice">{flowError}</p>}
      {missionState.phase === 'proposal' && (
        <div className="mission-step">
          <p>{t('Use only if the captain phone cannot submit.')} {t('Quest')} {missionState.roundIndex + 1} {t('needs exactly')} {currentTeamSize} {t('crew members.')} </p>
          <div className="team-picker">
            {players.map((player) => (
              <label key={player.id} className="check">
                <input type="checkbox" checked={selectedTeamIds.includes(player.id)} onChange={() => togglePlayer(player.id)} />
                {player.displayName}
              </label>
            ))}
          </div>
          <button type="button" className="secondary-control" onClick={() => run(() => selectMissionTeam(missionState, playerIds, selectedTeamIds), 'Could not propose team.')}>{t('Submit Backup Proposal')}</button>
        </div>
      )}
      {missionState.phase === 'vote' && (
        <div className="mission-step">
          <p>{t('Use only if phone votes need manual recovery.')} {t('Crew')}: {selectedTeamNames.join(', ')}.</p>
          <div className="count-row">
            <input value={approveCount} onChange={(event) => setApproveCount(event.target.value)} inputMode="numeric" placeholder={t('Approve')} aria-label={t('Approve count')} />
            <input value={rejectCount} onChange={(event) => setRejectCount(event.target.value)} inputMode="numeric" placeholder={t('Reject')} aria-label={t('Reject count')} />
            <button type="button" className="secondary-control" onClick={() => run(() => recordTeamVote(missionState, playerIds, Number(approveCount), Number(rejectCount)), 'Could not record vote.')}>{t('Record Vote')}</button>
          </div>
        </div>
      )}
      {missionState.phase === 'mission' && (
        <div className="mission-step">
          <p>{t('Use only if mission cards need manual recovery after the crew has acted.')}</p>
          <div className="count-row">
            <input value={successCount} onChange={(event) => setSuccessCount(event.target.value)} inputMode="numeric" placeholder={t('Success')} aria-label={t('Success cards')} />
            <input value={failCount} onChange={(event) => setFailCount(event.target.value)} inputMode="numeric" placeholder={t('Fail')} aria-label={t('Fail cards')} />
            <button type="button" className="secondary-control" onClick={() => run(() => advanceMissionResult(missionState, playerIds, Number(successCount), Number(failCount)), 'Could not record mission.')}>{t('Record Mission')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
