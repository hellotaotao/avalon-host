import { describe, expect, it } from 'vitest';
import { attemptRestore, isStaleSnapshot } from './roomSession';
import type { RoomSnapshot } from './services/roomService';

function makeSnapshot(overrides: { playerIds?: string[]; version?: number; updatedAt?: string; roomId?: string } = {}): RoomSnapshot {
  return {
    room: {
      id: overrides.roomId ?? 'room-1',
      code: '12345',
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: {},
      updatedAt: overrides.updatedAt,
      version: overrides.version,
    },
    players: (overrides.playerIds ?? ['player-1']).map((id, index) => ({
      id,
      roomId: overrides.roomId ?? 'room-1',
      displayName: `Player ${index + 1}`,
      seatIndex: index,
      isHost: index === 0,
      isReady: false,
      deviceToken: `token-${id}`,
    })),
  };
}

describe('restoring a saved seat', () => {
  it('restores when the server still lists this player', async () => {
    const attempt = await attemptRestore(async () => makeSnapshot({ playerIds: ['player-1', 'player-2'] }), 'player-2');
    expect(attempt.decision).toEqual({ action: 'restore' });
    expect(attempt.snapshot?.room.id).toBe('room-1');
  });

  it('keeps the saved seat when the lookup fails', async () => {
    const attempt = await attemptRestore(async () => {
      throw new Error('Failed to fetch');
    }, 'player-1');
    expect(attempt.decision).toEqual({ action: 'retry' });
  });

  it('clears the saved seat only when the server answers that the room is gone', async () => {
    const attempt = await attemptRestore(async () => undefined, 'player-1');
    expect(attempt.decision).toEqual({ action: 'clear', reason: 'roomGone' });
  });

  it('clears the saved seat when the room no longer lists this player', async () => {
    const attempt = await attemptRestore(async () => makeSnapshot({ playerIds: ['player-9'] }), 'player-1');
    expect(attempt.decision).toEqual({ action: 'clear', reason: 'playerGone' });
  });
});

describe('out-of-order room updates', () => {
  it('drops a response that carries an older version of the same room', () => {
    const current = makeSnapshot({ version: 7 });
    expect(isStaleSnapshot(current, makeSnapshot({ version: 6 }))).toBe(true);
    expect(isStaleSnapshot(current, makeSnapshot({ version: 7 }))).toBe(false);
    expect(isStaleSnapshot(current, makeSnapshot({ version: 8 }))).toBe(false);
  });

  it('falls back to updatedAt for writes that do not bump the version', () => {
    const current = makeSnapshot({ version: 3, updatedAt: '2026-09-23T10:00:05.000Z' });
    expect(isStaleSnapshot(current, makeSnapshot({ version: 3, updatedAt: '2026-09-23T10:00:01.000Z' }))).toBe(true);
    expect(isStaleSnapshot(current, makeSnapshot({ version: 3, updatedAt: '2026-09-23T10:00:09.000Z' }))).toBe(false);
  });

  it('accepts any snapshot for a different room or when nothing is on screen', () => {
    const current = makeSnapshot({ version: 9 });
    expect(isStaleSnapshot(current, makeSnapshot({ roomId: 'room-2', version: 1 }))).toBe(false);
    expect(isStaleSnapshot(undefined, makeSnapshot({ version: 1 }))).toBe(false);
  });

  it('accepts a snapshot when neither side is versioned, as in local demo storage', () => {
    expect(isStaleSnapshot(makeSnapshot(), makeSnapshot())).toBe(false);
  });
});
