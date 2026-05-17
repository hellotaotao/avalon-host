import { describe, expect, it } from 'vitest';
import {
  buildAiAvalonDecisionRequest,
  formatMissionReasoningSummaryForHistory,
  normalizeAiAvalonDecision,
  validateAiAvalonDecisionAction,
  type AiTableStateInput,
} from './aiAvalon';

const baseState: AiTableStateInput = {
  playerCount: 5,
  phase: 'proposal',
  roundIndex: 0,
  leaderIndex: 0,
  selectedTeamIds: [],
  missionResults: [],
  lastVote: undefined,
  lastMission: undefined,
  tableHistory: [
    { roundIndex: 0, kind: 'result', text: 'AI Table started.' },
    { roundIndex: 0, actorId: 'p2', actorName: 'Bors AI', kind: 'speech', text: 'I am watching p4.' },
  ],
  players: [
    { id: 'p1', displayName: 'Merlin AI', seatIndex: 0, role: 'Merlin', controller: 'ai', memory: { suspicion: { p2: 5, p3: 0, p4: 0, p5: 0 }, notes: ['private p1 note'], publicClaims: [] } },
    { id: 'p2', displayName: 'Assassin AI', seatIndex: 1, role: 'Assassin', controller: 'ai', memory: { suspicion: { p1: 99 }, notes: ['private p2 note'], publicClaims: ['secret'] } },
    { id: 'p3', displayName: 'Loyal', seatIndex: 2, role: 'Loyal Servant', controller: 'human' },
    { id: 'p4', displayName: 'Minion AI', seatIndex: 3, role: 'Minion', controller: 'ai', memory: { suspicion: { p1: -10 }, notes: ['private p4 note'], publicClaims: [] } },
    { id: 'p5', displayName: 'Loyal 2', seatIndex: 4, role: 'Loyal Servant', controller: 'human' },
  ],
};

