import { getTeamSize, getVisibilityInfo, roleAllegiance, type MissionCard, type Vote } from '../domain/avalon';
import { MAX_PROPOSALS_PER_QUEST } from '../domain/missionFlow';
import {
  formatMissionReasoningSummaryForHistory,
  mergeAiAgentMemory,
  updateAiBeliefAfterFormalAction,
  updateAiBeliefAfterMissionResult,
  type AiAvalonDecision,
  type AiBeliefAudit,
  type AiFormalActionBeliefEvent,
  type AiPlayerBeliefProfile,
} from '../aiAvalon';
import { formatRole, type Language } from '../i18n';
import { formatPrivateReasoningSummaryForHistory, makeHistory } from './demoHistory';
import {
  getDemoWinner,
  playerName,
  resolveDemoAssassination,
  resolveDemoMissionIfReady,
  resolveDemoVoteIfReady,
  toDemoAvalonPlayer,
} from './demoRules';
import { type AgentMemory, type DemoPlayer, type DemoState } from './demoTypes';

export function createAgentMemory(playerIds: string[], selfId: string): AgentMemory {
  return {
    suspicion: Object.fromEntries(playerIds.filter((id) => id !== selfId).map((id) => [id, 0])),
    notes: ['Opening read: no public evidence yet.'],
    publicClaims: [],
    beliefAudit: [],
    beliefProfiles: Object.fromEntries(
      playerIds
        .filter((id) => id !== selfId)
        .map((id) => [id, createEmptyBeliefProfile(id, id)]),
    ),
  };
}

function createEmptyBeliefProfile(playerId: string, player: string): AiPlayerBeliefProfile {
  return {
    playerId,
    player,
    pEvil: 0.5,
    suspicionScore: 0,
    evidenceForEvil: [],
    evidenceAgainstEvil: [],
    uncertainty: [],
  };
}

export function applyMissionResultBeliefUpdates(current: DemoState): DemoState {
  if (!current.lastMission) return current;
  const players: DemoPlayer[] = [];
  const aiHistory = [...current.aiHistory];

  current.players.forEach((player) => {
    if (player.controller !== 'ai') {
      players.push(player);
      return;
    }
    const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
    const update = updateAiBeliefAfterMissionResult(memory, current, player.id);
    players.push({ ...player, memory: update.memory });
    if (update.audit) {
      aiHistory.push(makeHistory(
        current,
        player,
        'result',
        `Belief update: ${formatBeliefDeltas(update.audit, current)}`,
        update.audit,
      ));
    }
  });

  return { ...current, players, aiHistory };
}

function applyFormalActionBeliefUpdates(current: DemoState, event: AiFormalActionBeliefEvent): DemoState {
  const players: DemoPlayer[] = [];
  const aiHistory = [...current.aiHistory];

  current.players.forEach((player) => {
    if (player.controller !== 'ai') {
      players.push(player);
      return;
    }
    const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
    const update = updateAiBeliefAfterFormalAction(memory, current, player.id, event);
    players.push({ ...player, memory: update.memory });
    if (update.audit) {
      aiHistory.push(makeHistory(
        current,
        player,
        event.type,
        `Belief update: ${formatBeliefDeltas(update.audit, current)}`,
        update.audit,
      ));
    }
  });

  return { ...current, players, aiHistory };
}

function makeDecisionAudit(current: DemoState, before: DemoPlayer, after: DemoPlayer, deduction: string): AiBeliefAudit {
  const beliefBefore = getPlayerBeliefSnapshot(current, before);
  const beliefAfter = getPlayerBeliefSnapshot(current, after);
  const beliefProfilesBefore = before.memory?.beliefProfiles;
  const beliefProfilesAfter = after.memory?.beliefProfiles;
  return {
    eventType: 'decision',
    roundIndex: current.roundIndex,
    evidenceMode: 'formal_actions_only',
    speechPolicy: 'ignored_by_design',
    informationUsed: [
      `Phase: ${current.phase}.`,
      `Quest: ${current.roundIndex + 1}.`,
      `Selected team: ${current.selectedTeamIds.length ? current.selectedTeamIds.map((id) => playerName(current, id)).join(', ') : 'none yet'}.`,
      `Role vision: ${formatDemoRoleVision(current, before)}.`,
      `Formal action history entries available: ${current.tableHistory.filter((entry) => entry.kind !== 'speech').length}.`,
    ],
    deductions: [deduction],
    beliefDeltas: computeBeliefDeltas(beliefBefore, beliefAfter),
    uncertainty: ['Decision audit v1 records the summary and belief state; it does not expose free-form chain-of-thought.', 'Public speech is ignored by design; only verified formal actions are evidence.'],
    beliefBefore,
    beliefAfter,
    beliefProfilesBefore,
    beliefProfilesAfter,
  };
}

