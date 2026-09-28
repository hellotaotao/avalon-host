import React, { useEffect, useState } from 'react';
import { getMissionFailThreshold, getTeamSize, roleAllegiance, type MissionCard, type Vote } from '../domain/avalon';
import { getLadyOfTheLakeHolderId, getLadyOfTheLakeTargetIds, type MissionState } from '../domain/missionFlow';
import { getPlannedPlayerCount, type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { fillText, formatAllegiance, useI18n } from '../i18n';
import { formatFailThresholdRule, getGameEndCopy, isFinalProposal, joinSentences } from '../components/gameText';
import { RoomInvite } from './InviteSharePanel';
import { RoundTable } from './RoundTable';
import {
  type RoomAiAutomationState,
  formatPendingAiMissionAction,
  getPendingAiMissionActor,
  sortRoomPlayersBySeat,
} from './roomText';

// The one place on the room page where the player acts. Every phase renders
// here, first thing under the top bar, so the next step never has to be hunted for.
function ActionCard({
  tone = '',
  phase,
  yourTurn = false,
  meta,
  title,
  children,
}: {
  tone?: string;
  phase: string;
  yourTurn?: boolean;
  meta?: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <section className={`room-action-card ${tone}`} aria-labelledby="room-action-title">
      <div className="room-action-head">
        <span className={`room-action-phase ${yourTurn ? 'your-turn' : ''}`}>{phase}</span>
        {meta && <span className="room-action-meta">{meta}</span>}
      </div>
      <h2 id="room-action-title">{title}</h2>
      {children}
    </section>
  );
}

function ActionStatus({ lines }: { lines: Array<string | undefined | false> }) {
  const shown = lines.filter((line): line is string => Boolean(line));
  if (shown.length === 0) return null;
  return (
    <div className="room-action-status" aria-live="polite">
      {shown.map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}

function joinNames(names: string[], language: string): string {
  return names.join(language === 'zh' ? '、' : ', ');
}

function NicknameForm({ player, busy, onRename }: { player: RoomPlayer; busy: boolean; onRename: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const { t } = useI18n();
  return (
    <form className="inline-form room-nickname" onSubmit={onRename} key={player.displayName}>
      <label htmlFor="room-nickname-input">{t('Your nickname')}</label>
      <input id="room-nickname-input" name="displayName" defaultValue={player.displayName} maxLength={24} />
      <button type="submit" disabled={busy}>{t('Save')}</button>
    </form>
  );
}

function AiRoomNote({ snapshot, isHost, isDemoMode }: { snapshot: RoomSnapshot; isHost: boolean; isDemoMode: boolean }) {
  const { t } = useI18n();
  const aiSeatCount = snapshot.players.filter((player) => player.isAi).length;
  if (aiSeatCount === 0 || isDemoMode) return null;
  const humanCount = getPlannedPlayerCount(snapshot.room.settings) - aiSeatCount;
  return (
    <div className="ai-fill-note ai-room-note">
      <strong>
        {t('AI fill-ins (experimental)')} · {humanCount} {t(humanCount === 1 ? 'human' : 'humans')} + {aiSeatCount} {t('AI')}
      </strong>
      <span>
        {t('Seats marked AI are played automatically.')}
        {isHost && ` ${t('AI moves run from this page, so keep it open during the game.')}`}
      </span>
    </div>
  );
}

export function LobbyActionCard({
  snapshot,
  currentPlayer,
  isDemoMode,
  joinLink,
  canEditSeats,
  busy,
  onReady,
  onRename,
  onSwapSeats,
}: {
  snapshot: RoomSnapshot;
  currentPlayer: RoomPlayer;
  isDemoMode: boolean;
  joinLink: string;
  canEditSeats: boolean;
  busy: boolean;
  onReady: () => void;
  onRename: (event: React.FormEvent<HTMLFormElement>) => void;
  onSwapSeats: (firstPlayerId: string, secondPlayerId: string) => void;
}) {
  const { t, language } = useI18n();
  const total = getPlannedPlayerCount(snapshot.room.settings);
  const missing = Math.max(0, total - snapshot.players.length);
  const players = sortRoomPlayersBySeat(snapshot.players);
  const notReady = players.filter((player) => !player.isReady);
  const notReadyLine = notReady.length > 0
    ? fillText(t('Not ready yet: {names}'), { names: joinNames(notReady.map((player) => nameWithYou(player, currentPlayer.id, t)), language) })
    : t('Starting the game now.');
  const nickname = <NicknameForm player={currentPlayer} busy={busy} onRename={onRename} />;
  const aiNote = <AiRoomNote snapshot={snapshot} isHost={currentPlayer.isHost} isDemoMode={isDemoMode} />;

  // Before the table is full the host has nothing to confirm yet: the next
  // newcomer would take the ready back, so the card is only about inviting.
  if (currentPlayer.isHost && missing > 0) {
    return (
      <ActionCard phase={t('Invite')} yourTurn title={t('Invite players to the table')}>
        <RoomInvite code={snapshot.room.code} joinLink={joinLink} isDemoMode={isDemoMode} />
        <ActionStatus lines={[fillText(t('{count} more to join. Once every seat is taken, this card turns into checking the seats.'), { count: String(missing) })]} />
        {aiNote}
        {nickname}
      </ActionCard>
    );
  }

  if (currentPlayer.isHost) {
    return (
      <ActionCard
        phase={t('Get ready')}
        yourTurn={!currentPlayer.isReady}
        meta={t('Everyone is seated')}
        title={currentPlayer.isReady ? t('Seats confirmed') : t('Check the seats, then get ready')}
      >
        <p className="room-action-copy">{t('Match the round table to where everyone is actually sitting. If it is off, swap players on the table.')}</p>
        <RoundTable
          players={snapshot.players}
          totalSeats={total}
          currentPlayerId={currentPlayer.id}
          readyPlayerIds={players.filter((player) => player.isReady).map((player) => player.id)}
          editable={canEditSeats}
          busy={busy}
          onSwap={onSwapSeats}
        />
        {nickname}
        <button type="button" className={`room-action-wide ${currentPlayer.isReady ? 'secondary-control' : 'primary'}`} onClick={onReady} disabled={busy}>
          {currentPlayer.isReady ? t('Cancel ready') : t('Confirm seats and ready')}
        </button>
        <ActionStatus lines={[notReadyLine, t('The game starts automatically when everyone is ready.')]} />
        {aiNote}
      </ActionCard>
    );
  }

  const waitingOnHost = missing === 0 && notReady.length === 1 && notReady[0].isHost;
  return (
    <ActionCard
      phase={t('Get ready')}
      yourTurn={!currentPlayer.isReady}
      title={currentPlayer.isReady ? t('You are ready') : t('Check your nickname, then get ready')}
    >
      {nickname}
      <button type="button" className={`room-action-wide ${currentPlayer.isReady ? 'secondary-control' : 'primary'}`} onClick={onReady} disabled={busy}>
        {currentPlayer.isReady ? t('Cancel ready') : t('Set Ready')}
      </button>
      <ActionStatus
        lines={[
          missing > 0 ? fillText(t('{count} more to join.'), { count: String(missing) }) : waitingOnHost ? t('Waiting for the host to confirm seats') : notReadyLine,
          t('The game starts automatically when everyone is ready.'),
        ]}
      />
      {aiNote}
    </ActionCard>
  );
}

function nameWithYou(player: RoomPlayer, currentPlayerId: string | undefined, t: (text: string) => string): string {
  return player.id === currentPlayerId ? fillText(t('{name} (you)'), { name: player.displayName }) : player.displayName;
}

function AiProgress({ missionState, players, aiAutomation }: { missionState: MissionState; players: RoomPlayer[]; aiAutomation?: RoomAiAutomationState }) {
  const { t } = useI18n();
  const actor = getPendingAiMissionActor(missionState, players);
  if (!actor) return null;
  return (
    <div className="ai-action-status" aria-live="polite">
      <span aria-hidden="true" />
      <div>
        <strong>{t('AI in progress')}</strong>
        <p>{formatPendingAiMissionAction(missionState, actor, t)}</p>
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
  );
}

export function GameActionCard({
  snapshot,
  missionState,
  currentPlayer,
  gamePlayerCount,
  busy,
  aiAutomation,
  draftTeamIds,
  nextGameReadyPlayerIds,
  onToggleDraftPlayer,
  onProposeTeam,
  onVote,
  onPlayMissionCard,
  onLadyOfTheLake,
  onAssassinate,
  onReadyForNextGame,
}: {
  snapshot: RoomSnapshot;
  missionState: MissionState;
  currentPlayer: RoomPlayer;
  gamePlayerCount: number;
  busy: boolean;
  aiAutomation?: RoomAiAutomationState;
  draftTeamIds: string[];
  nextGameReadyPlayerIds: string[];
  onToggleDraftPlayer: (playerId: string) => void;
  onProposeTeam: () => void;
  onVote: (vote: Vote) => void;
  onPlayMissionCard: (card: MissionCard) => void;
  onLadyOfTheLake: (targetPlayerId: string) => void;
  onAssassinate: (targetPlayerId: string) => void;
  onReadyForNextGame: () => void;
}) {
  const { t, language } = useI18n();
  const [assassinationTargetId, setAssassinationTargetId] = useState('');
  const players = sortRoomPlayersBySeat(snapshot.players);
  const nameOf = (playerId: string) => players.find((player) => player.id === playerId)?.displayName ?? playerId;
  const youName = (playerId: string) => {
    const player = players.find((candidate) => candidate.id === playerId);
    return player ? nameWithYou(player, currentPlayer.id, t) : playerId;
  };
  const quest = String(missionState.roundIndex + 1);
  const supportedCount = gamePlayerCount >= 5 && gamePlayerCount <= 10;
  const teamSize = supportedCount ? getTeamSize(gamePlayerCount, missionState.roundIndex) : 0;
  const failRule = supportedCount ? formatFailThresholdRule(getMissionFailThreshold(gamePlayerCount, missionState.roundIndex), language) : '';
  const aiProgress = <AiProgress missionState={missionState} players={players} aiAutomation={aiAutomation} />;
  const finalWarning = isFinalProposal(missionState)
    ? <p className="final-proposal-warning">{t('Fifth proposal this quest: if this crew is rejected, Evil wins.')}</p>
    : null;

  useEffect(() => {
    setAssassinationTargetId('');
  }, [missionState.phase, currentPlayer.id]);

  const lastProposalLine = missionState.teamVote
    ? fillText(t('Last proposal: {approve} approve, {reject} reject. Crew {result}.'), {
      approve: String(missionState.teamVote.approveCount),
      reject: String(missionState.teamVote.rejectCount),
      result: t(missionState.teamVote.passed ? 'approved' : 'rejected'),
    })
    : undefined;
  const previousQuest = missionState.missionResults.find((result) => result.roundIndex === missionState.roundIndex - 1);
  const previousQuestLine = previousQuest
    ? fillText(t('Quest {quest}: {outcome} · {count} Fail cards'), {
      quest: String(previousQuest.roundIndex + 1),
      outcome: t(previousQuest.outcome === 'success' ? 'Success' : 'Fail'),
      count: String(previousQuest.failCount),
    })
    : undefined;

  if (missionState.phase === 'proposal') {
    const leaderId = missionState.leaderPlayerId;
    const history = [missionState.proposalIndex > 0 ? lastProposalLine : previousQuestLine];
    if (leaderId === currentPlayer.id) {
      const canAdd = draftTeamIds.length < teamSize;
      return (
        <ActionCard
          phase={t('Choose team')}
          yourTurn
          title={fillText(t('You are the leader: choose {count} players'), { count: String(teamSize) })}
        >
          <div className="room-picks" role="group" aria-label={t('Quest team')}>
            {players.map((player) => {
              const checked = draftTeamIds.includes(player.id);
              return (
                <label key={player.id} className={`room-pick ${checked ? 'on' : ''}`}>
                  <input type="checkbox" aria-label={player.displayName} checked={checked} disabled={!checked && !canAdd} onChange={() => onToggleDraftPlayer(player.id)} />
                  {player.displayName}
                  {player.id === currentPlayer.id && <small aria-hidden="true">{t('You')}</small>}
                </label>
              );
            })}
          </div>
          <button type="button" className="primary room-action-wide" disabled={busy || draftTeamIds.length !== teamSize} onClick={onProposeTeam}>
            {t('Propose Team')}
          </button>
          <p className="room-action-rule">{fillText(t('Selected {count}/{total}'), { count: String(draftTeamIds.length), total: String(teamSize) })} · {failRule}</p>
          {finalWarning}
          <ActionStatus lines={history} />
        </ActionCard>
      );
    }
    return (
      <ActionCard phase={t('Choose team')} title={fillText(t('Waiting for {name} to choose the team'), { name: nameOf(leaderId) })}>
        <p className="room-action-copy room-action-waiting">
          {fillText(t('Quest {quest} needs {count} players. Once the team is proposed, you vote here.'), { quest, count: String(teamSize) })}
        </p>
        {finalWarning}
        {aiProgress}
        <ActionStatus lines={history} />
      </ActionCard>
    );
  }

  if (missionState.phase === 'vote') {
    const votes = missionState.teamVotes ?? {};
    const currentVote = votes[currentPlayer.id];
    const waiting = players.filter((player) => !votes[player.id]).map((player) => youName(player.id));
    return (
      <ActionCard phase={t('Team vote')} yourTurn={!currentVote} title={t('Vote on this team')}>
        <div className="room-crew" aria-label={t('Quest team')}>
          {missionState.selectedTeamIds.map((id) => <span key={id}>{nameOf(id)}</span>)}
        </div>
        {finalWarning}
        <div className="room-choices">
          <button type="button" className={currentVote === 'approve' ? 'selected' : ''} aria-pressed={currentVote === 'approve'} disabled={busy} onClick={() => onVote('approve')}>{t('Approve')}</button>
          <button type="button" className={currentVote === 'reject' ? 'selected' : ''} aria-pressed={currentVote === 'reject'} disabled={busy} onClick={() => onVote('reject')}>{t('Reject')}</button>
        </div>
        {aiProgress}
        <ActionStatus
          lines={[
            fillText(t('Votes in {count}/{total} · Waiting for: {names}'), {
              count: String(players.length - waiting.length),
              total: String(players.length),
              names: joinNames(waiting, language),
            }),
            currentVote ? t('You can change your vote until everyone has voted.') : t('Every player votes, including the leader.'),
          ]}
        />
      </ActionCard>
    );
  }

  if (missionState.phase === 'mission') {
    const submitted = missionState.missionCardSubmissions?.submittedPlayerIds ?? [];
    const waiting = missionState.selectedTeamIds.filter((id) => !submitted.includes(id));
    const onTeam = missionState.selectedTeamIds.includes(currentPlayer.id);
    const cardsLine = fillText(t('Cards in {count}/{total} · Waiting for: {names}'), {
      count: String(submitted.length),
      total: String(missionState.selectedTeamIds.length),
      names: joinNames(waiting.map(youName), language),
    });
    if (onTeam && !submitted.includes(currentPlayer.id)) {
      const canFail = Boolean(currentPlayer.role && roleAllegiance(currentPlayer.role) === 'evil');
      return (
        <ActionCard phase={t('On the quest')} yourTurn title={t('You are on the team: play a mission card')}>
          <div className="room-choices">
            <button type="button" disabled={busy} onClick={() => onPlayMissionCard('success')}>{t('Success')}</button>
            <button type="button" className="danger" disabled={busy || !canFail} onClick={() => onPlayMissionCard('fail')}>{t('Fail')}</button>
          </div>
          <p className="room-action-rule">
            {joinSentences([!canFail && t('Good players can only play Success.'), t('Mission cards are anonymous; only how many Success and Fail cards were played is shown.'), `${failRule}${language === 'zh' ? '。' : '.'}`], language)}
          </p>
          <ActionStatus lines={[cardsLine, lastProposalLine]} />
        </ActionCard>
      );
    }
    return (
      <ActionCard
        phase={t('On the quest')}
        title={onTeam ? t('Card played') : t('Waiting for the team to play their cards')}
      >
        <div className="room-crew" aria-label={t('Quest team')}>
          {missionState.selectedTeamIds.map((id) => <span key={id} className={submitted.includes(id) ? 'done' : 'waiting'}>{nameOf(id)}</span>)}
        </div>
        {aiProgress}
        <ActionStatus lines={[cardsLine, onTeam ? undefined : t('You are not on this team, so there is nothing to do.'), lastProposalLine]} />
      </ActionCard>
    );
  }

  if (missionState.phase === 'lady') {
    const holderId = getLadyOfTheLakeHolderId(missionState) ?? '';
    if (holderId === currentPlayer.id) {
      const candidates = players.filter((player) => getLadyOfTheLakeTargetIds(missionState, players.map((item) => item.id)).includes(player.id));
      return (
        <ActionCard phase={t('Lady of the Lake')} yourTurn title={t('Choose a player to examine')}>
          <p className="room-action-copy">{t('Choose a player to examine. Only you see their allegiance, in your Night info, and the Lady passes to them.')}</p>
          <div className="room-picks">
            {candidates.map((player) => (
              <button key={player.id} type="button" disabled={busy} onClick={() => onLadyOfTheLake(player.id)}>{player.displayName}</button>
            ))}
          </div>
          <ActionStatus lines={[previousQuestLine]} />
        </ActionCard>
      );
    }
    return (
      <ActionCard phase={t('Lady of the Lake')} title={fillText(t('{name} is using the Lady of the Lake'), { name: nameOf(holderId) })}>
        <p className="room-action-copy room-action-waiting">{t('Only the holder sees the result.')}</p>
        {aiProgress}
        <ActionStatus lines={[previousQuestLine]} />
      </ActionCard>
    );
  }

  if (missionState.phase === 'assassin') {
    if (currentPlayer.role === 'Assassin' && !currentPlayer.isAi) {
      const targets = players.filter((player) => player.id !== currentPlayer.id);
      return (
        <ActionCard tone="evil" phase={t('Assassinate Merlin')} yourTurn meta={t('Only you can act')} title={t('You are the Assassin: find Merlin')}>
          <p className="room-action-copy">{t('Good completed three quests. Hit Merlin and Evil wins; miss and Good wins. Talk it over with your team first.')}</p>
          <div className="room-picks" role="radiogroup" aria-label={t('Choose Merlin')}>
            {targets.map((player) => (
              <label key={player.id} className={`room-pick ${assassinationTargetId === player.id ? 'on' : ''}`}>
                <input type="radio" name="assassination-target" aria-label={player.displayName} checked={assassinationTargetId === player.id} onChange={() => setAssassinationTargetId(player.id)} />
                {player.displayName}
              </label>
            ))}
          </div>
          <button type="button" className="room-action-wide room-danger-button" disabled={busy || !assassinationTargetId} onClick={() => onAssassinate(assassinationTargetId)}>
            {t('Confirm Assassination')}
          </button>
        </ActionCard>
      );
    }
    return (
      <ActionCard tone="evil" phase={t('Assassinate Merlin')} meta={t('Waiting for the Assassin')} title={t('The Assassin is choosing Merlin')}>
        <p className="room-action-copy room-action-waiting">{t('Good completed three quests. If the Assassin hits Merlin, Evil wins; otherwise Good wins.')}</p>
        {aiProgress}
      </ActionCard>
    );
  }

  const winner = missionState.winner ?? 'good';
  const won = Boolean(currentPlayer.role && roleAllegiance(currentPlayer.role) === winner);
  const alreadyReady = nextGameReadyPlayerIds.includes(currentPlayer.id);
  const assassination = missionState.assassination;
  const assassinationLine = assassination
    ? fillText(t('The Assassin {assassin} chose {target}.'), { assassin: nameOf(assassination.assassinPlayerId), target: nameOf(assassination.targetPlayerId) })
    : undefined;
  return (
    <ActionCard
      tone={winner === 'good' ? 'good-win' : 'evil-win'}
      phase={t('Game over')}
      meta={won ? t('You won') : t('You lost')}
      title={`${fillText(t('{side} wins'), { side: formatAllegiance(winner, language) })} · ${won ? t('You won') : t('You lost')}`}
    >
      <p className="room-action-copy">{joinSentences([getGameEndCopy(missionState, t), assassinationLine], language)}</p>
      <button type="button" className="primary room-action-wide" disabled={busy || alreadyReady} onClick={onReadyForNextGame}>
        {alreadyReady ? t('Ready for next game') : t('Play Again')}
      </button>
      <ActionStatus
        lines={[
          fillText(t('{count}/{total} ready for the next game'), { count: String(nextGameReadyPlayerIds.length), total: String(players.length) }),
          players.length < gamePlayerCount && t('Someone has left, so Play Again first returns everyone to the lobby to fill the seats.'),
          currentPlayer.isHost && t('If anyone changed seats, swap them on the round table before playing again.'),
        ]}
      />
    </ActionCard>
  );
}
