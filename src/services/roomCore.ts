import {
  assignRoles,
  buildRolePreset,
  getRecommendedRolePresetOptions,
  getVisibilityInfo,
  playerCountRange,
  type AssignmentOptions,
  type Player as AvalonPlayer,
  type Role,
  type RolePresetOptions,
} from '../domain/avalon.js';
import {
  createInitialMissionState,
  type MissionState,
} from '../domain/missionFlow.js';

export type RoomStatus = 'setup' | 'lobby' | 'locked' | 'reveal' | 'proposal' | 'vote' | 'mission' | 'assassin' | 'finished';

export interface RoomSettings extends AssignmentOptions {
  plannedPlayerCount?: number;
  createdInDemoMode?: boolean;
  missionState?: MissionState;
}

export interface Room {
  id: string;
  code: string;
  status: RoomStatus;
  gameType: 'avalon_lite';
  settings: RoomSettings;
  updatedAt?: string;
}

export interface RoomPlayer {
  id: string;
  roomId: string;
  displayName: string;
  seatIndex: number;
  isHost: boolean;
  isReady: boolean;
  role?: Role;
  deviceToken?: string;
}

export interface RoomSnapshot {
  room: Room;
  players: RoomPlayer[];
}

export interface CreateRoomInput {
  displayName: string;
  plannedPlayerCount?: number;
  roleOptions?: RolePresetOptions;
  /** @deprecated Formal rooms now use recommended role presets by player count. */
  includePercivalMorgana?: boolean;
  deviceToken: string;
}

export interface JoinRoomInput {
  code: string;
  displayName: string;
  deviceToken: string;
}

export interface StartResult {
  ok: boolean;
  reason?: string;
  snapshot?: RoomSnapshot;
}

export const LOCAL_ROOMS_STORAGE_KEY = 'avalon-host.rooms.v1';
export const DEMO_JOIN_ROOM_CODE = '58213';
export const ACTIVE_ROOM_EXIT_GRACE_MS = 5 * 60 * 1000;

const DEMO_BOT_NAMES = ['Gwen', 'Lance', 'Mira', 'Percy', 'Selene', 'Tristan'];

export function generateRoomCode(existingCodes: Iterable<string> = []): string {
  const existing = new Set(Array.from(existingCodes, normalizeRoomCode));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    if (!existing.has(code)) return code;
  }
  throw new Error('Unable to generate an unused room code');
}

export function normalizeRoomCode(code: string): string {
  return code.replace(/\D/g, '').slice(0, 5);
}

export function getStartValidation(players: RoomPlayer[]): string | undefined {
  const startableCount = getStartablePlayers(players).length;
  if (startableCount < 5) {
    const neededCount = 5 - startableCount;
    return `Need ${neededCount} more ready player${neededCount === 1 ? '' : 's'} to start.`;
  }
  if (startableCount > 10) return 'Avalon Lite supports at most 10 players.';
  return undefined;
}

export function canStartGame(players: RoomPlayer[]): boolean {
  return !getStartValidation(players);
}

export function validateHostCanStart(snapshot: RoomSnapshot, hostPlayerId: string): string | undefined {
  const player = snapshot.players.find((item) => item.id === hostPlayerId);
  if (!player) return 'Player not found.';
  if (!player.isHost) return 'Only the host can start the game.';
  return getStartValidation(snapshot.players);
}

export function getStartablePlayers(players: RoomPlayer[]): RoomPlayer[] {
  const host = players.find((player) => player.isHost);
  const activePlayers = players.filter((player) => player.isReady || player.id === host?.id);
  return activePlayers.map((player, index) => ({
    ...player,
    seatIndex: index,
    isHost: host ? player.id === host.id : index === 0,
    isReady: true,
  }));
}

export function createHostDemoRoom(displayName: string): { snapshot: RoomSnapshot; currentPlayerId: string } {
  const roomId = 'demo-host-room';
  const currentPlayerId = 'demo-host-player';
  const players = [
    makeDemoPlayer(roomId, currentPlayerId, displayName.trim() || 'Demo Host', 0, true),
    ...DEMO_BOT_NAMES.slice(0, 4).map((name, index) => makeDemoPlayer(roomId, `demo-bot-${index + 1}`, `${name} Bot`, index + 1, false)),
  ];
  return { snapshot: makeDemoSnapshot(roomId, '41372', players), currentPlayerId };
}

