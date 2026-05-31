import { getTeamSize, getVisibilityInfo, roleAllegiance, type MissionCard, type Player, type Role, type Vote } from './domain/avalon.js';

export interface AiAgentMemory {
  suspicion: Record<string, number>;
  notes: string[];
  publicClaims: string[];
  beliefAudit?: AiBeliefAudit[];
  beliefProfiles?: Record<string, AiPlayerBeliefProfile>;
}

export interface AiEvidenceItem {
  event: string;
  reason: string;
}

export interface AiPlayerBeliefProfile {
  playerId: string;
  player: string;
  pEvil: number;
  suspicionScore: number;
  evidenceForEvil: AiEvidenceItem[];
  evidenceAgainstEvil: AiEvidenceItem[];
  uncertainty: string[];
}

export interface AiTablePlayerInput {
  id: string;
  displayName: string;
  seatIndex: number;
  role: Role;
  controller?: 'human' | 'ai';
  persona?: string;
  memory?: AiAgentMemory;
  teamVote?: Vote;
  missionCard?: MissionCard;
}

export interface AiTableHistoryEntryInput {
  roundIndex: number;
  actorId?: string;
  actorName?: string;
  kind: 'speech' | 'proposal' | 'vote' | 'mission' | 'result' | 'assassin';
  text: string;
}

export interface AiTableStateInput {
  playerCount: number;
  phase: 'setup' | 'proposal' | 'vote' | 'mission' | 'result' | 'assassin' | 'finished';
  roundIndex: number;
  leaderIndex: number;
  selectedTeamIds: string[];
  players: AiTablePlayerInput[];
  tableHistory: AiTableHistoryEntryInput[];
  missionResults: Array<{ roundIndex: number; outcome: 'success' | 'fail'; successCount: number; failCount: number; requiredFails: number; selectedTeamIds?: string[] }>;
  lastVote?: { approveCount: number; rejectCount: number; passed: boolean };
  lastMission?: { roundIndex: number; outcome: 'success' | 'fail'; successCount: number; failCount: number; requiredFails: number; selectedTeamIds?: string[] };
}

export type AiAvalonLegalAction =
  | { type: 'proposeTeam'; teamSize: number; candidatePlayerIds: string[] }
  | { type: 'vote'; values: Vote[]; selectedTeamIds: string[] }
  | { type: 'missionCard'; values: MissionCard[]; selectedTeamIds: string[] }
  | { type: 'assassinate'; candidatePlayerIds: string[] };

export type AiAvalonDecisionAction =
  | { type: 'proposeTeam'; teamIds: string[] }
  | { type: 'vote'; vote: Vote }
  | { type: 'missionCard'; card: MissionCard }
  | { type: 'assassinate'; targetPlayerId: string };

export interface AiAvalonDecisionRequest {
  formalActionPolicy: {
    evidenceMode: 'formal_actions_only';
    speechPolicy: 'ignored_by_design';
    principle: string;
    allowedEvidence: string[];
    ignoredEvidence: string[];
    costlySignalRules: string[];
    evidenceStrength: Array<{ evidence: string; strength: 'very_strong' | 'strong' | 'medium_high' | 'medium' | 'medium_low' | 'zero'; note: string }>;
  };
  game: {
    name: 'Avalon Lite';
    playerCount: number;
    roundIndex: number;
    phase: Exclude<AiTableStateInput['phase'], 'setup' | 'result' | 'finished'>;
    teamSize: number;
    selectedTeamIds: string[];
    missionResults: AiTableStateInput['missionResults'];
    lastVote?: AiTableStateInput['lastVote'];
    lastMission?: AiTableStateInput['lastMission'];
  };
  currentTurn: {
    phase: Exclude<AiTableStateInput['phase'], 'setup' | 'result' | 'finished'>;
    actorId: string;
    actorName: string;
    instruction: string;
  };
  currentActionContext: {
    actionType: AiAvalonLegalAction['type'];
    currentProposedTeamIds: string[];
    currentProposedTeam: Array<{ playerId: string; displayName: string; seatIndex: number }>;
    currentProposedTeamText: string;
    currentTeamRoleVisibleInfo: Array<{ playerId: string; displayName: string; hint: string }>;
    historyNote: string;
  };
  actingPlayer: {
    playerId: string;
    displayName: string;
    seatIndex: number;
    role: Role;
    allegiance: 'good' | 'evil';
    persona?: string;
  };
  publicPlayers: Array<{ playerId: string; displayName: string; seatIndex: number }>;
  roleVisibleInfo: Array<{ playerId: string; displayName: string; hint: string }>;
  roleVisiblePlayersOnCurrentTeam: Array<{ playerId: string; displayName: string; hint: string }>;
  formalActionHistoryNote: string;
  formalActionHistory: AiTableHistoryEntryInput[];
  /** @deprecated Use formalActionHistory. Speech entries are intentionally omitted from AI evidence. */
  publicTableHistoryNote: string;
  /** @deprecated Use formalActionHistory. Speech entries are intentionally omitted from AI evidence. */
  publicTableHistory: AiTableHistoryEntryInput[];
  beliefStateBefore: Record<string, number>;
  beliefSummary: {
    topSuspicious: Array<{ playerId: string; displayName: string; suspicion: number }>;
    topTrusted: Array<{ playerId: string; displayName: string; suspicion: number }>;
  };
  beliefProfiles: AiPlayerBeliefProfile[];
  ownMemory: AiAgentMemory;
  legalActions: AiAvalonLegalAction[];
}

export interface AiAvalonDecision {
  privateReasoningSummary: string;
  publicSpeech: string;
  action: AiAvalonDecisionAction;
  memoryUpdate: Partial<AiAgentMemory> & { note?: string };
}

export interface AiBeliefAudit {
  eventType: 'decision' | 'proposal' | 'vote' | 'missionResult';
  roundIndex: number;
  evidenceMode: 'formal_actions_only';
  speechPolicy: 'ignored_by_design';
  informationUsed: string[];
  deductions: string[];
  beliefDeltas: Record<string, number>;
  uncertainty: string[];
  beliefBefore: Record<string, number>;
  beliefAfter: Record<string, number>;
  beliefProfilesBefore?: Record<string, AiPlayerBeliefProfile>;
  beliefProfilesAfter?: Record<string, AiPlayerBeliefProfile>;
}

export interface AiBeliefUpdateResult {
  memory: AiAgentMemory;
  audit?: AiBeliefAudit;
}

export type AiFormalActionBeliefEvent =
  | { type: 'proposal'; roundIndex: number; leaderId: string; teamIds: string[] }
  | { type: 'vote'; roundIndex: number; teamIds: string[]; passed: boolean; votes: Array<{ playerId: string; vote: Vote }> };

