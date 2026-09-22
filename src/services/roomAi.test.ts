import { describe, expect, it } from 'vitest';
import type { Role } from '../domain/avalon';
import type { MissionResultState, MissionState } from '../domain/missionFlow';
import { getNextRoomAiAction } from './roomAi';
import type { RoomSnapshot } from './roomCore';

describe('room AI assassin', () => {
  it('picks the same target no matter which good player is actually Merlin', () => {
    const results = [success(['p4', 'p5']), success(['p3', 'p4', 'p5']), success(['p3', 'p5'])];
    const baseline = assassinTarget(makeAssassinSnapshot(['Assassin', 'Morgana', 'Merlin', 'Percival', 'Loyal Servant'], results));

    expect(assassinTarget(makeAssassinSnapshot(['Assassin', 'Morgana', 'Loyal Servant', 'Percival', 'Merlin'], results))).toBe(baseline);
    expect(assassinTarget(makeAssassinSnapshot(['Assassin', 'Morgana', 'Percival', 'Merlin', 'Loyal Servant'], results))).toBe(baseline);
  });

  it('never targets itself or an evil teammate it can see', () => {
    const results = [success(['p1', 'p2']), success(['p1', 'p2', 'p3']), success(['p1', 'p2'])];
    const target = assassinTarget(makeAssassinSnapshot(['Assassin', 'Minion', 'Merlin', 'Percival', 'Loyal Servant'], results));

    expect(['p1', 'p2']).not.toContain(target);
  });

  it('can suspect Oberon because the Assassin cannot see Oberon', () => {
    const results = [success(['p2', 'p4']), success(['p2', 'p3', 'p4']), success(['p2', 'p5'])];
    expect(assassinTarget(makeAssassinSnapshot(['Assassin', 'Oberon', 'Merlin', 'Percival', 'Loyal Servant'], results))).toBe('p2');
  });

  it('prefers players trusted on successful quests over players on failed quests', () => {
    const results = [fail(['p1', 'p3']), success(['p4', 'p5']), success(['p4', 'p5', 'p3']), success(['p4', 'p5'])];
    const target = assassinTarget(makeAssassinSnapshot(['Assassin', 'Morgana', 'Merlin', 'Percival', 'Loyal Servant'], results));

    expect(['p4', 'p5']).toContain(target);
  });
});

describe('room AI team votes', () => {
  it('good AI approves a team with no public red flags', () => {
    expect(aiVote(['Merlin', 'Assassin', 'Loyal Servant', 'Percival', 'Morgana'], { ai: [2], team: ['p3', 'p4'] })).toBe('approve');
  });

  it('good AI rejects a team with someone from a failed quest, but not for its own record', () => {
    const results = [fail(['p3', 'p4'])];
    expect(aiVote(['Merlin', 'Assassin', 'Loyal Servant', 'Percival', 'Morgana'], { ai: [2], team: ['p3', 'p4'], results })).toBe('reject');
    expect(aiVote(['Merlin', 'Assassin', 'Loyal Servant', 'Percival', 'Morgana'], { ai: [2], team: ['p3', 'p1'], results })).toBe('approve');
  });

  it('Merlin AI rejects a team with an evil player it can see', () => {
    expect(aiVote(['Merlin', 'Assassin', 'Loyal Servant', 'Percival', 'Morgana'], { ai: [0], team: ['p3', 'p5'] })).toBe('reject');
  });

  it('evil AI approves only teams with itself or an evil teammate it can see', () => {
    const roles: Role[] = ['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana'];
    expect(aiVote(roles, { ai: [1], team: ['p1', 'p5'] })).toBe('approve');
    expect(aiVote(roles, { ai: [1], team: ['p2', 'p3'] })).toBe('approve');
    expect(aiVote(roles, { ai: [1], team: ['p3', 'p4'] })).toBe('reject');
  });

  it('Oberon AI does not recognize evil teammates it cannot see', () => {
    expect(aiVote(['Loyal Servant', 'Oberon', 'Merlin', 'Assassin', 'Morgana', 'Percival', 'Minion'], { ai: [1], team: ['p4', 'p5'] })).toBe('reject');
  });

  it('good AI approves the fifth proposal because rejecting it hands Evil the game', () => {
    const results = [fail(['p3', 'p4'])];
    expect(aiVote(['Merlin', 'Assassin', 'Loyal Servant', 'Percival', 'Morgana'], { ai: [2], team: ['p3', 'p4'], results, proposalIndex: 4 })).toBe('approve');
  });

  it('evil AI still rejects a fifth proposal with no evil on it', () => {
    expect(aiVote(['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana'], { ai: [1], team: ['p3', 'p4'], proposalIndex: 4 })).toBe('reject');
  });
});

