import { getTeamSize, roleAllegiance, type MissionCard, type Vote } from '../domain/avalon';
import type { MissionState } from '../domain/missionFlow';
import type { RoomPlayer, RoomSnapshot } from './roomCore';

export type RoomAiAction =
  | { type: 'proposeTeam'; leaderPlayerId: string; selectedTeamIds: string[] }
  | { type: 'submitTeamVote'; playerId: string; vote: Vote }
  | { type: 'submitMissionCard'; playerId: string; card: MissionCard }
  | { type: 'submitAssassination'; assassinPlayerId: string; targetPlayerId: string };

export function getNextRoomAiAction(snapshot: RoomSnapshot): RoomAiAction | undefined {
  const missionState = snapshot.room.settings.missionState;
  if (!missionState || missionState.phase === 'finished') return undefined;

  if (missionState.phase === 'proposal') {
    const leader = snapshot.players.find((player) => player.id === missionState.leaderPlayerId);
    if (!leader?.isAi) return undefined;
    return {
      type: 'proposeTeam',
      leaderPlayerId: leader.id,
      selectedTeamIds: chooseAiTeam(snapshot.players, missionState, leader),
    };
  }

  if (missionState.phase === 'vote') {
    const voter = snapshot.players.find((player) => player.isAi && !missionState.teamVotes?.[player.id]);
    if (!voter) return undefined;
    return { type: 'submitTeamVote', playerId: voter.id, vote: chooseAiVote(missionState, voter) };
  }

  if (missionState.phase === 'mission') {
    const submittedPlayerIds = missionState.missionCardSubmissions?.submittedPlayerIds ?? [];
    const actor = snapshot.players.find((player) => player.isAi && missionState.selectedTeamIds.includes(player.id) && !submittedPlayerIds.includes(player.id));
    if (!actor?.role) return undefined;
    return {
      type: 'submitMissionCard',
      playerId: actor.id,
      card: roleAllegiance(actor.role) === 'evil' ? 'fail' : 'success',
    };
  }

  if (missionState.phase === 'assassin') {
    const assassin = snapshot.players.find((player) => player.isAi && player.role === 'Assassin');
    if (!assassin) return undefined;
    const target = snapshot.players.find((player) => player.role === 'Merlin' && player.id !== assassin.id)
      ?? snapshot.players.find((player) => player.id !== assassin.id);
    if (!target) return undefined;
    return { type: 'submitAssassination', assassinPlayerId: assassin.id, targetPlayerId: target.id };
  }

  return undefined;
}

export function getRoomAiActionKey(action: RoomAiAction): string {
  if (action.type === 'proposeTeam') return `${action.type}:${action.leaderPlayerId}:${action.selectedTeamIds.join('|')}`;
  if (action.type === 'submitTeamVote') return `${action.type}:${action.playerId}:${action.vote}`;
  if (action.type === 'submitMissionCard') return `${action.type}:${action.playerId}:${action.card}`;
  return `${action.type}:${action.assassinPlayerId}:${action.targetPlayerId}`;
}

function chooseAiTeam(players: RoomPlayer[], missionState: MissionState, leader: RoomPlayer): string[] {
  const teamSize = getTeamSize(players.length, missionState.roundIndex);
  const orderedPlayers = [...players].sort((left, right) => left.seatIndex - right.seatIndex);
  const evilAllies = leader.role && roleAllegiance(leader.role) === 'evil'
    ? orderedPlayers.filter((player) => player.id !== leader.id && player.role && roleAllegiance(player.role) === 'evil')
    : [];
  return uniqueIds([
    leader.id,
    ...evilAllies.map((player) => player.id),
    ...orderedPlayers.map((player) => player.id),
  ]).slice(0, teamSize);
}

function chooseAiVote(missionState: MissionState, voter: RoomPlayer): Vote {
  if (missionState.selectedTeamIds.includes(voter.id)) return 'approve';
  return 'approve';
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
