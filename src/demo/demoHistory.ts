import { type AiBeliefAudit } from '../aiAvalon';
import { type Language } from '../i18n';
import { type DemoHistoryEntry, type DemoHistoryTone, type DemoPlayer, type DemoState } from './demoTypes';

export function makeHistory(
  demo: DemoState,
  actor: DemoPlayer | undefined,
  kind: DemoHistoryEntry['kind'],
  text: string,
  audit?: AiBeliefAudit,
  data?: DemoHistoryEntry['data'],
): DemoHistoryEntry {
  return {
    id: `${Date.now()}-${demo.tableHistory.length}-${demo.aiHistory.length}-${actor?.id ?? 'table'}-${kind}`,
    roundIndex: demo.roundIndex,
    actorId: actor?.id,
    actorName: actor?.displayName,
    kind,
    text,
    audit,
    data,
  };
}

export function formatDemoHistoryEntry(entry: DemoHistoryEntry, language: Language): { label: string; text: string; tone: DemoHistoryTone; actorFallback: string } {
  const isZh = language === 'zh';
  const actorFallback = isZh ? '牌桌' : 'Table';
  const rawText = stripHistoryActorPrefix(entry.text, entry.actorName);

  if (entry.kind === 'speech') {
    return { label: isZh ? '发言' : 'Speech', text: rawText, tone: 'speech', actorFallback };
  }

  if (rawText.startsWith('Mission reasoning:')) {
    return {
      label: isZh ? '任务推理' : 'Mission reasoning',
      text: rawText.replace(/^Mission reasoning:\s*/, ''),
      tone: 'reasoning',
      actorFallback: isZh ? 'AI' : 'AI',
    };
  }

  if (rawText.startsWith('Assassin reasoning:') || rawText.startsWith('Assassin heuristic:') || rawText.startsWith('刺客推理：')) {
    return {
      label: isZh ? '刺客推理' : 'Assassin reasoning',
      text: rawText.replace(/^(Assassin reasoning:|Assassin heuristic:|刺客推理：)\s*/, ''),
      tone: 'reasoning',
      actorFallback: isZh ? 'AI' : 'AI',
    };
  }

  if (rawText.startsWith('Private reasoning:') || rawText.startsWith('私有推理：')) {
    return {
      label: isZh ? '私有推理' : 'Private reasoning',
      text: rawText.replace(/^(Private reasoning:|私有推理：)\s*/, ''),
      tone: 'reasoning',
      actorFallback: isZh ? 'AI' : 'AI',
    };
  }

  if (entry.kind === 'proposal') {
    const team = rawText.match(/^proposed (.+)\.$/i)?.[1] ?? rawText.match(/^.+? proposed (.+)\.$/i)?.[1];
    return {
      label: isZh ? '操作' : 'Action',
      text: team ? (isZh ? `提议任务队伍：${team.replace(/, /g, '、')}` : `Proposed quest team: ${team}.`) : rawText,
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'vote') {
    const vote = rawText.match(/^voted (approve|reject)\.$/i)?.[1] ?? rawText.match(/^.+? voted (approve|reject)\.$/i)?.[1];
    return {
      label: isZh ? '操作' : 'Action',
      text: vote ? (isZh ? `投票：${vote === 'approve' ? '赞成' : '反对'}` : `Voted ${vote}.`) : rawText,
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'mission' && /submitted a mission card\./i.test(rawText)) {
    return {
      label: isZh ? '操作' : 'Action',
      text: isZh ? '已提交任务票。' : 'Submitted a mission card.',
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'assassin') {
    const target = rawText.match(/^chose (.+) as Merlin\./i)?.[1] ?? rawText.match(/^.+? chose (.+) as Merlin\./i)?.[1];
    const hitMerlin = /Merlin was found/i.test(rawText);
    const merlinSurvived = /Merlin survived/i.test(rawText);
    return {
      label: isZh ? '操作' : 'Action',
      text: target && (hitMerlin || merlinSurvived)
        ? isZh
          ? `刺杀梅林：选择 ${target}。${hitMerlin ? '刺中梅林，坏人获胜。' : '梅林存活，好人获胜。'}`
          : `Chose ${target} as Merlin. ${hitMerlin ? 'Merlin was found; Evil wins.' : 'Merlin survived; Good wins.'}`
        : rawText,
      tone: 'action',
      actorFallback,
    };
  }

  if (entry.kind === 'result') {
    const start = rawText.match(/^Demo roundtable started with (\d+) players and (\d+) AI fill-ins\.$/);
    return {
      label: isZh ? '进度' : 'Progress',
      text: start && isZh ? `演示圆桌开始：${start[1]} 名玩家，${start[2]} 个 AI 补位。` : rawText,
      tone: 'result',
      actorFallback,
    };
  }

  return { label: isZh ? '操作' : 'Action', text: rawText, tone: 'action', actorFallback };
}

function stripHistoryActorPrefix(text: string, actorName?: string): string {
  if (!actorName) return text;
  const prefix = `${actorName} `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export function formatPrivateReasoningSummaryForHistory(summary: string): string {
  return `Private reasoning: ${summary}`;
}
