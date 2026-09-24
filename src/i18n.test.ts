import { describe, expect, it } from 'vitest';
import { translateZhPattern } from './i18n';

describe('Chinese error patterns', () => {
  it('translates rule errors that embed numbers or phase names', () => {
    expect(translateZhPattern('Quest 2 needs exactly 3 team members.')).toBe('第 2 轮任务需要正好 3 名队员。');
    expect(translateZhPattern('Mission flow is in vote, not proposal.')).toBe('游戏进度已经变化，请以最新画面为准。');
    expect(translateZhPattern('Request failed (502).')).toBe('请求失败，请稍后再试。');
    expect(translateZhPattern('Something else entirely.')).toBeUndefined();
  });
});
