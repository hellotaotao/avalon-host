// @ts-nocheck
import { neon } from '@neondatabase/serverless';
import {
  ensureMissionState,
  resolveAssassination,
  submitMissionCard as submitMissionCardToState,
  submitTeamProposal,
  submitTeamVote as submitTeamVoteToState,
  type MissionState,
} from '../src/domain/missionFlow.js';
import type { MissionCard, Vote } from '../src/domain/avalon.js';
import {
  applyMissionStateToSnapshot,
  assertDeletedRows,
  buildAiPlayers,
  buildCreateRoomSettings,
  findPlayerByDisplayName,
  generateRoomCode,
  isRoomStaleForExit,
  leavePlayerFromSnapshot,
  mapPlayer,
  mapRoom,
  normalizeRoomCode,
  removePlayerFromSnapshot,
  readyForNextGameInSnapshot,
  startDemoSnapshot,
  transferHostInSnapshot,
  resetRoomToLobbySnapshot,
  toAvalonPlayer,
  validateHostCanStart,
  type CreateRoomInput,
  type JoinRoomInput,
  type RoomSettings,
  type RoomSnapshot,
  type StartResult,
} from '../src/services/roomCore.js';

type VercelRequest = {
  method?: string;
  body?: unknown;
};

type VercelResponse = {
  status(statusCode: number): VercelResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(): void;
};

type RequestBody = Record<string, unknown> & { action?: string };

let sqlClient: ReturnType<typeof neon> | undefined;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('content-type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  try {
    const body = parseBody(req.body);
    const result = await dispatch(body);
    res.status(200).json(result ?? null);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Request failed.' });
  }
}

async function dispatch(body: RequestBody) {
  switch (body.action) {
    case 'createRoom':
      return createRoom(readObject<CreateRoomInput>(body.input, 'input'));
    case 'joinRoom':
      return joinRoom(readObject<JoinRoomInput>(body.input, 'input'));
    case 'updateNickname':
      return updateNickname(readString(body.roomId, 'roomId'), readString(body.playerId, 'playerId'), readString(body.displayName, 'displayName'));
    case 'setReady':
      return setReady(readString(body.roomId, 'roomId'), readString(body.playerId, 'playerId'), readBoolean(body.isReady, 'isReady'));
    case 'startGame':
      return startGame(readString(body.roomId, 'roomId'), readString(body.hostPlayerId, 'hostPlayerId'));
    case 'updateMissionState':
      return updateMissionState(readString(body.roomId, 'roomId'), readString(body.hostPlayerId, 'hostPlayerId'), readObject<MissionState>(body.missionState, 'missionState'));
    case 'proposeMissionTeam':
      return proposeMissionTeam(readString(body.roomId, 'roomId'), readString(body.leaderPlayerId, 'leaderPlayerId'), readStringArray(body.selectedTeamIds, 'selectedTeamIds'));
    case 'submitTeamVote':
      return submitTeamVote(readString(body.roomId, 'roomId'), readString(body.playerId, 'playerId'), readVote(body.vote));
    case 'submitMissionCard':
      return submitMissionCard(readString(body.roomId, 'roomId'), readString(body.playerId, 'playerId'), readMissionCard(body.card));
    case 'submitAssassination':
      return submitAssassination(readString(body.roomId, 'roomId'), readString(body.assassinPlayerId, 'assassinPlayerId'), readString(body.targetPlayerId, 'targetPlayerId'));
    case 'readyForNextGame':
      return readyForNextGame(readString(body.roomId, 'roomId'), readString(body.playerId, 'playerId'));
    case 'removePlayer':
      return removePlayer(readString(body.roomId, 'roomId'), readString(body.hostPlayerId, 'hostPlayerId'), readString(body.targetPlayerId, 'targetPlayerId'));
    case 'transferHost':
      return transferHost(readString(body.roomId, 'roomId'), readString(body.hostPlayerId, 'hostPlayerId'), readString(body.targetPlayerId, 'targetPlayerId'));
    case 'resetRoomToLobby':
      return resetRoomToLobby(readString(body.roomId, 'roomId'), readString(body.hostPlayerId, 'hostPlayerId'));
    case 'dissolveRoom':
      return dissolveRoom(readString(body.roomId, 'roomId'), readString(body.hostPlayerId, 'hostPlayerId'));
    case 'leaveRoom':
      return leaveRoom(readString(body.roomId, 'roomId'), readString(body.playerId, 'playerId'));
    case 'getRoomById':
      return getRoomById(readString(body.roomId, 'roomId'));
    case 'getRoomByCode':
      return getRoomByCode(readString(body.code, 'code'));
    default:
      throw new HttpError(400, 'Unknown room action.');
  }
}

