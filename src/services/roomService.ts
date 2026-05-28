import {
  ensureMissionState,
  resolveAssassination,
  submitMissionCard as submitMissionCardToState,
  submitTeamProposal,
  submitTeamVote as submitTeamVoteToState,
  type MissionState,
} from '../domain/missionFlow';
import type { MissionCard, Vote } from '../domain/avalon';
import { isDevSessionActive } from '../sessionKeys';
import {
  buildCreateRoomSettings,
  findPlayerByDeviceToken,
  findPlayerByDisplayName,
  generateRoomCode,
  isRoomStaleForExit,
  leavePlayerFromSnapshot,
  LOCAL_ROOMS_STORAGE_KEY,
  normalizeRoomCode,
  removePlayerFromSnapshot,
  startDemoSnapshot,
  transferHostInSnapshot,
  resetRoomToLobbySnapshot,
  validateHostCanStart,
  type CreateRoomInput,
  type JoinRoomInput,
  type Room,
  type RoomSnapshot,
  type StartResult,
} from './roomCore';

export {
  assertDeletedRows,
  buildCreateRoomSettings,
  canStartGame,
  createHostDemoRoom,
  createJoinDemoRoom,
  DEMO_JOIN_ROOM_CODE,
  findPlayerByDeviceToken,
  findPlayerByDisplayName,
  generateRoomCode,
  isRoomStaleForExit,
  getPrivateRoleInfo,
  getStartablePlayers,
  getStartValidation,
  leavePlayerFromSnapshot,
  LOCAL_ROOMS_STORAGE_KEY,
  normalizeRoomCode,
  removePlayerFromSnapshot,
  startDemoSnapshot,
  transferHostInSnapshot,
  resetRoomToLobbySnapshot,
  validateHostCanStart,
  type CreateRoomInput,
  type JoinRoomInput,
  type Room,
  type RoomPlayer,
  type RoomSettings,
  type RoomSnapshot,
  type RoomStatus,
  type StartResult,
} from './roomCore';

type Listener = (snapshot: RoomSnapshot | undefined) => void;

interface RoomRepository {
  createRoom(input: CreateRoomInput): Promise<{ snapshot: RoomSnapshot; currentPlayerId: string }>;
  joinRoom(input: JoinRoomInput): Promise<{ snapshot: RoomSnapshot; currentPlayerId: string }>;
  updateNickname(roomId: string, playerId: string, displayName: string): Promise<RoomSnapshot>;
  setReady(roomId: string, playerId: string, isReady: boolean): Promise<RoomSnapshot>;
  startGame(roomId: string, hostPlayerId: string): Promise<StartResult>;
  updateMissionState(roomId: string, hostPlayerId: string, missionState: MissionState): Promise<RoomSnapshot>;
  proposeMissionTeam(roomId: string, leaderPlayerId: string, selectedTeamIds: string[]): Promise<RoomSnapshot>;
  submitTeamVote(roomId: string, playerId: string, vote: Vote): Promise<RoomSnapshot>;
  submitMissionCard(roomId: string, playerId: string, card: MissionCard): Promise<RoomSnapshot>;
  submitAssassination(roomId: string, assassinPlayerId: string, targetPlayerId: string): Promise<RoomSnapshot>;
  removePlayer(roomId: string, hostPlayerId: string, targetPlayerId: string): Promise<RoomSnapshot>;
  transferHost(roomId: string, hostPlayerId: string, targetPlayerId: string): Promise<RoomSnapshot>;
  resetRoomToLobby(roomId: string, hostPlayerId: string): Promise<RoomSnapshot>;
  dissolveRoom(roomId: string, hostPlayerId: string): Promise<null>;
  leaveRoom(roomId: string, playerId: string): Promise<RoomSnapshot>;
  getRoomById(roomId: string): Promise<RoomSnapshot | undefined>;
  getRoomByCode(code: string): Promise<RoomSnapshot | undefined>;
  subscribeToRoom(roomId: string, listener: Listener): () => void;
}

export const isHostedConfigured = Boolean(!isDevSessionActive() && (import.meta.env.PROD || import.meta.env.VITE_USE_NEON_API === 'true'));

export async function createRoom(input: CreateRoomInput): Promise<{ snapshot: RoomSnapshot; currentPlayerId: string }> {
  return repository().createRoom(input);
}

export async function joinRoom(input: JoinRoomInput): Promise<{ snapshot: RoomSnapshot; currentPlayerId: string }> {
  return repository().joinRoom(input);
}

export async function updateNickname(roomId: string, playerId: string, displayName: string): Promise<RoomSnapshot> {
  return repository().updateNickname(roomId, playerId, displayName);
}

