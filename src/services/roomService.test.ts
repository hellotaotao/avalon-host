import { describe, expect, it } from 'vitest';
import { assignRoles } from '../domain/avalon';
import {
  findPlayerByDeviceToken,
  generateRoomCode,
  getStartValidation,
  removePlayerFromSnapshot,
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

  it('removes a player and compacts remaining seats', () => {
    const snapshot = makeSnapshot(5);
    removePlayerFromSnapshot(snapshot, 'p1', 'p3');
    expect(snapshot.players.map((player) => player.id)).toEqual(['p1', 'p2', 'p4', 'p5']);
    expect(snapshot.players.map((player) => player.seatIndex)).toEqual([0, 1, 2, 3]);
  });

  it('finds an existing same-device player for rejoin', () => {
    const players = makePlayers(3).map((player, index) => ({ ...player, deviceToken: `device-${index + 1}` }));
    expect(findPlayerByDeviceToken(players, 'device-2')?.id).toBe('p2');
    expect(findPlayerByDeviceToken(players, 'missing')).toBeUndefined();
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
