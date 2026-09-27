import React, { useEffect, useState } from 'react';
import { type RoomPlayer } from '../services/roomService';
import { useI18n } from '../i18n';

// The table is drawn from the viewer's chair: their seat sits at the bottom
// and seat order runs clockwise, so the next seat is on the viewer's left.
// Arrows on the rim carry the direction; no copy is needed to explain it.
const ROUND_TABLE_SEAT_RADIUS = 39;

const ROUND_TABLE_ARROW_RADIUS = 26.5;

function seatAngle(offset: number, count: number) {
  return Math.PI / 2 + (offset * 2 * Math.PI) / count;
}

function pointOnCircle(angle: number, radius: number) {
  return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
}

export function RoundTable({
  players,
  totalSeats,
  currentPlayerId,
  leaderId,
  teamIds = [],
  readyPlayerIds,
  centerCaption,
  editable,
  busy,
  onSwap,
}: {
  players: RoomPlayer[];
  totalSeats?: number;
  currentPlayerId?: string;
  leaderId?: string;
  teamIds?: string[];
  readyPlayerIds?: string[];
  centerCaption?: string;
  editable: boolean;
  busy: boolean;
  onSwap: (firstPlayerId: string, secondPlayerId: string) => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string>();
  const gradientId = React.useId().replace(/:/g, '');
  const ordered = [...players].sort((a, b) => a.seatIndex - b.seatIndex);
  const count = Math.max(ordered.length, totalSeats ?? 0);
  const viewerIndex = Math.max(0, ordered.findIndex((player) => player.id === currentPlayerId));
  const seatIndexById = new Map(ordered.map((player, index) => [player.id, index]));
  const leaderIndex = leaderId ? seatIndexById.get(leaderId) : undefined;
  const leader = leaderIndex === undefined ? undefined : ordered[leaderIndex];
  const readyCount = readyPlayerIds ? ordered.filter((player) => readyPlayerIds.includes(player.id)).length : 0;
  // Rendered in a stable order so a swap moves the same DOM nodes, which is
  // what lets the seats glide to their new places instead of jumping.
  const stablePlayers = [...ordered].sort((a, b) => a.id.localeCompare(b.id));
  const emptySeatIndexes = Array.from({ length: count - ordered.length }, (_, index) => ordered.length + index);

  useEffect(() => {
    if (!editable) setSelectedId(undefined);
  }, [editable]);

  function handleSeatClick(playerId: string) {
    if (!editable || busy) return;
    if (!selectedId) {
      setSelectedId(playerId);
      return;
    }
    if (selectedId !== playerId) onSwap(selectedId, playerId);
    setSelectedId(undefined);
  }

  function positionFor(index: number) {
    const offset = (index - viewerIndex + count) % count;
    const point = pointOnCircle(seatAngle(offset, count), ROUND_TABLE_SEAT_RADIUS);
    return { left: `${point.x}%`, top: `${point.y}%` };
  }

  const arrows = count >= 2
    ? Array.from({ length: count }, (_, index) => {
      const offset = (index - viewerIndex + count) % count;
      const step = (2 * Math.PI) / count;
      const gap = step * 0.2;
      const start = pointOnCircle(seatAngle(offset, count) + gap, ROUND_TABLE_ARROW_RADIUS);
      const end = pointOnCircle(seatAngle(offset + 1, count) - gap, ROUND_TABLE_ARROW_RADIUS);
      const r = ROUND_TABLE_ARROW_RADIUS;
      return {
        index,
        d: `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
        active: leaderIndex === index,
      };
    })
    : [];
  const cometTrail = [0, 1, 2, 3, 4, 5].map((step) => ({
    ...pointOnCircle(Math.PI / 2 - step * 0.075, ROUND_TABLE_ARROW_RADIUS),
    r: 1.5 - step * 0.2,
    opacity: 1 - step * 0.16,
  }));

  return (
    <div className="round-table-stage">
    <div className={['round-table', editable ? 'editable' : '', selectedId ? 'has-selection' : '', leader ? 'in-game' : ''].filter(Boolean).join(' ')}>
      <svg className="round-table-art" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <radialGradient id={`${gradientId}-felt`} cx="50%" cy="42%" r="60%">
            <stop offset="0%" stopColor="#4f7a45" />
            <stop offset="70%" stopColor="#2f4b2c" />
            <stop offset="100%" stopColor="#1f3320" />
          </radialGradient>
          <linearGradient id={`${gradientId}-rim`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#c98a3d" />
            <stop offset="50%" stopColor="#7a431b" />
            <stop offset="100%" stopColor="#4a260f" />
          </linearGradient>
          <radialGradient id={`${gradientId}-glow`}>
            <stop offset="0%" stopColor="#fff4c2" stopOpacity="1" />
            <stop offset="100%" stopColor="#f0c76b" stopOpacity="0" />
          </radialGradient>
          <marker id={`${gradientId}-head`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
            <path d="M 1 1 L 9 5 L 1 9 z" fill="#f0c76b" />
          </marker>
          <marker id={`${gradientId}-head-active`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
            <path d="M 1 1 L 9 5 L 1 9 z" fill="#fff1b8" />
          </marker>
        </defs>
        <circle cx="50" cy="50" r="24" fill={`url(#${gradientId}-rim)`} />
        <circle cx="50" cy="50" r="21.6" fill={`url(#${gradientId}-felt)`} />
        <circle cx="50" cy="50" r="21.6" fill="none" stroke="rgba(255, 228, 154, 0.35)" strokeWidth="0.5" />
        <circle cx="50" cy="50" r="15" fill="none" stroke="rgba(255, 228, 154, 0.14)" strokeWidth="0.4" strokeDasharray="0.8 1.6" />
        <g className="round-table-arrows">
          {arrows.map((arrow) => (
            <path
              key={arrow.index}
              className={arrow.active ? 'round-table-arrow active' : 'round-table-arrow'}
              d={arrow.d}
              markerEnd={`url(#${gradientId}-head${arrow.active ? '-active' : ''})`}
            />
          ))}
        </g>
        {count >= 2 && (
          <g className="round-table-comet">
            <circle cx="50" cy={50 + ROUND_TABLE_ARROW_RADIUS} r="4" fill={`url(#${gradientId}-glow)`} />
            {cometTrail.map((dot, index) => (
              <circle key={index} cx={dot.x} cy={dot.y} r={dot.r} fill="#fff4c2" opacity={dot.opacity} />
            ))}
          </g>
        )}
      </svg>

      <div className="round-table-center" aria-live="polite">
        {leader ? (
          <>
            <span className="round-table-center-crown" aria-hidden="true">♛</span>
            <small>{t('Leader')}</small>
            <strong>{leader.displayName}</strong>
          </>
        ) : readyPlayerIds ? (
          <>
            <strong className="round-table-center-count">{readyCount}<span>/{count}</span></strong>
            <small>{centerCaption ?? t('Ready')}</small>
          </>
        ) : null}
      </div>

      <ul className="round-table-seats" aria-label={t('Seats in table order')}>
        {stablePlayers.map((player) => {
          const index = seatIndexById.get(player.id) ?? 0;
          const isMe = player.id === currentPlayerId;
          const ready = readyPlayerIds?.includes(player.id);
          const className = [
            'round-table-seat',
            isMe ? 'me' : '',
            player.isAi ? 'ai' : '',
            player.id === leaderId ? 'leader' : '',
            teamIds.includes(player.id) ? 'on-team' : '',
            player.id === selectedId ? 'selected' : '',
            readyPlayerIds ? (ready ? 'ready' : 'waiting') : '',
          ].filter(Boolean).join(' ');
          const label = `${t('Seat')} ${index + 1}: ${player.displayName}${player.isHost ? ` (${t('Host')})` : ''}${readyPlayerIds ? ` · ${ready ? t('Ready') : t('Waiting')}` : ''}`;
          const content = (
            <>
              {player.id === leaderId && <span className="seat-crown" aria-hidden="true">♛</span>}
              <span className="seat-avatar" aria-hidden="true">
                <span className="seat-initial">{player.isAi ? 'AI' : Array.from(player.displayName.trim())[0]?.toUpperCase() ?? '?'}</span>
                <span className="seat-number">{index + 1}</span>
                {readyPlayerIds && <span className={`seat-ready ${ready ? 'on' : 'off'}`}>{ready ? '✓' : ''}</span>}
                {player.isHost && <span className="seat-host">{t('Host')}</span>}
              </span>
              <span className="seat-name" aria-hidden="true">{isMe ? `${player.displayName} · ${t('You')}` : player.displayName}</span>
            </>
          );
          return (
            <li key={player.id} className={className} style={{ ...positionFor(index), animationDelay: `${index * 45}ms` }}>
              {editable
                ? <button type="button" onClick={() => handleSeatClick(player.id)} disabled={busy} aria-pressed={player.id === selectedId} aria-label={label}>{content}</button>
                : <div role="img" aria-label={label}>{content}</div>}
            </li>
          );
        })}
        {emptySeatIndexes.map((index) => (
          <li key={`empty-${index}`} className="round-table-seat empty" style={positionFor(index)}>
            <div role="img" aria-label={`${t('Seat')} ${index + 1}: ${t('Open seat')}`}>
              <span className="seat-avatar" aria-hidden="true">
                <span className="seat-initial">+</span>
                <span className="seat-number">{index + 1}</span>
              </span>
              <span className="seat-name" aria-hidden="true">{t('Open seat')}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
      {editable && (
        <p className="round-table-caption">
          {selectedId ? t('Now tap the player to swap with.') : t('Tap two players to swap their seats.')}
        </p>
      )}
    </div>
  );
}
