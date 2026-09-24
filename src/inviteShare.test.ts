import { describe, expect, it, vi } from 'vitest';
import { buildInviteMessage, copyTextToClipboard, INVITE_MESSAGE_TEMPLATE } from './inviteShare';

const zh: Record<string, string> = {
  [INVITE_MESSAGE_TEMPLATE]: '来打阿瓦隆，房号 {code}。点链接入座：{link}',
};

describe('invite message', () => {
  it('fills the room code and link in the current language', () => {
    expect(buildInviteMessage((text) => text, { code: '12345', joinLink: 'https://avalon.example/?step=join&code=12345' }))
      .toBe('Avalon tonight. Room code 12345. Tap to take your seat: https://avalon.example/?step=join&code=12345');
    expect(buildInviteMessage((text) => zh[text] ?? text, { code: '12345', joinLink: 'https://avalon.example/zh/?step=join&code=12345' }))
      .toBe('来打阿瓦隆，房号 12345。点链接入座：https://avalon.example/zh/?step=join&code=12345');
  });
});

describe('clipboard copy', () => {
  it('copies through the selection first, inside the tap', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const legacyCopy = vi.fn().mockReturnValue(true);
    expect(await copyTextToClipboard('room 12345', { writeText, legacyCopy })).toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith('room 12345');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to the clipboard API when the selection copy fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyTextToClipboard('room 12345', { writeText, legacyCopy: () => false })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('room 12345');
    expect(await copyTextToClipboard('room 12345', {
      writeText,
      legacyCopy: () => {
        throw new Error('execCommand is not a function');
      },
    })).toBe(true);
    expect(await copyTextToClipboard('room 12345', { writeText })).toBe(true);
  });

  it('reports failure when both paths fail, so the UI can offer manual copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    expect(await copyTextToClipboard('room 12345', { writeText, legacyCopy: () => false })).toBe(false);
    expect(await copyTextToClipboard('room 12345', { legacyCopy: () => false })).toBe(false);
    expect(await copyTextToClipboard('room 12345', {})).toBe(false);
  });
});
