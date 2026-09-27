import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { buildInviteMessage, copyTextToClipboard } from '../inviteShare';
import { useI18n } from '../i18n';

// Drawn in the page: the join link never leaves the device, and the code still
// appears when the room is open on a flaky connection.
export function QrCodePanel({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <a className="qr-code" href={value} aria-label={t('Scan QR code to join this Avalon room')}>
      <QRCodeSVG
        value={value}
        title={t('QR code for the Avalon room join link')}
        size={176}
        marginSize={3}
        bgColor="#ffffff"
        fgColor="#231206"
      />
    </a>
  );
}

type InviteCopyFeedback =
  | { kind: 'copied'; text: string }
  | { kind: 'manual'; text: string; fallbackText: string; fallbackLabel: string };

export function InviteSharePanel({ joinLink, code }: { joinLink: string; code: string }) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<InviteCopyFeedback>();
  const inviteMessage = buildInviteMessage(t, { code, joinLink });

  useEffect(() => {
    if (feedback?.kind !== 'copied') return undefined;
    const timer = window.setTimeout(() => setFeedback(undefined), 2600);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copy(text: string, successMessage: string, fallbackLabel: string) {
    const copied = await copyTextToClipboard(text);
    setFeedback(copied
      ? { kind: 'copied', text: successMessage }
      : { kind: 'manual', text: t('This browser blocked the copy. Long-press the text below to copy it by hand.'), fallbackText: text, fallbackLabel });
  }

  return (
    <div className="share-panel">
      {/* Plain text, not a readonly <input>: iOS Safari zooms the page when a form
          control under 16px gets focus, and this link is set small so it fits. */}
      <div className="share-link" role="textbox" aria-readonly="true" aria-label={t('Join link')}>{joinLink}</div>
      <div className="share-actions share-actions-invite">
        <button type="button" className="primary" onClick={() => copy(inviteMessage, t('Invitation copied. Paste it into the chat.'), t('Invitation text to copy by hand'))}>{t('Copy Invitation')}</button>
      </div>
      <div className="share-actions">
        <button type="button" onClick={() => copy(joinLink, t('Join link copied.'), t('Join link to copy by hand'))}>{t('Copy Link')}</button>
        <button type="button" onClick={() => copy(code, t('Room code copied.'), t('Room code to copy by hand'))}>{t('Copy Code')}</button>
      </div>
      {feedback && (
        <div className="share-feedback" role="status" aria-live="polite">
          <p>{feedback.text}</p>
          {feedback.kind === 'manual' && (
            <textarea
              className="share-fallback"
              value={feedback.fallbackText}
              readOnly
              rows={3}
              aria-label={feedback.fallbackLabel}
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
        </div>
      )}
    </div>
  );
}
