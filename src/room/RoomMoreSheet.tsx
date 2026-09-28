import React, { useEffect, useRef } from 'react';
import { type MissionState } from '../domain/missionFlow';
import { type RoomPlayer, type RoomSnapshot } from '../services/roomService';
import { useI18n } from '../i18n';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { HostControls } from './HostAuthorityPanel';
import { RoomInvite } from './InviteSharePanel';
import { MissionRecoveryControls } from './MissionPanel';

// Everything a player rarely needs, in a sheet over the page that the top
// bar's "More" button opens: invite details, language, host tools, leaving.
export function RoomMoreSheet({
  snapshot,
  currentPlayer,
  missionState,
  started,
  isFinished,
  isDemoMode,
  joinLink,
  showInvite,
  currentTeamSize,
  busy,
  returnFocusRef,
  onClose,
  onLeave,
  onResetRoomToLobby,
  onDissolveRoom,
  onRemovePlayer,
  onReleaseSeat,
  onTransferHost,
  onMissionStateChange,
}: {
  snapshot: RoomSnapshot;
  currentPlayer?: RoomPlayer;
  missionState?: MissionState;
  started: boolean;
  isFinished: boolean;
  isDemoMode: boolean;
  joinLink: string;
  showInvite: boolean;
  currentTeamSize: number;
  busy: boolean;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onLeave: () => void;
  onResetRoomToLobby: () => void;
  onDissolveRoom: () => void;
  onRemovePlayer: (targetPlayerId: string) => void;
  onReleaseSeat: (targetPlayerId: string) => void;
  onTransferHost: (targetPlayerId: string) => void;
  onMissionStateChange: (missionState: MissionState) => void;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isHost = Boolean(currentPlayer?.isHost);
  const leaveLabel = started && !isFinished ? t('Exit Table') : t('Leave Room');

  useEffect(() => {
    const opener = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    // Keep keyboard focus inside the sheet while it covers the page.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !sheetRef.current) return;
      const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!sheetRef.current.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, []);

  return (
    <div className="room-sheet-backdrop" onClick={onClose}>
      <section
        ref={sheetRef}
        id="room-more"
        className="room-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="room-sheet-head">
          <h2 id="room-sheet-title">{t('More')}</h2>
          <button ref={closeRef} type="button" className="room-sheet-close" aria-label={t('Close')} onClick={onClose}>×</button>
        </header>
        <div className="room-sheet-body">
          {showInvite && <RoomInvite code={snapshot.room.code} joinLink={joinLink} isDemoMode={isDemoMode} />}
          <div className="room-sheet-row">
            <span>{t('Language')}</span>
            <LanguageSwitcher />
          </div>
          {isHost && (
            <section className="room-sheet-host" aria-label={t('Host permissions')}>
              <h3>{t('Host permissions')}</h3>
              <HostControls
                players={snapshot.players}
                currentPlayer={currentPlayer}
                started={started}
                isDemoMode={isDemoMode}
                busy={busy}
                onResetRoomToLobby={onResetRoomToLobby}
                onDissolveRoom={onDissolveRoom}
                onRemovePlayer={onRemovePlayer}
                onReleaseSeat={onReleaseSeat}
                onTransferHost={onTransferHost}
              />
              {missionState && !isFinished && (
                <MissionRecoveryControls
                  missionState={missionState}
                  players={snapshot.players}
                  currentTeamSize={currentTeamSize}
                  onMissionStateChange={onMissionStateChange}
                />
              )}
            </section>
          )}
          {currentPlayer && (
            <button type="button" className="secondary-control room-leave" onClick={onLeave} disabled={busy}>{leaveLabel}</button>
          )}
        </div>
      </section>
    </div>
  );
}
