// @ts-nocheck
import {
  normalizeAiAvalonDecision,
  type AiAvalonDecisionRequest,
} from '../src/aiAvalon.js';

type VercelRequest = { method?: string; body?: unknown };
type VercelResponse = {
  status(statusCode: number): VercelResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(): void;
};

const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    return;
  }

  try {
    const body = parseBody(req.body);
    const request = readRequest(body);
    const outputLocale = readOutputLocale(body);
    const provider = getProviderConfig();
    if (!provider) {
      res.status(200).json({
        ok: false,
        error: {
          code: 'missing_provider_key',
          message: 'Set OPENAI_API_KEY (and optional OPENAI_MODEL) or OPENROUTER_API_KEY to enable real AI decisions. Heuristic fallback remains available.',
        },
      });
      return;
    }

    const rawDecision = await requestDecision(provider, request, outputLocale);
    const decision = normalizeAiAvalonDecision(request, rawDecision);
    res.status(200).json({ ok: true, provider: provider.name, model: provider.model, decision });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI decision failed.';
    res.status(200).json({ ok: false, error: { code: 'ai_decision_failed', message } });
  }
}

function getProviderConfig() {
  if (process.env.OPENAI_API_KEY) {
    return {
      name: 'openai',
      url: OPENAI_URL,
      key: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      headers: {},
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: 'openrouter',
      url: OPENROUTER_URL,
      key: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'openai/gpt-5.4-mini',
      headers: {
        'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:5173',
        'X-Title': 'Veiled Roundtable AI Table',
      },
    };
  }
  return undefined;
}

type AiOutputLocale = 'en' | 'zh' | 'ja';

function readOutputLocale(body: unknown): AiOutputLocale {
  if (!isRecord(body)) return 'en';
  const locale = typeof body.locale === 'string' ? body.locale.toLowerCase() : '';
  if (locale.startsWith('zh')) return 'zh';
  if (locale.startsWith('ja')) return 'ja';
  return 'en';
}

function outputLanguageInstruction(locale: AiOutputLocale): string {
  if (locale === 'zh') {
    return 'Output language: Simplified Chinese. Write privateReasoningSummary, publicSpeech, memoryUpdate.note, and any other natural-language text in Simplified Chinese. Keep action enum values and JSON keys exactly as specified in English.';
  }
  if (locale === 'ja') {
    return 'Output language: Japanese. Write privateReasoningSummary, publicSpeech, memoryUpdate.note, and any other natural-language text in Japanese. Keep action enum values and JSON keys exactly as specified in English.';
  }
  return 'Output language: English. Keep action enum values and JSON keys exactly as specified.';
}

async function requestDecision(provider: ReturnType<typeof getProviderConfig>, request: AiAvalonDecisionRequest, outputLocale: AiOutputLocale) {
  const response = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.key}`,
      ...provider.headers,
    },
    body: JSON.stringify({
      model: provider.model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You are one independent AI participant in Avalon Lite, not an omniscient narrator.',
            'Use only the JSON input provided: your own role, role-visible info, your own memory, currentTurn, currentActionContext, legal actions, and historical publicTableHistory.',
            'currentActionContext is authoritative for the action happening now. publicTableHistory is historical and may mention older proposals.',
            'During vote phase, vote only on currentActionContext.currentProposedTeam/currentProposedTeamIds. In publicSpeech, refer to that current team, not a stale team from history.',
            'Before evaluating a vote or mission team, explicitly check roleVisiblePlayersOnCurrentTeam/currentActionContext.currentTeamRoleVisibleInfo; this is the intersection of the current team and your role-visible information.',
            'Prioritize roleVisibleInfo over table vibes when evaluating the current team. If you are Merlin and the current team contains a player hinted as "Evil player", your privateReasoningSummary must account for that known evil. Usually reject such teams unless you explicitly justify a Merlin-cover strategy; never reveal that certainty publicly.',
            'Percival "Merlin candidate" hints are ambiguity, not evil certainty. Evil-player and evil-teammate hints have different meanings; do not overgeneralize hint strings.',
            'Never infer or reveal hidden roles beyond roleVisibleInfo. Do not produce chain-of-thought.',
            outputLanguageInstruction(outputLocale),
            'Return only JSON with keys: privateReasoningSummary, publicSpeech, action, memoryUpdate.',
            'privateReasoningSummary must be a brief summary, not step-by-step reasoning. For missionCard, it must explain why you chose success or fail; good players must submit success, while evil players should weigh sabotage pressure against staying hidden.',
            'For missionCard, publicSpeech must stay neutral and must not reveal whether you submitted success or fail before mission resolution.',
            'For assassinate, choose one legal candidate most likely to be Merlin using public history, role-visible info, and your own memory. Use evil-teammate visibility to avoid known evil allies; the orchestrator does not tell you Merlin.',
            'action must match exactly one legal action. For proposeTeam use {"type":"proposeTeam","teamIds":[...]}; for vote use {"type":"vote","vote":"approve|reject"}; for missionCard use {"type":"missionCard","card":"success|fail"}; for assassinate use {"type":"assassinate","targetPlayerId":"..."}.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(request),
        },
      ],
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error?.message === 'string' ? body.error.message : `Provider returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Provider response did not contain a JSON message.');
  return parseJsonObject(content);
}

