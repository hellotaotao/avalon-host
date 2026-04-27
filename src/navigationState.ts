export type EntryScreen = 'home' | 'create' | 'join' | 'demo' | 'demoJoin';

const queryToScreen: Record<string, EntryScreen> = {
  create: 'create',
  join: 'join',
  demo: 'demo',
  'demo-join': 'demoJoin',
};

const screenToQuery: Record<Exclude<EntryScreen, 'home'>, string> = {
  create: 'create',
  join: 'join',
  demo: 'demo',
  demoJoin: 'demo-join',
};

export function parseEntryStep(rawUrl: string): EntryScreen {
  const url = new URL(rawUrl, 'https://avalon.local');
  return queryToScreen[url.searchParams.get('step') ?? ''] ?? 'home';
}

export function parseJoinCodeFromUrl(rawUrl: string): string {
  const url = new URL(rawUrl, 'https://avalon.local');
  if (parseEntryStep(url.href) !== 'join') return '';
  const code = normalizeJoinCode(url.searchParams.get('code') ?? '');
  return code.length === 5 ? code : '';
}

export function buildStepUrl(rawUrl: string, screen: EntryScreen): string {
  const url = new URL(rawUrl, 'https://avalon.local');
  if (screen === 'home') {
    url.searchParams.delete('step');
    url.searchParams.delete('code');
  } else {
    url.searchParams.set('step', screenToQuery[screen]);
    if (screen !== 'join') url.searchParams.delete('code');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildJoinUrl(rawUrl: string, code: string): string {
  const url = new URL(rawUrl, 'https://avalon.local');
  url.searchParams.set('step', 'join');
  url.searchParams.set('code', normalizeJoinCode(code));
  return `${url.pathname}${url.search}${url.hash}`;
}

function normalizeJoinCode(code: string): string {
  return code.replace(/\D/g, '').slice(0, 5);
}
