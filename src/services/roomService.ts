import { assignRoles, getVisibilityInfo, type AssignmentOptions, type Player as AvalonPlayer, type Role } from '../domain/avalon';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';

export type RoomStatus = 'setup' | 'lobby' | 'locked' | 'reveal' | 'proposal' | 'vote' | 'mission' | 'assassin' | 'finished';

export interface RoomSettings extends AssignmentOptions {
  createdInDemoMode?: boolean;
}

export interface Room {
  id: string;
  code: string;
  status: RoomStatus;
  gameType: 'avalon_lite';
  settings: RoomSettings;
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
  includePercivalMorgana: boolean;
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

type Listener = (snapshot: RoomSnapshot | undefined) => void;

const STORAGE_KEY = 'avalon-host.rooms.v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(existingCodes: Iterable<string> = []): string {
  const existing = new Set(Array.from(existingCodes, (code) => code.toUpperCase()));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    if (!existing.has(code)) return code;
  }
  throw new Error('Unable to generate an unused room code');
}

export function getStartValidation(players: RoomPlayer[]): string | undefined {
  if (players.length < 5) return 'Need at least 5 players to start.';
  if (players.length > 10) return 'Avalon Lite supports at most 10 players.';
  if (players.some((player) => !player.isReady)) return 'Every player, including the host, must be ready.';
  return undefined;
}

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

export async function startGame(roomId: string): Promise<StartResult> {
  return repository().startGame(roomId);
}