describe('AI Avalon request filtering and validation', () => {
  it('builds a per-agent request without other players roles or private memory', () => {
    const request = buildAiAvalonDecisionRequest(baseState, 'p1', 'Cautious analyst');

    expect(request.actingPlayer).toMatchObject({ playerId: 'p1', role: 'Merlin', allegiance: 'good' });
    expect(request.roleVisibleInfo.map((item) => item.playerId).sort()).toEqual(['p2', 'p4']);
    expect(request.ownMemory.notes).toEqual(['private p1 note']);
    expect(JSON.stringify(request)).not.toContain('private p2 note');
    expect(JSON.stringify(request)).not.toContain('private p4 note');
    expect(request.publicPlayers).toEqual([
      { playerId: 'p1', displayName: 'Merlin AI', seatIndex: 0 },
      { playerId: 'p2', displayName: 'Assassin AI', seatIndex: 1 },
      { playerId: 'p3', displayName: 'Loyal', seatIndex: 2 },
      { playerId: 'p4', displayName: 'Minion AI', seatIndex: 3 },
      { playerId: 'p5', displayName: 'Loyal 2', seatIndex: 4 },
    ]);
    expect(request.legalActions).toEqual([{ type: 'proposeTeam', teamSize: 2, candidatePlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'] }]);
  });

  it('validates proposal size and candidate legality', () => {
    const request = buildAiAvalonDecisionRequest(baseState, 'p1');

    expect(validateAiAvalonDecisionAction(request, { type: 'proposeTeam', teamIds: ['p1', 'p3'] })).toEqual({ type: 'proposeTeam', teamIds: ['p1', 'p3'] });
    expect(() => validateAiAvalonDecisionAction(request, { type: 'proposeTeam', teamIds: ['p1'] })).toThrow('expected 2');
    expect(() => validateAiAvalonDecisionAction(request, { type: 'proposeTeam', teamIds: ['p1', 'px'] })).toThrow('unknown player');
  });


  it('makes the current vote team authoritative even when history mentions an older proposal', () => {
    const voteState: AiTableStateInput = {
      ...baseState,
      phase: 'vote',
      selectedTeamIds: ['p3', 'p5'],
      tableHistory: [
        ...baseState.tableHistory,
        { roundIndex: 0, actorId: 'p1', actorName: 'Arthur AI', kind: 'proposal', text: 'Arthur AI proposed Arthur AI, Bors AI.' },
        { roundIndex: 0, actorId: 'p2', actorName: 'Bors AI', kind: 'speech', text: 'I reject Arthur AI and Bors AI.' },
      ],
    };

    const request = buildAiAvalonDecisionRequest(voteState, 'p1');

    expect(request.currentTurn.instruction).toContain('current proposed team only: Loyal (p3), Loyal 2 (p5)');
    expect(request.currentActionContext).toMatchObject({
      actionType: 'vote',
      currentProposedTeamIds: ['p3', 'p5'],
      currentProposedTeamText: 'Loyal (p3), Loyal 2 (p5)',
    });
    expect(request.currentActionContext.currentProposedTeam).toEqual([
      { playerId: 'p3', displayName: 'Loyal', seatIndex: 2 },
      { playerId: 'p5', displayName: 'Loyal 2', seatIndex: 4 },
    ]);
    expect(request.publicTableHistoryNote).toContain('Historical public transcript only');
    expect(request.publicTableHistory.map((entry) => entry.text).join(' ')).toContain('Arthur AI, Bors AI');
    expect(request.legalActions).toEqual([{ type: 'vote', values: ['approve', 'reject'], selectedTeamIds: ['p3', 'p5'] }]);
  });

  it('exposes role-visible info intersected with the current vote team without hidden leakage', () => {
    const voteState: AiTableStateInput = {
      ...baseState,
      phase: 'vote',
      selectedTeamIds: ['p2', 'p3'],
    };

    const request = buildAiAvalonDecisionRequest(voteState, 'p1');

    expect(request.roleVisiblePlayersOnCurrentTeam).toEqual([
      { playerId: 'p2', displayName: 'Assassin AI', hint: 'Evil player' },
    ]);
    expect(request.currentActionContext.currentTeamRoleVisibleInfo).toEqual(request.roleVisiblePlayersOnCurrentTeam);
    expect(JSON.stringify(request)).not.toContain('"role":"Assassin"');
    expect(JSON.stringify(request)).not.toContain('private p2 note');
  });

  it('guards Merlin from approving a current team containing role-visible evil without justification', () => {
    const voteState: AiTableStateInput = {
      ...baseState,
      phase: 'vote',
      selectedTeamIds: ['p2', 'p3'],
    };
    const request = buildAiAvalonDecisionRequest(voteState, 'p1');

    const decision = normalizeAiAvalonDecision(request, {
      privateReasoningSummary: 'The current team looks trustworthy based on public behaviour.',
      publicSpeech: 'This team looks trustworthy to me.',
      action: { type: 'vote', vote: 'approve' },
      memoryUpdate: {},
    });

    expect(decision.action).toEqual({ type: 'vote', vote: 'reject' });
    expect(decision.privateReasoningSummary).toContain('Evil player');
    expect(decision.publicSpeech).toBe('I reject the current proposed team: Assassin AI (p2), Loyal (p3).');
  });

  it('does not treat Percival Merlin-candidate visibility as known evil', () => {
    const percivalState: AiTableStateInput = {
      ...baseState,
      playerCount: 7,
      phase: 'vote',
      selectedTeamIds: ['p2', 'p4'],
      players: [
        { id: 'p1', displayName: 'Merlin AI', seatIndex: 0, role: 'Merlin', controller: 'ai' },
        { id: 'p2', displayName: 'Morgana AI', seatIndex: 1, role: 'Morgana', controller: 'ai' },
        { id: 'p3', displayName: 'Percival AI', seatIndex: 2, role: 'Percival', controller: 'ai' },
        { id: 'p4', displayName: 'Loyal', seatIndex: 3, role: 'Loyal Servant', controller: 'human' },
        { id: 'p5', displayName: 'Loyal 2', seatIndex: 4, role: 'Loyal Servant', controller: 'human' },
        { id: 'p6', displayName: 'Assassin AI', seatIndex: 5, role: 'Assassin', controller: 'ai' },
        { id: 'p7', displayName: 'Loyal 3', seatIndex: 6, role: 'Loyal Servant', controller: 'human' },
      ],
    };
    const request = buildAiAvalonDecisionRequest(percivalState, 'p3');

    expect(request.roleVisiblePlayersOnCurrentTeam).toEqual([
      { playerId: 'p2', displayName: 'Morgana AI', hint: 'Merlin candidate' },
    ]);
    expect(normalizeAiAvalonDecision(request, {
      privateReasoningSummary: 'Percival sees ambiguity here, not confirmed evil.',
      publicSpeech: 'I approve Morgana AI and Loyal for information.',
      action: { type: 'vote', vote: 'approve' },
      memoryUpdate: {},
    }).action).toEqual({ type: 'vote', vote: 'approve' });
  });

  it('replaces stale vote public speech with the current vote team', () => {
    const voteState: AiTableStateInput = {
      ...baseState,
      phase: 'vote',
      selectedTeamIds: ['p3', 'p5'],
      tableHistory: [
        { roundIndex: 0, actorId: 'p1', actorName: 'Arthur AI', kind: 'proposal', text: 'Arthur AI proposed Arthur AI, Bors AI.' },
      ],
    };
    const request = buildAiAvalonDecisionRequest(voteState, 'p1');

    const decision = normalizeAiAvalonDecision(request, {
      privateReasoningSummary: 'brief',
      publicSpeech: 'I reject Arthur AI and Bors AI because that pairing is risky.',
      action: { type: 'vote', vote: 'reject' },
      memoryUpdate: {},
    });

    expect(decision.publicSpeech).toBe('I reject the current proposed team: Loyal (p3), Loyal 2 (p5).');
    expect(decision.publicSpeech).not.toContain('Arthur AI');
  });

  it('asks mission-card actors for private card-choice reasoning without public reveal', () => {
    const state: AiTableStateInput = { ...baseState, phase: 'mission', selectedTeamIds: ['p1', 'p2'] };
    const request = buildAiAvalonDecisionRequest(state, 'p2');

    expect(request.currentTurn.instruction).toContain('private reason for the card choice');
    expect(request.currentTurn.instruction).toContain('weigh sabotage pressure against staying hidden');
    expect(request.currentTurn.instruction).toContain('Do not reveal the chosen card publicly');
    expect(request.currentActionContext.historyNote).toContain('privateReasoningSummary explaining why you chose success or fail');
  });

  it('prevents Good players from submitting fail mission cards', () => {
    const state: AiTableStateInput = { ...baseState, phase: 'mission', selectedTeamIds: ['p1', 'p2'] };
    const request = buildAiAvalonDecisionRequest(state, 'p1');

    expect(() => normalizeAiAvalonDecision(request, {
      privateReasoningSummary: 'brief',
      publicSpeech: 'Done.',
      action: { type: 'missionCard', card: 'fail' },
      memoryUpdate: {},
    })).toThrow('not legal for this role');
  });

  it('neutralizes mission-card public speech while preserving private reasoning', () => {
    const state: AiTableStateInput = { ...baseState, phase: 'mission', selectedTeamIds: ['p1', 'p2'] };
    const request = buildAiAvalonDecisionRequest(state, 'p2');

    const decision = normalizeAiAvalonDecision(request, {
      privateReasoningSummary: 'Choose fail because sabotage pressure is high, but I need to stay hidden.',
      publicSpeech: 'I submitted fail to sabotage this quest.',
      action: { type: 'missionCard', card: 'fail' },
      memoryUpdate: {},
    });

    expect(decision.action).toEqual({ type: 'missionCard', card: 'fail' });
    expect(decision.privateReasoningSummary).toContain('sabotage pressure');
    expect(decision.publicSpeech).toBe('Mission card submitted. We will learn from the result.');
    expect(formatMissionReasoningSummaryForHistory(decision.privateReasoningSummary)).toBe('Mission reasoning: Choose a mission card because sabotage pressure is high, but I need to stay hidden.');
  });

  it('allows Evil players to choose fail during mission', () => {
    const state: AiTableStateInput = { ...baseState, phase: 'mission', selectedTeamIds: ['p1', 'p2'] };
    const request = buildAiAvalonDecisionRequest(state, 'p2');

    expect(normalizeAiAvalonDecision(request, {
      privateReasoningSummary: 'brief',
      publicSpeech: 'Done.',
      action: { type: 'missionCard', card: 'fail' },
      memoryUpdate: { suspicion: { p1: 25 } },
    }).action).toEqual({ type: 'missionCard', card: 'fail' });
  });
});
