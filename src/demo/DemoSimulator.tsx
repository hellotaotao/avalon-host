import React, { useEffect, useState } from 'react';
import {
  buildRolePreset,
  getPlayerCountRule,
  getRecommendedRolePresetOptions,
  getTeamSize,
  getVisibilityInfo,
  playerCountRange,
  roleAllegiance,
  type Allegiance,
  type MissionCard,
  type RolePresetOptions,
  type VisibilityInfo,
  type Vote,
} from '../domain/avalon';
import { MAX_PROPOSALS_PER_QUEST } from '../domain/missionFlow';
import { buildAiAvalonDecisionRequest, findNextAiActor } from '../aiAvalon';
import { copyTextToClipboard } from '../inviteShare';
import { formatHint, formatRole, useI18n } from '../i18n';
import { canEnableRoleOption, optionalRoleControls, sanitizeRoleOptions } from '../components/CreateRoomRoleConfig';
import { PlayerPhone, type PlayerPhoneAction } from '../components/PlayerPhone';
import { formatFailThresholdLabel, formatQuestLabel, summarizeRoles } from '../components/gameText';
import { applyAiDecision, applyMissionResultBeliefUpdates, hasPendingAiAction, runNextAiAction } from './demoAi';
import { buildDemoLog } from './demoAudit';
import { formatDemoHistoryEntry, makeHistory } from './demoHistory';
import {
  advanceDemoToNextQuest,
  demoEndedByRejectedProposals,
  getDemoQuestTeamNames,
  getDemoWinner,
  resolveDemoAssassination,
  resolveDemoMissionIfReady,
  resolveDemoVoteIfReady,
  toDemoAvalonPlayer,
} from './demoRules';
import { createDemoState, formatDemoSeatMix } from './demoState';
import {
  type DemoAssassination,
  type DemoHistoryEntry,
  type DemoMissionResult,
  type DemoMode,
  type DemoPlayer,
  type DemoState,
} from './demoTypes';

const DEMO_RESULT_AUTO_ADVANCE_MS = 2200;