function readRequest(body: unknown): AiAvalonDecisionRequest {
  if (!isRecord(body) || !isRecord(body.request)) throw new Error('Missing AI decision request.');
  const request = body.request;
  assertFilteredRequest(request);

  // Rebuild a strict allow-listed payload before sending anything to the model.
  // This protects against accidental client additions such as full player roles or other agents' memory.
  return {
    game: {
      name: 'Avalon Lite',
      playerCount: request.game.playerCount,
      roundIndex: request.game.roundIndex,
      phase: request.game.phase,
      teamSize: request.game.teamSize,
      selectedTeamIds: [...request.game.selectedTeamIds],
      missionResults: request.game.missionResults.map((result) => ({ ...result })),
      lastVote: request.game.lastVote ? { ...request.game.lastVote } : undefined,
      lastMission: request.game.lastMission ? { ...request.game.lastMission } : undefined,
    },
    currentTurn: {
      phase: request.currentTurn.phase,
      actorId: request.currentTurn.actorId,
      actorName: request.currentTurn.actorName,
      instruction: request.currentTurn.instruction,
    },
    currentActionContext: {
      actionType: request.currentActionContext.actionType,
      currentProposedTeamIds: [...request.currentActionContext.currentProposedTeamIds],
      currentProposedTeam: request.currentActionContext.currentProposedTeam.map((player) => ({
        playerId: player.playerId,
        displayName: player.displayName,
        seatIndex: player.seatIndex,
      })),
      currentProposedTeamText: request.currentActionContext.currentProposedTeamText,
      currentTeamRoleVisibleInfo: intersectRoleVisibleInfoWithCurrentTeam(request.roleVisibleInfo, request.currentActionContext.currentProposedTeamIds),
      historyNote: request.currentActionContext.historyNote,
    },
    actingPlayer: {
      playerId: request.actingPlayer.playerId,
      displayName: request.actingPlayer.displayName,
      seatIndex: request.actingPlayer.seatIndex,
      role: request.actingPlayer.role,
      allegiance: request.actingPlayer.allegiance,
      persona: request.actingPlayer.persona,
    },
    publicPlayers: request.publicPlayers.map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      seatIndex: player.seatIndex,
    })),
    roleVisibleInfo: request.roleVisibleInfo.map((item) => ({ playerId: item.playerId, displayName: item.displayName, hint: item.hint })),
    roleVisiblePlayersOnCurrentTeam: intersectRoleVisibleInfoWithCurrentTeam(request.roleVisibleInfo, request.currentActionContext.currentProposedTeamIds),
    publicTableHistoryNote: request.publicTableHistoryNote,
    publicTableHistory: request.publicTableHistory.map((entry) => ({
      roundIndex: entry.roundIndex,
      actorId: entry.actorId,
      actorName: entry.actorName,
      kind: entry.kind,
      text: entry.text,
    })),
    ownMemory: {
      suspicion: { ...request.ownMemory.suspicion },
      notes: [...request.ownMemory.notes],
      publicClaims: [...request.ownMemory.publicClaims],
    },
    legalActions: request.legalActions.map((action) => ({ ...action })),
  };
}

function assertFilteredRequest(request: AiAvalonDecisionRequest) {
  if (!isRecord(request) || !isRecord(request.game) || !isRecord(request.currentTurn) || !isRecord(request.currentActionContext) || !isRecord(request.actingPlayer) || !Array.isArray(request.publicPlayers) || !Array.isArray(request.roleVisibleInfo) || !Array.isArray(request.publicTableHistory) || !Array.isArray(request.legalActions)) {
    throw new Error('Malformed AI decision request.');
  }
  if (!Array.isArray(request.currentActionContext.currentProposedTeamIds) || !Array.isArray(request.currentActionContext.currentProposedTeam)) {
    throw new Error('Malformed current action context.');
  }
  if ('currentTeamRoleVisibleInfo' in request.currentActionContext && !Array.isArray(request.currentActionContext.currentTeamRoleVisibleInfo)) {
    throw new Error('Malformed current team role-visible info.');
  }
  for (const player of request.currentActionContext.currentProposedTeam) {
    if (!isRecord(player)) throw new Error('Malformed current proposed team entry.');
    if ('role' in player || 'memory' in player || 'teamVote' in player || 'missionCard' in player) {
      throw new Error('AI request must not include hidden current team state.');
    }
  }
  for (const player of request.publicPlayers) {
    if (!isRecord(player)) throw new Error('Malformed public player entry.');
    if ('role' in player || 'memory' in player || 'teamVote' in player || 'missionCard' in player) {
      throw new Error('AI request must not include hidden public player state.');
    }
  }
  for (const item of request.roleVisibleInfo) {
    if (!isRecord(item)) throw new Error('Malformed role-visible info.');
    if ('role' in item || 'memory' in item || 'teamVote' in item || 'missionCard' in item) {
      throw new Error('AI request must not include hidden role-visible player state.');
    }
  }
  if (!isRecord(request.ownMemory) || !isRecord(request.ownMemory.suspicion) || !Array.isArray(request.ownMemory.notes) || !Array.isArray(request.ownMemory.publicClaims)) {
    throw new Error('AI request must include only acting player memory.');
  }
}

function intersectRoleVisibleInfoWithCurrentTeam(roleVisibleInfo: AiAvalonDecisionRequest['roleVisibleInfo'], currentTeamIds: string[]) {
  const currentTeamIdSet = new Set(currentTeamIds);
  return roleVisibleInfo
    .filter((item) => currentTeamIdSet.has(item.playerId))
    .map((item) => ({ playerId: item.playerId, displayName: item.displayName, hint: item.hint }));
}

function parseBody(body: unknown): unknown {
  if (typeof body === 'string') return JSON.parse(body);
  return body ?? {};
}

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Provider did not return valid JSON.');
    return JSON.parse(match[0]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