const ACTION_ECONOMICS = {
  failedMissionOtherMember: { raw: 32, profile: 4 },
  failedMissionOtherMemberTwoFailQuest: { raw: 24, profile: 3 },
  failedMissionPublicTeamMember: { raw: 18, profile: 2 },
  merlinHiddenEvilCandidate: { raw: 34, profile: 4 },
  successfulMissionMember: { raw: -8, profile: -0.5 },
  visibleEvilMinimum: { raw: 55, profile: 8 },
  visibleEvilOnSuccessfulMissionMinimum: { raw: 35, profile: 8 },
  evilViewGoodOnFailedTeam: { raw: 10, profile: 1 },
  proposalLaterFailed: { raw: 14, profile: 2 },
  proposalLaterSucceeded: { raw: -4, profile: -0.5 },
  approveFailedTeam: { raw: 6, profile: 1 },
  rejectFailedTeam: { raw: -3, profile: -0.5 },
  approveSuccessfulTeam: { raw: -2, profile: -0.25 },
  rejectSuccessfulTeam: { raw: 2, profile: 0.25 },
  proposalWithVisibleEvil: { raw: 16, profile: 2.5 },
  proposalWithSuspiciousTeam: { raw: 8, profile: 1.25 },
  proposalWithLowRiskTeam: { raw: -3, profile: -0.25 },
  approveVisibleEvilTeam: { raw: 12, profile: 2 },
  approveSuspiciousTeam: { raw: 6, profile: 1 },
  rejectSuspiciousTeam: { raw: -3, profile: -0.5 },
  rejectLowRiskTeam: { raw: 3, profile: 0.5 },
  approveLowRiskTeam: { raw: -1, profile: -0.25 },
} as const;

export function findNextAiActor(state: AiTableStateInput): AiTablePlayerInput | undefined {
  if (state.phase === 'proposal') {
    const leader = state.players[state.leaderIndex];
    return leader?.controller === 'ai' ? leader : undefined;
  }
  if (state.phase === 'vote') return state.players.find((player) => player.controller === 'ai' && !player.teamVote);
  if (state.phase === 'mission') return state.players.find((player) => player.controller === 'ai' && state.selectedTeamIds.includes(player.id) && !player.missionCard);
  if (state.phase === 'assassin') return state.players.find((player) => player.controller === 'ai' && player.role === 'Assassin');
  return undefined;
}

export function buildAiAvalonDecisionRequest(state: AiTableStateInput, actorId: string, persona?: string): AiAvalonDecisionRequest {
  if (state.phase === 'setup' || state.phase === 'result' || state.phase === 'finished') throw new Error('AI decisions are only available during proposal, vote, mission, or assassin phases.');
  const actor = state.players.find((player) => player.id === actorId);
  if (!actor) throw new Error('Acting player is not at this table.');
  const legalActions = getLegalActionsForActor(state, actor);
  if (!legalActions.length) throw new Error('Acting player has no legal action.');
  const visibility = getVisibilityInfo(toAvalonPlayer(actor), state.players.map(toAvalonPlayer));
  const roleVisibleInfo = visibility.sees.map((item) => ({ playerId: item.playerId, displayName: item.name, hint: item.hint }));
  const publicPlayers = state.players.map((player) => ({ playerId: player.id, displayName: player.displayName, seatIndex: player.seatIndex }));
  const currentActionContext = buildCurrentActionContext(state, legalActions[0], publicPlayers, roleVisibleInfo);
  const roleVisiblePlayersOnCurrentTeam = currentActionContext.currentTeamRoleVisibleInfo;
  const ownMemory = cloneMemory(actor.memory, state.players.map((player) => player.id), actor.id);
  const beliefProfiles = formatBeliefProfilesForRequest(ownMemory, state.players, actor.id);
  const formalActionHistory = state.tableHistory.filter((entry) => entry.kind !== 'speech').slice(-24).map((entry) => ({ ...entry }));
  const formalActionHistoryNote = 'Verified formal action history only. Public speech, chat, voice, tone, claims, accusations, and defenses are intentionally omitted by design; reason only from actions that changed game state.';
  return {
    formalActionPolicy: buildFormalActionPolicy(),
    game: {
      name: 'Avalon Lite',
      playerCount: state.playerCount,
      roundIndex: state.roundIndex,
      phase: state.phase,
      teamSize: getTeamSize(state.playerCount, state.roundIndex),
      selectedTeamIds: [...state.selectedTeamIds],
      missionResults: state.missionResults.map((result) => ({ ...result })),
      lastVote: state.lastVote ? { ...state.lastVote } : undefined,
      lastMission: state.lastMission ? { ...state.lastMission } : undefined,
    },
    currentTurn: {
      phase: state.phase,
      actorId: actor.id,
      actorName: actor.displayName,
      instruction: buildCurrentTurnInstruction(state.phase, currentActionContext.currentProposedTeamText),
    },
    currentActionContext,
    actingPlayer: {
      playerId: actor.id,
      displayName: actor.displayName,
      seatIndex: actor.seatIndex,
      role: actor.role,
      allegiance: roleAllegiance(actor.role),
      persona,
    },
    publicPlayers,
    roleVisibleInfo,
    roleVisiblePlayersOnCurrentTeam,
    formalActionHistoryNote,
    formalActionHistory,
    publicTableHistoryNote: formalActionHistoryNote,
    publicTableHistory: formalActionHistory,
    beliefStateBefore: { ...ownMemory.suspicion },
    beliefSummary: summarizeBeliefForRequest(ownMemory.suspicion, state.players, actor.id),
    beliefProfiles,
    ownMemory,
    legalActions,
  };
}

export function getLegalActionsForActor(state: AiTableStateInput, actor: AiTablePlayerInput): AiAvalonLegalAction[] {
  if (state.phase === 'proposal' && state.players[state.leaderIndex]?.id === actor.id) {
    return [{ type: 'proposeTeam', teamSize: getTeamSize(state.playerCount, state.roundIndex), candidatePlayerIds: state.players.map((player) => player.id) }];
  }
  if (state.phase === 'vote' && !actor.teamVote) return [{ type: 'vote', values: ['approve', 'reject'], selectedTeamIds: [...state.selectedTeamIds] }];
  if (state.phase === 'mission' && state.selectedTeamIds.includes(actor.id) && !actor.missionCard) {
    return [{ type: 'missionCard', values: roleAllegiance(actor.role) === 'evil' ? ['success', 'fail'] : ['success'], selectedTeamIds: [...state.selectedTeamIds] }];
  }
  if (state.phase === 'assassin' && actor.role === 'Assassin') {
    return [{ type: 'assassinate', candidatePlayerIds: state.players.filter((player) => player.id !== actor.id).map((player) => player.id) }];
  }
  return [];
}

export function validateAiAvalonDecisionAction(request: AiAvalonDecisionRequest, action: unknown): AiAvalonDecisionAction {
  if (!isRecord(action)) throw new Error('AI action must be an object.');
  const legal = request.legalActions[0];
  if (!legal) throw new Error('No legal action is available.');
  if (legal.type === 'proposeTeam') {
    if (action.type !== 'proposeTeam' || !Array.isArray(action.teamIds)) throw new Error('AI action must propose a team.');
    const teamIds = action.teamIds.filter((id): id is string => typeof id === 'string');
    const uniqueTeamIds = [...new Set(teamIds)];
    if (uniqueTeamIds.length !== legal.teamSize) throw new Error(`AI proposed ${uniqueTeamIds.length} players; expected ${legal.teamSize}.`);
    const candidates = new Set(legal.candidatePlayerIds);
    if (uniqueTeamIds.some((id) => !candidates.has(id))) throw new Error('AI proposed an unknown player.');
    return { type: 'proposeTeam', teamIds: uniqueTeamIds };
  }
  if (legal.type === 'vote') {
    if (action.type !== 'vote' || (action.vote !== 'approve' && action.vote !== 'reject')) throw new Error('AI action must vote approve or reject.');
    return { type: 'vote', vote: action.vote };
  }
  if (legal.type === 'missionCard') {
    if (action.type !== 'missionCard' || (action.card !== 'success' && action.card !== 'fail')) throw new Error('AI action must submit a mission card.');
    if (!legal.values.includes(action.card)) throw new Error('AI mission card is not legal for this role.');
    return { type: 'missionCard', card: action.card };
  }
  if (legal.type === 'assassinate') {
    if (action.type !== 'assassinate' || typeof action.targetPlayerId !== 'string') throw new Error('AI action must choose an assassination target.');
    if (!legal.candidatePlayerIds.includes(action.targetPlayerId)) throw new Error('AI assassination target is not legal.');
    return { type: 'assassinate', targetPlayerId: action.targetPlayerId };
  }
  throw new Error('Unsupported legal action.');
}

