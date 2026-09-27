import { type Allegiance, type Player } from '../domain/avalon';
import {
  advanceMissionResult,
  endedByRejectedProposals,
  recordTeamVote,
  resolveAssassination,
  type MissionPhase,
  type MissionState,
} from '../domain/missionFlow';
import { makeHistory } from './demoHistory';
import { type DemoAssassination, type DemoPlayer, type DemoState } from './demoTypes';

export function resolveDemoVoteIfReady(
  current: DemoState,
  players: DemoPlayer[],
): { players: DemoPlayer[]; statePatch: Partial<DemoState> } {
  const approveCount = players.filter((player) => player.teamVote === 'approve').length;
  const rejectCount = players.filter((player) => player.teamVote === 'reject').length;
  if (approveCount + rejectCount !== current.playerCount) return { players, statePatch: {} };
  const next = recordTeamVote(toDemoMissionState(current, 'vote'), current.players.map((player) => player.id), approveCount, rejectCount);
  return {
    players: players.map((player) => ({ ...player, missionCard: undefined })),
    statePatch: {
      phase: toDemoPhase(next.phase),
      leaderIndex: getDemoLeaderIndex(current, next.leaderPlayerId),
      proposalIndex: next.proposalIndex,
      selectedTeamIds: next.selectedTeamIds,
      lastVote: next.teamVote,
      winner: next.winner,
    },
  };
}

export function resolveDemoMissionIfReady(current: DemoState, players: DemoPlayer[]): DemoState {
  const missionCards = players.filter((player) => current.selectedTeamIds.includes(player.id) && player.missionCard);
  if (missionCards.length !== current.selectedTeamIds.length) return { ...current, players };
  const cards = current.selectedTeamIds.map((id) => players.find((player) => player.id === id)?.missionCard ?? 'success');
  const successCount = cards.filter((card) => card === 'success').length;
  const next = advanceMissionResult(toDemoMissionState(current, 'mission'), current.players.map((player) => player.id), successCount, cards.length - successCount);
  // The demo pauses on the quest result before the next proposal; advanceDemoToNextQuest moves on.
  const startsNextQuest = next.phase === 'proposal';
  return {
    ...current,
    players,
    phase: startsNextQuest ? 'result' : toDemoPhase(next.phase),
    missionResults: next.missionResults,
    selectedTeamIds: startsNextQuest ? current.selectedTeamIds : next.selectedTeamIds,
    lastMission: next.missionResults.at(-1),
    assassination: undefined,
    winner: next.winner,
  };
}

export function advanceDemoToNextQuest(current: DemoState): DemoState {
  return {
    ...current,
    phase: 'proposal',
    roundIndex: current.roundIndex + 1,
    leaderIndex: (current.leaderIndex + 1) % current.playerCount,
    proposalIndex: 0,
    selectedTeamIds: [],
    players: current.players.map((player) => ({ ...player, teamVote: undefined, missionCard: undefined })),
    lastVote: undefined,
  };
}

export function resolveDemoAssassination(current: DemoState, targetPlayerId: string): DemoState {
  if (current.phase !== 'assassin') return current;
  const target = current.players.find((player) => player.id === targetPlayerId);
  const assassin = current.players.find((player) => player.role === 'Assassin');
  if (!target || !assassin) return current;
  let next: MissionState;
  try {
    next = resolveAssassination(toDemoMissionState(current, 'assassin'), current.players.map(toDemoAvalonPlayer), assassin.id, target.id);
  } catch {
    return current;
  }
  const hitMerlin = Boolean(next.assassination?.hitMerlin);
  const winner: Allegiance = next.winner ?? (hitMerlin ? 'evil' : 'good');
  const assassination: DemoAssassination = {
    targetPlayerId: target.id,
    targetName: target.displayName,
    hitMerlin,
    winner,
  };
  return {
    ...current,
    phase: 'finished',
    assassination,
    winner,
    tableHistory: [
      ...current.tableHistory,
      makeHistory(
        current,
        assassin,
        'assassin',
        `${assassin?.displayName ?? 'Assassin'} chose ${target.displayName} as Merlin. ${hitMerlin ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`,
        undefined,
        { targetPlayerId: target.id },
      ),
    ],
  };
}

export function getDemoWinner(demo: DemoState): Allegiance | undefined {
  return demo.phase === 'finished' ? demo.winner : undefined;
}

// The demo keeps its own UI state, but votes, quests, and the assassination all
// resolve through the same missionFlow functions as live rooms, so the rules
// cannot drift apart.
function toDemoMissionState(demo: DemoState, phase: MissionState['phase']): MissionState {
  return {
    phase,
    roundIndex: demo.roundIndex,
    leaderPlayerId: demo.players[demo.leaderIndex]?.id ?? demo.players[0].id,
    selectedTeamIds: [...demo.selectedTeamIds],
    proposalIndex: demo.proposalIndex,
    teamVote: demo.lastVote,
    missionResults: demo.missionResults.map((result) => ({ ...result })),
    winner: demo.winner,
  };
}

function getDemoLeaderIndex(demo: DemoState, leaderPlayerId: string): number {
  return Math.max(0, demo.players.findIndex((player) => player.id === leaderPlayerId));
}

export function demoEndedByRejectedProposals(demo: DemoState): boolean {
  return endedByRejectedProposals(toDemoMissionState(demo, demo.phase === 'finished' ? 'finished' : 'proposal'));
}

export function getDemoQuestTeamNames(demo: DemoState, teamIds: string[] = []): string[] {
  return teamIds.map((id) => demo.players.find((player) => player.id === id)?.displayName ?? id);
}

export function playerName(current: DemoState, playerId: string): string {
  return current.players.find((player) => player.id === playerId)?.displayName ?? playerId;
}

export function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const copy = [...items];
  let state = [...seed].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) >>> 0, 2166136261);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

export function toDemoAvalonPlayer(player: DemoPlayer): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}

// The demo table never turns on the Lady of the Lake, so her phase cannot come up.
function toDemoPhase(phase: MissionPhase): Exclude<MissionPhase, 'lady'> {
  if (phase === 'lady') throw new Error('The demo does not use the Lady of the Lake.');
  return phase;
}
