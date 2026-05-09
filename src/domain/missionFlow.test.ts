import { describe, expect, it } from 'vitest';
import {
  advanceMissionResult,
  createInitialMissionState,
  recordTeamVote,
  resolveAssassination,
  selectMissionTeam,
  submitMissionCard,
  submitTeamProposal,
  submitTeamVote,
  type MissionState,
} from './missionFlow';
import type { Player } from './avalon';

const playerIds = ['p1', 'p2', 'p3', 'p4', 'p5'];
const sevenPlayerIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

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

  it('lets only the current leader submit a live phone proposal', () => {
    const state = createInitialMissionState(playerIds);
    expect(() => submitTeamProposal(state, playerIds, 'p2', ['p1', 'p2'])).toThrow('Only the current leader can propose the mission team.');

    const proposed = submitTeamProposal(state, playerIds, 'p1', ['p1', 'p2']);
    expect(proposed).toMatchObject({ phase: 'vote', selectedTeamIds: ['p1', 'p2'] });
  });

  it('records individual live votes and advances automatically when everyone has voted', () => {
    let state = selectMissionTeam(createInitialMissionState(playerIds), playerIds, ['p1', 'p2']);
    state = submitTeamVote(state, playerIds, 'p1', 'approve');
    expect(state).toMatchObject({
      phase: 'vote',
      teamVotes: { p1: 'approve' },
      teamVote: undefined,
    });

    state = submitTeamVote(state, playerIds, 'p2', 'approve');
    state = submitTeamVote(state, playerIds, 'p3', 'approve');
    state = submitTeamVote(state, playerIds, 'p4', 'reject');
    state = submitTeamVote(state, playerIds, 'p5', 'reject');

    expect(state).toMatchObject({
      phase: 'mission',
      teamVotes: { p1: 'approve', p2: 'approve', p3: 'approve', p4: 'reject', p5: 'reject' },
      teamVote: { approveCount: 3, rejectCount: 2, passed: true },
    });
  });

  it('records anonymous live mission cards and resolves only after the selected team has submitted', () => {
    let state = selectMissionTeam(createInitialMissionState(playerIds), playerIds, ['p2', 'p3']);
    state = recordTeamVote(state, playerIds, 3, 2);

    state = submitMissionCard(state, playerIds, rolePlayers, 'p2', 'fail');
    expect(state.phase).toBe('mission');
    expect(state.missionResults).toEqual([]);
    expect(state.missionCardSubmissions).toMatchObject({
      submittedPlayerIds: ['p2'],
      cards: ['fail'],
    });

    state = submitMissionCard(state, playerIds, rolePlayers, 'p3', 'success');
    expect(state).toMatchObject({
      phase: 'proposal',
      roundIndex: 1,
      missionResults: [{ outcome: 'fail', successCount: 1, failCount: 1 }],
      missionCardSubmissions: undefined,
    });
  });

  it('rejects live mission cards from non-team players and fail cards from Good players', () => {
    const state = recordTeamVote(selectMissionTeam(createInitialMissionState(playerIds), playerIds, ['p1', 'p2']), playerIds, 3, 2);
    expect(() => submitMissionCard(state, playerIds, rolePlayers, 'p3', 'success')).toThrow(
      'Only selected mission team players can submit mission cards.',
    );
    expect(() => submitMissionCard(state, playerIds, rolePlayers, 'p1', 'fail')).toThrow('Good players cannot submit Fail cards.');
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

  it('enters the assassin phase after three good quest successes', () => {
    const state = createAssassinPhaseState();
    expect(state.phase).toBe('assassin');
    expect(state.winner).toBeUndefined();
  });

  it('finishes with Evil winning when the assassin guesses Merlin', () => {
    const next = resolveAssassination(createAssassinPhaseState(), rolePlayers, 'p2', 'p1');
    expect(next).toMatchObject({
      phase: 'finished',
      winner: 'evil',
      assassination: { assassinPlayerId: 'p2', targetPlayerId: 'p1', hitMerlin: true },
    });
  });

  it('finishes with Good winning when the assassin guesses a non-Merlin target', () => {
    const next = resolveAssassination(createAssassinPhaseState(), rolePlayers, 'p2', 'p3');
    expect(next).toMatchObject({
      phase: 'finished',
      winner: 'good',
      assassination: { assassinPlayerId: 'p2', targetPlayerId: 'p3', hitMerlin: false },
    });
  });

  it('rejects assassination outside the assassin phase', () => {
    expect(() => resolveAssassination(createInitialMissionState(playerIds), rolePlayers, 'p2', 'p1')).toThrow(
      'Mission flow is in proposal, not assassin.',
    );
  });

  it('rejects invalid assassination target and non-assassin submitter', () => {
    const state = createAssassinPhaseState();
    expect(() => resolveAssassination(state, rolePlayers, 'p3', 'p1')).toThrow('Only the Assassin can submit the assassination.');
    expect(() => resolveAssassination(state, rolePlayers, 'p2', 'missing')).toThrow('Assassination target is not in this room.');
    expect(() => resolveAssassination(state, rolePlayers, 'p2', 'p2')).toThrow('Assassin cannot target themselves.');
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

  it('fails a 7-player fourth quest with one fail and succeeds with all success cards', () => {
    const fourthQuest: MissionState = {
      ...createInitialMissionState(sevenPlayerIds),
      phase: 'mission',
      roundIndex: 3,
      selectedTeamIds: ['p1', 'p2', 'p3', 'p4'],
    };

    expect(advanceMissionResult(fourthQuest, sevenPlayerIds, 3, 1).missionResults).toMatchObject([
      { roundIndex: 3, outcome: 'fail', successCount: 3, failCount: 1, requiredFails: 1 },
    ]);
    expect(advanceMissionResult(fourthQuest, sevenPlayerIds, 4, 0).missionResults).toMatchObject([
      { roundIndex: 3, outcome: 'success', successCount: 4, failCount: 0, requiredFails: 1 },
    ]);
  });
});

const rolePlayers: Player[] = [
  { id: 'p1', name: 'Merlin', role: 'Merlin' },
  { id: 'p2', name: 'Assassin', role: 'Assassin' },
  { id: 'p3', name: 'Servant 1', role: 'Loyal Servant' },
  { id: 'p4', name: 'Servant 2', role: 'Loyal Servant' },
  { id: 'p5', name: 'Minion', role: 'Minion' },
];

function createAssassinPhaseState(): MissionState {
  let state: MissionState = createInitialMissionState(playerIds);
  for (const team of [['p1', 'p2'], ['p2', 'p3', 'p4'], ['p3', 'p4']] as string[][]) {
    state = selectMissionTeam(state, playerIds, team);
    state = recordTeamVote(state, playerIds, 3, 2);
    state = advanceMissionResult(state, playerIds, team.length, 0);
  }
  return state;
}
