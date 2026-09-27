import { isSeatReleased, type RoomPlayer } from '../services/roomService';
import { useI18n } from '../i18n';

export function HostAuthorityPanel({
  players,
  currentPlayer,
  started,
  isDemoMode,
  busy,
  onResetRoomToLobby,
  onDissolveRoom,
  onRemovePlayer,
  onReleaseSeat,
  onTransferHost,
}: {
  players: RoomPlayer[];
  currentPlayer?: RoomPlayer;
  started: boolean;
  isDemoMode: boolean;
  busy: boolean;
  onResetRoomToLobby: () => void;
  onDissolveRoom: () => void;
  onRemovePlayer: (targetPlayerId: string) => void;
  onReleaseSeat: (targetPlayerId: string) => void;
  onTransferHost: (targetPlayerId: string) => void;
}) {
  const { t } = useI18n();
  if (!currentPlayer?.isHost) return null;

  const manageablePlayers = players.filter((player) => !player.isHost && !player.isAi && !isDemoMode);

  const controls = (
    <>
      {started && (
        <div className="host-action-group host-start-action">
          <div>
            <h3>{t('Current game')}</h3>
            <p>{t('Use this only when this round should be cancelled for everyone.')}</p>
          </div>
          <button type="button" className="secondary-control" onClick={onResetRoomToLobby} disabled={busy}>{t('Abandon Game')}</button>
        </div>
      )}

      {manageablePlayers.length > 0 && (
        <div className="host-action-group">
          <h3>{t('Manage players')}</h3>
          {started && <p>{t('If a player switched phones or browsers, release their seat so they can rejoin with the same nickname.')}</p>}
          <div className="host-player-actions">
            {manageablePlayers.map((player) => (
              <div key={player.id} className="host-player-action-row">
                <span>{player.displayName}</span>
                <div>
                  <button type="button" className="secondary-control" onClick={() => onTransferHost(player.id)} disabled={busy}>{t('Make Host')}</button>
                  {!started && <button type="button" className="small-danger" onClick={() => onRemovePlayer(player.id)} disabled={busy}>{t('Remove')}</button>}
                  {started && (isSeatReleased(player)
                    ? <small className="released-seat-status">{t('Waiting to rejoin')}</small>
                    : <button type="button" className="secondary-control" onClick={() => onReleaseSeat(player.id)} disabled={busy}>{t('Release Seat')}</button>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="host-action-group danger-zone compact-danger-zone">
        <div>
          <h3>{t('Room controls')}</h3>
          <p>{t('Dissolve the room only when the table is done or created by mistake.')}</p>
        </div>
        <button type="button" className="small-danger dissolve-room" onClick={onDissolveRoom} disabled={busy}>{t('Dissolve Room')}</button>
      </div>
    </>
  );

  // In-game the host panel is rarely needed, so collapse it to keep the play
  // surface short. In the lobby it stays open — space is not tight there.
  if (started) {
    return (
      <details className="panel host-authority-panel host-authority-disclosure">
        <summary className="host-authority-heading">
          <h2 id="host-authority-title">{t('Host permissions')}</h2>
          <span className="disclosure-hint">{t('Tap to manage')}</span>
        </summary>
        {controls}
      </details>
    );
  }

  return (
    <section className="panel host-authority-panel" aria-labelledby="host-authority-title">
      <div className="host-authority-heading">
        <h2 id="host-authority-title">{t('Host permissions')}</h2>
      </div>
      {controls}
    </section>
  );
}