function getPlayerBeliefSnapshot(current: DemoState, player: DemoPlayer): Record<string, number> {
  return Object.fromEntries(
    current.players
      .filter((candidate) => candidate.id !== player.id)
      .map((candidate) => [candidate.id, player.memory?.suspicion[candidate.id] ?? 0]),
  );
}

function computeBeliefDeltas(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(after)
      .map((id) => [id, after[id] - (before[id] ?? 0)] as const)
      .filter(([, delta]) => delta !== 0),
  );
}

function formatBeliefDeltas(audit: AiBeliefAudit, demo: DemoState): string {
  const entries = Object.entries(audit.beliefDeltas);
  if (!entries.length) return `Quest ${audit.roundIndex + 1}: no suspicion changes.`;
  return entries.map(([id, delta]) => `${playerName(demo, id)} ${delta >= 0 ? '+' : ''}${delta}`).join(', ');
}

function formatDemoRoleVision(current: DemoState, player: DemoPlayer): string {
  const visibility = getVisibilityInfo(
    { id: player.id, name: player.displayName, role: player.role },
    current.players.map(toDemoAvalonPlayer),
  );
  return visibility.sees.length
    ? visibility.sees.map((item) => `${item.name} (${item.hint})`).join(', ')
    : 'none';
}

export function hasPendingAiAction(demo: DemoState): boolean {
  if (demo.mode !== 'ai') return false;
  if (demo.phase === 'proposal') return demo.players[demo.leaderIndex]?.controller === 'ai';
  if (demo.phase === 'vote') return demo.players.some((player) => player.controller === 'ai' && !player.teamVote);
  if (demo.phase === 'mission') return demo.players.some((player) => player.controller === 'ai' && demo.selectedTeamIds.includes(player.id) && !player.missionCard);
  if (demo.phase === 'assassin') return demo.players.some((player) => player.controller === 'ai' && player.role === 'Assassin');
  return false;
}

export function runNextAiAction(current: DemoState, language: Language = 'en'): DemoState {
  if (current.mode !== 'ai' || current.phase === 'setup' || current.phase === 'result' || current.phase === 'finished' || getDemoWinner(current)) return current;
  if (current.phase === 'proposal') return runAiProposal(current, language);
  if (current.phase === 'vote') return runAiVote(current, language);
  if (current.phase === 'mission') return runAiMission(current, language);
  if (current.phase === 'assassin') return runAiAssassination(current, language);
  return current;
}

