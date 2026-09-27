import { getVisibilityInfo, roleAllegiance, type MissionCard, type Vote } from '../domain/avalon';
import { MAX_PROPOSALS_PER_QUEST } from '../domain/missionFlow';
import {
  type AiAvalonDecision,
  type AiBeliefAudit,
  type AiEvidenceItem,
  type AiPlayerBeliefProfile,
} from '../aiAvalon';
import { formatAllegiance, formatHint, formatRole, type Language } from '../i18n';
import { formatDemoHistoryEntry } from './demoHistory';
import { demoEndedByRejectedProposals, getDemoWinner, playerName, toDemoAvalonPlayer } from './demoRules';
import { type DemoHistoryEntry, type DemoPlayer, type DemoState } from './demoTypes';

export function buildDemoLog(demo: DemoState, language: Language): string {
  const winner = getDemoWinner(demo);
  const lines = [
    '# Avalon demo log',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Players: ${demo.playerCount}`,
    `Mode: ${demo.mode}`,
    `Manual seats: ${demo.humanCount}`,
    `AI seats: ${demo.playerCount - demo.humanCount}`,
    `Current phase: ${demo.phase}`,
    `Proposal this quest: ${demo.proposalIndex + 1}/${MAX_PROPOSALS_PER_QUEST}`,
    `Winner: ${winner ? formatAllegiance(winner, language) : 'not decided'}`,
  ];
  if (demoEndedByRejectedProposals(demo)) lines.push('End reason: five crew proposals in a row were rejected this quest.');

  lines.push('', '## Players, identities, and role vision');
  demo.players.forEach((player) => {
    const visibleInfo = getVisibilityInfo(
      { id: player.id, name: player.displayName, role: player.role },
      demo.players.map(toDemoAvalonPlayer),
    );
    lines.push(
      '',
      `### Seat ${player.seatIndex + 1}: ${player.displayName}`,
      `- Controller: ${player.controller}`,
      `- Role: ${formatRole(player.role, language)} (${formatAllegiance(roleAllegiance(player.role), language)})`,
      `- Persona: ${player.persona ?? 'human-controlled'}`,
      `- Role vision: ${visibleInfo.sees.length ? visibleInfo.sees.map((item) => `${item.name} = ${formatHint(item.hint, language)}`).join('; ') : 'none'}`,
    );
    if (player.memory) {
      lines.push(`- Suspicion memory: ${formatSuspicionMemory(player.memory.suspicion, demo)}`);
      lines.push(`- Memory notes: ${player.memory.notes.length ? player.memory.notes.join(' | ') : 'none'}`);
      lines.push('- Speech policy: ignored by design; formal actions only are used as evidence.');
      lines.push(`- Belief audit entries: ${player.memory.beliefAudit?.length ?? 0}`);
      lines.push(`- Belief profiles: ${player.memory.beliefProfiles ? Object.keys(player.memory.beliefProfiles).length : 0}`);
    }
    if (player.lastPublicSpeech) lines.push(`- Last public speech: ${player.lastPublicSpeech}`);
    if (player.lastReasoningSummary) lines.push(`- Last private reasoning: ${player.lastReasoningSummary}`);
  });

  lines.push('', '## AI belief profiles');
  const aiPlayersWithProfiles = demo.players.filter((player) => player.controller === 'ai' && player.memory?.beliefProfiles);
  if (!aiPlayersWithProfiles.length) {
    lines.push('No structured belief profiles yet.');
  }
  aiPlayersWithProfiles.forEach((actor) => {
    lines.push('', `### ${actor.displayName}'s formal-action beliefs`);
    Object.values(actor.memory?.beliefProfiles ?? {})
      .sort((left, right) => right.pEvil - left.pEvil || right.suspicionScore - left.suspicionScore || left.player.localeCompare(right.player))
      .forEach((profile) => {
        lines.push(
          '',
          `#### ${playerName(demo, profile.playerId)}`,
          `- pEvil: ${profile.pEvil.toFixed(2)}`,
          `- suspicionScore: ${profile.suspicionScore >= 0 ? '+' : ''}${profile.suspicionScore}`,
          `- Evidence for evil: ${formatEvidenceItems(profile.evidenceForEvil)}`,
          `- Evidence against evil: ${formatEvidenceItems(profile.evidenceAgainstEvil)}`,
          `- Uncertainty: ${profile.uncertainty.length ? profile.uncertainty.join(' | ') : 'none'}`,
        );
      });
  });

  lines.push('', '## Quest rounds');
  const roundIndexes = [...new Set([
    ...demo.tableHistory.map((entry) => entry.roundIndex),
    ...demo.aiHistory.map((entry) => entry.roundIndex),
    ...demo.missionResults.map((result) => result.roundIndex),
  ])].sort((left, right) => left - right);

  if (!roundIndexes.length) {
    lines.push('No rounds have been played.');
  }

  roundIndexes.forEach((roundIndex) => {
    const mission = demo.missionResults.find((result) => result.roundIndex === roundIndex);
    const teamNames = mission?.selectedTeamIds?.map((id) => playerName(demo, id)) ?? [];
    lines.push('', `### Quest ${roundIndex + 1}`);
    if (teamNames.length) lines.push(`- Team: ${teamNames.join(', ')}`);
    if (mission) {
      lines.push(`- Result: ${mission.outcome}; success cards: ${mission.successCount}; fail cards: ${mission.failCount}; required fails: ${mission.requiredFails}`);
    }
    const publicEntries = demo.tableHistory.filter((entry) => entry.roundIndex === roundIndex);
    const privateEntries = demo.aiHistory.filter((entry) => entry.roundIndex === roundIndex);
    lines.push('- Public table history:');
    if (publicEntries.length) {
      publicEntries.forEach((entry) => {
        const display = formatDemoHistoryEntry(entry, language);
        lines.push(`  - ${display.label} | ${entry.actorName ?? display.actorFallback}: ${display.text}`);
      });
    } else {
      lines.push('  - none');
    }
    lines.push('- AI private reasoning:');
    if (privateEntries.length) {
      privateEntries.forEach((entry) => {
        const display = formatDemoHistoryEntry(entry, language);
        lines.push(`  - ${display.label} | ${entry.actorName ?? display.actorFallback}: ${display.text}`);
        if (entry.audit) lines.push(...formatAuditForLog(entry.audit, demo, '    '));
      });
    } else {
      lines.push('  - none');
    }
  });

  lines.push('', '## Structured audit events');
  lines.push('```json');
  lines.push(JSON.stringify(buildStructuredAuditExport(demo), null, 2));
  lines.push('```');

  if (demo.lastVote) {
    lines.push('', '## Last vote snapshot', `- Approve: ${demo.lastVote.approveCount}`, `- Reject: ${demo.lastVote.rejectCount}`, `- Passed: ${demo.lastVote.passed}`);
  }
  if (demo.assassination) {
    lines.push('', '## Assassination', `- Target: ${demo.assassination.targetName}`, `- Hit Merlin: ${demo.assassination.hitMerlin}`, `- Winner: ${formatAllegiance(demo.assassination.winner, language)}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatSuspicionMemory(suspicion: Record<string, number>, demo: DemoState): string {
  const entries = Object.entries(suspicion);
  if (!entries.length) return 'none';
  return entries.map(([playerId, score]) => `${playerName(demo, playerId)} ${score >= 0 ? '+' : ''}${score}`).join(', ');
}

function formatEvidenceItems(items: Array<{ event: string; reason: string }>): string {
  if (!items.length) return 'none';
  return items.map((item) => `${item.event}: ${item.reason}`).join(' | ');
}

function formatAuditForLog(audit: AiBeliefAudit, demo: DemoState, indent: string): string[] {
  return [
    `${indent}- Audit event: ${audit.eventType}`,
    `${indent}- Evidence mode: ${audit.evidenceMode}`,
    `${indent}- Speech policy: ${audit.speechPolicy}`,
    `${indent}- Information used: ${audit.informationUsed.join(' | ')}`,
    `${indent}- Deductions: ${audit.deductions.join(' | ')}`,
    `${indent}- Belief before: ${formatSuspicionMemory(audit.beliefBefore, demo)}`,
    `${indent}- Belief after: ${formatSuspicionMemory(audit.beliefAfter, demo)}`,
    `${indent}- Belief deltas: ${formatSuspicionMemory(audit.beliefDeltas, demo)}`,
    `${indent}- Profile updates: ${formatProfileUpdates(audit.beliefProfilesAfter)}`,
    `${indent}- Uncertainty: ${audit.uncertainty.join(' | ')}`,
  ];
}

function formatProfileUpdates(profiles?: Record<string, AiPlayerBeliefProfile>): string {
  if (!profiles) return 'none';
  const updated = Object.values(profiles)
    .filter((profile) => profile.evidenceForEvil.length || profile.evidenceAgainstEvil.length || profile.uncertainty.length)
    .sort((left, right) => right.pEvil - left.pEvil || right.suspicionScore - left.suspicionScore)
    .slice(0, 4);
  if (!updated.length) return 'none';
  return updated.map((profile) => `${profile.player}: pEvil ${profile.pEvil.toFixed(2)}, suspicionScore ${profile.suspicionScore >= 0 ? '+' : ''}${profile.suspicionScore}`).join(' | ');
}

function buildStructuredAuditExport(demo: DemoState) {
  const idFor = createCompactPlayerIdLookup(demo.players);
  const usedRules = new Set<string>();
  const rememberRules = (rules: string[]) => rules.forEach((rule) => usedRules.add(rule));
  const beliefEvents = demo.aiHistory
    .filter((entry) => entry.audit && Object.keys(entry.audit.beliefDeltas).length)
    .map((entry, index) => {
      const audit = entry.audit as AiBeliefAudit;
      const rules = ruleCodesForAudit(audit);
      rememberRules(rules);
      return {
        id: compactEventId('be', entry, idFor, index),
        actor: entry.actorId ? idFor(entry.actorId) : undefined,
        event: `q${entry.roundIndex + 1}.${compactEventKind(entry.kind, audit.eventType)}`,
        beforeScore: compactChangedScores(audit.beliefBefore, audit.beliefDeltas, idFor),
        delta: compactNumericPlayerMap(audit.beliefDeltas, idFor),
        afterScore: compactChangedScores(audit.beliefAfter, audit.beliefDeltas, idFor),
        constraintsAdded: constraintsAddedForAudit(demo, audit, entry.actorId, idFor),
        rules,
      };
    });
  const decisions = demo.aiHistory
    .filter((entry) => entry.audit?.eventType === 'decision')
    .map((entry, index) => {
      const rules = ruleCodesForAudit(entry.audit as AiBeliefAudit);
      rememberRules(rules);
      return {
        id: compactEventId('d', entry, idFor, index),
        actor: entry.actorId ? idFor(entry.actorId) : undefined,
        phase: entry.kind,
        q: entry.roundIndex + 1,
        action: entry.data?.action ? compactActionForExport(entry.data.action, idFor) : undefined,
        used: ['formal_history', 'role_vision', 'belief_state'],
        rules,
      };
    });
  const finalBeliefs = buildCompactFinalBeliefs(demo, idFor, rememberRules);

  return {
    schema: 'avalon-audit.v2',
    exports: {
      human: 'avalon-log.md',
      machine: 'avalon-audit.compact.json',
      debug: 'avalon-audit.debug.jsonl.gz',
      debugDefault: false,
    },
    policy: {
      evidence: 'formal_actions_only',
      speech: 'ui_only',
    },
    players: Object.fromEntries(demo.players.map((player) => [idFor(player.id), {
      name: player.displayName,
      role: player.role,
      alignment: roleAllegiance(player.role),
      controller: player.controller,
    }])),
    vision: buildCompactVision(demo, idFor),
    quests: buildCompactQuests(demo, idFor),
    beliefEvents,
    decisions,
    finalBeliefs,
    ruleText: Object.fromEntries([...usedRules].sort().map((rule) => [rule, COMPACT_AUDIT_RULE_TEXT[rule] ?? rule])),
  };
}

function createCompactPlayerIdLookup(players: DemoPlayer[]) {
  const ids = new Map(players.map((player) => [player.id, `p${player.seatIndex + 1}`]));
  return (playerId: string) => ids.get(playerId) ?? playerId;
}

function compactNumericPlayerMap(values: Record<string, number>, idFor: (playerId: string) => string): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([playerId, value]) => [idFor(playerId), value]));
}

function compactChangedScores(values: Record<string, number>, deltas: Record<string, number>, idFor: (playerId: string) => string): Record<string, number> {
  return Object.fromEntries(Object.keys(deltas).map((playerId) => [idFor(playerId), values[playerId] ?? 0]));
}

function buildCompactVision(demo: DemoState, idFor: (playerId: string) => string) {
  return Object.fromEntries(
    demo.players
      .map((player) => {
        const visibility = getVisibilityInfo(
          { id: player.id, name: player.displayName, role: player.role },
          demo.players.map((candidate) => ({ id: candidate.id, name: candidate.displayName, role: candidate.role })),
        ).sees.map((item) => ({ target: idFor(item.playerId), label: compactVisionLabel(item.hint) }));
        return [idFor(player.id), visibility] as const;
      })
      .filter(([, visibility]) => visibility.length),
  );
}

function compactVisionLabel(hint: string): string {
  if (hint === 'Evil player') return 'evil';
  if (hint === 'Merlin candidate') return 'merlin_candidate';
  if (hint === 'Evil teammate') return 'evil_teammate';
  return hint.toLowerCase().replaceAll(' ', '_');
}

function buildCompactQuests(demo: DemoState, idFor: (playerId: string) => string) {
  return demo.missionResults.map((result) => {
    const entries = demo.tableHistory.filter((entry) => entry.roundIndex === result.roundIndex);
    const proposals: Array<{ leader?: string; team: string[]; votes: Record<string, Vote>; passed?: boolean }> = [];
    entries.forEach((entry) => {
      if (entry.kind === 'proposal' && entry.data?.teamIds) {
        proposals.push({ leader: entry.actorId ? idFor(entry.actorId) : undefined, team: entry.data.teamIds.map(idFor), votes: {} });
      }
      if (entry.kind === 'vote' && entry.actorId && entry.data?.vote && proposals.length) {
        proposals[proposals.length - 1].votes[idFor(entry.actorId)] = entry.data.vote;
      }
    });
    proposals.forEach((proposal) => {
      const votes = Object.values(proposal.votes);
      if (votes.length === demo.playerCount) proposal.passed = votes.filter((vote) => vote === 'approve').length > demo.playerCount / 2;
    });
    const finalProposal = [...proposals].reverse().find((proposal) => proposal.passed) ?? proposals.at(-1);
    const missionCardsDebug = Object.fromEntries(
      entries
        .filter((entry) => entry.kind === 'mission' && entry.actorId && entry.data?.missionCard)
        .map((entry) => [idFor(entry.actorId as string), entry.data?.missionCard as MissionCard]),
    );
    return {
      q: result.roundIndex + 1,
      leader: finalProposal?.leader,
      team: finalProposal?.team ?? result.selectedTeamIds?.map(idFor) ?? [],
      votes: finalProposal?.votes ?? {},
      result: {
        outcome: result.outcome,
        success: result.successCount,
        fail: result.failCount,
        requiredFails: result.requiredFails,
      },
      missionCardsDebug,
      proposals: proposals.length > 1 ? proposals : undefined,
    };
  });
}

function buildCompactFinalBeliefs(
  demo: DemoState,
  idFor: (playerId: string) => string,
  rememberRules: (rules: string[]) => void,
) {
  return demo.players
    .filter((player) => player.controller === 'ai' && player.memory?.beliefProfiles)
    .reduce<Record<string, Record<string, { pEvil: number; score: number; reason: string[]; counter?: string[] }>>>((beliefsByActor, player) => {
      beliefsByActor[idFor(player.id)] = Object.fromEntries(
        Object.values(player.memory?.beliefProfiles ?? {}).map((profile) => {
          const reason = uniqueRules(profile.evidenceForEvil.map(ruleCodeForEvidence));
          const counter = uniqueRules(profile.evidenceAgainstEvil.map(ruleCodeForEvidence));
          rememberRules([...reason, ...counter]);
          return [idFor(profile.playerId), {
            pEvil: profile.pEvil,
            score: profile.suspicionScore,
            reason,
            counter: counter.length ? counter : undefined,
          }];
        }),
      );
      return beliefsByActor;
    }, {});
}

function compactEventId(prefix: string, entry: DemoHistoryEntry, idFor: (playerId: string) => string, index: number): string {
  return `${prefix}.${index + 1}.q${entry.roundIndex + 1}.${entry.kind}.${entry.actorId ? idFor(entry.actorId) : 'table'}`;
}

function compactEventKind(kind: DemoHistoryEntry['kind'], eventType: AiBeliefAudit['eventType']): string {
  if (eventType === 'missionResult') return 'result';
  if (eventType === 'decision') return `${kind}.decision`;
  return kind;
}

function compactActionForExport(action: AiAvalonDecision['action'], idFor: (playerId: string) => string) {
  if (action.type === 'proposeTeam') return { proposeTeam: action.teamIds.map(idFor) };
  if (action.type === 'vote') return { vote: action.vote };
  if (action.type === 'missionCard') return { missionCard: action.card };
  return { assassinate: idFor(action.targetPlayerId) };
}

function constraintsAddedForAudit(demo: DemoState, audit: AiBeliefAudit, actorId: string | undefined, idFor: (playerId: string) => string) {
  if (audit.eventType !== 'missionResult') return [];
  const mission = demo.missionResults.find((result) => result.roundIndex === audit.roundIndex);
  if (!mission || mission.outcome !== 'fail' || !mission.selectedTeamIds?.length) return [];
  const rules = ruleCodesForAudit(audit);
  const candidateIds = rules.includes('GOOD_SELF_SUCCESS') && actorId
    ? mission.selectedTeamIds.filter((id) => id !== actorId)
    : mission.selectedTeamIds;
  return [{ type: 'at_least_n_evil', players: candidateIds.map(idFor), n: mission.requiredFails }];
}

function ruleCodesForAudit(audit: AiBeliefAudit): string[] {
  const text = [...audit.informationUsed, ...audit.deductions, ...audit.uncertainty].join(' ');
  const rules = ['FORMAL_ACTIONS_ONLY'];
  if (audit.eventType === 'decision') rules.push('AI_DECISION');
  if (audit.eventType === 'proposal') rules.push('PROPOSAL_BEHAVIOR');
  if (audit.eventType === 'vote') rules.push('VOTE_BEHAVIOR');
  if (audit.eventType === 'missionResult') rules.push(text.includes('Mission succeeded') ? 'SUCCESSFUL_MISSION' : 'FAILED_MISSION');
  if (text.includes("Actor's own mission card: success")) rules.push('GOOD_SELF_SUCCESS');
  if (text.includes('Role-visible players on team:') && !text.includes('Role-visible players on team: none')) rules.push('ROLE_VISION');
  if (text.includes('hidden evil/Mordred')) rules.push('MERLIN_MORDRED_HIDDEN');
  if (text.includes('Known evil teammate') || text.includes('evil teammates')) rules.push('EVIL_TEAM_VISION');
  if (text.includes('Public speech is ignored')) rules.push('SPEECH_IGNORED');
  return uniqueRules(rules);
}

function ruleCodeForEvidence(item: AiEvidenceItem): string {
  if (item.event === 'ROLE_VISION') return 'ROLE_VISION';
  if (item.event === 'EVIL_TEAM_VISION') return 'EVIL_TEAM_VISION';
  if (item.reason.includes('no Merlin-visible evil') || item.reason.includes('hidden evil/Mordred')) return 'MERLIN_MORDRED_HIDDEN';
  if (item.reason.includes('knows their own card was success')) return 'GOOD_SELF_SUCCESS';
  if (item.reason.includes('Approved a team that later failed')) return 'APPROVED_LATER_FAILED_TEAM';
  if (item.reason.includes('Rejected a team that later failed')) return 'REJECTED_LATER_FAILED_TEAM';
  if (item.reason.includes('Approved a team that succeeded')) return 'APPROVED_SUCCESSFUL_TEAM';
  if (item.reason.includes('Rejected a team that succeeded')) return 'REJECTED_SUCCESSFUL_TEAM';
  if (item.reason.includes('Proposed a team that later failed')) return 'PROPOSED_LATER_FAILED_TEAM';
  if (item.reason.includes('Proposed a team that succeeded')) return 'PROPOSED_SUCCESSFUL_TEAM';
  if (item.reason.includes('role-visible evil')) return 'ROLE_VISIBLE_EVIL_ON_TEAM';
  if (item.reason.includes('successful mission')) return 'SUCCESSFUL_MISSION';
  if (item.reason.includes('failed mission')) return 'FAILED_MISSION';
  if (item.reason.includes('low-risk team')) return 'LOW_RISK_TEAM_ACTION';
  if (item.reason.includes('suspicious')) return 'SUSPICIOUS_TEAM_ACTION';
  return item.event;
}

function uniqueRules(rules: string[]): string[] {
  return [...new Set(rules.filter(Boolean))];
}

const COMPACT_AUDIT_RULE_TEXT: Record<string, string> = {
  AI_DECISION: 'AI made a legal action from its current information set.',
  APPROVED_LATER_FAILED_TEAM: 'Approved a team that later failed.',
  APPROVED_SUCCESSFUL_TEAM: 'Approved a team that succeeded.',
  EVIL_TEAM_VISION: 'Actor has private evil-team information.',
  FAILED_MISSION: 'Mission failed, so at least the required number of fail cards came from the team.',
  FORMAL_ACTIONS_ONLY: 'Only proposals, votes, mission cards/results, and private role vision are evidence.',
  GOOD_SELF_SUCCESS: 'Good actor knows their own mission card was Success.',
  LOW_RISK_TEAM_ACTION: 'Acted on a team that looked low-risk by current belief.',
  MERLIN_MORDRED_HIDDEN: 'Merlin saw no visible evil on a failed team, so hidden evil/Mordred remains possible.',
  PROPOSAL_BEHAVIOR: 'Leader chose the mission team.',
  PROPOSED_LATER_FAILED_TEAM: 'Proposed a team that later failed.',
  PROPOSED_SUCCESSFUL_TEAM: 'Proposed a team that succeeded.',
  REJECTED_LATER_FAILED_TEAM: 'Rejected a team that later failed.',
  REJECTED_SUCCESSFUL_TEAM: 'Rejected a team that succeeded.',
  ROLE_VISIBLE_EVIL_ON_TEAM: 'Action involved a team containing role-visible evil.',
  ROLE_VISION: 'Actor used private role vision.',
  SPEECH_IGNORED: 'Speech is UI-only and ignored as evidence.',
  SUCCESSFUL_MISSION: 'Mission succeeded; this is weak positive evidence only.',
  SUSPICIOUS_TEAM_ACTION: 'Acted on a team already carrying formal-action suspicion.',
  VOTE_BEHAVIOR: 'Player approved or rejected a proposed team.',
};
