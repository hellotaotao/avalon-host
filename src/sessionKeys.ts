export interface SessionStorageKeys {
  currentPlayerId: string;
  currentRoomId: string;
  deviceToken: string;
}

const DEFAULT_PREFIX = 'avalon-host';

export function getSessionStorageKeys(rawUrl?: string): SessionStorageKeys {
  const currentUrl = rawUrl ?? (typeof window === 'undefined' ? '' : window.location.href);
  const devSessionId = import.meta.env.DEV ? parseDevSessionId(currentUrl) : '';
  return getStorageKeysForDevSession(devSessionId);
}

export function getStorageKeysForDevSession(devSessionId: string): SessionStorageKeys {
  const normalized = normalizeDevSessionId(devSessionId);
  const prefix = import.meta.env.DEV && normalized ? `${DEFAULT_PREFIX}.devSession.${normalized}` : DEFAULT_PREFIX;
  return {
    currentPlayerId: `${prefix}.currentPlayerId`,
    currentRoomId: `${prefix}.currentRoomId`,
    deviceToken: `${prefix}.deviceToken`,
  };
}

export function parseDevSessionId(rawUrl: string): string {
  const url = new URL(rawUrl, 'https://avalon.local');
  return normalizeDevSessionId(url.searchParams.get('devSession') ?? '');
}

export function isDevSessionActive(rawUrl: string = typeof window === 'undefined' ? '' : window.location.href): boolean {
  return import.meta.env.DEV && Boolean(parseDevSessionId(rawUrl));
}

export function normalizeDevSessionId(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
}