export async function setReady(roomId: string, playerId: string, isReady: boolean): Promise<RoomSnapshot> {
  return repository().setReady(roomId, playerId, isReady);
}

export async function startGame(roomId: string, hostPlayerId: string): Promise<StartResult> {
  return repository().startGame(roomId, hostPlayerId);
}

export async function updateMissionState(roomId: string, hostPlayerId: string, missionState: MissionState): Promise<RoomSnapshot> {
  return repository().updateMissionState(roomId, hostPlayerId, missionState);
}

export async function proposeMissionTeam(roomId: string, leaderPlayerId: string, selectedTeamIds: string[]): Promise<RoomSnapshot> {
  return repository().proposeMissionTeam(roomId, leaderPlayerId, selectedTeamIds);
}

export async function submitTeamVote(roomId: string, playerId: string, vote: Vote): Promise<RoomSnapshot> {
  return repository().submitTeamVote(roomId, playerId, vote);
}

export async function submitMissionCard(roomId: string, playerId: string, card: MissionCard): Promise<RoomSnapshot> {
  return repository().submitMissionCard(roomId, playerId, card);
}

export async function submitAssassination(roomId: string, assassinPlayerId: string, targetPlayerId: string): Promise<RoomSnapshot> {
  return repository().submitAssassination(roomId, assassinPlayerId, targetPlayerId);
}

export async function removePlayer(roomId: string, hostPlayerId: string, targetPlayerId: string): Promise<RoomSnapshot> {
  return repository().removePlayer(roomId, hostPlayerId, targetPlayerId);
}

export async function transferHost(roomId: string, hostPlayerId: string, targetPlayerId: string): Promise<RoomSnapshot> {
  return repository().transferHost(roomId, hostPlayerId, targetPlayerId);
}

export async function resetRoomToLobby(roomId: string, hostPlayerId: string): Promise<RoomSnapshot> {
  return repository().resetRoomToLobby(roomId, hostPlayerId);
}

export async function dissolveRoom(roomId: string, hostPlayerId: string): Promise<null> {
  return repository().dissolveRoom(roomId, hostPlayerId);
}

export async function leaveRoom(roomId: string, playerId: string): Promise<RoomSnapshot> {
  return repository().leaveRoom(roomId, playerId);
}

export async function getRoomById(roomId: string): Promise<RoomSnapshot | undefined> {
  return repository().getRoomById(roomId);
}

export async function getRoomByCode(code: string): Promise<RoomSnapshot | undefined> {
  return repository().getRoomByCode(code);
}

export function subscribeToRoom(roomId: string, listener: Listener): () => void {
  return repository().subscribeToRoom(roomId, listener);
}

function repository(): RoomRepository {
  return isHostedConfigured ? apiRepository : localRepository;
}