export function DemoSimulator() {
  const { t, language } = useI18n();
  const [demo, setDemo] = useState(() => createDemoState(7, getRecommendedRolePresetOptions(7), { humanCount: 0 }));
  const [pauseAfterAiQuest, setPauseAfterAiQuest] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [demoLogCopied, setDemoLogCopied] = useState(false);
  const rule = getPlayerCountRule(demo.playerCount);
  const preset = buildRolePreset(demo.playerCount, demo.roleOptions);
  const isPureAiDemo = demo.mode === 'ai' && demo.humanCount === 0;
  const shouldPauseAfterAiQuest = isPureAiDemo && pauseAfterAiQuest;
  const teamSize = getTeamSize(demo.playerCount, demo.roundIndex);
  const selectedPlayers = demo.selectedTeamIds.map((id) => demo.players.find((player) => player.id === id)?.displayName ?? id);
  const approveCount = demo.players.filter((player) => player.teamVote === 'approve').length;
  const rejectCount = demo.players.filter((player) => player.teamVote === 'reject').length;
  const votedCount = approveCount + rejectCount;
  const missionCards = demo.players.filter((player) => demo.selectedTeamIds.includes(player.id) && player.missionCard);
  const goodScore = demo.missionResults.filter((result) => result.outcome === 'success').length;
  const evilScore = demo.missionResults.filter((result) => result.outcome === 'fail').length;
  const winner = getDemoWinner(demo);
  const includedSpecialRoles = optionalRoleControls
    .filter((control) => demo.roleOptions[control.key])
    .map((control) => control.label);

  useEffect(() => {
    if (demo.phase !== 'result' || winner || demo.roundIndex >= 4) return undefined;
    if (shouldPauseAfterAiQuest) return undefined;
    const timeout = window.setTimeout(() => {
      setDemo((current) => {
        if (current.phase !== 'result' || getDemoWinner(current) || current.roundIndex >= 4) return current;
        return advanceDemoToNextQuest(current);
      });
    }, DEMO_RESULT_AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timeout);
  }, [demo.phase, demo.roundIndex, demo.missionResults.length, shouldPauseAfterAiQuest, winner]);

  useEffect(() => {
    if (demo.mode !== 'ai' || aiBusy || winner || demo.phase === 'setup' || demo.phase === 'result' || demo.phase === 'finished') return undefined;
    if (!hasPendingAiAction(demo)) return undefined;
    const timeout = window.setTimeout(() => {
      void runAiOnce();
    }, 750);
    return () => window.clearTimeout(timeout);
  }, [aiBusy, demo, winner]);

  function resetWith(playerCount: number, roleOptions: RolePresetOptions, options: { humanCount?: number } = {}) {
    const nextHumanCount = options.humanCount ?? (demo.humanCount === demo.playerCount ? playerCount : Math.min(demo.humanCount, playerCount));
    setDemoLogCopied(false);
    setDemo(createDemoState(playerCount, sanitizeRoleOptions(playerCount, roleOptions), {
      humanCount: nextHumanCount,
    }));
  }

  function startTable() {
    setDemoLogCopied(false);
    setDemo((current) => ({
      ...current,
      phase: 'proposal',
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, undefined, 'result', `Demo roundtable started with ${current.playerCount} players and ${current.playerCount - current.humanCount} AI fill-ins.`),
      ],
    }));
  }

  function setManualSeatCount(humanCount: number) {
    resetWith(demo.playerCount, demo.roleOptions, { humanCount });
  }

  function toggleOptionalRole(key: keyof RolePresetOptions) {
    resetWith(demo.playerCount, { ...demo.roleOptions, [key]: !demo.roleOptions[key] });
  }

  async function runAiOnce() {
    if (aiBusy || !hasPendingAiAction(demo)) return;
    const actor = findNextAiActor(demo);
    if (!actor) return;
    setAiBusy(true);
    setAiStatus(`${actor.displayName} ${t('is thinking…')}`);
    try {
      const request = buildAiAvalonDecisionRequest(demo, actor.id, actor.persona);
      const response = await fetch('/api/ai-avalon', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, locale: language }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(typeof body?.error?.message === 'string' ? body.error.message : t('AI provider unavailable.'));
      }
      setDemo((current) => applyAiDecision(current, actor.id, body.decision));
      setAiStatus(`${t('AI move from')} ${body.provider ?? 'AI'}${body.model ? ` (${body.model})` : ''}.`);
    } catch (error) {
      setDemo((current) => runNextAiAction(current, language));
      setAiStatus(`${error instanceof Error ? t(error.message) : t('AI failed.')} ${t('Used local heuristic fallback.')}`);
    } finally {
      setAiBusy(false);
    }
  }

  function toggleTeamPlayer(playerId: string) {
    if (demo.phase !== 'proposal') return;
    setDemo((current) => {
      const selectedTeamIds = current.selectedTeamIds.includes(playerId)
        ? current.selectedTeamIds.filter((id) => id !== playerId)
        : [...current.selectedTeamIds, playerId];
      return { ...current, selectedTeamIds };
    });
  }

  function proposeTeam() {
    if (demo.selectedTeamIds.length !== teamSize) return;
    setDemo((current) => ({
      ...current,
      phase: 'vote',
      players: current.players.map((player) => ({ ...player, teamVote: undefined, missionCard: undefined })),
      tableHistory: [
        ...current.tableHistory,
        makeHistory(
          current,
          current.players[current.leaderIndex],
          'proposal',
          `${current.players[current.leaderIndex]?.displayName} proposed ${current.selectedTeamIds.map((id) => current.players.find((player) => player.id === id)?.displayName ?? id).join(', ')}.`,
          undefined,
          { teamIds: [...current.selectedTeamIds] },
        ),
      ],
      lastVote: undefined,
      lastMission: undefined,
    }));
  }

  function vote(playerId: string, teamVote: Vote) {
    if (demo.phase !== 'vote') return;
    setDemo((current) => {
      const voter = current.players.find((player) => player.id === playerId);
      const nextPlayers = current.players.map((player) => (player.id === playerId ? { ...player, teamVote } : player));
      const resolved = resolveDemoVoteIfReady(current, nextPlayers);
      return {
        ...current,
        players: resolved.players,
        tableHistory: [...current.tableHistory, makeHistory(current, voter, 'vote', `${voter?.displayName ?? playerId} voted ${teamVote}.`, undefined, { vote: teamVote })],
        ...resolved.statePatch,
      };
    });
  }

  function playMissionCard(playerId: string, missionCard: MissionCard) {
    if (demo.phase !== 'mission') return;
    setDemo((current) => {
      const actor = current.players.find((player) => player.id === playerId);
      const nextPlayers = current.players.map((player) => (player.id === playerId ? { ...player, missionCard } : player));
      const next = resolveDemoMissionIfReady(current, nextPlayers);
      return applyMissionResultBeliefUpdates({
        ...next,
        tableHistory: [...next.tableHistory, makeHistory(current, actor, 'mission', `${actor?.displayName ?? playerId} submitted a mission card.`, undefined, { missionCard })],
      });
    });
  }

  function chooseAssassinationTarget(targetPlayerId: string) {
    if (demo.phase !== 'assassin') return;
    setDemo((current) => resolveDemoAssassination(current, targetPlayerId));
  }

  function continueAfterAiQuestPause() {
    setDemo((current) => {
      if (current.phase !== 'result' || getDemoWinner(current) || current.roundIndex >= 4) return current;
      return advanceDemoToNextQuest(current);
    });
  }

  async function copyDemoLog() {
    setDemoLogCopied(await copyTextToClipboard(buildDemoLog(demo, language)));
  }

  return (
    <div className="demo-simulator">
      <div className="demo-heading">
        <div>
          <p className="eyebrow">{t('Not a live game')}</p>
          <h2>{t('Demo mode')}</h2>
        </div>
        <button type="button" className="demo-reset-button" onClick={() => resetWith(demo.playerCount, demo.roleOptions)}>{t('Reset table')}</button>
      </div>

      {demo.phase === 'setup' ? (
        <section className="demo-setup">
          <div className="demo-ai-intro">
            <h3>{t('Demo roundtable')}</h3>
            <p>{t('Choose the table size and manual seats. AI fills the rest; set manual seats to 0 to watch a full AI table play itself.')}</p>
          </div>
          <div>
            <h3>{t('Table size')}</h3>
            <div className="segmented" aria-label={t('Table size')}>
              {playerCountRange.map((count) => (
                <button
                  key={count}
                  type="button"
                  className={count === demo.playerCount ? 'selected' : ''}
                  onClick={() => resetWith(count, getRecommendedRolePresetOptions(count))}
                >
                  {count}
                </button>
              ))}
            </div>
            <p>{rule.goodCount} {t('Good')} / {rule.evilCount} {t('Evil')}</p>
          </div>
          <div>
            <h3>{t('Manual seats')}</h3>
            <div className="segmented" aria-label={t('Manual seats')}>
              {Array.from({ length: demo.playerCount + 1 }, (_, count) => (
                <button key={count} type="button" className={demo.humanCount === count ? 'selected' : ''} onClick={() => setManualSeatCount(count)}>
                  {count}
                </button>
              ))}
            </div>
            <p>{formatDemoSeatMix(demo.humanCount, demo.playerCount - demo.humanCount, t, language)}</p>
          </div>
          <div className="demo-role-setup">
            <h3>{t('Role setup')}</h3>
            <div className="role-preset">
              <span>{t('Fixed')}: {preset.requiredRoles.map((role) => formatRole(role, language)).join(', ')}</span>
              <span>{t('Fill')}: {summarizeRoles(preset.fillerRoles, language)}</span>
            </div>
            <div className="optional-roles">
              {optionalRoleControls.map((control) => {
                const checked = Boolean(demo.roleOptions[control.key]);
                const disabled = !checked && !canEnableRoleOption(demo.playerCount, demo.roleOptions, control.key);
                return (
                  <label key={control.key} className="check role-toggle">
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleOptionalRole(control.key)} />
                    <span><strong>{formatRole(control.label, language)}</strong><small>{t(control.note)}</small></span>
                  </label>
                );
              })}
            </div>
          </div>
          {demo.playerCount > demo.humanCount && (
            <div className="ai-instruction-card">
              <h3>{t('Agent input contract')}</h3>
              <p>{t('On each turn the orchestrator sends: rules + current phase + legal actions + public history + that agent’s role vision + that agent’s private memory. Other agents’ private memory is never included.')}</p>
            </div>
          )}
          <div className="demo-start-row">
            <button type="button" className="primary" onClick={startTable}>{t('Start demo')}</button>
          </div>
        </section>
      ) : (
        <section className="demo-setup-summary" aria-label={t('Demo table setup')}>
          <span>{t('Demo roundtable')}</span>
          <span>{demo.playerCount} {t('players')}</span>
          <span>{formatDemoSeatMix(demo.humanCount, demo.playerCount - demo.humanCount, t, language)}</span>
          <span>{rule.goodCount} {t('Good')} / {rule.evilCount} {t('Evil')}</span>
          <span>{t('Special roles')}: {includedSpecialRoles.length ? includedSpecialRoles.map((role) => formatRole(role, language)).join(', ') : t('None')}</span>
          <span>{t('Base')}: {preset.requiredRoles.map((role) => formatRole(role, language)).join(', ')}</span>
          <span>{t('Fill')}: {summarizeRoles(preset.fillerRoles, language)}</span>
        </section>
      )}

      <section className="demo-progress-sticky" aria-label={t('Quest track')}>
        <div className="quest-track">
          {[0, 1, 2, 3, 4].map((roundIndex) => {
            const result = demo.missionResults.find((item) => item.roundIndex === roundIndex);
            const threshold = rule.failThresholds[roundIndex];
            const teamNames = getDemoQuestTeamNames(demo, result?.selectedTeamIds ?? (roundIndex === demo.roundIndex ? demo.selectedTeamIds : []));
            return (
              <span key={roundIndex} className={result?.outcome ?? (roundIndex === demo.roundIndex ? 'current' : '')}>
                <strong>{formatQuestLabel(roundIndex, language)}: {rule.teamSizes[roundIndex]}{threshold > 1 ? formatFailThresholdLabel(threshold, language) : ''}</strong>
                {teamNames.length > 0 && <small>{teamNames.join(', ')}</small>}
              </span>
            );
          })}
        </div>
        <div className="status">
          <span>{t('Leader')}: {demo.players[demo.leaderIndex]?.displayName}</span>
          <span>{t('Quest')}: {demo.roundIndex + 1} {t('needs')} {teamSize}</span>
          {(demo.phase === 'proposal' || demo.phase === 'vote') && (
            <span>{t('Proposal this quest')} {demo.proposalIndex + 1}/{MAX_PROPOSALS_PER_QUEST}</span>
          )}
          <span>{t('Score')}: {t('Good')} {goodScore} / {t('Evil')} {evilScore}</span>
        </div>
      </section>

      <section className="demo-board" aria-label={t('Demo table state')}>
        {(demo.phase === 'proposal' || demo.phase === 'vote') && demo.proposalIndex + 1 >= MAX_PROPOSALS_PER_QUEST && (
          <p className="final-proposal-warning">{t('Fifth proposal this quest: if this crew is rejected, Evil wins.')}</p>
        )}
        {demo.lastVote && (
          <p className="hint">
            {t('Last vote')}: {demo.lastVote.approveCount} {t('approve')}, {demo.lastVote.rejectCount} {t('reject')}.
            {' '}
            {t('Team')} {t(demo.lastVote.passed ? 'approved' : 'rejected')}.
          </p>
        )}
        {demo.lastMission && (
          <p className="notice">
            {formatQuestLabel(demo.lastMission.roundIndex, language)} {t(demo.lastMission.outcome === 'success' ? 'succeeded' : 'failed')};
            {' '}
            {demo.lastMission.failCount} {t('fail card')}.
          </p>
        )}
        {demo.phase === 'assassin' && <p className="notice">{t('Good completed three quests. The Assassin is choosing Merlin.')}</p>}
        {demo.phase === 'finished' && winner && (
          <div className="demo-result-actions">
            <p className="notice">
              {winner === 'good'
                ? t('Good wins: the Assassin missed Merlin.')
                : demo.assassination?.hitMerlin
                  ? t('Evil wins: the Assassin found Merlin.')
                  : demoEndedByRejectedProposals(demo)
                    ? t('Evil wins because five crew proposals in a row were rejected this quest.')
                    : t('Evil wins.')}
              {' '}
              {t('Reset the table to try another setup.')}
            </p>
            <button type="button" className="primary" onClick={copyDemoLog}>{t('Copy demo log')}</button>
            {demoLogCopied && <span className="copy-status" aria-live="polite">{t('Demo log copied.')}</span>}
          </div>
        )}
        {demo.phase === 'setup' && (
          <div className="mission-step">
            <p>{t('Choose player count and roles, then start the tabletop.')}</p>
          </div>
        )}
        {demo.phase === 'proposal' && (
          <div className="mission-step">
            <p>
              {demo.players[demo.leaderIndex]?.displayName} {t('is choosing')} {teamSize} {t('players')}.
              {' '}
              {t('Selected')}: {selectedPlayers.length ? selectedPlayers.join(', ') : t('None')}.
            </p>
          </div>
        )}
        {demo.phase === 'vote' && (
          <div className="mission-step">
            <p>
              {t('Everyone votes on')} {selectedPlayers.join(', ')}.
              {' '}
              {t('Votes in')}: {votedCount}/{demo.playerCount}; {t('The table advances when every player has voted.')}
            </p>
          </div>
        )}
        {demo.phase === 'mission' && (
          <div className="mission-step">
            <p>
              {t('Mission team plays cards anonymously.')} {t('Cards in')}: {missionCards.length}/{demo.selectedTeamIds.length};
              {' '}
              {t('The quest resolves when the team is done.')}
            </p>
          </div>
        )}
        {demo.phase === 'result' && !winner && (
          <div className="mission-step">
            <p>{shouldPauseAfterAiQuest ? t('Quest result is public. Review the table history, then continue when ready.') : t('Quest result is public on every phone. Next quest starts automatically.')}</p>
          </div>
        )}
        {demo.phase === 'assassin' && (
          <div className="mission-step">
            <p>{t('Good has three successful quests. Assassin chooses one player as Merlin: hit Merlin and Evil wins; miss and Good wins.')}</p>
          </div>
        )}
        {demo.phase === 'finished' && demo.assassination && (
          <div className="mission-step">
            <p>
              {t('Assassin targeted')} {demo.assassination.targetName}.
              {' '}
              {demo.assassination.hitMerlin ? t('That was Merlin.') : t('That was not Merlin.')}
            </p>
          </div>
        )}
      </section>

      {demo.mode === 'ai' && demo.phase !== 'setup' && (
        <section className="ai-table-panel" aria-label={t('AI table orchestration')}>
          <div className="ai-table-controls">
            <div>
              <p className="eyebrow">{t('AI Orchestrator')}</p>
              <h3>{t('Independent agents, filtered vision')}</h3>
              <p>{t('AI actions are generated from each player’s own role, legal moves, public history, and private suspicion memory.')}</p>
            </div>
            {isPureAiDemo && (
              <div className="choice-row">
                <div className="ai-pause-option">
                  <button
                    type="button"
                    className={`ai-state-switch ${pauseAfterAiQuest ? 'is-on' : 'is-off'}`}
                    role="switch"
                    aria-checked={pauseAfterAiQuest}
                    aria-label={t('Pause after AI quests')}
                    aria-describedby="ai-pause-help"
                    onClick={() => setPauseAfterAiQuest(!pauseAfterAiQuest)}
                  >
                    <span>{t('Pause after AI quests')}</span>
                    <strong>{pauseAfterAiQuest ? t('On') : t('Off')}</strong>
                  </button>
                  <p id="ai-pause-help" className="ai-pause-help">{t('AI pauses after each quest result so you can review the log before continuing.')}</p>
                </div>
              </div>
            )}
          </div>
          {aiStatus && <p className="ai-status" aria-live="polite">{aiStatus}</p>}
          <DemoHistoryLog entries={demo.tableHistory.slice(-8)} />
          {demo.aiHistory.length > 0 && (
            <DemoHistoryLog entries={demo.aiHistory.slice(-5)} privateLog ariaLabel={t('AI private reasoning log')} />
          )}
        </section>
      )}

      <section className="demo-phone-grid" aria-label={t('Virtual phones')}>
        {demo.players.map((player) => (
          <DemoPhone
            key={player.id}
            player={player}
            players={demo.players}
            leaderId={demo.players[demo.leaderIndex]?.id}
            phase={demo.phase}
            selectedTeamIds={demo.selectedTeamIds}
            teamSize={teamSize}
            onToggleTeamPlayer={toggleTeamPlayer}
            onVote={vote}
            onPlayMissionCard={playMissionCard}
            onProposeTeam={proposeTeam}
            onAssassinate={chooseAssassinationTarget}
            assassination={demo.assassination}
            winner={winner}
            lastMission={demo.lastMission}
            isFinalProposal={demo.proposalIndex + 1 >= MAX_PROPOSALS_PER_QUEST}
            tableMode={demo.mode}
          />
        ))}
      </section>

      {shouldPauseAfterAiQuest && demo.phase === 'result' && !winner && (
        <div className="ai-round-pause" role="dialog" aria-modal="false" aria-labelledby="ai-round-pause-title">
          <div>
            <p className="eyebrow">{t('AI demo paused')}</p>
            <h3 id="ai-round-pause-title">{t('Review this round?')}</h3>
            <p>{t('The AI table will wait here until you start the next round.')}</p>
          </div>
          <button type="button" className="primary" onClick={continueAfterAiQuestPause}>{t('Enter next round')}</button>
        </div>
      )}
    </div>
  );
}

