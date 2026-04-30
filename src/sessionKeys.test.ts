import { describe, expect, it } from 'vitest';
import { getSessionStorageKeys, getStorageKeysForDevSession } from './sessionKeys';

describe('session storage keys', () => {
  it('uses base keys by default without requiring window', () => {
    expect(getSessionStorageKeys()).toEqual({
      currentPlayerId: 'avalon-host.currentPlayerId',
      currentRoomId: 'avalon-host.currentRoomId',
      deviceToken: 'avalon-host.deviceToken',
    });
  });

  it('normalizes dev session keys from explicit ids and urls', () => {
    expect(getStorageKeysForDevSession(' Tao P1!? ')).toEqual({
      currentPlayerId: 'avalon-host.devSession.TaoP1.currentPlayerId',
      currentRoomId: 'avalon-host.devSession.TaoP1.currentRoomId',
      deviceToken: 'avalon-host.devSession.TaoP1.deviceToken',
    });

    expect(getSessionStorageKeys('https://avalon.local/?devSession=tao-p2!!')).toEqual({
      currentPlayerId: 'avalon-host.devSession.tao-p2.currentPlayerId',
      currentRoomId: 'avalon-host.devSession.tao-p2.currentRoomId',
      deviceToken: 'avalon-host.devSession.tao-p2.deviceToken',
    });
  });
});
