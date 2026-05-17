import { getTeamSize, getVisibilityInfo, roleAllegiance, type MissionCard, type Player, type Role, type Vote } from './domain/avalon.js';

export interface AiAgentMemory {
  suspicion: Record<string, number>;
  notes: string[];
  publicClaims: string[];
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
  missionResults: Array<{ roundIndex: number; outcome: 'success' | 'fail'; successCount: number; failCount: number; requiredFails: number }>;
  lastVote?: { approveCount: number; rejectCount: number; passed: boolean };
  lastMission?: { roundIndex: number; outcome: 'success' | 'fail'; successCount: number; failCount: number; requiredFails: number };
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
  publicTableHistoryNote: string;
  publicTableHistory: AiTableHistoryEntryInput[];
  ownMemory: AiAgentMemory;
  legalActions: AiAvalonLegalAction[];
}

export interface AiAvalonDecision {
  privateReasoningSummary: string;
  publicSpeech: string;
  action: AiAvalonDecisionAction;
  memoryUpdate: Partial<AiAgentMemory> & { note?: string };
}

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
  return {
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
    publicTableHistoryNote: 'Historical public transcript only. It may mention older proposed teams; do not treat those as the current proposal. For the action now, use currentActionContext as authoritative. During mission-card actions, give a brief private reason for the card choice; public speech must not reveal the chosen card before mission resolution.',
    publicTableHistory: state.tableHistory.slice(-24).map((entry) => ({ ...entry })),
    ownMemory: cloneMemory(actor.memory, state.players.map((player) => player.id), actor.id),
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
      ? `You are voting only on the current proposed team now: ${currentProposedTeamText}. Public table history is historical context and may describe previous proposals. First check currentTeamRoleVisibleInfo/roleVisiblePlayersOnCurrentTeam for role-visible information about this exact team.`
      : actionType === 'missionCard'
        ? `You are submitting a mission card only for the current mission team now: ${currentProposedTeamText}. Public table history is historical context. First check currentTeamRoleVisibleInfo/roleVisiblePlayersOnCurrentTeam for role-visible information about this exact team. Include a brief privateReasoningSummary explaining why you chose success or fail; good players must submit success, while evil players should weigh sabotage against staying hidden. Do not reveal the chosen mission card in publicSpeech.`
        : actionType === 'assassinate'
          ? 'Good completed three quests. As Assassin, choose one good player as Merlin. If you hit Merlin, Evil wins; otherwise Good wins. Use public history and your private memory only; you are not told Merlin by the orchestrator.'
          : 'You are proposing a new team now. Public table history is historical context only.',
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

export function mergeAiAgentMemory(current: AiAgentMemory, update: AiAvalonDecision['memoryUpdate'], fallbackNote: string, publicSpeech: string): AiAgentMemory {
  return {
    suspicion: { ...current.suspicion, ...(isRecord(update.suspicion) ? numericRecord(update.suspicion) : {}) },
    notes: [...current.notes.slice(-4), cleanText(update.note, fallbackNote)].slice(-5),
    publicClaims: [...current.publicClaims.slice(-4), publicSpeech].slice(-5),
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
  };
}

function toAvalonPlayer(player: AiTablePlayerInput): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))) as Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
