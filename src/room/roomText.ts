import { type MissionState } from '../domain/missionFlow';
import { type RoomPlayer } from '../services/roomService';

export type RoomAiAutomationState = {
  actionKey: string;
  attempt: number;
  lastError?: string;
  waitingForRetry: boolean;
};

export function formatStartValidation(message: string | undefined, t: (text: string) => string): string | undefined {
  if (!message) return undefined;
  const neededMatch = message.match(/^Need (\d+) more ready players? to start\.$/);
  if (neededMatch) return `${neededMatch[1]} ${t('more ready players needed to start.')}`;
  const plannedCountMatch = message.match(/^This room is set for (\d+) players\.$/);
  if (plannedCountMatch) return `${t('This room is set for')} ${plannedCountMatch[1]} ${t('players.')}`;
  return t(message);
}

export function getRoomPlayerNames(players: RoomPlayer[], playerIds: string[] = []): string[] {
  return playerIds.map((id) => {
    const player = players.find((candidate) => candidate.id === id);
    if (!player) return id;
    return player.isAi ? `${player.displayName} (AI)` : player.displayName;
  });
}

export function sortRoomPlayersBySeat(players: RoomPlayer[]): RoomPlayer[] {
  return [...players].sort((left, right) => left.seatIndex - right.seatIndex);
}

export function getPendingAiMissionActor(missionState: MissionState, players: RoomPlayer[]): RoomPlayer | undefined {
  const orderedPlayers = sortRoomPlayersBySeat(players);
  if (missionState.phase === 'proposal') {
    const leader = orderedPlayers.find((player) => player.id === missionState.leaderPlayerId);
    return leader?.isAi ? leader : undefined;
  }
  if (missionState.phase === 'vote') {
    return orderedPlayers.find((player) => player.isAi && !missionState.teamVotes?.[player.id]);
  }
  if (missionState.phase === 'mission') {
    const submittedPlayerIds = missionState.missionCardSubmissions?.submittedPlayerIds ?? [];
    return orderedPlayers.find((player) => player.isAi && missionState.selectedTeamIds.includes(player.id) && !submittedPlayerIds.includes(player.id));
  }
  if (missionState.phase === 'assassin') {
    return orderedPlayers.find((player) => player.isAi && player.role === 'Assassin');
  }
  return undefined;
}

export function formatPendingAiMissionAction(missionState: MissionState, player: RoomPlayer, t: (text: string) => string): string {
  if (missionState.phase === 'proposal') return `${player.displayName} ${t('is choosing the crew.')}`;
  if (missionState.phase === 'vote') return `${player.displayName} ${t('is thinking about the vote.')}`;
  if (missionState.phase === 'mission') return `${player.displayName} ${t('is preparing a mission card.')}`;
  if (missionState.phase === 'assassin') return `${player.displayName} ${t('is choosing Merlin.')}`;
  return '';
}
