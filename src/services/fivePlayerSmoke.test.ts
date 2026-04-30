import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});

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
