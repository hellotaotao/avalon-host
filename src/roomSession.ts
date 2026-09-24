// Restoring a seat has to tell two very different failures apart: the server
// saying the room or the player is gone, and the request never getting an
// answer. Only the first one may drop this device's saved seat; a flaky
// network in a WeChat browser must leave it alone so the player can retry.

import type { RoomSnapshot } from './services/roomService';

export type RestoreDecision =
  | { action: 'restore' }
  | { action: 'clear'; reason: 'roomGone' | 'playerGone' }
  | { action: 'retry' };

export interface RestoreAttempt {
  decision: RestoreDecision;
  snapshot?: RoomSnapshot;
  error?: unknown;
}

export async function attemptRestore(
  load: () => Promise<RoomSnapshot | undefined>,
  storedPlayerId: string,
): Promise<RestoreAttempt> {
  let snapshot: RoomSnapshot | undefined;
  try {
    snapshot = await load();
  } catch (error) {
    return { decision: { action: 'retry' }, error };
  }
  // A resolved lookup is authoritative: the API answers a missing room with an
  // empty result and only rejects when it could not answer at all.
  if (!snapshot) return { decision: { action: 'clear', reason: 'roomGone' } };
  if (!snapshot.players.some((player) => player.id === storedPlayerId)) {
    return { decision: { action: 'clear', reason: 'playerGone' }, snapshot };
  }
  return { decision: { action: 'restore' }, snapshot };
}

// Polls and action responses can land out of order, so a slow poll must not
// paint an older board over a newer one. Writes that change the game bump the
// room version; writes that only move players around refresh updatedAt.
export function isStaleSnapshot(current: RoomSnapshot | undefined, next: RoomSnapshot): boolean {
  if (!current || current.room.id !== next.room.id) return false;
  const currentVersion = current.room.version;
  const nextVersion = next.room.version;
  if (typeof currentVersion === 'number' && typeof nextVersion === 'number' && currentVersion !== nextVersion) {
    return nextVersion < currentVersion;
  }
  if (!current.room.updatedAt || !next.room.updatedAt) return false;
  return next.room.updatedAt < current.room.updatedAt;
}
