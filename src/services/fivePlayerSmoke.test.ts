import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialMissionState, type MissionState } from '../domain/missionFlow';

vi.mock('./supabaseClient', () => ({
  getSupabaseClient: () => Promise.resolve(undefined),
  isSupabaseConfigured: false,
}));

import {
  createRoom,
  getPrivateRoleInfo,
  joinRoom,
  setReady,
  startGame,
  submitAssassination,
  updateMissionState,
  type RoomSnapshot,
} from './roomService';

describe('five-player local room smoke', () => {
  beforeEach(() => {
    installLocalBrowserStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates, joins, readies, starts, and reveals private roles for five players', async () => {
    const host = await createRoom({
      displayName: 'Tao P1',
      includePercivalMorgana: false,
      deviceToken: 'device-1',
    });
    let snapshot: RoomSnapshot = host.snapshot;
    const playerIds = [host.currentPlayerId];

    for (let index = 2; index <= 5; index += 1) {
      const joined = await joinRoom({
        code: snapshot.room.code,
        displayName: `Tao P${index}`,
        deviceToken: `device-${index}`,
      });
      snapshot = joined.snapshot;
      playerIds.push(joined.currentPlayerId);
    }

    expect(snapshot.players).toHaveLength(5);
    expect(new Set(playerIds).size).toBe(5);

    for (const playerId of playerIds) {
      snapshot = await setReady(snapshot.room.id, playerId, true);
    }

    expect(snapshot.players.every((player) => player.isReady)).toBe(true);

    const started = await startGame(snapshot.room.id);
    expect(started.ok).toBe(true);
    expect(started.snapshot?.room.status).toBe('reveal');
    expect(started.snapshot?.players).toHaveLength(5);
    expect(started.snapshot?.players.every((player) => Boolean(player.role))).toBe(true);

    for (const player of started.snapshot?.players ?? []) {
      const privateInfo = getPrivateRoleInfo(player, started.snapshot!.players);
      expect(privateInfo?.role).toBe(player.role);
    }
  });

  it('lets the assigned Assassin resolve the endgame through the room service', async () => {
    const snapshot = await startReadyFivePlayerRoom();
    const assassin = snapshot.players.find((player) => player.role === 'Assassin');
    const merlin = snapshot.players.find((player) => player.role === 'Merlin');
    expect(assassin).toBeTruthy();
    expect(merlin).toBeTruthy();

    const missionState: MissionState = {
      ...createInitialMissionState(snapshot.players.map((player) => player.id)),
      phase: 'assassin',
      selectedTeamIds: [],
      missionResults: [
        { roundIndex: 0, outcome: 'success', successCount: 2, failCount: 0, requiredFails: 1 },
        { roundIndex: 1, outcome: 'success', successCount: 3, failCount: 0, requiredFails: 1 },
        { roundIndex: 2, outcome: 'success', successCount: 2, failCount: 0, requiredFails: 1 },
      ],
    };
    await updateMissionState(snapshot.room.id, missionState);

    const resolved = await submitAssassination(snapshot.room.id, assassin!.id, merlin!.id);
    expect(resolved.room.status).toBe('finished');
    expect(resolved.room.settings.missionState).toMatchObject({
      phase: 'finished',
      winner: 'evil',
      assassination: { assassinPlayerId: assassin!.id, targetPlayerId: merlin!.id, hitMerlin: true },
    });
  });
});

async function startReadyFivePlayerRoom(): Promise<RoomSnapshot> {
  const host = await createRoom({
    displayName: 'Tao P1',
    includePercivalMorgana: false,
    deviceToken: 'device-1',
  });
  let snapshot: RoomSnapshot = host.snapshot;
  const playerIds = [host.currentPlayerId];

  for (let index = 2; index <= 5; index += 1) {
    const joined = await joinRoom({
      code: snapshot.room.code,
      displayName: `Tao P${index}`,
      deviceToken: `device-${index}`,
    });
    snapshot = joined.snapshot;
    playerIds.push(joined.currentPlayerId);
  }

  for (const playerId of playerIds) {
    snapshot = await setReady(snapshot.room.id, playerId, true);
  }

  const started = await startGame(snapshot.room.id);
  if (!started.snapshot) throw new Error('Game did not start.');
  return started.snapshot;
}

function installLocalBrowserStorage() {
  const storage = new Map<string, string>();
  const listeners = new Set<(event: Event) => void>();

  const localStorageStub: Storage = {
    get length() {
      return storage.size;
    },
    clear: vi.fn(() => storage.clear()),
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(storage.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, String(value));
    }),
  };

  class TestStorageEvent extends Event {
    key: string | null;

    constructor(type: string, init: StorageEventInit = {}) {
      super(type);
      this.key = init.key ?? null;
    }
  }

  const windowStub = {
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      if (type === 'storage') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      if (type === 'storage') listeners.delete(listener);
    }),
    dispatchEvent: vi.fn((event: Event) => {
      listeners.forEach((listener) => listener(event));
      return true;
    }),
  };

  vi.stubGlobal('localStorage', localStorageStub);
  vi.stubGlobal('StorageEvent', TestStorageEvent);
  vi.stubGlobal('window', windowStub);
}
