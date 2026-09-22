import { describe, expect, it } from 'vitest';
import type { Role } from '../domain/avalon';
import type { MissionResultState } from '../domain/missionFlow';
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
