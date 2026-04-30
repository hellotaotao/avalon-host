import { describe, expect, it } from 'vitest';
import type { RoomSnapshot } from '../services/roomService';
import { createSimulatorSnapshot, DEV_ROOM_CODE, removeSimulatorRooms, replaceSimulatorRooms } from './simulatorStorage';

describe('simulator storage safety', () => {
  it('replaces only simulator rooms when seeding', () => {
    const localDemoRoom = makeRoom('local-demo-room', '24680');
    const previousSimulatorById = makeRoom('dev-room-old', '11111');
    const previousSimulatorByCode = makeRoom('local-room-with-dev-code', DEV_ROOM_CODE);
    const nextSimulator = createSimulatorSnapshot('next');

    const rooms = replaceSimulatorRooms(
      [localDemoRoom, previousSimulatorById, previousSimulatorByCode],
      nextSimulator,
    );

    expect(rooms).toEqual([localDemoRoom, nextSimulator]);
  });

  it('removes only simulator rooms when clearing', () => {
    const localDemoRoom = makeRoom('local-demo-room', '24680');
    const previousSimulatorById = makeRoom('dev-room-old', '11111');
    const previousSimulatorByCode = makeRoom('local-room-with-dev-code', DEV_ROOM_CODE);

    expect(removeSimulatorRooms([localDemoRoom, previousSimulatorById, previousSimulatorByCode])).toEqual([localDemoRoom]);
  });
});

function makeRoom(id: string, code: string): RoomSnapshot {
  return {
    room: {
      id,
      code,
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: {},
    },
    players: [],
  };
}
