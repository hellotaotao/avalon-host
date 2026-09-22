import { getMissionFailThreshold, getTeamSize, type MissionCard, type Vote } from '../domain/avalon';
import { MAX_PROPOSALS_PER_QUEST, type MissionState } from '../domain/missionFlow';
import { getPrivateRoleInfo, type RoomPlayer, type RoomSnapshot } from './roomCore';

export type RoomAiAction =
  | { type: 'proposeTeam'; leaderPlayerId: string; selectedTeamIds: string[] }
  | { type: 'submitTeamVote'; playerId: string; vote: Vote }
  | { type: 'submitMissionCard'; playerId: string; card: MissionCard }
  | { type: 'submitAssassination'; assassinPlayerId: string; targetPlayerId: string };

// Every AI decision below draws only on what a human in that seat would know:
// its own role, its night vision, and the public table state. Other players'
// hidden roles are never read directly. Choices are deterministic so the
// host's retry loop sees the same pending action on every render.

export function getNextRoomAiAction(snapshot: RoomSnapshot): RoomAiAction | undefined {
  const missionState = snapshot.room.settings.missionState;
  if (!missionState || missionState.phase === 'finished') return undefined;

  if (missionState.phase === 'proposal') {
    const leader = snapshot.players.find((player) => player.id === missionState.leaderPlayerId);
    if (!leader?.isAi) return undefined;
    return {
      type: 'proposeTeam',
      leaderPlayerId: leader.id,
      selectedTeamIds: chooseAiTeam(snapshot, missionState, leader),
    };
  }

  if (missionState.phase === 'vote') {
    const voter = snapshot.players.find((player) => player.isAi && !missionState.teamVotes?.[player.id]);
    if (!voter) return undefined;
    return { type: 'submitTeamVote', playerId: voter.id, vote: chooseAiVote(snapshot, missionState, voter) };
  }

  if (missionState.phase === 'mission') {
    const submittedPlayerIds = missionState.missionCardSubmissions?.submittedPlayerIds ?? [];
    const actor = snapshot.players.find((player) => player.isAi && missionState.selectedTeamIds.includes(player.id) && !submittedPlayerIds.includes(player.id));
    if (!actor?.role) return undefined;
    return {
      type: 'submitMissionCard',
      playerId: actor.id,
      card: chooseAiMissionCard(snapshot, missionState, actor),
    };
  }

  if (missionState.phase === 'assassin') {
    const assassin = snapshot.players.find((player) => player.isAi && player.role === 'Assassin');
    if (!assassin) return undefined;
    const target = chooseAiAssassinationTarget(snapshot, missionState, assassin);
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

interface AiKnowledge {
  isEvil: boolean;
  // Evil players seen at night: teammates for evil roles, suspects for Merlin.
  visibleEvilIds: Set<string>;
}

function getAiKnowledge(snapshot: RoomSnapshot, player: RoomPlayer): AiKnowledge {
  const info = getPrivateRoleInfo(player, snapshot.players);
  return {
    isEvil: info?.allegiance === 'evil',
    visibleEvilIds: new Set(info?.sees.filter((seen) => seen.hint !== 'Merlin candidate').map((seen) => seen.playerId) ?? []),
  };
}

function chooseAiTeam(snapshot: RoomSnapshot, missionState: MissionState, leader: RoomPlayer): string[] {
  const knowledge = getAiKnowledge(snapshot, leader);
  const teamSize = getTeamSize(snapshot.players.length, missionState.roundIndex);
  const others = snapshot.players.filter((player) => player.id !== leader.id);
  const ally = knowledge.isEvil
    ? others.filter((player) => knowledge.visibleEvilIds.has(player.id)).sort((left, right) => left.seatIndex - right.seatIndex)[0]
    : undefined;
  const trust = (player: RoomPlayer) => publicMissionScore(missionState, player.id)
    - (!knowledge.isEvil && knowledge.visibleEvilIds.has(player.id) ? 100 : 0);
  const rest = others
    .filter((player) => player.id !== ally?.id)
    .sort((left, right) => trust(right) - trust(left) || stableHash(snapshot.room.id, 'team', left.id) - stableHash(snapshot.room.id, 'team', right.id));
  return [leader.id, ...(ally ? [ally.id] : []), ...rest.map((player) => player.id)].slice(0, teamSize);
}

function chooseAiVote(snapshot: RoomSnapshot, missionState: MissionState, voter: RoomPlayer): Vote {
  const knowledge = getAiKnowledge(snapshot, voter);
  const team = missionState.selectedTeamIds;
  if (knowledge.isEvil) {
    return team.some((id) => id === voter.id || knowledge.visibleEvilIds.has(id)) ? 'approve' : 'reject';
  }
  // Rejecting the last allowed proposal hands Evil the game, so Good takes it.
  if (missionState.proposalIndex + 1 >= MAX_PROPOSALS_PER_QUEST) return 'approve';
  const suspicious = team.some((id) => id !== voter.id && (knowledge.visibleEvilIds.has(id) || wasOnFailedMission(missionState, id)));
  return suspicious ? 'reject' : 'approve';
}

function chooseAiMissionCard(snapshot: RoomSnapshot, missionState: MissionState, actor: RoomPlayer): MissionCard {
  const knowledge = getAiKnowledge(snapshot, actor);
  if (!knowledge.isEvil) return 'success';
  // Evil AIs that see each other agree on who fails: the lowest seats, only as
  // many as the quest needs, so a single quest does not expose them all.
  const requiredFails = getMissionFailThreshold(snapshot.players.length, missionState.roundIndex);
  const failers = snapshot.players
    .filter((player) => player.isAi && missionState.selectedTeamIds.includes(player.id) && (player.id === actor.id || knowledge.visibleEvilIds.has(player.id)))
    .sort((left, right) => left.seatIndex - right.seatIndex)
    .slice(0, requiredFails);
  if (!failers.some((player) => player.id === actor.id)) return 'success';
  // About one in three rooms, the first quest is passed to stay hidden.
  if (missionState.roundIndex === 0 && stableHash(snapshot.room.id, 'first-quest', actor.id) % 3 === 0) return 'success';
  return 'fail';
}

function chooseAiAssassinationTarget(snapshot: RoomSnapshot, missionState: MissionState, assassin: RoomPlayer): RoomPlayer | undefined {
  const knowledge = getAiKnowledge(snapshot, assassin);
  const candidates = snapshot.players.filter((player) => player.id !== assassin.id && !knowledge.visibleEvilIds.has(player.id));
  const merlinScore = (playerId: string) => missionState.missionResults.reduce((score, result) => {
    if (!result.selectedTeamIds?.includes(playerId)) return score;
    return score + (result.outcome === 'success' ? 2 : -3);
  }, 0);
  return [...candidates].sort((left, right) => (
    merlinScore(right.id) - merlinScore(left.id)
    || stableHash(snapshot.room.id, 'assassin', left.id) - stableHash(snapshot.room.id, 'assassin', right.id)
  ))[0];
}

function publicMissionScore(missionState: MissionState, playerId: string): number {
  return missionState.missionResults.reduce((score, result) => {
    if (!result.selectedTeamIds?.includes(playerId)) return score;
    return score + (result.outcome === 'success' ? 1 : -2);
  }, 0);
}

function wasOnFailedMission(missionState: MissionState, playerId: string): boolean {
  return missionState.missionResults.some((result) => result.outcome === 'fail' && result.selectedTeamIds?.includes(playerId));
}

// FNV-1a: varies choices between rooms instead of always following seat order.
function stableHash(...parts: string[]): number {
  let hash = 2166136261;
  for (const char of parts.join(':')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
