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

export function buildStepUrl(rawUrl: string, screen: EntryScreen): string {
  const url = new URL(rawUrl, 'https://avalon.local');
  if (screen === 'home') {
    url.searchParams.delete('step');
  } else {
    url.searchParams.set('step', screenToQuery[screen]);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
