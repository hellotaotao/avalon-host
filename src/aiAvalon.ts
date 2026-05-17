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
  kind: 'speech' | 'proposal' | 'vote' | 'mission' | 'result';
  text: string;
}

export interface AiTableStateInput {
  playerCount: number;
  phase: 'setup' | 'proposal' | 'vote' | 'mission' | 'result';
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
  | { type: 'missionCard'; values: MissionCard[]; selectedTeamIds: string[] };

export type AiAvalonDecisionAction =
  | { type: 'proposeTeam'; teamIds: string[] }
  | { type: 'vote'; vote: Vote }
  | { type: 'missionCard'; card: MissionCard };

export interface AiAvalonDecisionRequest {
  game: {
    name: 'Avalon Lite';
    playerCount: number;
    roundIndex: number;
    phase: Exclude<AiTableStateInput['phase'], 'setup' | 'result'>;
    teamSize: number;
    selectedTeamIds: string[];
    missionResults: AiTableStateInput['missionResults'];
    lastVote?: AiTableStateInput['lastVote'];
    lastMission?: AiTableStateInput['lastMission'];
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
  return undefined;
}

export function buildAiAvalonDecisionRequest(state: AiTableStateInput, actorId: string, persona?: string): AiAvalonDecisionRequest {
  if (state.phase === 'setup' || state.phase === 'result') throw new Error('AI decisions are only available during proposal, vote, or mission phases.');
  const actor = state.players.find((player) => player.id === actorId);
  if (!actor) throw new Error('Acting player is not at this table.');
  const legalActions = getLegalActionsForActor(state, actor);
  if (!legalActions.length) throw new Error('Acting player has no legal action.');
  const visibility = getVisibilityInfo(toAvalonPlayer(actor), state.players.map(toAvalonPlayer));
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
    actingPlayer: {
      playerId: actor.id,
      displayName: actor.displayName,
      seatIndex: actor.seatIndex,
      role: actor.role,
      allegiance: roleAllegiance(actor.role),
      persona,
    },
    publicPlayers: state.players.map((player) => ({ playerId: player.id, displayName: player.displayName, seatIndex: player.seatIndex })),
    roleVisibleInfo: visibility.sees.map((item) => ({ playerId: item.playerId, displayName: item.name, hint: item.hint })),
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
  throw new Error('Unsupported legal action.');
}

export function normalizeAiAvalonDecision(request: AiAvalonDecisionRequest, value: unknown): AiAvalonDecision {
  if (!isRecord(value)) throw new Error('AI decision must be a JSON object.');
  const action = validateAiAvalonDecisionAction(request, value.action);
  return {
    privateReasoningSummary: cleanText(value.privateReasoningSummary, 'No private summary provided.').slice(0, 500),
    publicSpeech: cleanText(value.publicSpeech, 'I have made my move.').slice(0, 500),
    action,
    memoryUpdate: normalizeMemoryUpdate(value.memoryUpdate),
  };
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