export async function removePlayer(roomId: string, hostPlayerId: string, targetPlayerId: string): Promise<RoomSnapshot> {
  return repository().removePlayer(roomId, hostPlayerId, targetPlayerId);
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

function repository() {
  return isSupabaseConfigured ? supabaseRepository : localRepository;
}

const localRepository = {
  async createRoom(input: CreateRoomInput) {
    const data = readRooms();
    const code = generateRoomCode(data.rooms.map((item) => item.room.code));
    const room: Room = {
      id: crypto.randomUUID(),
      code,
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: {
        includePercivalMorgana: input.includePercivalMorgana,
        createdInDemoMode: true,
      },
    };
    const player: RoomPlayer = {
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
    writeRooms(data);
    return { snapshot, currentPlayerId: player.id };
  },

  async joinRoom(input: JoinRoomInput) {
    const data = readRooms();
    const snapshot = findByCode(data, input.code);
    if (!snapshot) throw new Error('Room not found.');
    if (snapshot.room.status !== 'lobby') throw new Error('This room is already locked.');
    const displayName = input.displayName.trim();
    const existingPlayer = findPlayerByDeviceToken(snapshot.players, input.deviceToken);
    if (existingPlayer) {
      if (existingPlayer.displayName !== displayName) existingPlayer.displayName = displayName;
      writeRooms(data);
      return { snapshot, currentPlayerId: existingPlayer.id };
    }
    if (snapshot.players.length >= 10) throw new Error('This room already has 10 players.');
    const player: RoomPlayer = {
      id: crypto.randomUUID(),
      roomId: snapshot.room.id,
      displayName,
      seatIndex: snapshot.players.length,
      isHost: false,
      isReady: false,
      deviceToken: input.deviceToken,
    };
    snapshot.players.push(player);
    writeRooms(data);
    return { snapshot, currentPlayerId: player.id };
  },

  async updateNickname(roomId: string, playerId: string, displayName: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const player = requirePlayer(snapshot, playerId);
    player.displayName = displayName.trim();
    writeRooms(data);
    return snapshot;
  },

  async setReady(roomId: string, playerId: string, isReady: boolean) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    requirePlayer(snapshot, playerId).isReady = isReady;
    writeRooms(data);
    return snapshot;
  },

  async startGame(roomId: string): Promise<StartResult> {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    const reason = getStartValidation(snapshot.players);
    if (reason) return { ok: false, reason, snapshot };
    const assigned = assignRoles(
      snapshot.players.map(toAvalonPlayer),
      snapshot.room.settings,
      `${snapshot.room.code}-${snapshot.players.map((player) => player.id).join('|')}`,
    );
    snapshot.room.status = 'reveal';
    snapshot.players = snapshot.players.map((player) => ({
      ...player,
      role: assigned.find((assignedPlayer) => assignedPlayer.id === player.id)?.role,
    }));
    writeRooms(data);
    return { ok: true, snapshot };
  },

  async removePlayer(roomId: string, hostPlayerId: string, targetPlayerId: string) {
    const data = readRooms();
    const snapshot = requireById(data, roomId);
    removePlayerFromSnapshot(snapshot, hostPlayerId, targetPlayerId);
    writeRooms(data);
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
      if (event.key === STORAGE_KEY) {
        listener(readRooms().rooms.find((snapshot) => snapshot.room.id === roomId));
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  },
};

const supabaseRepository = {
  async createRoom(input: CreateRoomInput) {
    const supabase = await getSupabaseRequired();
    const code = generateRoomCode();
    const { data: roomRow, error: roomError } = await supabase
      .from('rooms')
      .insert({
        code,
        status: 'lobby',
        game_type: 'avalon_lite',
        settings: { includePercivalMorgana: input.includePercivalMorgana },
      })
      .select()
      .single();
    if (roomError) throw roomError;
    const { data: playerRow, error: playerError } = await supabase
      .from('players')
      .insert({
        room_id: roomRow.id,
        display_name: input.displayName.trim(),
        seat_index: 0,
        is_host: true,
        is_ready: false,
        device_token_hash: input.deviceToken,
      })
      .select()
      .single();
    if (playerError) throw playerError;
    return { snapshot: await fetchSnapshot(roomRow.id), currentPlayerId: playerRow.id as string };
  },

  async joinRoom(input: JoinRoomInput) {
    const found = await this.getRoomByCode(input.code);
    if (!found) throw new Error('Room not found.');
    if (found.room.status !== 'lobby') throw new Error('This room is already locked.');
    const supabase = await getSupabaseRequired();
    const { data: existingRows, error: existingError } = await supabase
      .from('players')
      .select('id, display_name')
      .eq('room_id', found.room.id)
      .eq('device_token_hash', input.deviceToken)
      .limit(1);
    if (existingError) throw existingError;
    const existingPlayer = existingRows?.[0];
    const displayName = input.displayName.trim();
    if (existingPlayer) {
      if (existingPlayer.display_name !== displayName) {
        const { error } = await supabase.from('players').update({ display_name: displayName }).eq('id', existingPlayer.id);
        if (error) throw error;
      }
      return { snapshot: await fetchSnapshot(found.room.id), currentPlayerId: existingPlayer.id as string };
    }
    if (found.players.length >= 10) throw new Error('This room already has 10 players.');
    const { data, error } = await supabase
      .from('players')
      .insert({
        room_id: found.room.id,
        display_name: displayName,
        seat_index: found.players.length,
        is_host: false,
        is_ready: false,
        device_token_hash: input.deviceToken,
      })
      .select()
      .single();
    if (error) throw error;
    return { snapshot: await fetchSnapshot(found.room.id), currentPlayerId: data.id as string };
  },

  async updateNickname(roomId: string, playerId: string, displayName: string) {
    const supabase = await getSupabaseRequired();
    const { error } = await supabase.from('players').update({ display_name: displayName.trim() }).eq('id', playerId);
    if (error) throw error;
    return fetchSnapshot(roomId);
  },

  async setReady(roomId: string, playerId: string, isReady: boolean) {
    const supabase = await getSupabaseRequired();
    const { error } = await supabase.from('players').update({ is_ready: isReady }).eq('id', playerId);
    if (error) throw error;
    return fetchSnapshot(roomId);
  },

  async startGame(roomId: string): Promise<StartResult> {
    const snapshot = await fetchSnapshot(roomId);
    const reason = getStartValidation(snapshot.players);
    if (reason) return { ok: false, reason, snapshot };
    const assigned = assignRoles(
      snapshot.players.map(toAvalonPlayer),
      snapshot.room.settings,
      `${snapshot.room.code}-${snapshot.players.map((player) => player.id).join('|')}`,
    );
    const supabase = await getSupabaseRequired();
    const { error: roomError } = await supabase.from('rooms').update({ status: 'reveal' }).eq('id', roomId);
    if (roomError) throw roomError;
    await Promise.all(
      assigned.map((player) =>
        supabase
          .from('players')
          .update({ role: player.role })
          .eq('id', player.id)
          .then(({ error }: { error: Error | null }) => {
            if (error) throw error;
          }),
      ),
    );
    return { ok: true, snapshot: await fetchSnapshot(roomId) };
  },

  async removePlayer(roomId: string, hostPlayerId: string, targetPlayerId: string) {
    const snapshot = await fetchSnapshot(roomId);
    removePlayerFromSnapshot(snapshot, hostPlayerId, targetPlayerId);
    const supabase = await getSupabaseRequired();
    const { error: deleteError } = await supabase.from('players').delete().eq('id', targetPlayerId).eq('room_id', roomId);
    if (deleteError) throw deleteError;
    await Promise.all(
      snapshot.players.map((player) =>
        supabase
          .from('players')
          .update({ seat_index: player.seatIndex })
          .eq('id', player.id)
          .then(({ error }: { error: Error | null }) => {
            if (error) throw error;
          }),
      ),
    );
    return fetchSnapshot(roomId);
  },

  async getRoomById(roomId: string) {
    return fetchSnapshot(roomId).catch(() => undefined);
  },

  async getRoomByCode(code: string) {
    const supabase = await getSupabaseRequired();
    const { data, error } = await supabase.from('rooms').select('id').eq('code', code.trim().toUpperCase()).maybeSingle();
    if (error) throw error;
    return data ? fetchSnapshot(data.id as string) : undefined;
  },

  subscribeToRoom(roomId: string, listener: Listener) {
    void fetchSnapshot(roomId).then(listener);
    let channel: any;
    void getSupabaseRequired().then((supabase) => {
      channel = supabase
        .channel(`room-${roomId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, () => {
          void fetchSnapshot(roomId).then(listener);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${roomId}` }, () => {
          void fetchSnapshot(roomId).then(listener);
        })
        .subscribe();
    });
    return () => {
      if (channel) void getSupabaseRequired().then((supabase) => supabase.removeChannel(channel));
    };
  },
};

async function fetchSnapshot(roomId: string): Promise<RoomSnapshot> {
  const supabase = await getSupabaseRequired();
  const [{ data: roomRow, error: roomError }, { data: playerRows, error: playerError }] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', roomId).single(),
    supabase.from('players').select('*').eq('room_id', roomId).order('seat_index'),
  ]);
  if (roomError) throw roomError;
  if (playerError) throw playerError;
  return {
    room: mapRoom(roomRow),
    players: (playerRows ?? []).map(mapPlayer),
  };
}