describe('room AI mission cards', () => {
  it('good AI always plays Success', () => {
    expect(aiCard(['Merlin', 'Assassin', 'Loyal Servant', 'Percival', 'Morgana'], { ai: [2], team: ['p2', 'p3'], roundIndex: 1 })).toBe('success');
  });

  it('a lone evil AI plays Fail after the first quest', () => {
    expect(aiCard(['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana'], { ai: [1], team: ['p2', 'p3', 'p4'], roundIndex: 1 })).toBe('fail');
  });

  it('evil AIs that see each other let only the lowest seat play Fail', () => {
    const roles: Role[] = ['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana'];
    const options = { ai: [1, 4], team: ['p2', 'p3', 'p5'], roundIndex: 1 };
    expect(aiCard(roles, options, 'p2')).toBe('fail');
    expect(aiCard(roles, options, 'p5')).toBe('success');
  });

  it('two evil AIs both play Fail when the quest needs two fails', () => {
    const roles: Role[] = ['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana', 'Loyal Servant', 'Minion'];
    const options = { ai: [1, 4], team: ['p2', 'p3', 'p5', 'p6'], roundIndex: 3 };
    expect(aiCard(roles, options, 'p2')).toBe('fail');
    expect(aiCard(roles, options, 'p5')).toBe('fail');
  });

  it('Oberon plays alone because no evil teammate can see it', () => {
    const roles: Role[] = ['Loyal Servant', 'Assassin', 'Merlin', 'Oberon', 'Morgana', 'Percival', 'Minion'];
    const options = { ai: [1, 3], team: ['p2', 'p3', 'p4'], roundIndex: 1 };
    expect(aiCard(roles, options, 'p2')).toBe('fail');
    expect(aiCard(roles, options, 'p4')).toBe('fail');
  });

  it('sometimes hides behind Success on the first quest, deterministically per room', () => {
    const cards = Array.from({ length: 30 }, (_, index) => aiCard(['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana'], { ai: [1], team: ['p2', 'p3'], roundIndex: 0, roomId: `room-${index}` }));
    expect(cards).toContain('success');
    expect(cards).toContain('fail');
    const again = Array.from({ length: 30 }, (_, index) => aiCard(['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana'], { ai: [1], team: ['p2', 'p3'], roundIndex: 0, roomId: `room-${index}` }));
    expect(again).toEqual(cards);
  });
});

describe('room AI team proposals', () => {
  it('evil AI leader brings its visible teammate and never uses where Oberon sits', () => {
    const withOberon = aiTeam(['Assassin', 'Loyal Servant', 'Merlin', 'Oberon', 'Morgana', 'Percival', 'Minion'], { ai: [0], roundIndex: 2 });
    const withServant = aiTeam(['Assassin', 'Oberon', 'Merlin', 'Loyal Servant', 'Morgana', 'Percival', 'Minion'], { ai: [0], roundIndex: 2 });

    expect(withOberon[0]).toBe('p1');
    expect(withOberon[1]).toBe('p5');
    expect(withOberon).toEqual(withServant);
  });

  it('Oberon AI leader picks the same team wherever the other evil players sit', () => {
    const first = aiTeam(['Oberon', 'Assassin', 'Merlin', 'Loyal Servant', 'Morgana', 'Percival', 'Minion'], { ai: [0], roundIndex: 2 });
    const second = aiTeam(['Oberon', 'Loyal Servant', 'Merlin', 'Assassin', 'Percival', 'Morgana', 'Minion'], { ai: [0], roundIndex: 2 });
    expect(second).toEqual(first);
  });

  it('good AI leader leaves out players from failed quests when it can', () => {
    const team = aiTeam(['Loyal Servant', 'Assassin', 'Merlin', 'Percival', 'Morgana'], { ai: [0], roundIndex: 1, results: [fail(['p2', 'p5'])] });
    expect(team).toHaveLength(3);
    expect(team).not.toContain('p2');
    expect(team).not.toContain('p5');
  });
});

