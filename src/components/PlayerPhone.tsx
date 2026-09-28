import React, { useRef, useState } from 'react';
import {
  roleAllegiance,
  type Allegiance,
  type MissionCard,
  type Role,
  type VisibilityInfo,
  type Vote,
} from '../domain/avalon';
import {
  type MissionResultState,
  type MissionState,
} from '../domain/missionFlow';
import { type RoomPlayer } from '../services/roomService';
import { formatAllegiance, formatHint, formatRole, formatRoleDescription, useI18n } from '../i18n';
import { type DemoAssassination, type DemoMissionResult } from '../demo/demoTypes';

interface PlayerPhonePerson {
  id: string;
  displayName: string;
  seatIndex: number;
  role?: Role;
  teamVote?: Vote;
  missionCard?: MissionCard;
}

type PlayerPhoneMode = 'demo' | 'live';

type PlayerPhoneResult = DemoMissionResult | MissionResultState;

export type PlayerPhoneAction =
  | {
      kind: 'proposal';
      isLeader: boolean;
      leaderName: string;
      teamSize: number;
      selectedTeamIds: string[];
      players: PlayerPhonePerson[];
      canEdit: boolean;
      onToggleTeamPlayer?: (playerId: string) => void;
      onProposeTeam?: () => void;
    }
  | {
      kind: 'vote';
      selectedTeamNames: string[];
      isFinalProposal?: boolean;
      currentVote?: Vote;
      submittedVoteCount?: number;
      playerCount?: number;
      onVote?: (vote: Vote) => void;
    }
  | {
      kind: 'mission';
      onTeam: boolean;
      selectedTeamCount: number;
      canFailMission: boolean;
      currentMissionCard?: MissionCard;
      missionCardSubmitted?: boolean;
      submittedCardCount?: number;
      onPlayMissionCard?: (card: MissionCard) => void;
    }
  | {
      kind: 'result';
      winner?: Allegiance;
      playerWon?: boolean;
      result?: PlayerPhoneResult;
    }
  | {
      kind: 'lady';
      isHolder: boolean;
      holderName: string;
      candidates: PlayerPhonePerson[];
      onExamine?: (targetPlayerId: string) => void;
    }
  | {
      kind: 'assassin';
      isAssassin: boolean;
      candidates: PlayerPhonePerson[];
      onAssassinate?: (targetPlayerId: string) => void;
    }
  | {
      kind: 'finished';
      winner?: Allegiance;
      playerWon?: boolean;
      result?: PlayerPhoneResult;
      assassination?: DemoAssassination;
    };

export interface LadyOfTheLakeResult {
  targetPlayerId: string;
  targetName: string;
  allegiance: Allegiance;
}

// What this player learned from the Lady of the Lake. Only the holder at the
// time of each check sees its result.
export function getLadyOfTheLakeResults(missionState: MissionState, players: RoomPlayer[], playerId: string): LadyOfTheLakeResult[] {
  return (missionState.ladyOfTheLake?.checks ?? []).flatMap((check) => {
    if (check.holderPlayerId !== playerId) return [];
    const target = players.find((candidate) => candidate.id === check.targetPlayerId);
    if (!target?.role) return [];
    return [{ targetPlayerId: target.id, targetName: target.displayName, allegiance: roleAllegiance(target.role) }];
  });
}

export function PlayerPhone({
  mode,
  player,
  privateInfo,
  ladyChecks,
  leaderId,
  selectedTeamIds = [],
  winner,
  result,
  agentView,
  action,
}: {
  mode: PlayerPhoneMode;
  player: PlayerPhonePerson;
  privateInfo?: VisibilityInfo;
  ladyChecks?: LadyOfTheLakeResult[];
  leaderId?: string;
  selectedTeamIds?: string[];
  winner?: Allegiance;
  result?: PlayerPhoneResult;
  agentView?: React.ReactNode;
  action?: PlayerPhoneAction;
}) {
  const { t } = useI18n();
  const isLeader = player.id === leaderId;
  const onTeam = selectedTeamIds.includes(player.id);
  const playerMeta = [
    `${t('Seat')} ${player.seatIndex + 1}`,
    t('Leader rotation order'),
    isLeader ? t('Current Leader') : undefined,
  ].filter(Boolean).join(' · ');
  const outcomeClass = [
    winner && player.role ? (roleAllegiance(player.role) === winner ? 'phone-winner' : 'phone-loser') : '',
    result ? `mission-${result.outcome}-phone` : '',
  ].filter(Boolean).join(' ');

  return (
    <article className={`player-phone ${mode === 'demo' ? 'demo-phone' : 'live-player-phone'} ${isLeader ? 'leader-phone' : ''} ${outcomeClass}`}>
      <div className="phone-top">
        <div className="phone-player-row">
          <strong>{player.displayName}</strong>
          <small>{playerMeta}</small>
        </div>
        {onTeam && <span className="phone-team-pill">{t('Selected for this quest')}</span>}
      </div>
      {player.role && (
        <PrivateSwipeReveal
          playerName={player.displayName}
          role={player.role}
          privateInfo={privateInfo}
          ladyChecks={ladyChecks}
        />
      )}
      {agentView}
      {action && <PlayerPhoneActionPanel action={action} />}
    </article>
  );
}

