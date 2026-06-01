import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialMissionState, type MissionState } from '../domain/missionFlow';

import {
  createRoom,
  getPrivateRoleInfo,
  joinRoom,
  proposeMissionTeam,
  setReady,
  submitAssassination,
  submitMissionCard,
  submitTeamVote,
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
    expect(snapshot.room.status).toBe('reveal');
    expect(snapshot.players).toHaveLength(5);
    expect(snapshot.players.every((player) => Boolean(player.role))).toBe(true);

    for (const player of snapshot.players) {
      const privateInfo = getPrivateRoleInfo(player, snapshot.players);
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
    await updateMissionState(snapshot.room.id, snapshot.players.find((player) => player.isHost)!.id, missionState);

    const resolved = await submitAssassination(snapshot.room.id, assassin!.id, merlin!.id);
    expect(resolved.room.status).toBe('finished');
    expect(resolved.room.settings.missionState).toMatchObject({
      phase: 'finished',
      winner: 'evil',
      assassination: { assassinPlayerId: assassin!.id, targetPlayerId: merlin!.id, hitMerlin: true },
    });
  });

  it('runs a live phone mission flow through proposal, individual votes, and mission cards', async () => {
    let snapshot = await startReadyFivePlayerRoom();
    const playerIds = snapshot.players.map((player) => player.id);
    const leaderId = snapshot.room.settings.missionState!.leaderPlayerId;
    const selectedTeamIds = [playerIds[0], playerIds[1]];

    snapshot = await proposeMissionTeam(snapshot.room.id, leaderId, selectedTeamIds);
    expect(snapshot.room.status).toBe('vote');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'vote',
      selectedTeamIds,
    });

    for (const playerId of playerIds) {
      snapshot = await submitTeamVote(snapshot.room.id, playerId, playerId === playerIds[4] ? 'reject' : 'approve');
    }

    expect(snapshot.room.status).toBe('mission');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'mission',
      teamVotes: {
        [playerIds[0]]: 'approve',
        [playerIds[1]]: 'approve',
        [playerIds[2]]: 'approve',
        [playerIds[3]]: 'approve',
        [playerIds[4]]: 'reject',
      },
      teamVote: { approveCount: 4, rejectCount: 1, passed: true },
    });

    snapshot = await submitMissionCard(snapshot.room.id, selectedTeamIds[0], 'success');
    expect(snapshot.room.status).toBe('mission');
    expect(snapshot.room.settings.missionState?.missionResults).toEqual([]);
    expect(snapshot.room.settings.missionState?.missionCardSubmissions?.submittedPlayerIds).toEqual([selectedTeamIds[0]]);

    snapshot = await submitMissionCard(snapshot.room.id, selectedTeamIds[1], 'success');
    expect(snapshot.room.status).toBe('proposal');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'proposal',
      roundIndex: 1,
      missionResults: [{ roundIndex: 0, outcome: 'success', successCount: 2, failCount: 0, requiredFails: 1, selectedTeamIds }],
      missionCardSubmissions: undefined,
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

  if (snapshot.room.status === 'lobby') throw new Error('Game did not start.');
  return snapshot;
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