export function createJoinDemoRoom(displayName: string): { snapshot: RoomSnapshot; currentPlayerId: string } {
  const roomId = 'demo-join-room';
  const currentPlayerId = 'demo-joining-player';
  const players = [
    makeDemoPlayer(roomId, 'demo-existing-host', 'Demo Host', 0, true),
    ...DEMO_BOT_NAMES.slice(0, 3).map((name, index) => makeDemoPlayer(roomId, `demo-existing-bot-${index + 1}`, `${name} Bot`, index + 1, false)),
    makeDemoPlayer(roomId, currentPlayerId, displayName.trim() || 'Demo Guest', 4, false),
  ];
  return { snapshot: makeDemoSnapshot(roomId, DEMO_JOIN_ROOM_CODE, players), currentPlayerId };
}

export function buildCreateRoomSettings(input: Pick<CreateRoomInput, 'plannedPlayerCount' | 'roleOptions' | 'includePercivalMorgana'>): RoomSettings {
  const plannedPlayerCount: number = playerCountRange.includes(input.plannedPlayerCount as (typeof playerCountRange)[number])
    ? input.plannedPlayerCount!
    : playerCountRange[0];
  const roleOptions = sanitizeRoomRoleOptions(plannedPlayerCount, input.roleOptions ?? {
    ...getRecommendedRolePresetOptions(plannedPlayerCount),
    ...(typeof input.includePercivalMorgana === 'boolean'
      ? { includePercival: input.includePercivalMorgana, includeMorgana: input.includePercivalMorgana }
      : {}),
  });
  return {
    plannedPlayerCount,
    ...roleOptions,
  };
}

export function startDemoSnapshot(snapshot: RoomSnapshot, hostPlayerId?: string): StartResult {
  const reason = hostPlayerId ? validateHostCanStart(snapshot, hostPlayerId) : getStartValidation(snapshot.players);
  if (reason) return { ok: false, reason, snapshot };
  const players = getStartablePlayers(snapshot.players);
  const assigned = assignRoles(
    players.map(toAvalonPlayer),
    snapshot.room.settings,
    `${snapshot.room.code}-${players.map((player) => player.id).join('|')}`,
  );
  return {
    ok: true,
    snapshot: {
      ...snapshot,
      room: {
        ...snapshot.room,
        status: 'reveal',
        settings: {
          ...snapshot.room.settings,
          missionState: createInitialMissionState(players.map((player) => player.id)),
        },
      },
      players: players.map((player) => ({
        ...player,
        role: assigned.find((assignedPlayer) => assignedPlayer.id === player.id)?.role,
      })),
    },
  };
}

function sanitizeRoomRoleOptions(playerCount: number, roleOptions: RolePresetOptions): RolePresetOptions {
  const controls: Array<keyof RolePresetOptions> = ['includePercival', 'includeMorgana', 'includeMordred', 'includeOberon'];
  return controls.reduce<RolePresetOptions>((next, key) => {
    if (!roleOptions[key]) return { ...next, [key]: false };
    const candidate = { ...next, [key]: true };
    try {
      buildRolePreset(playerCount, candidate);
      return candidate;
    } catch {
      return { ...next, [key]: false };
    }
  }, {});
}

export function assertDeletedRows(rows: unknown[] | null | undefined, message: string) {
  if (!rows?.length) throw new Error(message);
}

export function removePlayerFromSnapshot(snapshot: RoomSnapshot, hostPlayerId: string, targetPlayerId: string): RoomSnapshot {
  if (snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup') {
    throw new Error('Players can only be removed before the game starts.');
  }
  const host = requirePlayer(snapshot, hostPlayerId);
  if (!host.isHost) throw new Error('Only the host can remove players.');
  if (hostPlayerId === targetPlayerId) throw new Error('Host cannot remove themselves.');
  requirePlayer(snapshot, targetPlayerId);
  snapshot.players = snapshot.players
    .filter((player) => player.id !== targetPlayerId)
    .map((player, index) => ({ ...player, seatIndex: index }));
  return snapshot;
}

export function leavePlayerFromSnapshot(snapshot: RoomSnapshot, playerId: string, options: { allowStaleActiveRoom?: boolean } = {}): RoomSnapshot {
  const active = isRoomInProgress(snapshot);
  if (active && !options.allowStaleActiveRoom) {
    throw new Error('Players can only leave an active game after the room has been inactive for 5 minutes.');
  }
  if (!active && snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup' && snapshot.room.status !== 'finished') {
    throw new Error('Players can only leave before the game starts or after it finishes.');
  }
  requirePlayer(snapshot, playerId);
  snapshot.players = snapshot.players
    .filter((player) => player.id !== playerId)
    .map((player, index) => ({ ...player, seatIndex: index, isHost: index === 0 }));
  if (active) resetAbandonedRoomAfterLeave(snapshot);
  return snapshot;
}

