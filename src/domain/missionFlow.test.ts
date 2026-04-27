import { describe, expect, it } from 'vitest';
import {
  advanceMissionResult,
  createInitialMissionState,
  recordTeamVote,
  selectMissionTeam,
  type MissionState,
} from './missionFlow';

const playerIds = ['p1', 'p2', 'p3', 'p4', 'p5'];

describe('mission flow', () => {
  it('creates a first proposal led by the host seat', () => {
    expect(createInitialMissionState(playerIds)).toMatchObject({
      phase: 'proposal',
      roundIndex: 0,
      leaderPlayerId: 'p1',
      selectedTeamIds: [],
      missionResults: [],
    });
  });

  it('requires the selected team to match the round team size', () => {
    const state = createInitialMissionState(playerIds);
    expect(() => selectMissionTeam(state, playerIds, ['p1'])).toThrow('Quest 1 needs exactly 2 team members.');
  });

  it('moves an exact selected team into team voting', () => {
    const state = selectMissionTeam(createInitialMissionState(playerIds), playerIds, ['p1', 'p2']);
    expect(state.phase).toBe('vote');
    expect(state.selectedTeamIds).toEqual(['p1', 'p2']);
  });

  it('returns to proposal with the next leader when a team vote fails', () => {
    const state = selectMissionTeam(createInitialMissionState(playerIds), playerIds, ['p1', 'p2']);
    const next = recordTeamVote(state, playerIds, 2, 3);
    expect(next).toMatchObject({
      phase: 'proposal',
      roundIndex: 0,
      leaderPlayerId: 'p2',
      selectedTeamIds: [],
      teamVote: { approveCount: 2, rejectCount: 3, passed: false },
    });
  });

  it('records an approved successful mission and advances the round', () => {
    const proposed = selectMissionTeam(createInitialMissionState(playerIds), playerIds, ['p1', 'p2']);
    const approved = recordTeamVote(proposed, playerIds, 3, 2);
    const next = advanceMissionResult(approved, playerIds, 2, 0);
    expect(next.phase).toBe('proposal');
    expect(next.roundIndex).toBe(1);
    expect(next.leaderPlayerId).toBe('p2');
    expect(next.missionResults).toMatchObject([{ outcome: 'success', successCount: 2, failCount: 0 }]);
  });

  it('enters the assassin placeholder after three good quest successes', () => {
    let state: MissionState = createInitialMissionState(playerIds);
    for (const team of [['p1', 'p2'], ['p2', 'p3', 'p4'], ['p3', 'p4']] as string[][]) {
      state = selectMissionTeam(state, playerIds, team);
      state = recordTeamVote(state, playerIds, 3, 2);
      state = advanceMissionResult(state, playerIds, team.length, 0);
    }
    expect(state.phase).toBe('assassin');
    expect(state.winner).toBeUndefined();
  });

  it('finishes with Evil winning after three failed quests', () => {
    let state: MissionState = createInitialMissionState(playerIds);
    for (const team of [['p1', 'p2'], ['p2', 'p3', 'p4'], ['p3', 'p4']] as string[][]) {
      state = selectMissionTeam(state, playerIds, team);
      state = recordTeamVote(state, playerIds, 3, 2);
      state = advanceMissionResult(state, playerIds, team.length - 1, 1);
    }
    expect(state.phase).toBe('finished');
    expect(state.winner).toBe('evil');
  });
});