async function createRoom(input: CreateRoomInput) {
  const sql = getSql();
  const displayName = input.displayName.trim();
  if (!displayName) throw new HttpError(400, 'Display name is required.');

  const existingRooms = await sql`select code from rooms`;
  const code = generateRoomCode(existingRooms.map((room) => String(room.code)));
  const settings: RoomSettings = buildCreateRoomSettings(input);
  const [roomRow] = await sql`
    insert into rooms (code, status, game_type, settings)
    values (${code}, 'lobby', 'avalon_lite', ${JSON.stringify(settings)}::jsonb)
    returning id::text as id
  `;
  const [playerRow] = await sql`
    insert into players (room_id, display_name, seat_index, is_host, is_ready, device_token_hash, is_ai)
    values (${roomRow.id}, ${displayName}, 0, true, false, ${input.deviceToken}, false)
    returning id::text as id
  `;
  for (const aiPlayer of buildAiPlayers(roomRow.id as string, settings, 1)) {
    await sql`
      insert into players (id, room_id, display_name, seat_index, is_host, is_ready, device_token_hash, is_ai)
      values (${aiPlayer.id}, ${roomRow.id}, ${aiPlayer.displayName}, ${aiPlayer.seatIndex}, false, true, ${aiPlayer.deviceToken}, true)
    `;
  }

  return { snapshot: await fetchSnapshot(roomRow.id as string), currentPlayerId: playerRow.id as string };
}

async function joinRoom(input: JoinRoomInput) {
  const found = await getRoomByCode(input.code);
  if (!found) throw new HttpError(404, 'Room not found.');

  const sql = getSql();
  const displayName = input.displayName.trim();
  if (!displayName) throw new HttpError(400, 'Display name is required.');

  const existingRows = await sql`
    select id::text as id, display_name
    from players
    where room_id = ${found.room.id} and device_token_hash = ${input.deviceToken}
    limit 1
  `;
  const existingPlayer = existingRows[0];
  if (existingPlayer) {
    if (existingPlayer.display_name !== displayName) {
      await sql`update players set display_name = ${displayName} where id = ${existingPlayer.id} and room_id = ${found.room.id}`;
      await touchRoom(found.room.id);
    }
    return { snapshot: await fetchSnapshot(found.room.id), currentPlayerId: existingPlayer.id as string };
  }

  if (found.room.status !== 'lobby') throw new HttpError(409, 'This game has already started. Only original players can re-enter from the same device.');

  const sameNamePlayer = findPlayerByDisplayName(found.players.filter((player) => !player.isAi), displayName);
  if (sameNamePlayer) {
    await sql`
      update players
      set display_name = ${displayName}, device_token_hash = ${input.deviceToken}
      where id = ${sameNamePlayer.id} and room_id = ${found.room.id}
    `;
    await touchRoom(found.room.id);
    return { snapshot: await fetchSnapshot(found.room.id), currentPlayerId: sameNamePlayer.id };
  }

  const capacity = found.room.settings.plannedPlayerCount ?? 10;
  if (found.players.length >= capacity) throw new HttpError(409, 'This room is already full.');

  const [playerRow] = await sql`
    insert into players (room_id, display_name, seat_index, is_host, is_ready, device_token_hash, is_ai)
    values (${found.room.id}, ${displayName}, ${found.players.length}, false, false, ${input.deviceToken}, false)
    returning id::text as id
  `;
  await touchRoom(found.room.id);
  return { snapshot: await fetchSnapshot(found.room.id), currentPlayerId: playerRow.id as string };
}

async function updateNickname(roomId: string, playerId: string, displayName: string) {
  const rows = await getSql()`
    update players
    set display_name = ${displayName.trim()}
    where id = ${playerId} and room_id = ${roomId}
    returning id::text as id
  `;
  assertDeletedRows(rows, 'Player not found.');
  await touchRoom(roomId);
  return fetchSnapshot(roomId);
}

async function setReady(roomId: string, playerId: string, isReady: boolean) {
  const rows = await getSql()`
    update players
    set is_ready = ${isReady}
    where id = ${playerId} and room_id = ${roomId}
    returning id::text as id
  `;
  assertDeletedRows(rows, 'Player not found.');
  await touchRoom(roomId);
  return fetchSnapshot(roomId);
}

