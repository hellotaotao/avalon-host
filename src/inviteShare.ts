// Copying an invite has to work inside WeChat's in-app browser, where the
// async clipboard API is often missing or rejected. Every copy therefore
// reports whether it actually landed, so the UI can fall back to text the
// player can long-press instead of claiming a success that never happened.

import { fillText } from './i18n';

export const INVITE_MESSAGE_TEMPLATE = 'Avalon tonight. Room code {code}. Tap to take your seat: {link}';

export interface ClipboardScope {
  writeText?: (text: string) => Promise<void>;
  legacyCopy?: (text: string) => boolean;
}

export function buildInviteMessage(
  translate: (text: string) => string,
  values: { code: string; joinLink: string },
): string {
  return fillText(translate(INVITE_MESSAGE_TEMPLATE), { code: values.code, link: values.joinLink });
}

// The selection copy goes first because WebKit (iOS Safari, WeChat's
// WKWebView) only honors it synchronously inside the tap; trying it after an
// awaited clipboard rejection would always fail there.
export async function copyTextToClipboard(text: string, scope: ClipboardScope = browserClipboardScope()): Promise<boolean> {
  try {
    if (scope.legacyCopy?.(text)) return true;
  } catch {
    // Fall through to the async clipboard API.
  }
  if (!scope.writeText) return false;
  try {
    await scope.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function browserClipboardScope(): ClipboardScope {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return {
    writeText: clipboard?.writeText ? (text) => clipboard.writeText(text) : undefined,
    legacyCopy: typeof document === 'undefined' ? undefined : copyBySelection,
  };
}

// iOS Safari (and WeChat's WKWebView) only copy from an on-screen field
// with an explicit selection range, so the field is kept on screen but
// transparent instead of moved off-screen.
function copyBySelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '0';
  // iOS zooms the page when focusing a field smaller than 16px.
  field.style.fontSize = '16px';
  field.style.opacity = '0';
  field.style.pointerEvents = 'none';
  document.body.append(field);
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