export function normalizeAiAvalonDecision(request: AiAvalonDecisionRequest, value: unknown): AiAvalonDecision {
  if (!isRecord(value)) throw new Error('AI decision must be a JSON object.');
  const action = guardVoteAgainstVisibleEvil(request, validateAiAvalonDecisionAction(request, value.action), cleanText(value.privateReasoningSummary, 'No private summary provided.'));
  const privateReasoningSummary = ensurePrivateReasoningAccountsForVisibleTeamInfo(request, action, cleanText(value.privateReasoningSummary, 'No private summary provided.'));
  const publicSpeech = ensurePublicSpeechReferencesCurrentTeam(request, action, sanitizeMissionCardPublicSpeech(request, action, cleanText(value.publicSpeech, 'I have made my move.')));
  return {
    privateReasoningSummary: privateReasoningSummary.slice(0, 500),
    publicSpeech: publicSpeech.slice(0, 500),
    action,
    memoryUpdate: normalizeMemoryUpdate(value.memoryUpdate),
  };
}

function buildCurrentActionContext(
  state: AiTableStateInput,
  legalAction: AiAvalonLegalAction,
  publicPlayers: AiAvalonDecisionRequest['publicPlayers'],
  roleVisibleInfo: AiAvalonDecisionRequest['roleVisibleInfo'],
): AiAvalonDecisionRequest['currentActionContext'] {
  const currentProposedTeamIds = legalAction.type === 'vote' || legalAction.type === 'missionCard' ? [...state.selectedTeamIds] : [];
  const currentProposedTeamIdSet = new Set(currentProposedTeamIds);
  const currentProposedTeam = currentProposedTeamIds.map((id) => publicPlayers.find((player) => player.playerId === id)).filter(Boolean) as AiAvalonDecisionRequest['publicPlayers'];
  const currentTeamRoleVisibleInfo = roleVisibleInfo.filter((item) => currentProposedTeamIdSet.has(item.playerId));
  const currentProposedTeamText = formatTeamText(currentProposedTeam);
  const actionType = legalAction.type;
  return {
    actionType,
    currentProposedTeamIds,
    currentProposedTeam,
    currentProposedTeamText,
    currentTeamRoleVisibleInfo,
    historyNote: actionType === 'vote'
      ? `You are voting only on the current proposed team now: ${currentProposedTeamText}. Formal action history is historical context and may describe previous proposals or votes; public speech is ignored by design. First check currentTeamRoleVisibleInfo/roleVisiblePlayersOnCurrentTeam for role-visible information about this exact team.`
      : actionType === 'missionCard'
        ? `You are submitting a mission card only for the current mission team now: ${currentProposedTeamText}. Formal action history is historical context; public speech is ignored by design. First check currentTeamRoleVisibleInfo/roleVisiblePlayersOnCurrentTeam for role-visible information about this exact team. Include a brief privateReasoningSummary explaining why you chose success or fail; good players must submit success, while evil players should price sabotage against the cost of staying hidden. Do not reveal the chosen mission card in publicSpeech.`
        : actionType === 'assassinate'
          ? 'Good completed three quests. As Assassin, choose one good player as Merlin. If you hit Merlin, Evil wins; otherwise Good wins. Use formal action history and your private memory only; public speech is ignored by design and you are not told Merlin by the orchestrator.'
          : 'You are proposing a new team now. Formal action history is historical context only; public speech is ignored by design.',
  };
}

function buildCurrentTurnInstruction(phase: AiAvalonDecisionRequest['game']['phase'], currentTeamText: string): string {
  if (phase === 'vote') return `Vote approve or reject for the current proposed team only: ${currentTeamText}. Do not vote on or cite an older historical team as if it is current.`;
  if (phase === 'mission') return `Submit a mission card for the current mission team only: ${currentTeamText}. Include a brief private reason for the card choice: good players must submit success; evil players should weigh sabotage pressure against staying hidden. Do not reveal the chosen card publicly before mission resolution.`;
  if (phase === 'assassin') return 'Good completed three quests. Choose exactly one good player as Merlin for the Assassin endgame; do not claim certainty unless your own information supports it.';
  return 'Propose a new legal mission team for the current round.';
}

function formatTeamText(team: AiAvalonDecisionRequest['publicPlayers']): string {
  return team.length ? team.map((player) => `${player.displayName} (${player.playerId})`).join(', ') : 'none selected yet';
}

function guardVoteAgainstVisibleEvil(request: AiAvalonDecisionRequest, action: AiAvalonDecisionAction, privateReasoningSummary: string): AiAvalonDecisionAction {
  const visibleEvilOnTeam = visibleEvilPlayersOnCurrentTeam(request);
  if (request.currentActionContext.actionType !== 'vote' || action.type !== 'vote' || action.vote !== 'approve' || !visibleEvilOnTeam.length) return action;
  if (hasExplicitStrategicVisibleEvilApprovalJustification(privateReasoningSummary, visibleEvilOnTeam)) return action;
  return { type: 'vote', vote: 'reject' };
}

function ensurePrivateReasoningAccountsForVisibleTeamInfo(request: AiAvalonDecisionRequest, action: AiAvalonDecisionAction, privateReasoningSummary: string): string {
  const visibleEvilOnTeam = visibleEvilPlayersOnCurrentTeam(request);
  if (request.currentActionContext.actionType !== 'vote' || !visibleEvilOnTeam.length) return privateReasoningSummary;
  if (mentionsVisibleTeamInfo(privateReasoningSummary, visibleEvilOnTeam)) return privateReasoningSummary;
  const names = visibleEvilOnTeam.map((item) => `${item.displayName} (${item.hint})`).join(', ');
  const decision = action.type === 'vote' ? action.vote : 'vote';
  return `${privateReasoningSummary} Visible role info on the current team flags ${names}; I should ${decision === 'approve' ? 'only approve with a deliberate Merlin-cover strategy' : 'reject by default without publicly revealing certainty'}.`;
}

function visibleEvilPlayersOnCurrentTeam(request: AiAvalonDecisionRequest): AiAvalonDecisionRequest['roleVisibleInfo'] {
  const source = request.roleVisiblePlayersOnCurrentTeam?.length
    ? request.roleVisiblePlayersOnCurrentTeam
    : request.currentActionContext.currentTeamRoleVisibleInfo;
  return source.filter((item) => item.hint.toLowerCase() === 'evil player');
}

