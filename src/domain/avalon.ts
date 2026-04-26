export type Role = 'Merlin' | 'Assassin' | 'Loyal Servant' | 'Minion' | 'Percival' | 'Morgana';
export type Allegiance = 'good' | 'evil';
export type Vote = 'approve' | 'reject';
export type MissionCard = 'success' | 'fail';

export interface Player {
  id: string;
  name: string;
  role?: Role;
}

export interface AssignmentOptions {
  includePercivalMorgana?: boolean;
}

export interface VisibilityInfo {
  playerId: string;
  role: Role;
  allegiance: Allegiance;
  sees: Array<{ playerId: string; name: string; hint: string }>;
}

export const playerCountRange = [5, 6, 7, 8, 9, 10] as const;

export const teamSizeByPlayers: Record<number, number[]> = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

export const evilCountByPlayers: Record<number, number> = {
  5: 2,
  6: 2,
  7: 3,
  8: 3,
  9: 3,
  10: 4,
};

export function getRoleDistribution(playerCount: number, options: AssignmentOptions = {}): Role[] {
  assertSupportedPlayerCount(playerCount);
  const evilCount = evilCountByPlayers[playerCount];
  const goodCount = playerCount - evilCount;
  const roles: Role[] = ['Merlin', 'Assassin'];

  if (options.includePercivalMorgana && playerCount >= 7) {
    roles.push('Percival', 'Morgana');
  }

  const currentGood = roles.filter((role) => roleAllegiance(role) === 'good').length;
  const currentEvil = roles.filter((role) => roleAllegiance(role) === 'evil').length;

  roles.push(...Array.from<Role>({ length: goodCount - currentGood }).fill('Loyal Servant'));
  roles.push(...Array.from<Role>({ length: evilCount - currentEvil }).fill('Minion'));
  return roles;
}

export function assignRoles(players: Player[], options: AssignmentOptions = {}, seed = 'avalon-host'): Player[] {
  const roles = shuffle(getRoleDistribution(players.length, options), seed);
  return players.map((player, index) => ({ ...player, role: roles[index] }));
}

export function roleAllegiance(role: Role): Allegiance {
  return role === 'Assassin' || role === 'Minion' || role === 'Morgana' ? 'evil' : 'good';
}

export function getTeamSize(playerCount: number, roundIndex: number): number {
  assertSupportedPlayerCount(playerCount);
  const size = teamSizeByPlayers[playerCount][roundIndex];
  if (!size) throw new Error(`Unsupported round index: ${roundIndex}`);
  return size;
}

export function votePasses(votes: Vote[], playerCount: number): boolean {
  return votes.filter((vote) => vote === 'approve').length > playerCount / 2;
}

export function resolveMission(cards: MissionCard[], playerCount: number, roundIndex: number): {
  outcome: 'success' | 'fail';
  failCount: number;
  requiredFails: number;
} {
  const failCount = cards.filter((card) => card === 'fail').length;
  const requiredFails = playerCount >= 7 && roundIndex === 3 ? 2 : 1;
  return {
    outcome: failCount >= requiredFails ? 'fail' : 'success',
    failCount,
    requiredFails,
  };
}

export function getVisibilityInfo(viewer: Player, players: Player[]): VisibilityInfo {
  if (!viewer.role) throw new Error('Viewer has no role');
  const sees: VisibilityInfo['sees'] = [];

  if (viewer.role === 'Merlin') {
    players
      .filter((player) => player.id !== viewer.id && player.role && roleAllegiance(player.role) === 'evil')
      .forEach((player) => sees.push({ playerId: player.id, name: player.name, hint: 'Evil player' }));
  }

  if (viewer.role === 'Assassin' || viewer.role === 'Minion' || viewer.role === 'Morgana') {
    players
      .filter((player) => player.id !== viewer.id && player.role && roleAllegiance(player.role) === 'evil')
      .forEach((player) => sees.push({ playerId: player.id, name: player.name, hint: 'Evil teammate' }));
  }

  if (viewer.role === 'Percival') {
    players
      .filter((player) => player.role === 'Merlin' || player.role === 'Morgana')
      .forEach((player) => sees.push({ playerId: player.id, name: player.name, hint: 'Merlin candidate' }));
  }

  return {
    playerId: viewer.id,
    role: viewer.role,
    allegiance: roleAllegiance(viewer.role),
    sees,
  };
}

export function assassinWins(guessPlayerId: string, players: Player[]): boolean {
  return players.find((player) => player.id === guessPlayerId)?.role === 'Merlin';
}

function assertSupportedPlayerCount(playerCount: number): void {
  if (!playerCountRange.includes(playerCount as (typeof playerCountRange)[number])) {
    throw new Error(`Avalon Lite supports 5-10 players, got ${playerCount}`);
  }
}

function shuffle<T>(items: T[], seed: string): T[] {
  const copy = [...items];
  let state = hashSeed(seed);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function hashSeed(seed: string): number {
  return [...seed].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) >>> 0, 2166136261);
}