function PlayerPhoneActionPanel({ action }: { action: PlayerPhoneAction }) {
  const { t } = useI18n();
  if (action.kind === 'proposal') {
    const selectedCount = action.selectedTeamIds.length;
    const canAddToTeam = selectedCount < action.teamSize;
    return (
      <div className={`phone-action ${action.canEdit ? '' : 'phone-readonly'}`}>
        <span>{action.canEdit ? `${t('Propose team')} · ${selectedCount}/${action.teamSize}` : t('Proposal')}</span>
        {action.canEdit ? (
          <>
            <p>{t('You can change the crew until you submit. After submission, voting starts and the proposal is locked.')}</p>
            {action.players.map((candidate) => (
              <label key={candidate.id} className="check">
                <input
                  type="checkbox"
                  checked={action.selectedTeamIds.includes(candidate.id)}
                  disabled={!action.selectedTeamIds.includes(candidate.id) && !canAddToTeam}
                  onChange={() => action.onToggleTeamPlayer?.(candidate.id)}
                />
                {candidate.displayName}
              </label>
            ))}
            <button type="button" className="primary" disabled={selectedCount !== action.teamSize} onClick={action.onProposeTeam}>{t('Propose Team')}</button>
          </>
        ) : (
          <>
            <p>{action.isLeader ? t('You are choosing the quest team.') : `${action.leaderName} ${t('is choosing')} ${action.teamSize} ${t('players')}.`}</p>
            <p>{t('Selected')}: {selectedCount}/{action.teamSize}</p>
          </>
        )}
      </div>
    );
  }

  if (action.kind === 'vote') {
    return (
      <div className={`phone-action ${action.onVote ? '' : 'phone-readonly'}`}>
        <span>{t('Team vote')}</span>
        {action.selectedTeamNames.length > 0 && <p>{t('Team')}: {action.selectedTeamNames.join(', ')}</p>}
        <p>{t('Every player votes on this proposal, including the captain.')}</p>
        {action.isFinalProposal && <p className="final-proposal-warning">{t('Fifth proposal this quest: if this crew is rejected, Evil wins.')}</p>}
        {action.onVote ? (
          <>
            <div className="choice-row">
              <button type="button" className={action.currentVote === 'approve' ? 'selected' : ''} onClick={() => action.onVote?.('approve')}>{t('Approve')}</button>
              <button type="button" className={action.currentVote === 'reject' ? 'selected' : ''} onClick={() => action.onVote?.('reject')}>{t('Reject')}</button>
            </div>
            {typeof action.submittedVoteCount === 'number' && action.playerCount && (
              <p>{t('Votes in')}: {action.submittedVoteCount}/{action.playerCount}</p>
            )}
          </>
        ) : action.currentVote ? (
          <>
            <div className={`vote-status-pill ${action.currentVote}`} aria-label={t('Submitted vote')}>
              {action.currentVote === 'approve' ? t('Approve') : t('Reject')}
            </div>
            {typeof action.submittedVoteCount === 'number' && action.playerCount && (
              <p>{t('Votes in')}: {action.submittedVoteCount}/{action.playerCount}</p>
            )}
          </>
        ) : (
          <p>{t('Vote not submitted yet.')} {typeof action.submittedVoteCount === 'number' && action.playerCount ? `${t('Votes in')}: ${action.submittedVoteCount}/${action.playerCount}.` : ''}</p>
        )}
      </div>
    );
  }

  if (action.kind === 'mission') {
    return (
      <div className={`phone-action ${action.onTeam && action.onPlayMissionCard ? '' : 'phone-readonly'}`}>
        <span>{action.onTeam ? t('Mission card') : t('Mission')}</span>
        {action.onTeam && action.onPlayMissionCard ? (
          <>
            <div className="choice-row">
              <button type="button" className={action.currentMissionCard === 'success' ? 'selected' : ''} onClick={() => action.onPlayMissionCard?.('success')}>{t('Success')}</button>
              <button
                type="button"
                className={action.currentMissionCard === 'fail' ? 'selected danger-choice' : ''}
                disabled={!action.canFailMission}
                onClick={() => action.onPlayMissionCard?.('fail')}
              >
                {t('Fail')}
              </button>
            </div>
            {typeof action.submittedCardCount === 'number' && (
              <p>{t('Cards in')}: {action.submittedCardCount}/{action.selectedTeamCount}</p>
            )}
          </>
        ) : (
          <p>
            {action.onTeam
              ? action.missionCardSubmitted
                ? `${t('Card submitted.')} ${t('Cards in')}: ${action.submittedCardCount ?? 0}/${action.selectedTeamCount}.`
                : t('Waiting for your mission card.')
              : `${action.selectedTeamCount} ${t('players are on the mission. Wait for their cards.')}`}
          </p>
        )}
      </div>
    );
  }

  if (action.kind === 'lady') {
    return (
      <div className={`phone-action ${action.onExamine ? '' : 'phone-readonly'}`}>
        <span>{t('Lady of the Lake')}</span>
        {action.onExamine ? (
          <>
            <p>{t('Choose a player to examine. Only you see their allegiance, in your Night info, and the Lady passes to them.')}</p>
            <div className="choice-row">
              {action.candidates.map((candidate) => (
                <button key={candidate.id} type="button" onClick={() => action.onExamine?.(candidate.id)}>{candidate.displayName}</button>
              ))}
            </div>
          </>
        ) : (
          <p>{action.isHolder ? t('Waiting for the Lady of the Lake.') : `${action.holderName} ${t('is using the Lady of the Lake.')}`}</p>
        )}
      </div>
    );
  }

  if (action.kind === 'assassin') {
    return (
      <div className={`phone-action ${action.onAssassinate ? '' : 'phone-readonly'}`}>
        <span>{t('Assassin phase')}</span>
        {action.onAssassinate ? (
          <>
            <p>{t('Good completed three quests. Choose Merlin: hit Merlin and Evil wins; miss and Good wins.')}</p>
            <div className="choice-row">
              {action.candidates.map((candidate) => (
                <button key={candidate.id} type="button" onClick={() => action.onAssassinate?.(candidate.id)}>{candidate.displayName}</button>
              ))}
            </div>
          </>
        ) : (
          <p>{action.isAssassin ? t('Waiting for the AI Assassin to choose Merlin.') : t('Good completed three quests. The Assassin is choosing Merlin.')}</p>
        )}
      </div>
    );
  }

  const isFinished = action.kind === 'finished';
  return (
    <div className={`phone-action ${action.winner ? 'phone-result' : 'phone-readonly'}`}>
      <span>{action.winner || isFinished ? t('Game result') : t('Quest result')}</span>
      {action.result && <MissionResultReveal result={action.result} />}
      {action.kind === 'finished' && action.assassination && (
        <p>
          {t('Assassin targeted')} {action.assassination.targetName}.
          {' '}
          {action.assassination.hitMerlin ? t('Merlin was found.') : t('Merlin survived.')}
        </p>
      )}
      {action.winner ? (
        <p>{action.playerWon ? t('Victory') : t('Defeat')} · {action.winner === 'good' ? t('Good wins') : t('Evil wins')}</p>
      ) : (
        <p>{isFinished ? t('Game finished.') : t('Next quest starts automatically.')}</p>
      )}
    </div>
  );
}