function mentionsVisibleTeamInfo(privateReasoningSummary: string, visibleItems: AiAvalonDecisionRequest['roleVisibleInfo']): boolean {
  const text = privateReasoningSummary.toLowerCase();
  return visibleItems.some((item) => text.includes(item.playerId.toLowerCase()) || text.includes(item.displayName.toLowerCase()) || text.includes(item.hint.toLowerCase()));
}

function hasExplicitStrategicVisibleEvilApprovalJustification(privateReasoningSummary: string, visibleItems: AiAvalonDecisionRequest['roleVisibleInfo']): boolean {
  const text = privateReasoningSummary.toLowerCase();
  return mentionsVisibleTeamInfo(privateReasoningSummary, visibleItems) && /\b(merlin|assassin|hide|hiding|cover|strategic|strategy|bait|trap)\b/.test(text);
}

function ensurePublicSpeechReferencesCurrentTeam(request: AiAvalonDecisionRequest, action: AiAvalonDecisionAction, publicSpeech: string): string {
  if (request.currentActionContext.actionType !== 'vote') return publicSpeech;
  const teamText = request.currentActionContext.currentProposedTeamText;
  if (!request.currentActionContext.currentProposedTeam.length) return publicSpeech;
  const speechLower = publicSpeech.toLowerCase();
  const referencesCurrentTeam = request.currentActionContext.currentProposedTeam.every((player) =>
    speechLower.includes(player.displayName.toLowerCase()) || speechLower.includes(player.playerId.toLowerCase()),
  );
  if (referencesCurrentTeam) return publicSpeech;
  const vote = action.type === 'vote' ? action.vote : 'vote';
  return `I ${vote} the current proposed team: ${teamText}.`;
}

export function formatMissionReasoningSummaryForHistory(privateReasoningSummary: string): string {
  return `Mission reasoning: ${redactExplicitMissionCardOutcome(cleanText(privateReasoningSummary, 'No private summary provided.'))}`;
}

function sanitizeMissionCardPublicSpeech(request: AiAvalonDecisionRequest, action: AiAvalonDecisionAction, publicSpeech: string): string {
  if (request.currentActionContext.actionType !== 'missionCard' || action.type !== 'missionCard') return publicSpeech;
  const lowered = publicSpeech.toLowerCase();
  if (/\b(success|fail)\b/.test(lowered) || /\b(sabotage|sabotaged|hide|hidden|evil)\b/.test(lowered)) {
    return 'Mission card submitted. We will learn from the result.';
  }
  return publicSpeech;
}

function redactExplicitMissionCardOutcome(text: string): string {
  return text
    .replace(/\b(played|submitted|chose|choose|picked|selected|used|sent)\s+(a\s+)?(mission\s+)?(card\s+)?(success|fail)\b/gi, '$1 a mission card')
    .replace(/\b(success|fail)\s+card\b/gi, 'mission card')
    .replace(/\b(card|mission card)\s*:\s*(success|fail)\b/gi, '$1 submitted');
}

export function mergeAiAgentMemory(current: AiAgentMemory, update: AiAvalonDecision['memoryUpdate'], fallbackNote: string, _publicSpeech: string): AiAgentMemory {
  return {
    suspicion: { ...current.suspicion, ...(isRecord(update.suspicion) ? numericRecord(update.suspicion) : {}) },
    notes: [...current.notes.slice(-4), cleanText(update.note, fallbackNote)].slice(-5),
    publicClaims: [...current.publicClaims].slice(-5),
    beliefAudit: current.beliefAudit?.slice(-8) ?? [],
    beliefProfiles: cloneBeliefProfiles(current.beliefProfiles),
  };
}

