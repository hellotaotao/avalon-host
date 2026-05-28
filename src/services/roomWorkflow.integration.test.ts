import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTeamSize, roleAllegiance, type MissionCard, type Vote } from '../domain/avalon';
import {
  createRoom,
  joinRoom,
  LOCAL_ROOMS_STORAGE_KEY,
  proposeMissionTeam,
  readyForNextGame,
  setReady,
  startGame,
  submitAssassination,
  submitMissionCard,
  submitTeamVote,
  type RoomSnapshot,
} from './roomService';

describe('room workflow integration', () => {
  beforeEach(() => {
    installLocalBrowserStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a full five-player game from room creation to an evil mission win', async () => {
    let snapshot = await startReadyFivePlayerRoom();
    const evilPlayer = snapshot.players.find((player) => player.role && roleAllegiance(player.role) === 'evil');
    expect(evilPlayer).toBeTruthy();

    for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
      const missionState = snapshot.room.settings.missionState;
      expect(missionState?.phase).toBe('proposal');
      expect(missionState?.roundIndex).toBe(roundIndex);

      const teamSize = getTeamSize(snapshot.players.length, roundIndex);
      const selectedTeamIds = selectTeamIncluding(snapshot, evilPlayer!.id, teamSize);
      snapshot = await proposeMissionTeam(snapshot.room.id, missionState!.leaderPlayerId, selectedTeamIds);

      snapshot = await submitVotes(snapshot, () => 'approve');
      expect(snapshot.room.status).toBe('mission');

      snapshot = await submitMissionCards(snapshot, (playerId) => (playerId === evilPlayer!.id ? 'fail' : 'success'));
      expect(snapshot.room.settings.missionState?.missionResults[roundIndex]).toMatchObject({
        roundIndex,
        outcome: 'fail',
        failCount: 1,
        selectedTeamIds,
      });
    }

    expect(snapshot.room.status).toBe('finished');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'finished',
      winner: 'evil',
    });
    expect(snapshot.room.settings.missionState?.missionResults).toHaveLength(3);
    expect(snapshot.room.settings.gameHistory?.at(-1)).toMatchObject({
      gameNumber: 1,
      winner: 'evil',
      endReason: 'three_failed_quests',
    });
  });

  it('records game results and returns the same room to lobby after everyone requests another game', async () => {
    let snapshot = await playThreeSuccessfulMissions();
    const assassin = snapshot.players.find((player) => player.role === 'Assassin');
    const merlin = snapshot.players.find((player) => player.role === 'Merlin');
    expect(assassin).toBeTruthy();
    expect(merlin).toBeTruthy();

    snapshot = await submitAssassination(snapshot.room.id, assassin!.id, merlin!.id);
    expect(snapshot.room.status).toBe('finished');
    expect(snapshot.room.settings.gameHistory).toHaveLength(1);
    const merlinResult = snapshot.room.settings.gameHistory?.[0].playerResults.find((result) => result.playerId === merlin!.id);
    expect(merlinResult).toMatchObject({ role: 'Merlin', allegiance: 'good', won: false });

    for (let index = 0; index < snapshot.players.length - 1; index += 1) {
      snapshot = await readyForNextGame(snapshot.room.id, snapshot.players[index].id);
      expect(snapshot.room.status).toBe('finished');
      expect(snapshot.room.settings.nextGameReadyPlayerIds).toContain(snapshot.players[index].id);
    }

    snapshot = await readyForNextGame(snapshot.room.id, snapshot.players.at(-1)!.id);
    expect(snapshot.room.status).toBe('lobby');
    expect(snapshot.room.settings.missionState).toBeUndefined();
    expect(snapshot.room.settings.nextGameReadyPlayerIds).toBeUndefined();
    expect(snapshot.room.settings.gameHistory).toHaveLength(1);
    expect(snapshot.players.every((player) => player.isReady && !player.role)).toBe(true);
  });

  it('enters assassin phase after three good mission wins, then evil wins if Merlin is hit', async () => {
    let snapshot = await playThreeSuccessfulMissions();
    const assassin = snapshot.players.find((player) => player.role === 'Assassin');
    const merlin = snapshot.players.find((player) => player.role === 'Merlin');
    expect(assassin).toBeTruthy();
    expect(merlin).toBeTruthy();
    expect(snapshot.room.status).toBe('assassin');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'assassin',
      missionResults: [
        { roundIndex: 0, outcome: 'success', failCount: 0 },
        { roundIndex: 1, outcome: 'success', failCount: 0 },
        { roundIndex: 2, outcome: 'success', failCount: 0 },
      ],
    });

    snapshot = await submitAssassination(snapshot.room.id, assassin!.id, merlin!.id);

    expect(snapshot.room.status).toBe('finished');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'finished',
      winner: 'evil',
      assassination: { assassinPlayerId: assassin!.id, targetPlayerId: merlin!.id, hitMerlin: true },
    });
  });

  it('finishes with good winning if the assassin misses Merlin after three good missions', async () => {
    let snapshot = await playThreeSuccessfulMissions();
    const assassin = snapshot.players.find((player) => player.role === 'Assassin');
    const nonMerlinTarget = snapshot.players.find((player) => player.role !== 'Assassin' && player.role !== 'Merlin');
    expect(assassin).toBeTruthy();
    expect(nonMerlinTarget).toBeTruthy();

    snapshot = await submitAssassination(snapshot.room.id, assassin!.id, nonMerlinTarget!.id);

    expect(snapshot.room.status).toBe('finished');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'finished',
      winner: 'good',
      assassination: { assassinPlayerId: assassin!.id, targetPlayerId: nonMerlinTarget!.id, hitMerlin: false },
    });
  });

  it('keeps the game in proposal flow when a team vote is rejected and rotates leader', async () => {
    let snapshot = await startReadyFivePlayerRoom();
    const firstLeaderId = snapshot.room.settings.missionState!.leaderPlayerId;
    const firstLeaderIndex = snapshot.players.findIndex((player) => player.id === firstLeaderId);
    const expectedNextLeaderId = snapshot.players[(firstLeaderIndex + 1) % snapshot.players.length].id;
    const selectedTeamIds = snapshot.players.slice(0, 2).map((player) => player.id);

    snapshot = await proposeMissionTeam(snapshot.room.id, firstLeaderId, selectedTeamIds);
    snapshot = await submitVotes(snapshot, (_, index) => (index < 3 ? 'reject' : 'approve'));

    expect(snapshot.room.status).toBe('proposal');
    expect(snapshot.room.settings.missionState).toMatchObject({
      phase: 'proposal',
      leaderPlayerId: expectedNextLeaderId,
      selectedTeamIds: [],
      proposalIndex: 1,
      teamVote: { approveCount: 2, rejectCount: 3, passed: false },
    });
    expect(snapshot.room.settings.missionState?.missionResults).toEqual([]);
  });
});

