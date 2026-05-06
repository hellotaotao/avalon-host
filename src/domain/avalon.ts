export type Role = 'Merlin' | 'Assassin' | 'Loyal Servant' | 'Minion' | 'Percival' | 'Morgana' | 'Mordred' | 'Oberon';
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
  includeMordred?: boolean;
  includeOberon?: boolean;
}

export interface RolePresetOptions {
  includePercival?: boolean;
  includeMorgana?: boolean;
  includeMordred?: boolean;
  includeOberon?: boolean;
}

export interface PlayerCountRule {
  playerCount: number;
  goodCount: number;
  evilCount: number;
  teamSizes: number[];
  failThresholds: number[];
}

export interface RolePreset extends PlayerCountRule {
  requiredRoles: Role[];
  optionalRoles: Role[];
  fillerRoles: Role[];
  roles: Role[];
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

export const goodCountByPlayers: Record<number, number> = {
  5: 3,
  6: 4,
  7: 4,
  8: 5,
  9: 6,
  10: 6,
};

export function getRoleDistribution(playerCount: number, options: AssignmentOptions = {}): Role[] {
  return buildRolePreset(playerCount, {
    includePercival: options.includePercivalMorgana && playerCount >= 7,
    includeMorgana: options.includePercivalMorgana && playerCount >= 7,
    includeMordred: options.includeMordred,
    includeOberon: options.includeOberon,
  }).roles;
}

export function assignRoles(players: Player[], options: AssignmentOptions = {}, seed = 'avalon-host'): Player[] {
  const roles = shuffle(getRoleDistribution(players.length, options), seed);
  return players.map((player, index) => ({ ...player, role: roles[index] }));
}

export function roleAllegiance(role: Role): Allegiance {
  return role === 'Assassin' || role === 'Minion' || role === 'Morgana' || role === 'Mordred' || role === 'Oberon' ? 'evil' : 'good';
}

export function getTeamSize(playerCount: number, roundIndex: number): number {
  assertSupportedPlayerCount(playerCount);
  const size = teamSizeByPlayers[playerCount][roundIndex];
  if (!size) throw new Error(`Unsupported round index: ${roundIndex}`);
  return size;
}

export function getMissionFailThreshold(playerCount: number, roundIndex: number): number {
  assertSupportedPlayerCount(playerCount);
  if (roundIndex < 0 || roundIndex > 4) throw new Error(`Unsupported round index: ${roundIndex}`);
  return playerCount >= 7 && roundIndex === 3 ? 2 : 1;
}

export function getPlayerCountRule(playerCount: number): PlayerCountRule {
  assertSupportedPlayerCount(playerCount);
  return {
    playerCount,
    goodCount: goodCountByPlayers[playerCount],
    evilCount: evilCountByPlayers[playerCount],
    teamSizes: [...teamSizeByPlayers[playerCount]],
    failThresholds: [0, 1, 2, 3, 4].map((roundIndex) => getMissionFailThreshold(playerCount, roundIndex)),
  };
}

export function buildRolePreset(playerCount: number, options: RolePresetOptions = {}): RolePreset {
  const rule = getPlayerCountRule(playerCount);
  const requiredRoles: Role[] = ['Merlin', 'Assassin'];
  const optionalRoles: Role[] = [
    ...(options.includePercival ? (['Percival'] as Role[]) : []),
    ...(options.includeMorgana ? (['Morgana'] as Role[]) : []),
    ...(options.includeMordred ? (['Mordred'] as Role[]) : []),
    ...(options.includeOberon ? (['Oberon'] as Role[]) : []),
  ];
  const fixedRoles = [...requiredRoles, ...optionalRoles];
  const fixedGoodCount = fixedRoles.filter((role) => roleAllegiance(role) === 'good').length;
  const fixedEvilCount = fixedRoles.filter((role) => roleAllegiance(role) === 'evil').length;
  if (fixedGoodCount > rule.goodCount) throw new Error(`Too many Good special roles for ${playerCount} players.`);
  if (fixedEvilCount > rule.evilCount) throw new Error(`Too many Evil special roles for ${playerCount} players.`);
  const fillerRoles: Role[] = [
    ...Array.from<Role>({ length: rule.goodCount - fixedGoodCount }).fill('Loyal Servant'),
    ...Array.from<Role>({ length: rule.evilCount - fixedEvilCount }).fill('Minion'),
  ];
  return {
    ...rule,
    requiredRoles,
    optionalRoles,
    fillerRoles,
    roles: [...requiredRoles, ...optionalRoles, ...fillerRoles],
  };
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
  const requiredFails = getMissionFailThreshold(playerCount, roundIndex);
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
      .filter((player) => player.id !== viewer.id && player.role && roleAllegiance(player.role) === 'evil' && player.role !== 'Mordred')
      .forEach((player) => sees.push({ playerId: player.id, name: player.name, hint: 'Evil player' }));
  }

  if (viewer.role === 'Assassin' || viewer.role === 'Minion' || viewer.role === 'Morgana' || viewer.role === 'Mordred') {
    players
      .filter((player) => player.id !== viewer.id && player.role && roleAllegiance(player.role) === 'evil' && player.role !== 'Oberon')
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