export function updateAiBeliefAfterFormalAction(current: AiAgentMemory, state: AiTableStateInput, actorId: string, event: AiFormalActionBeliefEvent): AiBeliefUpdateResult {
  const actor = state.players.find((player) => player.id === actorId);
  if (!actor) return { memory: current };
  const allPlayerIds = state.players.map((player) => player.id);
  const beliefBefore = normalizeSuspicionForPlayers(current.suspicion, allPlayerIds, actor.id);
  const suspicion = { ...beliefBefore };
  const beliefProfilesBefore = normalizeBeliefProfiles(current.beliefProfiles, state.players, actor.id, beliefBefore);
  const beliefProfiles = cloneBeliefProfiles(beliefProfilesBefore) ?? {};
  const visibility = getVisibilityInfo(toAvalonPlayer(actor), state.players.map(toAvalonPlayer));
  const teamIds = event.teamIds;
  const teamNames = teamIds.map((id) => playerNameFromState(state, id));
  const teamText = teamNames.join('+');
  const visibleEvilOnTeam = visibility.sees.filter((item) => item.hint === 'Evil player' && teamIds.includes(item.playerId));
  const teamProfileScore = averageProfileScore(beliefProfiles, teamIds, actor.id);
  const teamRisk = visibleEvilOnTeam.length ? 'role-visible-evil' : teamProfileScore >= 2 ? 'suspicious' : teamProfileScore <= 0 ? 'low-risk' : 'uncertain';
  const informationUsed = [
    `${event.type === 'proposal' ? 'Proposal' : 'Vote'} event in Quest ${event.roundIndex + 1}.`,
    `Team: ${teamNames.join(', ')}.`,
    `Actor role/allegiance: ${actor.role} / ${roleAllegiance(actor.role)}.`,
    `Role-visible players on team: ${visibleEvilOnTeam.length ? visibleEvilOnTeam.map((item) => `${item.name} (${item.hint})`).join(', ') : 'none'}.`,
    `Team profile suspicionScore average before event: ${teamProfileScore}.`,
  ];
  const deductions = [
    'Formal actions are costly signals, not direct truth.',
    'Proposal behavior is stronger than a single vote because the leader chooses who receives mission leverage.',
    'Votes are weak-to-medium evidence because both sides can feint.',
  ];
  const uncertainty = [
    'Good players can propose or approve bad teams with incomplete information.',
    'Evil players can reject bad teams or approve good teams for cover.',
    'Public speech is ignored by design; only verified formal actions are evidence.',
  ];

  const addEventEvidence = (
    playerId: string,
    rawDelta: number,
    profileDelta: number,
    direction: 'for' | 'against',
    eventId: string,
    reason: string,
    uncertaintyItem: string,
  ) => {
    if (playerId === actor.id) return;
    suspicion[playerId] = clampSuspicion((suspicion[playerId] ?? 0) + rawDelta);
    addBeliefEvidence(beliefProfiles, playerId, direction, eventId, reason, profileDelta, uncertaintyItem);
  };

  if (event.type === 'proposal') {
    const leader = state.players.find((player) => player.id === event.leaderId);
    const eventId = `Q${event.roundIndex + 1}_PROPOSAL`;
    informationUsed.push(`Leader: ${leader?.displayName ?? event.leaderId}.`);
    if (leader && leader.id !== actor.id) {
      if (teamRisk === 'role-visible-evil') {
        const weight = ACTION_ECONOMICS.proposalWithVisibleEvil;
        addEventEvidence(
          leader.id,
          weight.raw,
          weight.profile,
          'for',
          eventId,
          `Proposed ${teamText}, which contains role-visible evil from ${actor.displayName}'s information set.`,
          `A bad-looking proposal is strong evidence but not proof; leaders can lack ${actor.displayName}'s private role vision.`,
        );
      } else if (teamRisk === 'suspicious') {
        const weight = ACTION_ECONOMICS.proposalWithSuspiciousTeam;
        addEventEvidence(
          leader.id,
          weight.raw,
          weight.profile,
          'for',
          eventId,
          `Proposed ${teamText}, which includes seats already carrying formal-action suspicion.`,
          'Suspicious proposals are medium evidence because the leader may be testing a contested team.',
        );
      } else if (teamRisk === 'low-risk') {
        const weight = ACTION_ECONOMICS.proposalWithLowRiskTeam;
        addEventEvidence(
          leader.id,
          weight.raw,
          weight.profile,
          'against',
          eventId,
          `Proposed ${teamText}, a relatively low-risk team by current formal-action belief.`,
          'Low-risk proposals are only weak positive evidence and do not clear the leader.',
        );
      }
    }
  } else {
    informationUsed.push(`Vote result: ${event.passed ? 'passed' : 'rejected'}.`);
    event.votes.forEach(({ playerId, vote }) => {
      if (playerId === actor.id) return;
      const voter = state.players.find((player) => player.id === playerId);
      if (!voter) return;
      const eventId = `Q${event.roundIndex + 1}_VOTE`;
      if (vote === 'approve' && teamRisk === 'role-visible-evil') {
        const weight = ACTION_ECONOMICS.approveVisibleEvilTeam;
        addEventEvidence(playerId, weight.raw, weight.profile, 'for', eventId, `Approved ${teamText}, which contains role-visible evil from ${actor.displayName}'s information set.`, 'Approving a bad team is not hard proof; a good player may lack this private role vision.');
      } else if (vote === 'approve' && teamRisk === 'suspicious') {
        const weight = ACTION_ECONOMICS.approveSuspiciousTeam;
        addEventEvidence(playerId, weight.raw, weight.profile, 'for', eventId, `Approved ${teamText}, a team already carrying formal-action suspicion.`, 'Good players can approve suspicious teams with incomplete information.');
      } else if (vote === 'reject' && (teamRisk === 'role-visible-evil' || teamRisk === 'suspicious')) {
        const weight = ACTION_ECONOMICS.rejectSuspiciousTeam;
        addEventEvidence(playerId, weight.raw, weight.profile, 'against', eventId, `Rejected ${teamText}, a team that looked risky by current formal-action belief.`, `Rejecting a risky team does not clear ${voter.displayName}; evil can reject bad teams for cover.`);
      } else if (vote === 'reject' && teamRisk === 'low-risk') {
        const weight = ACTION_ECONOMICS.rejectLowRiskTeam;
        addEventEvidence(playerId, weight.raw, weight.profile, 'for', eventId, `Rejected ${teamText}, a relatively low-risk team by current formal-action belief.`, 'Good players may reject good teams because they lack alignment certainty.');
      } else if (vote === 'approve' && teamRisk === 'low-risk') {
        const weight = ACTION_ECONOMICS.approveLowRiskTeam;
        addEventEvidence(playerId, weight.raw, weight.profile, 'against', eventId, `Approved ${teamText}, a relatively low-risk team by current formal-action belief.`, 'Approving a low-risk team is very weak evidence and can be cheap cover.');
      }
    });
  }

  const beliefAfter = normalizeSuspicionForPlayers(suspicion, allPlayerIds, actor.id);
  const beliefProfilesAfter = finalizeBeliefProfiles(beliefProfiles, state.players, actor.id);
  const audit: AiBeliefAudit = {
    eventType: event.type,
    roundIndex: event.roundIndex,
    evidenceMode: 'formal_actions_only',
    speechPolicy: 'ignored_by_design',
    informationUsed,
    deductions,
    beliefDeltas: computeSuspicionDeltas(beliefBefore, beliefAfter),
    uncertainty,
    beliefBefore,
    beliefAfter,
    beliefProfilesBefore,
    beliefProfilesAfter,
  };

  if (!Object.keys(audit.beliefDeltas).length) return { memory: current };
  return {
    memory: {
      suspicion: beliefAfter,
      notes: [...current.notes.slice(-4), summarizeBeliefAudit(audit, state)].slice(-5),
      publicClaims: [...current.publicClaims].slice(-5),
      beliefAudit: [...(current.beliefAudit?.slice(-7) ?? []), audit],
      beliefProfiles: beliefProfilesAfter,
    },
    audit,
  };
}

