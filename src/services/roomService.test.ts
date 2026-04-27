import { describe, expect, it } from 'vitest';
import { assignRoles } from '../domain/avalon';
import { generateRoomCode, getStartValidation, type RoomPlayer } from './roomService';

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
