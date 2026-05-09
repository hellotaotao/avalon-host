import { assassinWins, getTeamSize, resolveMission, roleAllegiance, votePasses, type MissionCard, type Player, type Vote } from './avalon';

export type MissionPhase = 'proposal' | 'vote' | 'mission' | 'assassin' | 'finished';
export type MissionWinner = 'good' | 'evil';

export interface TeamVoteState {
  approveCount: number;
  rejectCount: number;
  passed: boolean;
}

export interface MissionResultState {
  roundIndex: number;
  outcome: 'success' | 'fail';
  successCount: number;
  failCount: number;
  requiredFails: number;
}

export interface AssassinationState {
  assassinPlayerId: string;
  targetPlayerId: string;
  hitMerlin: boolean;
}

export interface MissionCardSubmissionState {
  submittedPlayerIds: string[];
  cards: MissionCard[];
}

export interface MissionState {
  phase: MissionPhase;
  roundIndex: number;
  leaderPlayerId: string;
  selectedTeamIds: string[];
  proposalIndex: number;
  teamVote?: TeamVoteState;
  teamVotes?: Record<string, Vote>;
  missionCardSubmissions?: MissionCardSubmissionState;
  missionResults: MissionResultState[];
  assassination?: AssassinationState;
  winner?: MissionWinner;
}

export function createInitialMissionState(playerIds: string[]): MissionState {
  assertPlayablePlayers(playerIds);
  return {
    phase: 'proposal',
    roundIndex: 0,
    leaderPlayerId: playerIds[0],
    selectedTeamIds: [],
    proposalIndex: 0,
    missionResults: [],
  };
}

export function ensureMissionState(state: MissionState | undefined, playerIds: string[]): MissionState {
  return state ?? createInitialMissionState(playerIds);
}

export function selectMissionTeam(state: MissionState, playerIds: string[], selectedTeamIds: string[]): MissionState {
  assertPhase(state, 'proposal');
  assertPlayablePlayers(playerIds);
  const requiredSize = getTeamSize(playerIds.length, state.roundIndex);
  const uniqueSelection = Array.from(new Set(selectedTeamIds));
  if (uniqueSelection.some((playerId) => !playerIds.includes(playerId))) throw new Error('Selected team includes a player outside this room.');
  if (uniqueSelection.length !== requiredSize) {
    throw new Error(`Quest ${state.roundIndex + 1} needs exactly ${requiredSize} team members.`);
  }
  return {
    ...state,
    phase: 'vote',
    selectedTeamIds: uniqueSelection,
    teamVote: undefined,
    teamVotes: undefined,
    missionCardSubmissions: undefined,
  };
}

export function submitTeamProposal(state: MissionState, playerIds: string[], leaderPlayerId: string, selectedTeamIds: string[]): MissionState {
  assertPhase(state, 'proposal');
  assertPlayerInRoom(playerIds, leaderPlayerId);
  if (state.leaderPlayerId !== leaderPlayerId) throw new Error('Only the current leader can propose the mission team.');
  return selectMissionTeam(state, playerIds, selectedTeamIds);
}

export function recordTeamVote(state: MissionState, playerIds: string[], approveCount: number, rejectCount: number): MissionState {
  assertPhase(state, 'vote');
  assertPlayablePlayers(playerIds);
  assertWholeCount(approveCount, 'Approve count');
  assertWholeCount(rejectCount, 'Reject count');
  if (approveCount + rejectCount !== playerIds.length) throw new Error(`Team vote needs exactly ${playerIds.length} total votes.`);
  const votes: Vote[] = [
    ...Array.from<Vote>({ length: approveCount }).fill('approve'),
    ...Array.from<Vote>({ length: rejectCount }).fill('reject'),
  ];
  const passed = votePasses(votes, playerIds.length);
  const teamVote = { approveCount, rejectCount, passed };
  if (!passed) {
    return {
      ...state,
      phase: 'proposal',
      leaderPlayerId: nextLeader(playerIds, state.leaderPlayerId),
      selectedTeamIds: [],
      proposalIndex: state.proposalIndex + 1,
      teamVote,
      teamVotes: undefined,
      missionCardSubmissions: undefined,
    };
  }
  return { ...state, phase: 'mission', teamVote, missionCardSubmissions: undefined };
}

export function submitTeamVote(state: MissionState, playerIds: string[], playerId: string, vote: Vote): MissionState {
  assertPhase(state, 'vote');
  assertPlayablePlayers(playerIds);
  assertPlayerInRoom(playerIds, playerId);
  const teamVotes = { ...(state.teamVotes ?? {}), [playerId]: vote };
  const votes = playerIds.map((id) => teamVotes[id]).filter((item): item is Vote => item === 'approve' || item === 'reject');
  if (votes.length < playerIds.length) return { ...state, teamVotes, teamVote: undefined };

  const approveCount = votes.filter((item) => item === 'approve').length;
  const rejectCount = votes.length - approveCount;
  return recordTeamVote({ ...state, teamVotes }, playerIds, approveCount, rejectCount);
}