export function updateAiBeliefAfterMissionResult(current: AiAgentMemory, state: AiTableStateInput, actorId: string): AiBeliefUpdateResult {
  const actor = state.players.find((player) => player.id === actorId);
  const mission = state.lastMission ?? state.missionResults.at(-1);
  if (!actor || !mission) return { memory: current };
  const teamIds = mission.selectedTeamIds?.length ? mission.selectedTeamIds : state.selectedTeamIds;
  if (!teamIds.length) return { memory: current };

  const allPlayerIds = state.players.map((player) => player.id);
  const beliefBefore = normalizeSuspicionForPlayers(current.suspicion, allPlayerIds, actor.id);
  const suspicion = { ...beliefBefore };
  const visibility = getVisibilityInfo(toAvalonPlayer(actor), state.players.map(toAvalonPlayer));
  const visibleEvilOnTeam = visibility.sees.filter((item) => item.hint === 'Evil player' && teamIds.includes(item.playerId));
  const actorAllegiance = roleAllegiance(actor.role);
  const actorOnTeam = teamIds.includes(actor.id);
  const ownMissionCard = actorOnTeam
    ? actor.missionCard ?? (actorAllegiance === 'good' ? 'success' : undefined)
    : undefined;
  const teamNames = teamIds.map((id) => state.players.find((player) => player.id === id)?.displayName ?? id);
  const eventId = `Q${mission.roundIndex + 1}_RESULT`;
  const teamText = teamNames.join('+');
  const beliefProfilesBefore = normalizeBeliefProfiles(current.beliefProfiles, state.players, actor.id, beliefBefore);
  const beliefProfiles = cloneBeliefProfiles(beliefProfilesBefore) ?? {};
  const addSuspicionEvidence = (
    playerId: string,
    rawDelta: number,
    profileDelta: number,
    direction: 'for' | 'against',
    reason: string,
    uncertaintyItem?: string,
    evidenceEvent = eventId,
  ) => {
    if (playerId === actor.id) return;
    suspicion[playerId] = clampSuspicion((suspicion[playerId] ?? 0) + rawDelta);
    addBeliefEvidence(beliefProfiles, playerId, direction, evidenceEvent, reason, profileDelta, uncertaintyItem);
  };
  const setSuspicionAtLeastWithEvidence = (
    playerId: string,
    minimum: number,
    minimumProfileScore: number,
    reason: string,
  ) => {
    if (playerId === actor.id) return;
    suspicion[playerId] = clampSuspicion(Math.max(suspicion[playerId] ?? 0, minimum));
    setBeliefProfileScoreAtLeast(beliefProfiles, playerId, minimumProfileScore);
    addBeliefEvidence(beliefProfiles, playerId, 'for', 'ROLE_VISION', reason, 0);
  };
  const informationUsed = [
    `Quest ${mission.roundIndex + 1} result: ${mission.outcome}; fail cards ${mission.failCount}/${mission.requiredFails}.`,
    `Quest team: ${teamNames.join(', ')}.`,
    `Actor role/allegiance: ${actor.role} / ${actorAllegiance}.`,
    `Role-visible players on team: ${visibleEvilOnTeam.length ? visibleEvilOnTeam.map((item) => `${item.name} (${item.hint})`).join(', ') : 'none'}.`,
  ];
  if (ownMissionCard) informationUsed.push(`Actor's own mission card: ${ownMissionCard}.`);

  const deductions: string[] = [];
  const uncertainty = ['Successful quests do not hard-clear team members; evil can submit success.'];

  if (mission.outcome === 'fail') {
    deductions.push(`A failed mission means at least ${mission.requiredFails} fail card${mission.requiredFails === 1 ? '' : 's'} were submitted.`);
    if (actorAllegiance === 'good') {
      if (actorOnTeam) {
        deductions.push('Actor is good and was on the failed mission, so their own card cannot be the source of the fail.');
        teamIds.filter((id) => id !== actor.id).forEach((id) => {
          const weight = mission.requiredFails > 1 ? ACTION_ECONOMICS.failedMissionOtherMemberTwoFailQuest : ACTION_ECONOMICS.failedMissionOtherMember;
          addSuspicionEvidence(
            id,
            weight.raw,
            weight.profile,
            'for',
            `Was on failed mission ${teamText}; ${actor.displayName} knows their own card was success.`,
            `${playerNameFromState(state, id)} shares responsibility with ${teamIds.filter((teamId) => teamId !== id).map((teamId) => playerNameFromState(state, teamId)).join(', ')}, so responsibility is not isolated.`,
          );
        });
      } else if (actor.role === 'Merlin' && !visibleEvilOnTeam.length) {
        deductions.push('Merlin saw no visible evil on this failed mission, so hidden evil/Mordred is likely among the team.');
        teamIds.forEach((id) => {
          const weight = ACTION_ECONOMICS.merlinHiddenEvilCandidate;
          addSuspicionEvidence(
            id,
            weight.raw,
            weight.profile,
            'for',
            `Failed mission ${teamText} contained no Merlin-visible evil, so hidden evil/Mordred is possible here.`,
            `${playerNameFromState(state, id)} is only one member of the failed team; the hidden evil candidate set is ${teamNames.join(', ')}.`,
          );
        });
      } else {
        deductions.push('Actor was not on the failed mission, so all team members become more suspicious from public evidence.');
        teamIds.forEach((id) => {
          const weight = ACTION_ECONOMICS.failedMissionPublicTeamMember;
          addSuspicionEvidence(
            id,
            weight.raw,
            weight.profile,
            'for',
            `Was on failed mission ${teamText}.`,
            `${playerNameFromState(state, id)} is not isolated; the failed team was ${teamNames.join(', ')}.`,
          );
        });
      }
      visibleEvilOnTeam.forEach((item) => {
        setSuspicionAtLeastWithEvidence(item.playerId, ACTION_ECONOMICS.visibleEvilMinimum.raw, ACTION_ECONOMICS.visibleEvilMinimum.profile, `Visible to ${actor.displayName} as evil by role vision.`);
      });
      if (visibleEvilOnTeam.length) deductions.push('Role vision already flags at least one team member as visible evil.');
    } else {
      deductions.push('Actor is evil and knows evil teammates; keep private teammate reads separate from public suspicion pressure.');
      state.players.forEach((player) => {
        if (player.id !== actor.id && roleAllegiance(player.role) === 'evil' && player.role !== 'Oberon') {
          suspicion[player.id] = Math.min(suspicion[player.id] ?? 0, -35);
          setBeliefProfileScoreAtLeast(beliefProfiles, player.id, 10);
          addBeliefEvidence(beliefProfiles, player.id, 'for', 'EVIL_TEAM_VISION', `Known evil teammate from ${actor.displayName}'s private information set.`, 0);
        }
      });
      teamIds.forEach((id) => {
        const player = state.players.find((candidate) => candidate.id === id);
        if (player && roleAllegiance(player.role) === 'good') {
          const weight = ACTION_ECONOMICS.evilViewGoodOnFailedTeam;
          addSuspicionEvidence(
            id,
            weight.raw,
            weight.profile,
            'for',
            `Good player was on failed mission ${teamText}; from evil view this creates useful public suspicion pressure.`,
            'Evil players model public suspicion separately from true alignment.',
          );
        }
      });
    }
  } else {
    deductions.push('Mission succeeded; reduce suspicion slightly but preserve uncertainty.');
    if (actorAllegiance === 'good') {
      teamIds.forEach((id) => {
        if (id !== actor.id && !visibleEvilOnTeam.some((item) => item.playerId === id)) {
          const weight = ACTION_ECONOMICS.successfulMissionMember;
          addSuspicionEvidence(
            id,
            weight.raw,
            weight.profile,
            'against',
            `Was on successful mission ${teamText}, but this is weak because evil can submit success early.`,
            `Q${mission.roundIndex + 1} success does not clear ${playerNameFromState(state, id)}.`,
          );
        }
      });
      visibleEvilOnTeam.forEach((item) => {
        setSuspicionAtLeastWithEvidence(item.playerId, ACTION_ECONOMICS.visibleEvilOnSuccessfulMissionMinimum.raw, ACTION_ECONOMICS.visibleEvilOnSuccessfulMissionMinimum.profile, `Visible to ${actor.displayName} as evil by role vision, despite the successful mission.`);
      });
    } else {
      state.players.forEach((player) => {
        if (player.id !== actor.id && roleAllegiance(player.role) === 'evil' && player.role !== 'Oberon') {
          suspicion[player.id] = Math.min(suspicion[player.id] ?? 0, -35);
          setBeliefProfileScoreAtLeast(beliefProfiles, player.id, 10);
          addBeliefEvidence(beliefProfiles, player.id, 'for', 'EVIL_TEAM_VISION', `Known evil teammate from ${actor.displayName}'s private information set.`, 0);
        }
      });
    }
  }

  const proposal = state.tableHistory.find((entry) => entry.roundIndex === mission.roundIndex && entry.kind === 'proposal' && entry.actorId);
  if (proposal?.actorId && proposal.actorId !== actor.id) {
    if (mission.outcome === 'fail') {
      const weight = ACTION_ECONOMICS.proposalLaterFailed;
      addSuspicionEvidence(
        proposal.actorId,
        weight.raw,
        weight.profile,
        'for',
        `Proposed a team that later failed (${teamText}); proposal behavior is costlier than speech because it grants mission leverage.`,
        `A failed proposal is not proof by itself; a good leader may have incomplete information.`,
        `Q${mission.roundIndex + 1}_PROPOSAL`,
      );
    } else {
      const weight = ACTION_ECONOMICS.proposalLaterSucceeded;
      addSuspicionEvidence(
        proposal.actorId,
        weight.raw,
        weight.profile,
        'against',
        `Proposed a team that succeeded (${teamText}), a mild positive signal.`,
        `Successful proposals do not hard-clear the leader because evil can build trust early.`,
        `Q${mission.roundIndex + 1}_PROPOSAL`,
      );
    }
  }

  state.players.forEach((voter) => {
    if (!voter.teamVote || voter.id === actor.id) return;
    if (mission.outcome === 'fail' && voter.teamVote === 'approve') {
      const weight = ACTION_ECONOMICS.approveFailedTeam;
      addSuspicionEvidence(
        voter.id,
        weight.raw,
        weight.profile,
        'for',
        `Approved a team that later failed (${teamText}); this is weak-to-medium evidence with real voting cost.`,
        `Good players can approve bad teams with incomplete information, so this vote is not decisive.`,
        `Q${mission.roundIndex + 1}_VOTE`,
      );
    } else if (mission.outcome === 'fail' && voter.teamVote === 'reject') {
      const weight = ACTION_ECONOMICS.rejectFailedTeam;
      addSuspicionEvidence(
        voter.id,
        weight.raw,
        weight.profile,
        'against',
        `Rejected a team that later failed (${teamText}), a mild positive signal.`,
        `Evil can reject bad teams for cover, so this vote does not clear ${voter.displayName}.`,
        `Q${mission.roundIndex + 1}_VOTE`,
      );
    } else if (mission.outcome === 'success' && voter.teamVote === 'approve') {
      const weight = ACTION_ECONOMICS.approveSuccessfulTeam;
      addSuspicionEvidence(
        voter.id,
        weight.raw,
        weight.profile,
        'against',
        `Approved a team that succeeded (${teamText}), a very weak positive signal.`,
        `Approval of a successful team is cheap cover and should barely move belief.`,
        `Q${mission.roundIndex + 1}_VOTE`,
      );
    } else if (mission.outcome === 'success' && voter.teamVote === 'reject') {
      const weight = ACTION_ECONOMICS.rejectSuccessfulTeam;
      addSuspicionEvidence(
        voter.id,
        weight.raw,
        weight.profile,
        'for',
        `Rejected a team that succeeded (${teamText}), a very weak negative signal.`,
        `Good players may reject good teams because they lack alignment information.`,
        `Q${mission.roundIndex + 1}_VOTE`,
      );
    }
  });

  if (actor.role === 'Percival') {
    uncertainty.push('Percival sees Merlin candidates only; that vision is ambiguous between Merlin and Morgana.');
  }
  if (actor.role === 'Merlin') {
    uncertainty.push('Mordred is hidden from Merlin and cannot be ruled out by Merlin vision.');
  }
  uncertainty.push('Public speech is ignored by design; only verified formal actions are evidence.');

  const beliefAfter = normalizeSuspicionForPlayers(suspicion, allPlayerIds, actor.id);
  const beliefProfilesAfter = finalizeBeliefProfiles(beliefProfiles, state.players, actor.id);
  const audit: AiBeliefAudit = {
    eventType: 'missionResult',
    roundIndex: mission.roundIndex,
    evidenceMode: 'formal_actions_only',
    speechPolicy: 'ignored_by_design',
    informationUsed,
    deductions,
    beliefDeltas: computeSuspicionDeltas(beliefBefore, beliefAfter),
    uncertainty,
    beliefBefore,
    beliefAfter,
    beliefProfilesBefore,
    beliefProfilesAfter,
  };

  return {
    memory: {
      suspicion: beliefAfter,
      notes: [...current.notes.slice(-4), summarizeBeliefAudit(audit, state)].slice(-5),
      publicClaims: [...current.publicClaims].slice(-5),
      beliefAudit: [...(current.beliefAudit?.slice(-7) ?? []), audit],
      beliefProfiles: beliefProfilesAfter,
    },
    audit,
  };
}