async function startGame(roomId: string, hostPlayerId: string): Promise<StartResult> {
  const snapshot = await fetchSnapshot(roomId);
  const reason = validateHostCanStart(snapshot, hostPlayerId);
  if (reason) return { ok: false, reason, snapshot };
  const result = startDemoSnapshot(snapshot, hostPlayerId);
  if (!result.ok || !result.snapshot) return result;

  const sql = getSql();
  const activePlayerIds = new Set(result.snapshot.players.map((player) => player.id));
  const removedPlayerIds = snapshot.players.filter((player) => !activePlayerIds.has(player.id)).map((player) => player.id);
  await Promise.all(removedPlayerIds.map((playerId) => sql`delete from players where id = ${playerId} and room_id = ${roomId}`));
  await sql`
    update rooms
    set status = 'reveal', settings = ${JSON.stringify(result.snapshot.room.settings)}::jsonb
    where id = ${roomId}
  `;
  for (const player of result.snapshot.players) {
    await sql`
      update players
      set seat_index = ${player.seatIndex},
          is_host = ${player.isHost},
          is_ready = ${player.isReady},
          role = ${player.role ?? null},
          is_ai = ${Boolean(player.isAi)}
      where id = ${player.id} and room_id = ${roomId}
    `;
  }
  return { ok: true, snapshot: await fetchSnapshot(roomId) };
}

async function updateMissionState(roomId: string, hostPlayerId: string, missionState: MissionState) {
  const snapshot = await fetchSnapshot(roomId);
  const host = snapshot.players.find((player) => player.id === hostPlayerId);
  if (!host?.isHost) throw new HttpError(403, 'Only the host can use backup controls.');
  return persistMissionState(roomId, snapshot, missionState);
}

async function proposeMissionTeam(roomId: string, leaderPlayerId: string, selectedTeamIds: string[]) {
  const snapshot = await fetchSnapshot(roomId);
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
  const nextMissionState = submitTeamProposal(missionState, playerIds, leaderPlayerId, selectedTeamIds);
  return persistMissionState(roomId, snapshot, nextMissionState);
}

async function submitTeamVote(roomId: string, playerId: string, vote: Vote) {
  const snapshot = await fetchSnapshot(roomId);
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
  const nextMissionState = submitTeamVoteToState(missionState, playerIds, playerId, vote);
  return persistMissionState(roomId, snapshot, nextMissionState);
}

async function submitMissionCard(roomId: string, playerId: string, card: MissionCard) {
  const snapshot = await fetchSnapshot(roomId);
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
  const nextMissionState = submitMissionCardToState(missionState, playerIds, snapshot.players.map(toAvalonPlayer), playerId, card);
  return persistMissionState(roomId, snapshot, nextMissionState);
}

async function submitAssassination(roomId: string, assassinPlayerId: string, targetPlayerId: string) {
  const snapshot = await fetchSnapshot(roomId);
  const playerIds = snapshot.players.map((player) => player.id);
  const missionState = ensureMissionState(snapshot.room.settings.missionState, playerIds);
  const nextMissionState = resolveAssassination(missionState, snapshot.players.map(toAvalonPlayer), assassinPlayerId, targetPlayerId);
  return persistMissionState(roomId, snapshot, nextMissionState);
}

async function readyForNextGame(roomId: string, playerId: string) {
  const snapshot = await fetchSnapshot(roomId);
  readyForNextGameInSnapshot(snapshot, playerId);
  const sql = getSql();
  await sql`
    update rooms
    set status = ${snapshot.room.status}, settings = ${JSON.stringify(snapshot.room.settings)}::jsonb
    where id = ${roomId}
  `;
  for (const player of snapshot.players) {
    await sql`
      update players
      set seat_index = ${player.seatIndex},
          is_host = ${player.isHost},
          is_ready = ${player.isReady},
          role = ${player.role ?? null},
          is_ai = ${Boolean(player.isAi)}
      where id = ${player.id} and room_id = ${roomId}
    `;
  }
  return fetchSnapshot(roomId);
}

async function removePlayer(roomId: string, hostPlayerId: string, targetPlayerId: string) {
  const snapshot = await fetchSnapshot(roomId);
  removePlayerFromSnapshot(snapshot, hostPlayerId, targetPlayerId);
  const sql = getSql();
  const deletedRows = await sql`
    delete from players
    where id = ${targetPlayerId} and room_id = ${roomId}
    returning id::text as id
  `;
  assertDeletedRows(deletedRows, 'Could not remove player.');
  for (const player of snapshot.players) {
    await sql`update players set seat_index = ${player.seatIndex} where id = ${player.id} and room_id = ${roomId}`;
  }
  return fetchSnapshot(roomId);
}

async function transferHost(roomId: string, hostPlayerId: string, targetPlayerId: string) {
  const snapshot = await fetchSnapshot(roomId);
  transferHostInSnapshot(snapshot, hostPlayerId, targetPlayerId);
  const sql = getSql();
  for (const player of snapshot.players) {
    await sql`update players set is_host = ${player.isHost} where id = ${player.id} and room_id = ${roomId}`;
  }
  return fetchSnapshot(roomId);
}

