import { describe, expect, it } from 'vitest';
import { buildJoinUrl, parseEntryStep, parseJoinCodeFromUrl, buildStepUrl } from './navigationState';

describe('entry navigation state', () => {
  it('maps missing and invalid steps to home', () => {
    expect(parseEntryStep('https://example.test/')).toBe('home');
    expect(parseEntryStep('https://example.test/?step=unknown')).toBe('home');
    expect(parseEntryStep('https://example.test/?step=room')).toBe('home');
  });

  it('parses supported entry steps from the query string', () => {
    expect(parseEntryStep('https://example.test/?step=create')).toBe('create');
    expect(parseEntryStep('https://example.test/?step=join')).toBe('join');
    expect(parseEntryStep('https://example.test/?step=demo')).toBe('demo');
    expect(parseEntryStep('https://example.test/?step=demo-join')).toBe('demoJoin');
  });

  it('parses a normalized join code only from join URLs', () => {
    expect(parseJoinCodeFromUrl('https://example.test/?step=join&code=12-345')).toBe('12345');
    expect(parseJoinCodeFromUrl('https://example.test/?step=create&code=12345')).toBe('');
    expect(parseJoinCodeFromUrl('https://example.test/?step=join&code=123')).toBe('');
  });

  it('builds shareable join URLs with a five-digit code', () => {
    expect(buildJoinUrl('https://example.test/path?x=1#top', '12-345')).toBe('/path?x=1&step=join&code=12345#top');
  });

  it('preserves unrelated query params when setting an entry step', () => {
    const url = buildStepUrl('https://example.test/?deploy-check=ok&step=join', 'create');
    expect(url).toBe('/?deploy-check=ok&step=create');
  });

  it('removes only the step param when returning home', () => {
    const url = buildStepUrl('https://example.test/?deploy-check=ok&step=demo-join', 'home');
    expect(url).toBe('/?deploy-check=ok');
  });
});