function normalizeMemoryUpdate(value: unknown): AiAvalonDecision['memoryUpdate'] {
  if (!isRecord(value)) return {};
  return {
    suspicion: isRecord(value.suspicion) ? numericRecord(value.suspicion) : undefined,
    notes: Array.isArray(value.notes) ? value.notes.filter((item): item is string => typeof item === 'string').slice(-5) : undefined,
    publicClaims: Array.isArray(value.publicClaims) ? value.publicClaims.filter((item): item is string => typeof item === 'string').slice(-5) : undefined,
    note: typeof value.note === 'string' ? value.note : undefined,
  };
}

function cloneMemory(memory: AiAgentMemory | undefined, playerIds: string[], selfId: string): AiAgentMemory {
  if (!memory) return { suspicion: Object.fromEntries(playerIds.filter((id) => id !== selfId).map((id) => [id, 0])), notes: [], publicClaims: [] };
  return {
    suspicion: { ...memory.suspicion },
    notes: [...memory.notes],
    publicClaims: [...memory.publicClaims],
    beliefAudit: memory.beliefAudit?.map((entry) => ({
      ...entry,
      informationUsed: [...entry.informationUsed],
      deductions: [...entry.deductions],
      beliefDeltas: { ...entry.beliefDeltas },
      uncertainty: [...entry.uncertainty],
      beliefBefore: { ...entry.beliefBefore },
      beliefAfter: { ...entry.beliefAfter },
      beliefProfilesBefore: cloneBeliefProfiles(entry.beliefProfilesBefore),
      beliefProfilesAfter: cloneBeliefProfiles(entry.beliefProfilesAfter),
    })),
    beliefProfiles: cloneBeliefProfiles(memory.beliefProfiles),
  };
}

function buildFormalActionPolicy(): AiAvalonDecisionRequest['formalActionPolicy'] {
  return {
    evidenceMode: 'formal_actions_only',
    speechPolicy: 'ignored_by_design',
    principle: 'AI does not analyze what people said; it analyzes what they paid a game-state cost to do.',
    allowedEvidence: [
      'private role and role vision available to the actor',
      'quest leaders and proposed teams',
      'team votes and whether proposals passed or failed',
      'mission team composition',
      'mission success/failure',
      'success card count, fail card count, and required fail count',
      'the actor own submitted mission card',
      'known evil teammates when the actor is evil',
    ],
    ignoredEvidence: [
      'public speech',
      'chat transcript',
      'voice transcript',
      'tone, style, persuasion, accusations, and defenses',
      'facial expression, body language, and table atmosphere',
    ],
    costlySignalRules: [
      'Treat formal actions as costly signals, not direct truth.',
      'For each action, consider its strategic benefit and cost for good and evil players.',
      'Never hard-clear a player only because they were on a successful mission.',
      'Never hard-condemn a player only because they approved a failed mission.',
      'Preserve uncertainty and update beliefs probabilistically.',
    ],
    evidenceStrength: [
      { evidence: 'private role vision', strength: 'very_strong', note: 'Hard information, but only inside the actor information set.' },
      { evidence: 'mission fail card count', strength: 'very_strong', note: 'Hard constraint on possible evil locations.' },
      { evidence: 'mission team composition', strength: 'strong', note: 'Failed teams create a suspect set.' },
      { evidence: 'actor own mission card', strength: 'strong', note: 'Good actors know they submitted success.' },
      { evidence: 'proposal behavior', strength: 'medium_high', note: 'Leaders actively choose who receives mission leverage.' },
      { evidence: 'vote behavior', strength: 'medium', note: 'Votes have cost but allow strategic feints.' },
      { evidence: 'successful mission membership', strength: 'medium_low', note: 'Mild trust signal only; evil may submit success to build cover.' },
      { evidence: 'public speech', strength: 'zero', note: 'Ignored by product design and never used as belief evidence.' },
    ],
  };
}