async function resetRoomToLobby(roomId: string, hostPlayerId: string) {
  const snapshot = await fetchSnapshot(roomId);
  resetRoomToLobbySnapshot(snapshot, hostPlayerId);
  const sql = getSql();
  await sql`
    update rooms
    set status = 'lobby', settings = ${JSON.stringify(snapshot.room.settings)}::jsonb
    where id = ${roomId}
  `;
  for (const player of snapshot.players) {
    await sql`
      update players
      set seat_index = ${player.seatIndex}, is_ready = ${Boolean(player.isAi)}, role = null, is_ai = ${Boolean(player.isAi)}
      where id = ${player.id} and room_id = ${roomId}
    `;
  }
  return fetchSnapshot(roomId);
}

async function dissolveRoom(roomId: string, hostPlayerId: string) {
  const snapshot = await fetchSnapshot(roomId);
  const host = snapshot.players.find((player) => player.id === hostPlayerId);
  if (!host?.isHost) throw new HttpError(403, 'Only the host can dissolve the room.');
  await getSql()`delete from rooms where id = ${roomId}`;
  return null;
}

async function leaveRoom(roomId: string, playerId: string) {
  const snapshot = await fetchSnapshot(roomId);
  leavePlayerFromSnapshot(snapshot, playerId, { allowStaleActiveRoom: isRoomStaleForExit(snapshot) });
  const sql = getSql();
  const deletedRows = await sql`
    delete from players
    where id = ${playerId} and room_id = ${roomId}
    returning id::text as id
  `;
  assertDeletedRows(deletedRows, 'Could not leave room.');
  if (snapshot.room.status === 'lobby') {
    await sql`update rooms set status = 'lobby', settings = ${JSON.stringify(snapshot.room.settings)}::jsonb where id = ${roomId}`;
    await Promise.all(snapshot.players.map((player) => sql`update players set is_ready = ${Boolean(player.isAi)}, role = null where id = ${player.id} and room_id = ${roomId}`));
  }
  if (snapshot.players.length === 0) {
    await sql`delete from rooms where id = ${roomId}`;
    return null;
  }
  for (const player of snapshot.players) {
    await sql`
      update players
      set seat_index = ${player.seatIndex}, is_host = ${player.isHost}
      where id = ${player.id} and room_id = ${roomId}
    `;
  }
  return fetchSnapshot(roomId);
}

async function getRoomById(roomId: string) {
  return fetchSnapshot(roomId).catch((error) => {
    if (error instanceof HttpError && error.statusCode === 404) return undefined;
    throw error;
  });
}

async function getRoomByCode(code: string) {
  const rows = await getSql()`select id::text as id from rooms where code = ${normalizeRoomCode(code)} limit 1`;
  return rows[0] ? fetchSnapshot(rows[0].id as string) : undefined;
}

async function persistMissionState(roomId: string, snapshot: RoomSnapshot, missionState: MissionState) {
  applyMissionStateToSnapshot(snapshot, missionState);
  await getSql()`
    update rooms
    set settings = ${JSON.stringify(snapshot.room.settings)}::jsonb, status = ${snapshot.room.status}
    where id = ${roomId}
  `;
  return fetchSnapshot(roomId);
}

async function fetchSnapshot(roomId: string): Promise<RoomSnapshot> {
  const sql = getSql();
  const [roomRows, playerRows] = await Promise.all([
    sql`
      select id::text as id, code, status, game_type, settings, updated_at
      from rooms
      where id = ${roomId}
      limit 1
    `,
    sql`
      select id::text as id,
             room_id::text as room_id,
             display_name,
             device_token_hash,
             seat_index,
             is_host,
             is_ready,
             role,
             is_ai
      from players
      where room_id = ${roomId}
      order by seat_index
    `,
  ]);
  if (!roomRows[0]) throw new HttpError(404, 'Room not found.');
  return {
    room: mapRoom(roomRows[0]),
    players: playerRows.map(mapPlayer),
  };
}

async function touchRoom(roomId: string) {
  await getSql()`update rooms set updated_at = now() where id = ${roomId}`;
}

function getSql() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new HttpError(500, 'DATABASE_URL is not configured.');
  sqlClient ??= neon(databaseUrl);
  return sqlClient;
}

function parseBody(body: unknown): RequestBody {
  if (typeof body === 'string') return JSON.parse(body) as RequestBody;
  if (body && typeof body === 'object') return body as RequestBody;
  throw new HttpError(400, 'JSON body is required.');
}

function readObject<T>(value: unknown, name: string): T {
  if (!value || typeof value !== 'object') throw new HttpError(400, `${name} is required.`);
  return value as T;
}

function readString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${name} is required.`);
  return value;
}

function readBoolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${name} is required.`);
  return value;
}

function readStringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new HttpError(400, `${name} is required.`);
  }
  return value;
}

function readVote(value: unknown): Vote {
  if (value !== 'approve' && value !== 'reject') throw new HttpError(400, 'vote is invalid.');
  return value;
}

function readMissionCard(value: unknown): MissionCard {
  if (value !== 'success' && value !== 'fail') throw new HttpError(400, 'card is invalid.');
  return value;
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}