const localRepository: RoomRepository = {
  async createRoom(input: CreateRoomInput) {
    const data = readRooms();
    const code = generateRoomCode(data.rooms.map((item) => item.room.code));
    const room: Room = {
      id: crypto.randomUUID(),
      code,
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: buildCreateRoomSettings(input),
      updatedAt: new Date().toISOString(),
    };
    const player = {
      id: crypto.randomUUID(),
      roomId: room.id,
      displayName: input.displayName.trim(),
      seatIndex: 0,
      isHost: true,
      isReady: false,
      deviceToken: input.deviceToken,
    };
    const snapshot = { room, players: [player] };
    data.rooms.push(snapshot);
    writeRooms(data, snapshot.room.id);
    return { snapshot, currentPlayerId: player.id };
  },

  async joinRoom(input: JoinRoomInput) {
    const data = readRooms();
    const snapshot = findByCode(data, input.code);
    if (!snapshot) throw new Error('Room not found.');
    const displayName = input.displayName.trim();
    const sameDevicePlayer = findPlayerByDeviceToken(snapshot.players, input.deviceToken);
    if (sameDevicePlayer) {
      if (displayName && sameDevicePlayer.displayName !== displayName) sameDevicePlayer.displayName = displayName;
      writeRooms(data, snapshot.room.id);
      return { snapshot, currentPlayerId: sameDevicePlayer.id };
    }
    if (snapshot.room.status !== 'lobby') throw new Error('This game has already started. Only original players can re-enter from the same device.');
    const existingPlayer = findPlayerByDisplayName(snapshot.players, displayName);
    if (existingPlayer) {
      if (existingPlayer.displayName !== displayName) existingPlayer.displayName = displayName;
      existingPlayer.deviceToken = input.deviceToken;
      writeRooms(data, snapshot.room.id);
      return { snapshot, currentPlayerId: existingPlayer.id };
    }
    if (snapshot.players.length >= 10) throw new Error('This room already has 10 players.');
    const player = {
      id: crypto.randomUUID(),
      roomId: snapshot.room.id,
      displayName,
      seatIndex: snapshot.players.length,
      isHost: false,
      isReady: false,
      deviceToken: input.deviceToken,
    };
    snapshot.players.push(player);
    writeRooms(data, snapshot.room.id);
    return { snapshot, currentPlayerId: player.id };
  },

  async updateNickname(roomId: string, playerId: string, displayName: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    requireLocalPlayer(snapshot, playerId).displayName = displayName.trim();
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async setReady(roomId: string, playerId: string, isReady: boolean) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    requireLocalPlayer(snapshot, playerId).isReady = isReady;
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async startGame(roomId: string, hostPlayerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const reason = validateHostCanStart(snapshot, hostPlayerId);
    if (reason) return { ok: false, reason, snapshot };
    const result = startDemoSnapshot(snapshot, hostPlayerId);
    if (result.snapshot) {
      const index = data.rooms.findIndex((item) => item.room.id === roomId);
      data.rooms[index] = result.snapshot;
      writeRooms(data, snapshot.room.id);
    }
    return result;
  },

  async updateMissionState(roomId: string, hostPlayerId: string, missionState: MissionState) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const host = requireLocalPlayer(snapshot, hostPlayerId);
    if (!host.isHost) throw new Error('Only the host can use backup controls.');
    snapshot.room.settings = { ...snapshot.room.settings, missionState };
    snapshot.room.status = missionState.phase;
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async proposeMissionTeam(roomId: string, leaderPlayerId: string, selectedTeamIds: string[]) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const playerIds = snapshot.players.map((player) => player.id);
    const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
    const nextMissionState = submitTeamProposal(missionState, playerIds, leaderPlayerId, selectedTeamIds);
    snapshot.room.settings = { ...snapshot.room.settings, missionState: nextMissionState };
    snapshot.room.status = nextMissionState.phase;
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async submitTeamVote(roomId: string, playerId: string, vote: Vote) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const playerIds = snapshot.players.map((player) => player.id);
    const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
    const nextMissionState = submitTeamVoteToState(missionState, playerIds, playerId, vote);
    snapshot.room.settings = { ...snapshot.room.settings, missionState: nextMissionState };
    snapshot.room.status = nextMissionState.phase;
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async submitMissionCard(roomId: string, playerId: string, card: MissionCard) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const playerIds = snapshot.players.map((player) => player.id);
    const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
    const nextMissionState = submitMissionCardToState(
      missionState,
      playerIds,
      snapshot.players.map((player) => ({ id: player.id, name: player.displayName, role: player.role })),
      playerId,
      card,
    );
    snapshot.room.settings = { ...snapshot.room.settings, missionState: nextMissionState };
    snapshot.room.status = nextMissionState.phase;
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async submitAssassination(roomId: string, assassinPlayerId: string, targetPlayerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const playerIds = snapshot.players.map((player) => player.id);
    const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
    const nextMissionState = resolveAssassination(
      missionState,
      snapshot.players.map((player) => ({ id: player.id, name: player.displayName, role: player.role })),
      assassinPlayerId,
      targetPlayerId,
    );
    snapshot.room.settings = { ...snapshot.room.settings, missionState: nextMissionState };
    snapshot.room.status = nextMissionState.phase;
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async removePlayer(roomId: string, hostPlayerId: string, targetPlayerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    removePlayerFromSnapshot(snapshot, hostPlayerId, targetPlayerId);
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async transferHost(roomId: string, hostPlayerId: string, targetPlayerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    transferHostInSnapshot(snapshot, hostPlayerId, targetPlayerId);
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async resetRoomToLobby(roomId: string, hostPlayerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    resetRoomToLobbySnapshot(snapshot, hostPlayerId);
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async dissolveRoom(roomId: string, hostPlayerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const host = requireLocalPlayer(snapshot, hostPlayerId);
    if (!host.isHost) throw new Error('Only the host can dissolve the room.');
    data.rooms = data.rooms.filter((room) => room.room.id !== roomId);
    writeRooms(data, snapshot.room.id);
    return null;
  },

  async leaveRoom(roomId: string, playerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    leavePlayerFromSnapshot(snapshot, playerId, { allowStaleActiveRoom: isRoomStaleForExit(snapshot) });
    if (snapshot.players.length === 0) {
      data.rooms = data.rooms.filter((room) => room.room.id !== roomId);
    }
    writeRooms(data, snapshot.room.id);
    return snapshot;
  },

  async getRoomById(roomId: string) {
    return readRooms().rooms.find((snapshot) => snapshot.room.id === roomId);
  },

  async getRoomByCode(code: string) {
    return findByCode(readRooms(), code);
  },

  subscribeToRoom(roomId: string, listener: Listener) {
    listener(readRooms().rooms.find((snapshot) => snapshot.room.id === roomId));
    const handler = (event: StorageEvent) => {
      if (event.key === LOCAL_ROOMS_STORAGE_KEY) {
        listener(readRooms().rooms.find((snapshot) => snapshot.room.id === roomId));
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  },
};

const apiRepository: RoomRepository = {
  createRoom: (input) => apiRequest('createRoom', { input }),
  joinRoom: (input) => apiRequest('joinRoom', { input }),
  updateNickname: (roomId, playerId, displayName) => apiRequest('updateNickname', { roomId, playerId, displayName }),
  setReady: (roomId, playerId, isReady) => apiRequest('setReady', { roomId, playerId, isReady }),
  startGame: (roomId, hostPlayerId) => apiRequest('startGame', { roomId, hostPlayerId }),
  updateMissionState: (roomId, hostPlayerId, missionState) => apiRequest('updateMissionState', { roomId, hostPlayerId, missionState }),
  proposeMissionTeam: (roomId, leaderPlayerId, selectedTeamIds) => apiRequest('proposeMissionTeam', { roomId, leaderPlayerId, selectedTeamIds }),
  submitTeamVote: (roomId, playerId, vote) => apiRequest('submitTeamVote', { roomId, playerId, vote }),
  submitMissionCard: (roomId, playerId, card) => apiRequest('submitMissionCard', { roomId, playerId, card }),
  submitAssassination: (roomId, assassinPlayerId, targetPlayerId) => apiRequest('submitAssassination', { roomId, assassinPlayerId, targetPlayerId }),
  removePlayer: (roomId, hostPlayerId, targetPlayerId) => apiRequest('removePlayer', { roomId, hostPlayerId, targetPlayerId }),
  transferHost: (roomId, hostPlayerId, targetPlayerId) => apiRequest('transferHost', { roomId, hostPlayerId, targetPlayerId }),
  resetRoomToLobby: (roomId, hostPlayerId) => apiRequest('resetRoomToLobby', { roomId, hostPlayerId }),
  dissolveRoom: (roomId, hostPlayerId) => apiRequest('dissolveRoom', { roomId, hostPlayerId }),
  leaveRoom: (roomId, playerId) => apiRequest('leaveRoom', { roomId, playerId }),
  async getRoomById(roomId) {
    return (await apiRequest<RoomSnapshot | null>('getRoomById', { roomId })) ?? undefined;
  },
  async getRoomByCode(code) {
    return (await apiRequest<RoomSnapshot | null>('getRoomByCode', { code })) ?? undefined;
  },
  subscribeToRoom(roomId: string, listener: Listener) {
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        listener(await apiRepository.getRoomById(roomId));
      } catch {
        // Keep polling through transient API/network failures.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  },
};

async function apiRequest<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : 'Request failed.');
  }
  return body as T;
}

function readRooms(): { rooms: RoomSnapshot[] } {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_ROOMS_STORAGE_KEY) ?? '{"rooms":[]}') as { rooms: RoomSnapshot[] };
  } catch {
    return { rooms: [] };
  }
}

function writeRooms(data: { rooms: RoomSnapshot[] }, touchedRoomId?: string) {
  if (touchedRoomId) {
    const touchedSnapshot = data.rooms.find((snapshot) => snapshot.room.id === touchedRoomId);
    if (touchedSnapshot) touchedSnapshot.room.updatedAt = new Date().toISOString();
  }
  localStorage.setItem(LOCAL_ROOMS_STORAGE_KEY, JSON.stringify(data));
  window.dispatchEvent(new StorageEvent('storage', { key: LOCAL_ROOMS_STORAGE_KEY }));
}

function findByCode(data: { rooms: RoomSnapshot[] }, code: string) {
  return data.rooms.find((snapshot) => snapshot.room.code === normalizeRoomCode(code));
}

function requireById(data: { rooms: RoomSnapshot[] }, roomId: string) {
  const snapshot = data.rooms.find((item) => item.room.id === roomId);
  if (!snapshot) throw new Error('Room not found.');
  return snapshot;
}

function requireLocalPlayer(snapshot: RoomSnapshot, playerId: string) {
  const player = snapshot.players.find((item) => item.id === playerId);
  if (!player) throw new Error('Player not found.');
  return player;
}
