import { buildRolePreset, type Player, type Role } from '../domain/avalon';
import { endedByRejectedProposals, MAX_PROPOSALS_PER_QUEST, type MissionState } from '../domain/missionFlow';
import { type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { fillText, formatRole, useI18n } from '../i18n';

export function summarizeRoles(roles: Role[], language: ReturnType<typeof useI18n>['language'] = 'en'): string {
  return summarizeRoleEntries(roles)
    .map((item) => formatRoleCount(item.role, item.count, language))
    .join(', ');
}

export function summarizeRoleEntries(roles: Role[]): Array<{ role: Role; count: number }> {
  const counts = roles.reduce<Record<string, number>>((summary, role) => {
    summary[role] = (summary[role] ?? 0) + 1;
    return summary;
  }, {});
  return Object.entries(counts)
    .map(([role, count]) => ({ role: role as Role, count }));
}

export function formatRoleCount(role: Role, count: number, language: ReturnType<typeof useI18n>['language']): string {
  const roleName = formatRole(role, language);
  return count > 1 ? `${roleName} x${count}` : roleName;
}

export function formatQuestLabel(roundIndex: number, language: ReturnType<typeof useI18n>['language']): string {
  return language === 'zh' ? `第${roundIndex + 1}轮` : `Q${roundIndex + 1}`;
}

export function formatFailThresholdLabel(threshold: number, language: ReturnType<typeof useI18n>['language']): string {
  return language === 'zh' ? ` · ${threshold} 张失败票才失败` : ` / ${threshold} fails`;
}

export function formatFailThresholdRule(threshold: number, language: ReturnType<typeof useI18n>['language']): string {
  return language === 'zh'
    ? `需要 ${threshold} 张失败票才失败`
    : `${threshold} Fail ${threshold === 1 ? 'card' : 'cards'} to fail`;
}

const publicRoleOrder: Role[] = ['Merlin', 'Percival', 'Loyal Servant', 'Assassin', 'Morgana', 'Mordred', 'Oberon', 'Minion'];

// Short form for tight spots such as the room's top bar.
export function formatFailsOnRule(threshold: number, t: (text: string) => string): string {
  return threshold === 1 ? t('Fails on 1 Fail card') : fillText(t('Fails on {count} Fail cards'), { count: String(threshold) });
}

// Chinese sentences run together; English ones need a space.
export function joinSentences(sentences: Array<string | undefined | false>, language: ReturnType<typeof useI18n>['language']): string {
  return sentences.filter(Boolean).join(language === 'zh' ? '' : ' ');
}

export function summarizePublicRoleLineup(players: RoomPlayer[]): Array<{ role: Role; count: number }> {
  const roles = players.map((player) => player.role).filter((role): role is Role => Boolean(role));
  const fallbackRoles = roles.length === players.length ? roles : buildRolePreset(players.length).roles;
  const counts = fallbackRoles.reduce<Map<Role, number>>((summary, role) => {
    summary.set(role, (summary.get(role) ?? 0) + 1);
    return summary;
  }, new Map<Role, number>());
  return publicRoleOrder
    .filter((role) => counts.has(role))
    .map((role) => ({ role, count: counts.get(role) ?? 0 }));
}

export function getRoomHeroTitle(snapshot: RoomSnapshot | undefined, t: (text: string) => string): string {
  if (!snapshot) return t('Round Table Lobby');
  const missionState = snapshot.room.settings.missionState;
  if (snapshot.room.status === 'lobby' || snapshot.room.status === 'setup') return t('Round Table Lobby');
  return missionState?.phase === 'finished' ? t('Game result') : t('Game Progress');
}

export function getGameEndCopy(missionState: MissionState, t: (text: string) => string): string {
  if (endedByRejectedProposals(missionState)) return t('Evil wins because five crew proposals in a row were rejected this quest.');
  if (missionState.assassination) {
    return missionState.winner === 'evil' ? t('The Assassin found Merlin and stole the endgame.') : t('Merlin survived the final guess.');
  }
  return missionState.winner === 'evil' ? t('Evil wins after three failed quests.') : t('Good wins after three successful quests.');
}

export function isFinalProposal(missionState: MissionState): boolean {
  return missionState.proposalIndex + 1 >= MAX_PROPOSALS_PER_QUEST;
}

export function toRoomAvalonPlayer(player: RoomPlayer): Player {
  return { id: player.id, name: player.displayName, role: player.role };
}
