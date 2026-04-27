import { getTeamSize, resolveMission, votePasses, type MissionCard, type Vote } from './avalon';

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

export interface MissionState {
  phase: MissionPhase;
  roundIndex: number;
  leaderPlayerId: string;
  selectedTeamIds: string[];
  proposalIndex: number;
  teamVote?: TeamVoteState;
  missionResults: MissionResultState[];
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
  };
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
    };
  }
  return { ...state, phase: 'mission', teamVote };
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
  if (failTotal >= 3) return finishState(state, missionResults, 'evil');
  if (successTotal >= 3) return { ...state, phase: 'assassin', missionResults, selectedTeamIds: [] };
  return {
    ...state,
    phase: 'proposal',
    roundIndex: state.roundIndex + 1,
    leaderPlayerId: nextLeader(playerIds, state.leaderPlayerId),
    selectedTeamIds: [],
    proposalIndex: 0,
    teamVote: undefined,
    missionResults,
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

function assertPhase(state: MissionState, phase: MissionPhase) {
  if (state.phase !== phase) throw new Error(`Mission flow is in ${state.phase}, not ${phase}.`);
}

function assertWholeCount(count: number, label: string) {
  if (!Number.isInteger(count) || count < 0) throw new Error(`${label} must be a non-negative whole number.`);
}