function MissionResultReveal({ result }: { result: PlayerPhoneResult }) {
  const { t, language } = useI18n();
  const succeeded = result.outcome === 'success';
  const failCardLabel = language === 'zh' ? t('fail card') : `${t('fail card')}${result.failCount === 1 ? '' : 's'}`;
  return (
    <div className={`mission-result-reveal ${succeeded ? 'success' : 'fail'}`} aria-live="polite">
      <strong>{succeeded ? t('Quest Success') : t('Quest Failed')}</strong>
      <small>{result.failCount} {failCardLabel} · {result.requiredFails} {t('needed to fail')}</small>
    </div>
  );
}

type PrivateRevealSide = 'left' | 'right';

export function PrivateSwipeReveal({
  playerName,
  role,
  privateInfo,
  ladyChecks = [],
}: {
  playerName: string;
  role: Role;
  privateInfo?: VisibilityInfo;
  ladyChecks?: LadyOfTheLakeResult[];
}) {
  const { t, language } = useI18n();
  const allegiance = roleAllegiance(role);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number | undefined>(undefined);
  const [activeSide, setActiveSide] = useState<PrivateRevealSide | undefined>();
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  function maxRevealOffset() {
    return Math.max(96, (trackRef.current?.clientWidth ?? 112) - 18);
  }

  function reveal(side: PrivateRevealSide) {
    const maxOffset = maxRevealOffset();
    setActiveSide(side);
    setDragOffset(side === 'left' ? maxOffset : -maxOffset);
  }

  function resetReveal() {
    dragStartX.current = undefined;
    setIsDragging(false);
    setActiveSide(undefined);
    setDragOffset(0);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragStartX.current = event.clientX;
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStartX.current === undefined) return;
    const maxOffset = maxRevealOffset();
    const nextOffset = Math.max(-maxOffset, Math.min(maxOffset, event.clientX - dragStartX.current));
    setDragOffset(nextOffset);
    if (Math.abs(nextOffset) < 8) {
      setActiveSide(undefined);
      return;
    }
    setActiveSide(nextOffset > 0 ? 'left' : 'right');
  }

  function handleButtonKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, side: PrivateRevealSide) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    reveal(side);
  }

  const swipeStyle = { '--swipe-x': `${dragOffset}px` } as React.CSSProperties;
  const roleRevealLabel = language === 'zh' ? `${t('Reveal hidden role for')}${playerName}` : `Reveal ${playerName}'s hidden role`;
  const nightRevealLabel = language === 'zh' ? `${t('Reveal hidden night information for')}${playerName}` : `Reveal ${playerName}'s hidden night information`;
  const fullRevealLabel = language === 'zh' ? `${roleRevealLabel} / ${nightRevealLabel}` : `Reveal hidden role and night information for ${playerName}`;

  return (
    <div
      className={`phone-private-swipe ${activeSide ? `reveal-${activeSide}` : 'reveal-hidden'} ${isDragging ? 'dragging' : ''}`}
      ref={trackRef}
      role="group"
      aria-label={fullRevealLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={resetReveal}
      onPointerCancel={resetReveal}
      onLostPointerCapture={resetReveal}
    >
      <div className={`private-swipe-panel private-swipe-left phone-role revealed ${allegiance}`} aria-hidden={activeSide !== 'left'}>
        <span className="private-swipe-label">{t('Identity')}</span>
        <div className="role-face">
          <strong>{formatRole(role, language)}</strong>
          <span>{formatAllegiance(allegiance, language)}</span>
          <p className="role-summary">{formatRoleDescription(role, language)}</p>
        </div>
      </div>

      <div className="private-swipe-slider" style={swipeStyle}>
        <div className="private-swipe-neutral">
          <span>{t('Swipe left or right to peek')}</span>
          <div className="private-swipe-actions">
            <button
              type="button"
              onPointerDown={() => reveal('left')}
              onPointerUp={resetReveal}
              onPointerCancel={resetReveal}
              onKeyDown={(event) => handleButtonKeyDown(event, 'left')}
              onKeyUp={resetReveal}
              aria-label={roleRevealLabel}
            >
              {t('Identity')}
            </button>
            <button
              type="button"
              onPointerDown={() => reveal('right')}
              onPointerUp={resetReveal}
              onPointerCancel={resetReveal}
              onKeyDown={(event) => handleButtonKeyDown(event, 'right')}
              onKeyUp={resetReveal}
              aria-label={nightRevealLabel}
            >
              {t('Night info')}
            </button>
          </div>
        </div>

        <div className="private-swipe-panel private-swipe-right phone-info phone-night-info" aria-hidden={activeSide !== 'right'}>
          <span>{t('Night info')}</span>
          <div className="night-info-face">
            {privateInfo?.sees.length ? (
              <ul>{privateInfo.sees.map((item) => <li key={item.playerId}>{item.name}: {formatHint(item.hint, language)}</li>)}</ul>
            ) : ladyChecks.length === 0 && (
              <p>{t('No extra information.')}</p>
            )}
            {ladyChecks.length > 0 && (
              <ul className="lady-checks">
                {ladyChecks.map((check) => (
                  <li key={check.targetPlayerId}>{t('Lady of the Lake')}: {check.targetName} · {formatAllegiance(check.allegiance, language)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