function DemoHistoryLog({ entries, privateLog = false, ariaLabel }: { entries: DemoHistoryEntry[]; privateLog?: boolean; ariaLabel?: string }) {
  const { language } = useI18n();

  return (
    <div className={`ai-history ${privateLog ? 'ai-private-history' : ''}`} aria-label={ariaLabel}>
      {entries.map((entry) => {
        const display = formatDemoHistoryEntry(entry, language);
        return (
          <article key={entry.id} className={`ai-history-entry history-${display.tone}`}>
            <div className="ai-history-meta">
              <span className="ai-history-label">{display.label}</span>
              <strong>{entry.actorName ?? display.actorFallback}</strong>
            </div>
            <p>{display.text}</p>
          </article>
        );
      })}
    </div>
  );
}

function DemoPhone({
  player,
  players,
  leaderId,
  phase,
  selectedTeamIds,
  teamSize,
  onToggleTeamPlayer,
  onVote,
  onPlayMissionCard,
  onProposeTeam,
  onAssassinate,
  assassination,
  winner,
  lastMission,
  isFinalProposal,
  tableMode,
}: {
  player: DemoPlayer;
  players: DemoPlayer[];
  leaderId?: string;
  phase: DemoState['phase'];
  selectedTeamIds: string[];
  teamSize: number;
  onToggleTeamPlayer: (playerId: string) => void;
  onVote: (playerId: string, vote: Vote) => void;
  onPlayMissionCard: (playerId: string, card: MissionCard) => void;
  onProposeTeam: () => void;
  onAssassinate: (targetPlayerId: string) => void;
  assassination?: DemoAssassination;
  winner?: Allegiance;
  lastMission?: DemoMissionResult;
  isFinalProposal: boolean;
  tableMode: DemoMode;
}) {
  const { t, language } = useI18n();
  const isLeader = player.id === leaderId;
  const onTeam = selectedTeamIds.includes(player.id);
  const privateInfo = getVisibilityInfo(
    { id: player.id, name: player.displayName, role: player.role },
    players.map(toDemoAvalonPlayer),
  );
  const canFailMission = roleAllegiance(player.role) === 'evil';

  return (
    <PlayerPhone
      mode="demo"
      player={player}
      privateInfo={privateInfo}
      leaderId={leaderId}
      selectedTeamIds={selectedTeamIds}
      winner={winner}
      result={phase === 'result' ? lastMission : undefined}
      agentView={tableMode === 'ai' ? getAgentViewSummary(player, privateInfo, t, language) : undefined}
      action={getDemoPhoneAction({
        player,
        players,
        leaderId,
        phase,
        isLeader,
        onTeam,
        selectedTeamIds,
        teamSize,
        canFailMission,
        winner,
        lastMission,
        isFinalProposal,
        onToggleTeamPlayer,
        onVote,
        onPlayMissionCard,
        onProposeTeam,
        onAssassinate,
        assassination,
      })}
    />
  );
}

