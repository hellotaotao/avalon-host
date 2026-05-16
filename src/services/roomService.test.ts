import { describe, expect, it, vi } from 'vitest';
import { assignRoles } from '../domain/avalon';
import {
  assertDeletedRows,
  canStartGame,
  createHostDemoRoom,
  createJoinDemoRoom,
  DEMO_JOIN_ROOM_CODE,
  findPlayerByDeviceToken,
  findPlayerByDisplayName,
  generateRoomCode,
  getStartablePlayers,
  getStartValidation,
  leavePlayerFromSnapshot,
  transferHostInSnapshot,
  resetRoomToLobbySnapshot,
  normalizeRoomCode,
  removePlayerFromSnapshot,
  startDemoSnapshot,
  validateHostCanStart,
  type RoomSnapshot,
  type RoomPlayer,
} from './roomService';

describe('room service rules', () => {
  it('generates five-digit numeric room codes', () => {
    const code = generateRoomCode();
    expect(code).toHaveLength(5);
    expect(code).toMatch(/^\d{5}$/);
  });

  it('does not reuse an existing room code when another code can be generated', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.12345).mockReturnValueOnce(0.54321);

    try {
      expect(generateRoomCode(['12345'])).toBe('54321');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('normalizes room code input to five digits', () => {
    expect(normalizeRoomCode('ab 12-345 67')).toBe('12345');
  });

  it('validates lobby start constraints', () => {
    expect(getStartValidation(makePlayers(4))).toBe('Need 1 more ready player to start.');
    expect(getStartValidation(makePlayers(11))).toBe('Avalon Lite supports at most 10 players.');
    expect(getStartValidation(makePlayers(5, [2]))).toBe('Need 1 more ready player to start.');
    expect(getStartValidation(makePlayers(6, [2]))).toBeUndefined();
    expect(getStartValidation(makePlayers(5))).toBeUndefined();
  });

  it('allows the room to start once enough players are ready', () => {
    const players = makePlayers(5);
    expect(players.some((player) => !player.isHost && player.isReady)).toBe(true);
    expect(canStartGame(players)).toBe(true);
    expect(canStartGame(makePlayers(6, [3]))).toBe(true);
    expect(canStartGame(makePlayers(5, [3]))).toBe(false);
  });

  it('excludes unready non-host players and compacts seats for start', () => {
    const players = getStartablePlayers(makePlayers(7, [2, 5]));
    expect(players.map((player) => player.id)).toEqual(['p1', 'p2', 'p4', 'p5', 'p7']);
    expect(players.map((player) => player.seatIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(players.filter((player) => player.isHost)).toHaveLength(1);
    expect(players[0]).toMatchObject({ id: 'p1', isHost: true, isReady: true });
  });

  it('preserves an unready host when preparing players for start', () => {
    const sourcePlayers = makePlayers(6, [0, 5]);
    expect(getStartValidation(sourcePlayers)).toBeUndefined();

    const players = getStartablePlayers(sourcePlayers);
    expect(players.map((player) => player.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(players[0]).toMatchObject({ id: 'p1', isHost: true, isReady: true, seatIndex: 0 });
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


  it('lets the host transfer host rights to another player', () => {
    const snapshot = makeSnapshot(5);
    transferHostInSnapshot(snapshot, 'p1', 'p3');
    expect(snapshot.players.filter((player) => player.isHost)).toHaveLength(1);
    expect(snapshot.players.find((player) => player.id === 'p3')?.isHost).toBe(true);
  });

  it('does not allow non-host players to transfer host rights', () => {
    const snapshot = makeSnapshot(5);
    expect(() => transferHostInSnapshot(snapshot, 'p2', 'p3')).toThrow('Only the host can transfer host rights.');
  });

  it('lets the host abandon a game and return everyone to the lobby', () => {
    const snapshot = makeSnapshot(5);
    snapshot.room.status = 'mission';
    snapshot.room.settings.missionState = { phase: 'mission', roundIndex: 1, proposalIndex: 0, leaderPlayerId: 'p1', selectedTeamIds: ['p1', 'p2'], missionResults: [] };
    snapshot.players[0].role = 'Merlin';
    resetRoomToLobbySnapshot(snapshot, 'p1');
    expect(snapshot.room.status).toBe('lobby');
    expect(snapshot.room.settings.missionState).toBeUndefined();
    expect(snapshot.players.every((player) => !player.isReady && !player.role)).toBe(true);
  });

  it('does not allow non-host players to abandon a game', () => {
    const snapshot = makeSnapshot(5);
    expect(() => resetRoomToLobbySnapshot(snapshot, 'p2')).toThrow('Only the host can reset the game.');
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

  it('does not allow players to leave while a game is in progress', () => {
    const snapshot = makeSnapshot(5);
    snapshot.room.status = 'reveal';
    expect(() => leavePlayerFromSnapshot(snapshot, 'p3')).toThrow('Players can only leave before the game starts or after it finishes.');
  });

  it('allows players to leave after a game finishes', () => {
    const snapshot = makeSnapshot(5);
    snapshot.room.status = 'finished';
    leavePlayerFromSnapshot(snapshot, 'p3');
    expect(snapshot.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p4', 'p5']);
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

  it('rejects start attempts from non-host players', () => {
    const snapshot = makeSnapshot(5);

    expect(validateHostCanStart(snapshot, 'p2')).toBe('Only the host can start the game.');
    expect(startDemoSnapshot(snapshot, 'p2')).toMatchObject({
      ok: false,
      reason: 'Only the host can start the game.',
    });
  });

  it('allows the host to start a ready room', () => {
    const snapshot = makeSnapshot(5);

    expect(validateHostCanStart(snapshot, 'p1')).toBeUndefined();
    expect(startDemoSnapshot(snapshot, 'p1').ok).toBe(true);
  });

  it('starts a demo room with unready players excluded from roles and mission state', () => {
    const snapshot = makeSnapshot(7);
    snapshot.players[2].isReady = false;
    snapshot.players[5].isReady = false;
    const started = startDemoSnapshot(snapshot);

    expect(started.ok).toBe(true);
    expect(started.snapshot?.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p4', 'p5', 'p7']);
    expect(started.snapshot?.players.map((player) => player.seatIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(started.snapshot?.players.filter((player) => player.isHost)).toHaveLength(1);
    expect(started.snapshot?.players.every((player) => player.role)).toBe(true);
    expect(started.snapshot?.room.settings.missionState?.leaderPlayerId).toBe('p1');
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
      code: '12345',
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: {},
    },
    players: makePlayers(count),
  };
}