async function getSupabaseRequired() {
  const client = await getSupabaseClient();
  if (!client) throw new Error('Supabase is not configured.');
  return client;
}

function readRooms(): { rooms: RoomSnapshot[] } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{"rooms":[]}') as { rooms: RoomSnapshot[] };
  } catch {
    return { rooms: [] };
  }
}

function writeRooms(data: { rooms: RoomSnapshot[] }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
}

function findByCode(data: { rooms: RoomSnapshot[] }, code: string) {
  return data.rooms.find((snapshot) => snapshot.room.code === code.trim().toUpperCase());
}

function requireById(data: { rooms: RoomSnapshot[] }, roomId: string) {
  const snapshot = data.rooms.find((item) => item.room.id === roomId);
  if (!snapshot) throw new Error('Room not found.');
  return snapshot;
}

function requirePlayer(snapshot: RoomSnapshot, playerId: string) {
  const player = snapshot.players.find((item) => item.id === playerId);
  if (!player) throw new Error('Player not found.');
  return player;
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

export function findPlayerByDeviceToken(players: RoomPlayer[], deviceToken: string): RoomPlayer | undefined {
  return players.find((player) => player.deviceToken === deviceToken);
}

function toAvalonPlayer(player: RoomPlayer): AvalonPlayer {
  return { id: player.id, name: player.displayName };
}

function mapRoom(row: Record<string, unknown>): Room {
  return {
    id: row.id as string,
    code: row.code as string,
    status: row.status as RoomStatus,
    gameType: row.game_type as 'avalon_lite',
    settings: (row.settings as RoomSettings | null) ?? {},
  };
}

function mapPlayer(row: Record<string, unknown>): RoomPlayer {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    displayName: row.display_name as string,
    seatIndex: row.seat_index as number,
    isHost: row.is_host as boolean,
    isReady: row.is_ready as boolean,
    role: row.role as Role | undefined,
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
