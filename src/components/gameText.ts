import { buildRolePreset, type Player, type Role } from '../domain/avalon';
import { endedByRejectedProposals, MAX_PROPOSALS_PER_QUEST, type MissionState } from '../domain/missionFlow';
import { type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { formatRole, useI18n } from '../i18n';

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

export function getMissionPhaseLabel(missionState: MissionState): string {
  if (missionState.phase === 'proposal') return 'Choosing crew';
  if (missionState.phase === 'vote') return 'Council vote';
  if (missionState.phase === 'mission') return 'Quest underway';
  if (missionState.phase === 'assassin') return 'Assassin endgame';
  return missionState.winner === 'evil' ? 'Evil victory' : 'Good victory';
}

export function getRoomHeroTitle(snapshot: RoomSnapshot | undefined, t: (text: string) => string): string {
  if (!snapshot) return t('Round Table Lobby');
  const missionState = snapshot.room.settings.missionState;
  if (snapshot.room.status === 'lobby' || snapshot.room.status === 'setup') return t('Round Table Lobby');
  return missionState?.phase === 'finished' ? t('Game result') : t('Game Progress');
}

export function getRoomHeroCopy(snapshot: RoomSnapshot | undefined, t: (text: string) => string): string {
  if (!snapshot) return t('Create a room, let every player ready at the table, then reveal each secret role on their own phone.');
  const missionState = snapshot.room.settings.missionState;
  if (snapshot.room.status === 'lobby' || snapshot.room.status === 'setup') return t('Create a room, let every player ready at the table, then reveal each secret role on their own phone.');
  if (snapshot.room.status === 'reveal') return t('Check your private identity first; the shared board below keeps the table moving through teams, votes, quests, and results.');
  if (!missionState) return t('The shared board tracks proposals, votes, mission cards, and quest results.');
  if (missionState.phase === 'proposal') return t('The current captain picks a crew, then every player votes on that proposal.');
  if (missionState.phase === 'vote') return t('Every player votes, including the captain who proposed the crew.');
  if (missionState.phase === 'mission') return t('Only the selected crew submits mission cards; results stay anonymous.');
  if (missionState.phase === 'assassin') return t('Good has three successful quests. The Assassin must guess Merlin before the winner is final.');
  return t('The table is finished. Review the result or reset for the next game.');
}

export function getMissionPhaseCopy({
  missionState,
  currentTeamSize,
  submittedVoteCount,
  submittedCardCount,
  playerCount,
  t,
}: {
  missionState: MissionState;
  currentTeamSize: number;
  submittedVoteCount: number;
  submittedCardCount: number;
  playerCount: number;
  t: (text: string) => string;
}): string {
  if (missionState.phase === 'proposal') {
    return `${t('The captain is choosing exactly')} ${currentTeamSize} ${t('players before the table votes.')}`;
  }
  if (missionState.phase === 'vote') {
    return `${submittedVoteCount}/${playerCount} ${t('phones have voted on the proposed crew.')}`;
  }
  if (missionState.phase === 'mission') {
    return `${submittedCardCount}/${missionState.selectedTeamIds.length} ${t('mission cards are in. The quest resolves when the crew is done.')}`;
  }
  if (missionState.phase === 'assassin') {
    return t('Good reached three successful quests. The Assassin now chooses a Merlin target.');
  }
  return getGameEndCopy(missionState, t);
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