function summarizeBeliefForRequest(
  suspicion: Record<string, number>,
  players: AiTablePlayerInput[],
  selfId: string,
): AiAvalonDecisionRequest['beliefSummary'] {
  const entries = players
    .filter((player) => player.id !== selfId)
    .map((player) => ({ playerId: player.id, displayName: player.displayName, suspicion: suspicion[player.id] ?? 0 }))
    .sort((left, right) => right.suspicion - left.suspicion || left.displayName.localeCompare(right.displayName));
  return {
    topSuspicious: entries.slice(0, 3),
    topTrusted: [...entries].sort((left, right) => left.suspicion - right.suspicion || left.displayName.localeCompare(right.displayName)).slice(0, 3),
  };
}

function formatBeliefProfilesForRequest(memory: AiAgentMemory, players: AiTablePlayerInput[], selfId: string): AiPlayerBeliefProfile[] {
  return Object.values(normalizeBeliefProfiles(memory.beliefProfiles, players, selfId, memory.suspicion))
    .sort((left, right) => right.pEvil - left.pEvil || right.suspicionScore - left.suspicionScore || left.player.localeCompare(right.player))
    .map(cloneBeliefProfile);
}

function normalizeBeliefProfiles(
  source: Record<string, AiPlayerBeliefProfile> | undefined,
  players: AiTablePlayerInput[],
  selfId: string,
  suspicion: Record<string, number>,
): Record<string, AiPlayerBeliefProfile> {
  return Object.fromEntries(
    players
      .filter((player) => player.id !== selfId)
      .map((player) => {
        const existing = source?.[player.id];
        const fallbackScore = suspicionToProfileScore(suspicion[player.id] ?? 0);
        const profile: AiPlayerBeliefProfile = existing
          ? {
              ...cloneBeliefProfile(existing),
              playerId: player.id,
              player: player.displayName,
            }
          : {
              playerId: player.id,
              player: player.displayName,
              pEvil: profileScoreToProbability(fallbackScore),
              suspicionScore: fallbackScore,
              evidenceForEvil: [],
              evidenceAgainstEvil: [],
              uncertainty: [],
            };
        return [player.id, finalizeBeliefProfile(profile)] as const;
      }),
  );
}

function finalizeBeliefProfiles(
  profiles: Record<string, AiPlayerBeliefProfile>,
  players: AiTablePlayerInput[],
  selfId: string,
): Record<string, AiPlayerBeliefProfile> {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  return Object.fromEntries(
    Object.entries(profiles)
      .filter(([id]) => id !== selfId && playerMap.has(id))
      .map(([id, profile]) => {
        const player = playerMap.get(id);
        return [id, finalizeBeliefProfile({ ...profile, playerId: id, player: player?.displayName ?? profile.player })] as const;
      }),
  );
}

function finalizeBeliefProfile(profile: AiPlayerBeliefProfile): AiPlayerBeliefProfile {
  const suspicionScore = clampProfileScore(profile.suspicionScore);
  return {
    ...profile,
    suspicionScore,
    pEvil: profileScoreToProbability(suspicionScore),
    evidenceForEvil: profile.evidenceForEvil.slice(-8).map((item) => ({ ...item })),
    evidenceAgainstEvil: profile.evidenceAgainstEvil.slice(-8).map((item) => ({ ...item })),
    uncertainty: [...new Set(profile.uncertainty.filter(Boolean))].slice(-8),
  };
}

function addBeliefEvidence(
  profiles: Record<string, AiPlayerBeliefProfile>,
  playerId: string,
  direction: 'for' | 'against',
  event: string,
  reason: string,
  scoreDelta: number,
  uncertainty?: string,
): void {
  const profile = profiles[playerId];
  if (!profile) return;
  profile.suspicionScore = clampProfileScore(profile.suspicionScore + scoreDelta);
  const evidence = { event, reason };
  if (direction === 'for') profile.evidenceForEvil = [...profile.evidenceForEvil, evidence].slice(-8);
  else profile.evidenceAgainstEvil = [...profile.evidenceAgainstEvil, evidence].slice(-8);
  if (uncertainty) profile.uncertainty = [...new Set([...profile.uncertainty, uncertainty])].slice(-8);
  profile.pEvil = profileScoreToProbability(profile.suspicionScore);
}

function setBeliefProfileScoreAtLeast(profiles: Record<string, AiPlayerBeliefProfile>, playerId: string, minimumScore: number): void {
  const profile = profiles[playerId];
  if (!profile) return;
  profile.suspicionScore = Math.max(profile.suspicionScore, minimumScore);
  profile.pEvil = profileScoreToProbability(profile.suspicionScore);
}

function cloneBeliefProfiles(source: Record<string, AiPlayerBeliefProfile> | undefined): Record<string, AiPlayerBeliefProfile> | undefined {
  if (!source) return undefined;
  return Object.fromEntries(Object.entries(source).map(([id, profile]) => [id, cloneBeliefProfile(profile)]));
}

function cloneBeliefProfile(profile: AiPlayerBeliefProfile): AiPlayerBeliefProfile {
  return {
    ...profile,
    evidenceForEvil: profile.evidenceForEvil.map((item) => ({ ...item })),
    evidenceAgainstEvil: profile.evidenceAgainstEvil.map((item) => ({ ...item })),
    uncertainty: [...profile.uncertainty],
  };
}

function suspicionToProfileScore(suspicion: number): number {
  return clampProfileScore(Math.round((suspicion / 8) * 2) / 2);
}

function profileScoreToProbability(score: number): number {
  const clamped = clampProfileScore(score);
  if (clamped >= 10) return 0.95;
  if (clamped <= -10) return 0.05;
  const raw = 0.5 + clamped * 0.03;
  return Math.round(Math.max(0.05, Math.min(0.95, raw)) * 100) / 100;
}

function clampProfileScore(value: number): number {
  return Math.max(-10, Math.min(10, Math.round(value * 4) / 4));
}

function averageProfileScore(profiles: Record<string, AiPlayerBeliefProfile>, teamIds: string[], selfId: string): number {
  const scores = teamIds
    .filter((id) => id !== selfId)
    .map((id) => profiles[id]?.suspicionScore ?? 0);
  if (!scores.length) return 0;
  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100;
}

function toAvalonPlayer(player: AiTablePlayerInput): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}

function playerNameFromState(state: AiTableStateInput, playerId: string): string {
  return state.players.find((player) => player.id === playerId)?.displayName ?? playerId;
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))) as Record<string, number>;
}

function normalizeSuspicionForPlayers(suspicion: Record<string, number>, playerIds: string[], selfId: string): Record<string, number> {
  return Object.fromEntries(
    playerIds
      .filter((id) => id !== selfId)
      .map((id) => [id, clampSuspicion(typeof suspicion[id] === 'number' ? suspicion[id] : 0)]),
  );
}

function computeSuspicionDeltas(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(after)
      .map((id) => [id, after[id] - (before[id] ?? 0)] as const)
      .filter(([, delta]) => delta !== 0),
  );
}

function summarizeBeliefAudit(audit: AiBeliefAudit, state: AiTableStateInput): string {
  const deltas = Object.entries(audit.beliefDeltas);
  if (!deltas.length) return `Belief update after Quest ${audit.roundIndex + 1}: no suspicion changes.`;
  const formatted = deltas
    .map(([id, delta]) => `${state.players.find((player) => player.id === id)?.displayName ?? id} ${delta >= 0 ? '+' : ''}${delta}`)
    .join(', ');
  return `Belief update after Quest ${audit.roundIndex + 1}: ${formatted}.`;
}

function clampSuspicion(value: number): number {
  return Math.max(-100, Math.min(100, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