interface AiScenario {
  ai: number[];
  team?: string[];
  results?: MissionResultState[];
  roundIndex?: number;
  proposalIndex?: number;
  roomId?: string;
}

function aiVote(roles: Role[], scenario: AiScenario) {
  const action = getNextRoomAiAction(makeRoomSnapshot(roles, scenario, { phase: 'vote' }));
  if (action?.type !== 'submitTeamVote') throw new Error(`Expected a vote, got ${action?.type}`);
  return action.vote;
}

function aiCard(roles: Role[], scenario: AiScenario, actorId?: string) {
  const snapshot = makeRoomSnapshot(roles, scenario, { phase: 'mission' });
  if (actorId) {
    const others = scenario.team?.filter((id) => id !== actorId) ?? [];
    snapshot.room.settings.missionState!.missionCardSubmissions = { submittedPlayerIds: others, cards: others.map(() => 'success') };
  }
  const action = getNextRoomAiAction(snapshot);
  if (action?.type !== 'submitMissionCard') throw new Error(`Expected a mission card, got ${action?.type}`);
  if (actorId) expect(action.playerId).toBe(actorId);
  return action.card;
}

function aiTeam(roles: Role[], scenario: AiScenario) {
  const action = getNextRoomAiAction(makeRoomSnapshot(roles, scenario, { phase: 'proposal', leaderPlayerId: 'p1' }));
  if (action?.type !== 'proposeTeam') throw new Error(`Expected a proposal, got ${action?.type}`);
  return action.selectedTeamIds;
}

function makeRoomSnapshot(roles: Role[], scenario: AiScenario, mission: Pick<MissionState, 'phase'> & Partial<MissionState>): RoomSnapshot {
  const roomId = scenario.roomId ?? 'room-ai';
  return {
    room: {
      id: roomId,
      code: '12345',
      status: mission.phase,
      gameType: 'avalon_lite',
      settings: {
        plannedPlayerCount: roles.length,
        missionState: {
          roundIndex: scenario.roundIndex ?? 0,
          leaderPlayerId: 'p1',
          selectedTeamIds: scenario.team ?? [],
          proposalIndex: scenario.proposalIndex ?? 0,
          missionResults: scenario.results ?? [],
          ...mission,
        },
      },
    },
    players: roles.map((role, index) => ({
      id: `p${index + 1}`,
      roomId,
      displayName: `Player ${index + 1}`,
      seatIndex: index,
      isHost: index === 0,
      isReady: true,
      isAi: scenario.ai.includes(index),
      role,
    })),
  };
}

function assassinTarget(snapshot: RoomSnapshot): string {
  const action = getNextRoomAiAction(snapshot);
  if (action?.type !== 'submitAssassination') throw new Error(`Expected an assassination, got ${action?.type}`);
  expect(action.assassinPlayerId).toBe('p1');
  return action.targetPlayerId;
}

function makeAssassinSnapshot(roles: Role[], missionResults: MissionResultState[]): RoomSnapshot {
  return {
    room: {
      id: 'room-assassin',
      code: '12345',
      status: 'assassin',
      gameType: 'avalon_lite',
      settings: {
        plannedPlayerCount: roles.length,
        missionState: {
          phase: 'assassin',
          roundIndex: missionResults.length,
          leaderPlayerId: 'p1',
          selectedTeamIds: [],
          proposalIndex: 0,
          missionResults,
        },
      },
    },
    players: roles.map((role, index) => ({
      id: `p${index + 1}`,
      roomId: 'room-assassin',
      displayName: `Player ${index + 1}`,
      seatIndex: index,
      isHost: index === 0,
      isReady: true,
      isAi: index === 0,
      role,
    })),
  };
}

function success(selectedTeamIds: string[]): MissionResultState {
  return { roundIndex: 0, outcome: 'success', successCount: selectedTeamIds.length, failCount: 0, requiredFails: 1, selectedTeamIds };
}

function fail(selectedTeamIds: string[]): MissionResultState {
  return { roundIndex: 0, outcome: 'fail', successCount: selectedTeamIds.length - 1, failCount: 1, requiredFails: 1, selectedTeamIds };
}
