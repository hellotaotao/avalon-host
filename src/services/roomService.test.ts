import { describe, expect, it } from 'vitest';
import { assignRoles } from '../domain/avalon';
import {
  assertDeletedRows,
  createHostDemoRoom,
  createJoinDemoRoom,
  DEMO_JOIN_ROOM_CODE,
  findPlayerByDeviceToken,
  findPlayerByDisplayName,
  generateRoomCode,
  getStartValidation,
  leavePlayerFromSnapshot,
  removePlayerFromSnapshot,
  startDemoSnapshot,
  type RoomSnapshot,
  type RoomPlayer,
} from './roomService';

describe('room service rules', () => {
  it('generates four-character room codes without ambiguous characters', () => {
    const code = generateRoomCode();
    expect(code).toMatch(/^[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[IO01]/);
  });

  it('does not reuse an existing room code when another code can be generated', () => {
    expect(generateRoomCode(['ABCD'])).toHaveLength(4);
  });

  it('validates lobby start constraints', () => {
    expect(getStartValidation(makePlayers(4))).toBe('Need at least 5 players to start.');
    expect(getStartValidation(makePlayers(11))).toBe('Avalon Lite supports at most 10 players.');
    expect(getStartValidation(makePlayers(5, [2]))).toBe('Every player, including the host, must be ready.');
    expect(getStartValidation(makePlayers(5))).toBeUndefined();
  });

  it('assigns roles from the actual joined player count', () => {
    const players = makePlayers(7).map((player) => ({ id: player.id, name: player.displayName }));
    const assigned = assignRoles(players, { includePercivalMorgana: true }, 'actual-7');
    expect(assigned).toHaveLength(7);
    expect(assigned.map((player) => player.role)).toContain('Percival');
    expect(assigned.map((player) => player.role)).toContain('Morgana');
  });

  it('does not allow non-host players to remove others', () => {
    const snapshot = makeSnapshot(5);
    expect(() => removePlayerFromSnapshot(snapshot, 'p2', 'p3')).toThrow('Only the host can remove players.');
  });

  it('does not allow the host to remove themselves', () => {
    const snapshot = makeSnapshot(5);
    expect(() => removePlayerFromSnapshot(snapshot, 'p1', 'p1')).toThrow('Host cannot remove themselves.');
  });

  it('lets the host remove any non-host player before the game starts', () => {
    const snapshot = makeSnapshot(6);
    removePlayerFromSnapshot(snapshot, 'p1', 'p6');
    expect(snapshot.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(snapshot.players.map((player) => player.seatIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(snapshot.players[0].isHost).toBe(true);
  });

  it('removes a player and compacts remaining seats', () => {
    const snapshot = makeSnapshot(5);
    removePlayerFromSnapshot(snapshot, 'p1', 'p3');
    expect(snapshot.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p4', 'p5']);
    expect(snapshot.players.map((player) => player.seatIndex)).toEqual([0, 1, 2, 3]);
  });

  it('fails loudly when a database delete matches no player rows', () => {
    expect(() => assertDeletedRows([], 'Could not remove player.')).toThrow('Could not remove player.');
  });

  it('lets a non-host leave before the game starts and compacts seats', () => {
    const snapshot = makeSnapshot(5);
    leavePlayerFromSnapshot(snapshot, 'p3');
    expect(snapshot.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p4', 'p5']);
    expect(snapshot.players.map((player) => player.seatIndex)).toEqual([0, 1, 2, 3]);
    expect(snapshot.players[0].isHost).toBe(true);
  });

  it('promotes the next player when the host leaves before the game starts', () => {
    const snapshot = makeSnapshot(5);
    leavePlayerFromSnapshot(snapshot, 'p1');
    expect(snapshot.players.map((player) => player.id)).toEqual(['p2', 'p3', 'p4', 'p5']);
    expect(snapshot.players[0]).toMatchObject({ id: 'p2', isHost: true, seatIndex: 0 });
  });

  it('does not allow players to leave after the game starts', () => {
    const snapshot = makeSnapshot(5);
    snapshot.room.status = 'reveal';
    expect(() => leavePlayerFromSnapshot(snapshot, 'p3')).toThrow('Players can only leave before the game starts.');
  });

  it('finds an existing same-device player for rejoin', () => {
    const players = makePlayers(3).map((player, index) => ({ ...player, deviceToken: `device-${index + 1}` }));
    expect(findPlayerByDeviceToken(players, 'device-2')?.id).toBe('p2');
    expect(findPlayerByDeviceToken(players, 'missing')).toBeUndefined();
  });

  it('finds an existing same-name player as a zombie-prevention fallback', () => {
    const players = makePlayers(3);
    players[1].displayName = '  Alice   Wang  ';
    expect(findPlayerByDisplayName(players, 'alice wang')?.id).toBe('p2');
    expect(findPlayerByDisplayName(players, 'Bob')).toBeUndefined();
  });

  it('creates a host demo room with enough ready players and exactly one host', () => {
    const { snapshot, currentPlayerId } = createHostDemoRoom('Morgan');

    expect(snapshot.room.settings.createdInDemoMode).toBe(true);
    expect(snapshot.players).toHaveLength(5);
    expect(snapshot.players.filter((player) => player.isHost)).toHaveLength(1);
    expect(snapshot.players[0]).toMatchObject({ id: currentPlayerId, displayName: 'Morgan', isHost: true, isReady: true });
    expect(snapshot.players.every((player) => player.isReady)).toBe(true);
    expect(getStartValidation(snapshot.players)).toBeUndefined();
  });

  it('creates a deterministic join demo room with an existing host and ready demo players', () => {
    const { snapshot, currentPlayerId } = createJoinDemoRoom('Riley');

    expect(snapshot.room.code).toBe(DEMO_JOIN_ROOM_CODE);
    expect(snapshot.players).toHaveLength(5);
    expect(snapshot.players.filter((player) => player.isHost)).toHaveLength(1);
    expect(snapshot.players[0]).toMatchObject({ displayName: 'Demo Host', isHost: true, isReady: true });
    expect(snapshot.players.find((player) => player.id === currentPlayerId)).toMatchObject({
      displayName: 'Riley',
      isHost: false,
      isReady: true,
    });
    expect(getStartValidation(snapshot.players)).toBeUndefined();
  });

  it('can start a host demo room and assign locked roles without persistence', () => {
    const { snapshot } = createHostDemoRoom('Morgan');
    const started = startDemoSnapshot(snapshot);

    expect(started.ok).toBe(true);
    expect(started.snapshot?.room.status).toBe('reveal');
    expect(started.snapshot?.players.every((player) => player.role)).toBe(true);
  });

  it('can auto-start a join demo room for a guest without persistence', () => {
    const { snapshot, currentPlayerId } = createJoinDemoRoom('Riley');
    const started = startDemoSnapshot(snapshot);

    expect(started.ok).toBe(true);
    expect(started.snapshot?.room.status).toBe('reveal');
    expect(started.snapshot?.players.find((player) => player.id === currentPlayerId)?.role).toBeTruthy();
  });
});

function makePlayers(count: number, notReadyIndexes: number[] = []): RoomPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    roomId: 'r1',
    displayName: `Player ${index + 1}`,
    seatIndex: index,
    isHost: index === 0,
    isReady: !notReadyIndexes.includes(index),
  }));
}

function makeSnapshot(count: number): RoomSnapshot {
  return {
    room: {
      id: 'r1',
      code: 'ABCD',
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: {},
    },
    players: makePlayers(count),
  };
}