export function isRoomInProgress(snapshot: RoomSnapshot): boolean {
  return snapshot.room.status !== 'lobby' && snapshot.room.status !== 'setup' && snapshot.room.status !== 'finished';
}

export function isRoomStaleForExit(snapshot: RoomSnapshot, nowMs = Date.now()): boolean {
  if (!isRoomInProgress(snapshot)) return true;
  const updatedAtMs = snapshot.room.updatedAt ? Date.parse(snapshot.room.updatedAt) : 0;
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return false;
  return nowMs - updatedAtMs >= ACTIVE_ROOM_EXIT_GRACE_MS;
}

function resetAbandonedRoomAfterLeave(snapshot: RoomSnapshot) {
  const { missionState: _missionState, ...settings } = snapshot.room.settings;
  snapshot.room = {
    ...snapshot.room,
    status: 'lobby',
    settings,
  };
  snapshot.players = snapshot.players.map((player, index) => ({
    ...player,
    seatIndex: index,
    isReady: false,
    role: undefined,
  }));
}


export function transferHostInSnapshot(snapshot: RoomSnapshot, hostPlayerId: string, targetPlayerId: string): RoomSnapshot {
  const host = requirePlayer(snapshot, hostPlayerId);
  if (!host.isHost) throw new Error('Only the host can transfer host rights.');
  const target = requirePlayer(snapshot, targetPlayerId);
  if (host.id === target.id) return snapshot;
  snapshot.players = snapshot.players.map((player) => ({ ...player, isHost: player.id === target.id }));
  return snapshot;
}

export function resetRoomToLobbySnapshot(snapshot: RoomSnapshot, hostPlayerId: string): RoomSnapshot {
  const host = requirePlayer(snapshot, hostPlayerId);
  if (!host.isHost) throw new Error('Only the host can reset the game.');
  const { missionState: _missionState, ...settings } = snapshot.room.settings;
  snapshot.room = {
    ...snapshot.room,
    status: 'lobby',
    settings,
  };
  snapshot.players = snapshot.players.map((player, index) => ({
    ...player,
    seatIndex: index,
    isReady: false,
    role: undefined,
  }));
  return snapshot;
}

export function findPlayerByDeviceToken(players: RoomPlayer[], deviceToken: string): RoomPlayer | undefined {
  return players.find((player) => player.deviceToken === deviceToken);
}

export function findPlayerByDisplayName(players: RoomPlayer[], displayName: string): RoomPlayer | undefined {
  const normalized = normalizeDisplayName(displayName);
  if (!normalized) return undefined;
  return players.find((player) => normalizeDisplayName(player.displayName) === normalized);
}

export function requirePlayer(snapshot: RoomSnapshot, playerId: string) {
  const player = snapshot.players.find((item) => item.id === playerId);
  if (!player) throw new Error('Player not found.');
  return player;
}

export function toAvalonPlayer(player: RoomPlayer): AvalonPlayer {
  return { id: player.id, name: player.displayName, role: player.role };
}

export function mapRoom(row: Record<string, unknown>): Room {
  return {
    id: row.id as string,
    code: row.code as string,
    status: row.status as RoomStatus,
    gameType: row.game_type as 'avalon_lite',
    settings: (row.settings as RoomSettings | null) ?? {},
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at as string | undefined),
  };
}

export function mapPlayer(row: Record<string, unknown>): RoomPlayer {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    displayName: row.display_name as string,
    seatIndex: row.seat_index as number,
    isHost: row.is_host as boolean,
    isReady: row.is_ready as boolean,
    role: row.role as Role | undefined,
    deviceToken: row.device_token_hash as string | undefined,
  };
}

export function getPrivateRoleInfo(currentPlayer: RoomPlayer, players: RoomPlayer[]) {
  if (!currentPlayer.role) return undefined;
  const avalonPlayers = players.map((player) => ({
    id: player.id,
    name: player.displayName,
    role: player.role,
  }));
  return getVisibilityInfo(
    { id: currentPlayer.id, name: currentPlayer.displayName, role: currentPlayer.role },
    avalonPlayers,
  );
}

function normalizeDisplayName(displayName: string) {
  return displayName.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function makeDemoSnapshot(roomId: string, code: string, players: RoomPlayer[]): RoomSnapshot {
  return {
    room: {
      id: roomId,
      code,
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: {
        createdInDemoMode: true,
      },
    },
    players,
  };
}

function makeDemoPlayer(roomId: string, id: string, displayName: string, seatIndex: number, isHost: boolean): RoomPlayer {
  return {
    id,
    roomId,
    displayName,
    seatIndex,
    isHost,
    isReady: true,
    deviceToken: id,
  };
}