function getDemoPhoneAction({
  player,
  players,
  leaderId,
  phase,
  isLeader,
  onTeam,
  selectedTeamIds,
  teamSize,
  canFailMission,
  winner,
  lastMission,
  isFinalProposal,
  onToggleTeamPlayer,
  onVote,
  onPlayMissionCard,
  onProposeTeam,
  onAssassinate,
  assassination,
}: {
  player: DemoPlayer;
  players: DemoPlayer[];
  leaderId?: string;
  phase: DemoState['phase'];
  isLeader: boolean;
  onTeam: boolean;
  selectedTeamIds: string[];
  teamSize: number;
  canFailMission: boolean;
  winner?: Allegiance;
  lastMission?: DemoMissionResult;
  isFinalProposal: boolean;
  onToggleTeamPlayer: (playerId: string) => void;
  onVote: (playerId: string, vote: Vote) => void;
  onPlayMissionCard: (playerId: string, card: MissionCard) => void;
  onProposeTeam: () => void;
  onAssassinate: (targetPlayerId: string) => void;
  assassination?: DemoAssassination;
}): PlayerPhoneAction | undefined {
  const isAiControlled = player.controller === 'ai';
  if (phase === 'proposal') {
    return {
      kind: 'proposal',
      isLeader,
      leaderName: players.find((candidate) => candidate.id === leaderId)?.displayName ?? 'Leader',
      teamSize,
      selectedTeamIds,
      players,
      canEdit: isLeader && !isAiControlled,
      onToggleTeamPlayer,
      onProposeTeam,
    };
  }
  if (phase === 'vote') {
    return {
      kind: 'vote',
      selectedTeamNames: selectedTeamIds.map((id) => players.find((candidate) => candidate.id === id)?.displayName ?? id),
      isFinalProposal,
      currentVote: player.teamVote,
      submittedVoteCount: players.filter((candidate) => candidate.teamVote).length,
      playerCount: players.length,
      onVote: isAiControlled ? undefined : (vote) => onVote(player.id, vote),
    };
  }
  if (phase === 'mission') {
    return {
      kind: 'mission',
      onTeam,
      selectedTeamCount: selectedTeamIds.length,
      canFailMission,
      currentMissionCard: player.missionCard,
      missionCardSubmitted: Boolean(player.missionCard),
      submittedCardCount: players.filter((candidate) => selectedTeamIds.includes(candidate.id) && candidate.missionCard).length,
      onPlayMissionCard: isAiControlled ? undefined : (card) => onPlayMissionCard(player.id, card),
    };
  }
  if (phase === 'result') {
    return {
      kind: 'result',
      winner,
      playerWon: winner && roleAllegiance(player.role) === winner,
      result: lastMission,
    };
  }
  if (phase === 'assassin') {
    return {
      kind: 'assassin',
      isAssassin: player.role === 'Assassin',
      candidates: players.filter((candidate) => candidate.role !== 'Assassin'),
      onAssassinate: player.role === 'Assassin' && !isAiControlled ? onAssassinate : undefined,
    };
  }
  if (phase === 'finished') {
    return {
      kind: 'finished',
      winner,
      playerWon: winner && roleAllegiance(player.role) === winner,
      result: lastMission,
      assassination,
    };
  }
  return undefined;
}

function getAgentViewSummary(player: DemoPlayer, privateInfo: VisibilityInfo, t: (text: string) => string, language: ReturnType<typeof useI18n>['language']): React.ReactNode {
  if (player.controller !== 'ai') return <div className="agent-card human-card"><span>{t('Human seat')}</span><p>{t("You make this player's decisions.")}</p></div>;
  return (
    <div className="agent-card">
      <span>{t('AI Agent')} · {player.persona}</span>
      <div className="agent-visible-info">
        <strong>{t('Visible info')}:</strong>
        {privateInfo.sees.length ? (
          <ul>
            {privateInfo.sees.map((item) => (
              <li key={item.playerId}>{item.name}{language === 'zh' ? '：' : ': '}{formatHint(item.hint, language)}</li>
            ))}
          </ul>
        ) : (
          <p>{t('No private identity info.')}</p>
        )}
      </div>
      {player.lastPublicSpeech && <p><strong>{t('Public')}:</strong> "{player.lastPublicSpeech}"</p>}
      {player.lastReasoningSummary && <p><strong>{t('Reasoning summary')}:</strong> {player.lastReasoningSummary}</p>}
    </div>
  );
}