export function advanceMissionResult(state: MissionState, playerIds: string[], successCount: number, failCount: number): MissionState {
  assertPhase(state, 'mission');
  assertPlayablePlayers(playerIds);
  assertWholeCount(successCount, 'Success count');
  assertWholeCount(failCount, 'Fail count');
  if (successCount + failCount !== state.selectedTeamIds.length) throw new Error(`Mission needs exactly ${state.selectedTeamIds.length} cards.`);
  const cards: MissionCard[] = [
    ...Array.from<MissionCard>({ length: successCount }).fill('success'),
    ...Array.from<MissionCard>({ length: failCount }).fill('fail'),
  ];
  const resolved = resolveMission(cards, playerIds.length, state.roundIndex);
  const missionResults = [
    ...state.missionResults,
    {
      roundIndex: state.roundIndex,
      outcome: resolved.outcome,
      successCount,
      failCount: resolved.failCount,
      requiredFails: resolved.requiredFails,
    },
  ];
  const successTotal = missionResults.filter((result) => result.outcome === 'success').length;
  const failTotal = missionResults.filter((result) => result.outcome === 'fail').length;
  if (failTotal >= 3) return finishState({ ...state, missionCardSubmissions: undefined, teamVotes: undefined }, missionResults, 'evil');
  if (successTotal >= 3) {
    return { ...state, phase: 'assassin', missionResults, selectedTeamIds: [], missionCardSubmissions: undefined, teamVotes: undefined };
  }
  return {
    ...state,
    phase: 'proposal',
    roundIndex: state.roundIndex + 1,
    leaderPlayerId: nextLeader(playerIds, state.leaderPlayerId),
    selectedTeamIds: [],
    proposalIndex: 0,
    teamVote: undefined,
    teamVotes: undefined,
    missionCardSubmissions: undefined,
    missionResults,
  };
}

export function submitMissionCard(state: MissionState, playerIds: string[], players: Player[], playerId: string, card: MissionCard): MissionState {
  assertPhase(state, 'mission');
  assertPlayablePlayers(playerIds);
  assertPlayerInRoom(playerIds, playerId);
  if (!state.selectedTeamIds.includes(playerId)) throw new Error('Only selected mission team players can submit mission cards.');
  const player = players.find((candidate) => candidate.id === playerId);
  if (!player?.role) throw new Error('Mission player has no role.');
  if (card === 'fail' && roleAllegiance(player.role) !== 'evil') throw new Error('Good players cannot submit Fail cards.');
  const currentSubmissions = state.missionCardSubmissions ?? { submittedPlayerIds: [], cards: [] };
  if (currentSubmissions.submittedPlayerIds.includes(playerId)) throw new Error('This player has already submitted a mission card.');
  const missionCardSubmissions: MissionCardSubmissionState = {
    submittedPlayerIds: [...currentSubmissions.submittedPlayerIds, playerId],
    cards: [...currentSubmissions.cards, card],
  };
  if (missionCardSubmissions.submittedPlayerIds.length < state.selectedTeamIds.length) {
    return { ...state, missionCardSubmissions };
  }
  const failCount = missionCardSubmissions.cards.filter((item) => item === 'fail').length;
  const successCount = missionCardSubmissions.cards.length - failCount;
  return advanceMissionResult({ ...state, missionCardSubmissions }, playerIds, successCount, failCount);
}

export function resolveAssassination(state: MissionState, players: Player[], assassinPlayerId: string, targetPlayerId: string): MissionState {
  assertPhase(state, 'assassin');
  assertPlayablePlayers(players.map((player) => player.id));
  const assassin = players.find((player) => player.id === assassinPlayerId);
  if (!assassin) throw new Error('Assassin player is not in this room.');
  if (assassin.role !== 'Assassin') throw new Error('Only the Assassin can submit the assassination.');
  if (targetPlayerId === assassinPlayerId) throw new Error('Assassin cannot target themselves.');
  const target = players.find((player) => player.id === targetPlayerId);
  if (!target) throw new Error('Assassination target is not in this room.');
  if (!target.role) throw new Error('Assassination target has no role.');
  const hitMerlin = assassinWins(targetPlayerId, players);
  return {
    ...state,
    phase: 'finished',
    selectedTeamIds: [],
    assassination: { assassinPlayerId, targetPlayerId, hitMerlin },
    winner: hitMerlin ? 'evil' : 'good',
  };
}

function finishState(state: MissionState, missionResults: MissionResultState[], winner: MissionWinner): MissionState {
  return { ...state, phase: 'finished', winner, missionResults, selectedTeamIds: [] };
}

function nextLeader(playerIds: string[], currentLeaderPlayerId: string): string {
  const currentIndex = Math.max(0, playerIds.indexOf(currentLeaderPlayerId));
  return playerIds[(currentIndex + 1) % playerIds.length];
}

function assertPlayablePlayers(playerIds: string[]) {
  if (playerIds.length < 5 || playerIds.length > 10) throw new Error('Avalon Lite missions need 5-10 players.');
}

function assertPlayerInRoom(playerIds: string[], playerId: string) {
  if (!playerIds.includes(playerId)) throw new Error('Player is not in this room.');
}

function assertPhase(state: MissionState, phase: MissionPhase) {
  if (state.phase !== phase) throw new Error(`Mission flow is in ${state.phase}, not ${phase}.`);
}

function assertWholeCount(count: number, label: string) {
  if (!Number.isInteger(count) || count < 0) throw new Error(`${label} must be a non-negative whole number.`);
}