export function applyAiDecision(current: DemoState, actorId: string, decision: AiAvalonDecision): DemoState {
  if (current.mode !== 'ai' || current.phase === 'setup' || current.phase === 'result' || current.phase === 'finished' || getDemoWinner(current)) return current;
  const actor = current.players.find((player) => player.id === actorId);
  if (!actor || actor.controller !== 'ai') return current;
  const publicSpeech = buildAiSpeech(current, actor, decision.publicSpeech);
  const rememberedActor = rememberAgentFromDecision(actor, current, decision, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, actor, rememberedActor, decision.privateReasoningSummary);

  if (current.phase === 'proposal' && current.players[current.leaderIndex]?.id === actor.id && decision.action.type === 'proposeTeam') {
    const teamSize = getTeamSize(current.playerCount, current.roundIndex);
    const teamIds = [...new Set(decision.action.teamIds)].filter((id) => current.players.some((player) => player.id === id)).slice(0, teamSize);
    if (teamIds.length !== teamSize) return runAiProposal(current);
    const players = current.players.map((player) => (player.id === actor.id ? rememberedActor : { ...player, teamVote: undefined, missionCard: undefined }));
    const proposedState = { ...current, phase: 'vote' as const, selectedTeamIds: teamIds, players, lastVote: undefined, lastMission: undefined };
    const withHistory = {
      ...proposedState,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, rememberedActor, 'speech', publicSpeech),
        makeHistory(current, rememberedActor, 'proposal', `${rememberedActor.displayName} proposed ${teamIds.map((id) => playerName(current, id)).join(', ')}.`, undefined, { teamIds }),
      ],
      aiHistory: [
        ...current.aiHistory,
        makeHistory(current, rememberedActor, 'proposal', formatPrivateReasoningSummaryForHistory(decision.privateReasoningSummary), decisionAudit, { action: decision.action }),
      ],
    };
    return applyFormalActionBeliefUpdates(withHistory, { type: 'proposal', roundIndex: current.roundIndex, leaderId: rememberedActor.id, teamIds });
  }

  if (current.phase === 'vote' && !actor.teamVote && decision.action.type === 'vote') {
    const vote = decision.action.vote;
    const playersWithVote = current.players.map((player) => (
      player.id === actor.id ? { ...rememberedActor, teamVote: vote } : player
    ));
    const resolved = resolveDemoVoteIfReady(current, playersWithVote);
    const withHistory = {
      ...current,
      players: resolved.players,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, actor, 'speech', publicSpeech),
        makeHistory(current, actor, 'vote', `${actor.displayName} voted ${vote}.`, undefined, { vote }),
      ],
      aiHistory: [
        ...current.aiHistory,
        makeHistory(current, rememberedActor, 'vote', formatPrivateReasoningSummaryForHistory(decision.privateReasoningSummary), decisionAudit, { action: decision.action }),
      ],
      ...resolved.statePatch,
    };
    if (!resolved.statePatch.lastVote) return withHistory;
    return applyFormalActionBeliefUpdates(withHistory, {
      type: 'vote',
      roundIndex: current.roundIndex,
      teamIds: [...current.selectedTeamIds],
      passed: resolved.statePatch.lastVote.passed,
      votes: playersWithVote
        .filter((player): player is DemoPlayer & { teamVote: Vote } => Boolean(player.teamVote))
        .map((player) => ({ playerId: player.id, vote: player.teamVote })),
    });
  }

  if (current.phase === 'mission' && current.selectedTeamIds.includes(actor.id) && !actor.missionCard && decision.action.type === 'missionCard') {
    const legalCard = decision.action.card === 'fail' && roleAllegiance(actor.role) !== 'evil' ? 'success' : decision.action.card;
    const playersWithCard = current.players.map((player) => (
      player.id === actor.id ? { ...rememberedActor, missionCard: legalCard } : player
    ));
    const next = resolveDemoMissionIfReady(current, playersWithCard);
    return applyMissionResultBeliefUpdates({
      ...next,
      tableHistory: [
        ...next.tableHistory,
        makeHistory(current, actor, 'speech', publicSpeech),
        makeHistory(current, actor, 'mission', `${actor.displayName} submitted a mission card.`, undefined, { missionCard: legalCard }),
      ],
      aiHistory: [
        ...next.aiHistory,
        makeHistory(current, actor, 'mission', formatMissionReasoningSummaryForHistory(decision.privateReasoningSummary), decisionAudit, { action: decision.action }),
      ],
    });
  }

  const decisionAction = decision.action;
  if (current.phase === 'assassin' && actor.role === 'Assassin' && decisionAction.type === 'assassinate') {
    const target = current.players.find((player) => player.id === decisionAction.targetPlayerId && player.role !== 'Assassin');
    if (!target) return runAiAssassination(current);
    const rememberedPlayers = current.players.map((player) => (player.id === actor.id ? rememberedActor : player));
    const resolved = resolveDemoAssassination({ ...current, players: rememberedPlayers }, target.id);
    return {
      ...resolved,
      tableHistory: [
        ...current.tableHistory,
        makeHistory(current, rememberedActor, 'speech', publicSpeech),
        makeHistory(current, rememberedActor, 'assassin', `${rememberedActor.displayName} chose ${target.displayName} as Merlin. ${target.role === 'Merlin' ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`, undefined, { targetPlayerId: target.id }),
      ],
      aiHistory: [
        ...current.aiHistory,
        makeHistory(current, rememberedActor, 'assassin', `Assassin reasoning: ${decision.privateReasoningSummary}`, decisionAudit, { action: decision.action }),
      ],
    };
  }

  return runNextAiAction(current);
}

