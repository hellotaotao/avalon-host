import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../api/ai-avalon';
import { buildAiAvalonDecisionRequest, type AiTableStateInput } from '../src/aiAvalon';

const state: AiTableStateInput = {
  playerCount: 5, phase: 'proposal', roundIndex: 0, leaderIndex: 0,
  selectedTeamIds: [], missionResults: [], tableHistory: [],
  players: [
    { id: 'p1', displayName: 'Merlin', seatIndex: 0, role: 'Merlin', controller: 'ai' },
    { id: 'p2', displayName: 'Assassin', seatIndex: 1, role: 'Assassin', controller: 'ai' },
    { id: 'p3', displayName: 'Loyal', seatIndex: 2, role: 'Loyal Servant', controller: 'human' },
    { id: 'p4', displayName: 'Minion', seatIndex: 3, role: 'Minion', controller: 'ai' },
    { id: 'p5', displayName: 'Loyal 2', seatIndex: 4, role: 'Loyal Servant', controller: 'human' },
  ],
};
const decision = {
  privateReasoningSummary: 'Choose a safe team.', publicSpeech: 'Let us try this team.',
  action: { type: 'proposeTeam', teamIds: ['p1', 'p3'] },
  memoryUpdate: { suspicion: {}, note: 'First proposal.' },
};
const fetchMock = vi.fn();

async function callHandler() {
  const res = { status: vi.fn().mockReturnThis(), setHeader: vi.fn(), json: vi.fn(), end: vi.fn() };
  await handler({ method: 'POST', body: { request: buildAiAvalonDecisionRequest(state, 'p1') } }, res);
  return res;
}

beforeEach(() => {
  for (const name of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_REASONING_EFFORT', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_REASONING_EFFORT']) {
    vi.stubEnv(name, '');
  }
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(decision) } }] }) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('AI provider model and reasoning configuration', () => {
  it('uses Luna with explicit medium reasoning by default', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const res = await callHandler();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'medium' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, model: 'gpt-6-luna' }));
  });

  it('ignores a model or reasoning effort set in the deployment environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini');
    vi.stubEnv('OPENAI_REASONING_EFFORT', 'none');
    await callHandler();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'medium' });
  });

  it('uses the namespaced Luna model through OpenRouter', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    await callHandler();
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'openai/gpt-6-luna', reasoning_effort: 'medium' });
  });

  it('ignores OpenRouter model overrides in the environment too', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'openai/gpt-5.4-mini');
    vi.stubEnv('OPENROUTER_REASONING_EFFORT', 'none');
    await callHandler();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'openai/gpt-6-luna', reasoning_effort: 'medium' });
  });

  it('does not call a provider when no key is configured', async () => {
    const res = await callHandler();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'missing_provider_key' }) }));
  });
});
