import type { RoomSnapshot } from '../services/roomService';

export const DEV_ROOM_CODE = '13579';

export const DEV_SESSIONS = [
  { id: 'tao-p1', label: 'Tao P1', role: 'Host' },
  { id: 'tao-p2', label: 'Tao P2', role: 'Player' },
  { id: 'tao-p3', label: 'Tao P3', role: 'Player' },
  { id: 'tao-p4', label: 'Tao P4', role: 'Player' },
  { id: 'tao-p5', label: 'Tao P5', role: 'Player' },
] as const;

export function createSimulatorSnapshot(runId: string): RoomSnapshot {
  const roomId = `dev-room-${runId}`;
  const players = DEV_SESSIONS.map((session, index) => ({
    id: `dev-player-${runId}-${index + 1}`,
    roomId,
    displayName: session.label,
    seatIndex: index,
    isHost: index === 0,
    isReady: false,
    deviceToken: `dev-device-${runId}-${session.id}`,
  }));

  return {
    room: {
      id: roomId,
      code: DEV_ROOM_CODE,
      status: 'lobby',
      gameType: 'avalon_lite',
      settings: { includePercivalMorgana: false },
    },
    players,
  };
}

export function replaceSimulatorRooms(rooms: RoomSnapshot[], simulatorRoom: RoomSnapshot): RoomSnapshot[] {
  return [...rooms.filter((room) => !isSimulatorRoom(room)), simulatorRoom];
}

export function removeSimulatorRooms(rooms: RoomSnapshot[]): RoomSnapshot[] {
  return rooms.filter((room) => !isSimulatorRoom(room));
}

export function isSimulatorRoom(snapshot: RoomSnapshot): boolean {
  return snapshot.room.code === DEV_ROOM_CODE || snapshot.room.id.startsWith('dev-room-');
}