function rememberAgentFromDecision(player: DemoPlayer, current: DemoState, decision: AiAvalonDecision, publicSpeech: string): DemoPlayer {
  const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
  const nextMemory = mergeAiAgentMemory(memory, decision.memoryUpdate, decision.privateReasoningSummary, publicSpeech);
  return {
    ...player,
    memory: nextMemory,
    lastReasoningSummary: decision.privateReasoningSummary,
    lastPublicSpeech: publicSpeech,
  };
}

function runAiProposal(current: DemoState, language: Language = 'en'): DemoState {
  const leader = current.players[current.leaderIndex];
  if (!leader || leader.controller !== 'ai') return current;
  const teamSize = getTeamSize(current.playerCount, current.roundIndex);
  const teamIds = chooseAiTeam(current, leader, teamSize);
  const teamNames = teamIds.map((id) => playerName(current, id)).join(language === 'zh' ? '、' : ', ');
  const publicSpeech = buildAiSpeech(current, leader, localizeDemoText(language, `I want to test ${teamNames}. This team gives us information without overloading one suspicious seat.`, `我想先试 ${teamNames}。这队能给桌面信息，也不会把压力都压在一个可疑座位上。`));
  const reasoning = localizeDemoText(
    language,
    `As ${leader.role}, choose a team that includes self when useful, favours lower suspicion, and ${roleAllegiance(leader.role) === 'evil' ? 'keeps evil options live' : 'avoids suspicious seats'}.`,
    `作为 ${formatRole(leader.role, language)}，优先选择可控且怀疑度较低的队伍；${roleAllegiance(leader.role) === 'evil' ? '同时保留坏人行动空间。' : '尽量避开可疑座位。'}`,
  );
  const updatedLeader = rememberAgent(leader, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, leader, updatedLeader, reasoning);
  const players = current.players.map((player) => (player.id === leader.id ? updatedLeader : { ...player, teamVote: undefined, missionCard: undefined }));
  const proposedState = {
    ...current,
    phase: 'vote' as const,
    selectedTeamIds: teamIds,
    players,
    lastVote: undefined,
    lastMission: undefined,
  };
  const withHistory = {
    ...proposedState,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, updatedLeader, 'speech', publicSpeech),
      makeHistory(current, updatedLeader, 'proposal', `${updatedLeader.displayName} proposed ${teamIds.map((id) => playerName(current, id)).join(', ')}.`, undefined, { teamIds }),
    ],
    aiHistory: [
      ...current.aiHistory,
      makeHistory(current, updatedLeader, 'proposal', formatPrivateReasoningSummaryForHistory(reasoning), decisionAudit, { action: { type: 'proposeTeam', teamIds } }),
    ],
  };
  return applyFormalActionBeliefUpdates(withHistory, { type: 'proposal', roundIndex: current.roundIndex, leaderId: updatedLeader.id, teamIds });
}