async function playThreeSuccessfulMissions(): Promise<RoomSnapshot> {
  let snapshot = await startReadyFivePlayerRoom();

  for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
    const missionState = snapshot.room.settings.missionState;
    const teamSize = getTeamSize(snapshot.players.length, roundIndex);
    const selectedTeamIds = snapshot.players
      .filter((player) => !player.role || roleAllegiance(player.role) === 'good')
      .map((player) => player.id)
      .slice(0, teamSize);

    snapshot = await proposeMissionTeam(snapshot.room.id, missionState!.leaderPlayerId, selectedTeamIds);
    snapshot = await submitVotes(snapshot, () => 'approve');
    snapshot = await submitMissionCards(snapshot, () => 'success');
  }

  return snapshot;
}

async function startReadyFivePlayerRoom(): Promise<RoomSnapshot> {
  const host = await createRoom({
    displayName: 'Tao P1',
    includePercivalMorgana: false,
    deviceToken: 'workflow-device-1',
  });
  let snapshot: RoomSnapshot = host.snapshot;
  const playerIds = [host.currentPlayerId];

  for (let index = 2; index <= 5; index += 1) {
    const joined = await joinRoom({
      code: snapshot.room.code,
      displayName: `Tao P${index}`,
      deviceToken: `workflow-device-${index}`,
    });
    snapshot = joined.snapshot;
    playerIds.push(joined.currentPlayerId);
  }

  for (const playerId of playerIds) {
    snapshot = await setReady(snapshot.room.id, playerId, true);
  }

  const started = await startGame(snapshot.room.id, host.currentPlayerId);
  if (!started.snapshot) throw new Error('Game did not start.');
  return started.snapshot;
}

function selectTeamIncluding(snapshot: RoomSnapshot, requiredPlayerId: string, teamSize: number): string[] {
  return [
    requiredPlayerId,
    ...snapshot.players.map((player) => player.id).filter((playerId) => playerId !== requiredPlayerId),
  ].slice(0, teamSize);
}

async function submitVotes(snapshot: RoomSnapshot, voteFor: (playerId: string, index: number) => Vote): Promise<RoomSnapshot> {
  let nextSnapshot = snapshot;
  for (const [index, player] of snapshot.players.entries()) {
    nextSnapshot = await submitTeamVote(snapshot.room.id, player.id, voteFor(player.id, index));
  }
  return nextSnapshot;
}

async function submitMissionCards(
  snapshot: RoomSnapshot,
  cardFor: (playerId: string, index: number) => MissionCard,
): Promise<RoomSnapshot> {
  let nextSnapshot = snapshot;
  const selectedTeamIds = snapshot.room.settings.missionState?.selectedTeamIds ?? [];
  for (const [index, playerId] of selectedTeamIds.entries()) {
    nextSnapshot = await submitMissionCard(snapshot.room.id, playerId, cardFor(playerId, index));
  }
  return nextSnapshot;
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
  localStorage.removeItem(LOCAL_ROOMS_STORAGE_KEY);
}