function runAiVote(current: DemoState, language: Language = 'en'): DemoState {
  const voter = current.players.find((player) => player.controller === 'ai' && !player.teamVote);
  if (!voter) return current;
  const vote = chooseAiVote(current, voter);
  const selectedNames = current.selectedTeamIds.map((id) => playerName(current, id)).join(language === 'zh' ? '、' : ', ');
  const publicSpeech = buildAiSpeech(
    current,
    voter,
    vote === 'approve'
      ? localizeDemoText(language, `I can approve ${selectedNames}; the table composition is acceptable for this quest.`, `我可以赞成 ${selectedNames}；这个任务队伍目前可以接受。`)
      : localizeDemoText(language, `I reject ${selectedNames}; this team does not give me enough confidence.`, `我反对 ${selectedNames}；这队现在还不能让我放心。`),
  );
  const visibleEvil = visibleEvilPlayersOnCurrentDemoTeam(current, voter);
  const reasoning = visibleEvil.length
    ? localizeDemoText(
      language,
      `Vote ${vote}; role-visible info flags ${visibleEvil.map((player) => player.name).join(', ')} as evil on the current team, so avoid approving without exposing certainty.`,
      `投票${vote === 'approve' ? '赞成' : '反对'}；身份视野显示当前队伍里 ${visibleEvil.map((player) => player.name).join('、')} 是坏人，因此不能轻易赞成，也要避免公开暴露确定信息。`,
    )
    : localizeDemoText(language, `Vote ${vote}; team suspicion score ${scoreTeamSuspicion(current, voter, current.selectedTeamIds)}.`, `投票${vote === 'approve' ? '赞成' : '反对'}；当前队伍怀疑分为 ${scoreTeamSuspicion(current, voter, current.selectedTeamIds)}。`);
  const rememberedVoter = rememberAgent(voter, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, voter, rememberedVoter, reasoning);
  const playersWithVote = current.players.map((player) => (
    player.id === voter.id ? { ...rememberedVoter, teamVote: vote } : player
  ));
  const resolved = resolveDemoVoteIfReady(current, playersWithVote);
  const withHistory = {
    ...current,
    players: resolved.players,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, voter, 'speech', publicSpeech),
      makeHistory(current, voter, 'vote', `${voter.displayName} voted ${vote}.`, undefined, { vote }),
    ],
    aiHistory: [
      ...current.aiHistory,
      makeHistory(current, voter, 'vote', formatPrivateReasoningSummaryForHistory(reasoning), decisionAudit, { action: { type: 'vote', vote } }),
    ],
    ...resolved.statePatch,
  };
  if (!resolved.statePatch.lastVote) return withHistory;
  return applyFormalActionBeliefUpdates(withHistory, {
    type: 'vote',
    roundIndex: current.roundIndex,
    teamIds: [...current.selectedTeamIds],
    passed: resolved.statePatch.lastVote.passed,
    votes: playersWithVote
      .filter((player): player is DemoPlayer & { teamVote: Vote } => Boolean(player.teamVote))
      .map((player) => ({ playerId: player.id, vote: player.teamVote })),
  });
}

function runAiMission(current: DemoState, language: Language = 'en'): DemoState {
  const actor = current.players.find((player) => player.controller === 'ai' && current.selectedTeamIds.includes(player.id) && !player.missionCard);
  if (!actor) return current;
  const card: MissionCard = roleAllegiance(actor.role) === 'evil' ? chooseEvilMissionCard(current, actor) : 'success';
  const publicSpeech = buildAiSpeech(current, actor, localizeDemoText(language, 'Mission card submitted. We will learn from the result.', '任务票已提交。等结果出来再继续判断。'));
  const reasoning = roleAllegiance(actor.role) === 'evil'
    ? localizeDemoText(language, 'Mission choice weighs sabotage pressure against staying hidden; early stacked evil teams may hide to avoid linking allies.', '任务票选择要权衡破坏任务和隐藏身份；早期坏人扎堆时可以先藏，避免把队友连在一起。')
    : localizeDemoText(language, 'Good roles must submit success, so the mission choice is forced.', '好人必须提交成功票，所以任务票选择是固定的。');
  const rememberedActor = rememberAgent(actor, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, actor, rememberedActor, reasoning);
  const playersWithCard = current.players.map((player) => (
    player.id === actor.id ? { ...rememberedActor, missionCard: card } : player
  ));
  const next = resolveDemoMissionIfReady(current, playersWithCard);
  return applyMissionResultBeliefUpdates({
    ...next,
    tableHistory: [
      ...next.tableHistory,
      makeHistory(current, actor, 'speech', publicSpeech),
      makeHistory(current, actor, 'mission', `${actor.displayName} submitted a mission card.`, undefined, { missionCard: card }),
    ],
    aiHistory: [
      ...next.aiHistory,
      makeHistory(current, actor, 'mission', formatMissionReasoningSummaryForHistory(reasoning), decisionAudit, { action: { type: 'missionCard', card } }),
    ],
  });
}

function runAiAssassination(current: DemoState, language: Language = 'en'): DemoState {
  const assassin = current.players.find((player) => player.controller === 'ai' && player.role === 'Assassin');
  if (!assassin) return current;
  const target = chooseAiAssassinationTarget(current, assassin);
  const publicSpeech = buildAiSpeech(current, assassin, localizeDemoText(language, `I choose ${target.displayName} as Merlin.`, `我选择 ${target.displayName} 作为梅林目标。`));
  const reasoning = localizeDemoText(language, `Assassin heuristic: target the good player with the strongest Merlin signals from private suspicion memory and public quest history; selected ${target.displayName}.`, `刺客推理：根据私有怀疑记忆和公开任务历史，选择最像梅林的好人；目标是 ${target.displayName}。`);
  const rememberedAssassin = rememberAgent(assassin, current, reasoning, publicSpeech);
  const decisionAudit = makeDecisionAudit(current, assassin, rememberedAssassin, reasoning);
  const withMemory = { ...current, players: current.players.map((player) => (player.id === assassin.id ? rememberedAssassin : player)) };
  const resolved = resolveDemoAssassination(withMemory, target.id);
  return {
    ...resolved,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(current, rememberedAssassin, 'speech', publicSpeech),
      makeHistory(current, rememberedAssassin, 'assassin', `${rememberedAssassin.displayName} chose ${target.displayName} as Merlin. ${target.role === 'Merlin' ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`, undefined, { targetPlayerId: target.id }),
    ],
    aiHistory: [
      ...current.aiHistory,
      makeHistory(current, rememberedAssassin, 'assassin', reasoning, decisionAudit, { action: { type: 'assassinate', targetPlayerId: target.id } }),
    ],
  };
}

function chooseAiTeam(current: DemoState, leader: DemoPlayer, teamSize: number): string[] {
  const bySuspicion = [...current.players].sort((left, right) => suspicionFor(leader, left.id) - suspicionFor(leader, right.id));
  const team = new Set<string>();
  if (roleAllegiance(leader.role) === 'evil') {
    team.add(leader.id);
    const visibleEvilIds = getDemoVisibleEvilIds(current, leader);
    const ally = current.players.find((player) => visibleEvilIds.has(player.id));
    if (ally && team.size < teamSize) team.add(ally.id);
  } else if (teamSize > 1) {
    team.add(leader.id);
  }
  bySuspicion.forEach((player) => {
    if (team.size < teamSize) team.add(player.id);
  });
  return [...team].slice(0, teamSize);
}

function chooseAiVote(current: DemoState, voter: DemoPlayer): Vote {
  const selfOnTeam = current.selectedTeamIds.includes(voter.id);
  const suspicionScore = scoreTeamSuspicion(current, voter, current.selectedTeamIds);
  if (roleAllegiance(voter.role) === 'evil') return selfOnTeam || suspicionScore > -30 ? 'approve' : 'reject';
  // Rejecting the last allowed proposal hands Evil the game.
  if (current.proposalIndex + 1 >= MAX_PROPOSALS_PER_QUEST) return 'approve';
  if (visibleEvilPlayersOnCurrentDemoTeam(current, voter).length) return 'reject';
  return suspicionScore <= 45 || selfOnTeam ? 'approve' : 'reject';
}

// Evil players the viewer sees at night: teammates for evil roles, suspects for Merlin.
function getDemoVisibleEvilIds(current: DemoState, viewer: DemoPlayer): Set<string> {
  const info = getVisibilityInfo(
    { id: viewer.id, name: viewer.displayName, role: viewer.role },
    current.players.map((player) => ({ id: player.id, name: player.displayName, role: player.role })),
  );
  return new Set(info.sees.filter((item) => item.hint !== 'Merlin candidate').map((item) => item.playerId));
}

function visibleEvilPlayersOnCurrentDemoTeam(current: DemoState, viewer: DemoPlayer): Array<{ playerId: string; name: string; hint: string }> {
  const currentTeamIds = new Set(current.selectedTeamIds);
  return getVisibilityInfo(
    { id: viewer.id, name: viewer.displayName, role: viewer.role },
    current.players.map((player) => ({ id: player.id, name: player.displayName, role: player.role })),
  ).sees.filter((item) => item.hint === 'Evil player' && currentTeamIds.has(item.playerId));
}

function chooseEvilMissionCard(current: DemoState, actor: DemoPlayer): MissionCard {
  const visibleEvilIds = getDemoVisibleEvilIds(current, actor);
  const evilOnTeam = current.selectedTeamIds.filter((id) => id === actor.id || visibleEvilIds.has(id)).length;
  if (current.roundIndex === 0 && evilOnTeam > 1 && actor.role !== 'Assassin') return 'success';
  return 'fail';
}

function chooseAiAssassinationTarget(current: DemoState, assassin: DemoPlayer): DemoPlayer {
  const visibleEvilIds = getDemoVisibleEvilIds(current, assassin);
  const goodCandidates = current.players.filter((player) => player.id !== assassin.id && !visibleEvilIds.has(player.id));
  const successfulTeamIds = current.missionResults
    .filter((result) => result.outcome === 'success')
    .flatMap((result) => result.selectedTeamIds ?? []);
  const successfulTeamCounts = successfulTeamIds.reduce<Record<string, number>>((counts, id) => {
    counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  }, {});
  return [...goodCandidates].sort((left, right) => {
    const rightScore = suspicionFor(assassin, right.id) + (successfulTeamCounts[right.id] ?? 0) * 12;
    const leftScore = suspicionFor(assassin, left.id) + (successfulTeamCounts[left.id] ?? 0) * 12;
    return rightScore - leftScore || left.seatIndex - right.seatIndex;
  })[0] ?? goodCandidates[0] ?? current.players[0];
}

function rememberAgent(player: DemoPlayer, current: DemoState, reasoning: string, publicSpeech: string): DemoPlayer {
  if (player.controller !== 'ai') return player;
  const nextMemory = updateAgentMemory(player, current, reasoning, publicSpeech);
  return {
    ...player,
    memory: nextMemory,
    lastReasoningSummary: reasoning,
    lastPublicSpeech: publicSpeech,
  };
}

function updateAgentMemory(player: DemoPlayer, current: DemoState, reasoning: string, _publicSpeech: string): AgentMemory {
  const memory = player.memory ?? createAgentMemory(current.players.map((candidate) => candidate.id), player.id);
  const suspicion = { ...memory.suspicion };
  const visibleEvilIds = roleAllegiance(player.role) === 'evil' ? getDemoVisibleEvilIds(current, player) : new Set<string>();
  current.selectedTeamIds.forEach((id) => {
    if (visibleEvilIds.has(id)) suspicion[id] = -35;
  });
  return {
    suspicion,
    notes: [...memory.notes.slice(-3), reasoning],
    publicClaims: [...memory.publicClaims].slice(-3),
    beliefAudit: memory.beliefAudit?.slice(-8) ?? [],
    beliefProfiles: memory.beliefProfiles,
  };
}

function scoreTeamSuspicion(current: DemoState, voter: DemoPlayer, teamIds: string[]): number {
  return teamIds.reduce((score, id) => score + suspicionFor(voter, id), 0);
}

function suspicionFor(viewer: DemoPlayer, targetId: string): number {
  if (targetId === viewer.id) return roleAllegiance(viewer.role) === 'evil' ? -20 : -12;
  const target = viewer.memory?.beliefProfiles?.[targetId];
  if (target && roleAllegiance(viewer.role) !== 'evil') return Math.round(target.suspicionScore * 8);
  return viewer.memory?.suspicion[targetId] ?? 0;
}

function buildAiSpeech(_current: DemoState, player: DemoPlayer, fallback: string): string {
  if (player.role === 'Merlin' && fallback.includes('confidence')) return fallback.replace('confidence', 'behavioural confidence');
  if (player.persona?.includes('Aggressive')) return fallback.replace('I ', 'I strongly ');
  return fallback;
}

function localizeDemoText(language: Language, en: string, zh: string): string {
  return language === 'zh' ? zh : en;
}
