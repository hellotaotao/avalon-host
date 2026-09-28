import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type Allegiance, type Role } from '../domain/avalon';
import { type RoomPlayer } from '../services/roomService';
import { formatRole, useI18n } from '../i18n';

export type RevealedSeatRoles = Record<string, { role: Role; allegiance: Allegiance }>;

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

// A swap reads as a swap when the two seats pass each other on the rim: one
// travels on an outer lane, the other on an inner one, both lifted mid-way.
const SWAP_DURATION_MS = 650;
// When the viewer's own seat moves, the table then turns so they sit at the
// bottom again; that turn is a second step after the swap itself.
const TURN_DURATION_MS = 550;
const SWAP_LANE = 8;
const DROP_SETTLE_MS = 280;
const DRAG_START_PX = 6;
// How close (in % of the table) the pointer must be to a seat to drop there.
const DROP_RADIUS = 13;

function shortestTurn(from: number, to: number) {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}

function easeInOut(progress: number) {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

// Frames along the rim, eased within their own span [start, end] of the
// whole animation, so a swap and a following turn can share one timeline.
function arcKeyframes(fromAngle: number, toAngle: number, lane: number, start = 0, end = 1): Keyframe[] {
  const delta = shortestTurn(fromAngle, toAngle);
  const steps = 14;
  return Array.from({ length: steps + 1 }, (_, step) => {
    const progress = easeInOut(step / steps);
    const lift = Math.sin(Math.PI * progress);
    const point = pointOnCircle(fromAngle + delta * progress, ROUND_TABLE_SEAT_RADIUS + lane * lift);
    return {
      offset: start + (end - start) * (step / steps),
      left: `${point.x}%`,
      top: `${point.y}%`,
      transform: `translate(-50%, -50%) scale(${(1 + (lane ? 0.14 : 0) * lift).toFixed(3)})`,
    };
  });
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

type DragState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  active: boolean;
  targetId?: string;
};

export function RoundTable({
  players,
  totalSeats,
  currentPlayerId,
  leaderId,
  teamIds = [],
  readyPlayerIds,
  seatMarks,
  revealedRoles,
  seatTags,
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
  // Per-seat progress for the current step (voted, card played). Unlike
  // readyPlayerIds, it leaves the seats undimmed and the center alone.
  seatMarks?: Record<string, 'done' | 'waiting'>;
  // After a game: every seat's role, shown on the table instead of a list.
  revealedRoles?: RevealedSeatRoles;
  // Short public labels on a seat, such as who the Assassin chose.
  seatTags?: Record<string, string>;
  centerCaption?: string;
  editable: boolean;
  busy: boolean;
  onSwap: (firstPlayerId: string, secondPlayerId: string) => void;
}) {
  const { t, language } = useI18n();
  const [selectedId, setSelectedId] = useState<string>();
  const gradientId = React.useId().replace(/:/g, '');
  const baseOrdered = [...players].sort((a, b) => a.seatIndex - b.seatIndex);
  const baseSignature = baseOrdered.map((player) => player.id).join('|');
  // A swap shows at once instead of after the server round trip. It only
  // applies to the table it was made on, and is dropped when the request ends:
  // the new snapshot then carries the order, or a failure puts the seats back.
  const [optimistic, setOptimistic] = useState<{ base: string; order: string[] }>();
  const playersById = new Map(players.map((player) => [player.id, player]));
  const ordered = optimistic?.base === baseSignature
    ? optimistic.order.map((id) => playersById.get(id)).filter((player): player is RoomPlayer => Boolean(player))
    : baseOrdered;
  const count = Math.max(ordered.length, totalSeats ?? 0);
  const tableRef = useRef<HTMLDivElement>(null);
  const seatRefs = useRef(new Map<string, HTMLLIElement>());
  const previousLayoutRef = useRef<{ indexById: Map<string, number>; viewerIndex: number; count: number } | undefined>(undefined);
  const lastSwapRef = useRef<[string, string] | undefined>(undefined);
  const lastDropRef = useRef<{ id: string; dx: number; dy: number } | undefined>(undefined);
  const dragRef = useRef<DragState | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const wasBusyRef = useRef(busy);
  const viewerIndex = Math.max(0, ordered.findIndex((player) => player.id === currentPlayerId));
  const seatIndexById = new Map(ordered.map((player, index) => [player.id, index]));
  const leaderIndex = leaderId ? seatIndexById.get(leaderId) : undefined;
  const leader = leaderIndex === undefined ? undefined : ordered[leaderIndex];
  const readyCount = readyPlayerIds ? ordered.filter((player) => readyPlayerIds.includes(player.id)).length : 0;
  // Rendered in a stable order so a swap moves the same DOM nodes, which is
  // what lets the swap animation run on the seats that actually changed.
  const stablePlayers = [...ordered].sort((a, b) => a.id.localeCompare(b.id));
  const emptySeatIndexes = Array.from({ length: count - ordered.length }, (_, index) => ordered.length + index);

  useEffect(() => {
    if (!editable) setSelectedId(undefined);
  }, [editable]);

  useEffect(() => {
    if (wasBusyRef.current && !busy) setOptimistic(undefined);
    wasBusyRef.current = busy;
  }, [busy]);

  // Once the table's real order changes, an earlier local swap is spent; kept
  // around, it would reappear if the order ever came back to the same list.
  useEffect(() => {
    setOptimistic((current) => (current && current.base !== baseSignature ? undefined : current));
  }, [baseSignature]);

  function angleFor(index: number) {
    return seatAngle((index - viewerIndex + count) % count, count);
  }

  function positionFor(index: number) {
    const point = pointOnCircle(angleFor(index), ROUND_TABLE_SEAT_RADIUS);
    return { left: `${point.x}%`, top: `${point.y}%` };
  }

  // Animate every seat whose place on screen changed since the last render.
  // The swapped pair trade places on two lanes, in the orientation the table
  // had before. If the viewer's own seat moved, the table is drawn from a new
  // chair, so it then turns until the viewer sits at the bottom again.
  const layoutSignature = `${ordered.map((player) => player.id).join('|')}#${viewerIndex}#${count}`;
  useLayoutEffect(() => {
    const indexById = new Map(ordered.map((player, index) => [player.id, index]));
    const previous = previousLayoutRef.current;
    previousLayoutRef.current = { indexById, viewerIndex, count };
    const drop = lastDropRef.current;
    lastDropRef.current = undefined;
    const swapped = lastSwapRef.current;
    lastSwapRef.current = undefined;
    if (!previous || previous.count !== count || prefersReducedMotion()) return;

    const angleAt = (index: number, viewer: number) => seatAngle((index - viewer + count) % count, count);
    const plans = ordered.flatMap((player) => {
      const before = previous.indexById.get(player.id);
      if (before === undefined) return [];
      const index = indexById.get(player.id)!;
      return [{
        player,
        moves: before !== index,
        from: angleAt(before, previous.viewerIndex),
        mid: angleAt(index, previous.viewerIndex),
        to: angleAt(index, viewerIndex),
      }];
    });
    const seatMovers = plans.filter((plan) => plan.moves);
    const turns = previous.viewerIndex !== viewerIndex;
    if (seatMovers.length === 0 && !turns) return;
    // A swap made on another phone arrives without a record of which pair it
    // was; then the pair is the two seats whose place in the order changed.
    const pair = swapped ?? (seatMovers.length === 2 ? [seatMovers[0].player.id, seatMovers[1].player.id] as [string, string] : undefined);
    const swapEnd = turns ? SWAP_DURATION_MS / (SWAP_DURATION_MS + TURN_DURATION_MS) : 1;
    const duration = turns ? SWAP_DURATION_MS + TURN_DURATION_MS : SWAP_DURATION_MS;
    const table = tableRef.current?.getBoundingClientRect();

    for (const plan of plans) {
      if (!plan.moves && !turns) continue;
      const element = seatRefs.current.get(plan.player.id);
      if (!element?.animate) continue;
      const inPair = Boolean(pair?.includes(plan.player.id));
      const lane = inPair ? (plan.player.id === pair![0] ? SWAP_LANE : -SWAP_LANE) : 0;
      const turn = turns ? arcKeyframes(plan.mid, plan.to, 0, swapEnd, 1).slice(1) : [];
      let animation: Animation;
      if (drop?.id === plan.player.id) {
        // Dropped by hand: settle from where the finger let go.
        const from = pointOnCircle(plan.from, ROUND_TABLE_SEAT_RADIUS);
        const landed = pointOnCircle(plan.mid, ROUND_TABLE_SEAT_RADIUS);
        const dropLeft = from.x + (table ? (drop.dx / table.width) * 100 : 0);
        const dropTop = from.y + (table ? (drop.dy / table.height) * 100 : 0);
        const settleEnd = turns ? (DROP_SETTLE_MS / duration) : 1;
        const settle: Keyframe[] = [
          { offset: 0, left: `${dropLeft}%`, top: `${dropTop}%`, transform: 'translate(-50%, -50%) scale(1.14)' },
          { offset: settleEnd, left: `${landed.x}%`, top: `${landed.y}%`, transform: 'translate(-50%, -50%) scale(1)' },
        ];
        if (turns) settle.push({ offset: swapEnd, left: `${landed.x}%`, top: `${landed.y}%`, transform: 'translate(-50%, -50%) scale(1)' });
        animation = element.animate([...settle, ...turn], {
          duration: turns ? duration : DROP_SETTLE_MS,
          easing: turns ? 'linear' : 'cubic-bezier(0.2, 0.8, 0.3, 1)',
        });
      } else {
        animation = element.animate([...arcKeyframes(plan.from, plan.mid, lane, 0, swapEnd), ...turn], { duration, easing: 'linear' });
      }
      if (inPair) {
        element.classList.add('swapping');
        const done = () => element.classList.remove('swapping');
        animation.addEventListener('finish', done);
        animation.addEventListener('cancel', done);
      }
    }
  }, [layoutSignature]);

  function commitSwap(firstPlayerId: string, secondPlayerId: string) {
    const order = ordered.map((player) => player.id);
    const firstIndex = order.indexOf(firstPlayerId);
    const secondIndex = order.indexOf(secondPlayerId);
    if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) return;
    [order[firstIndex], order[secondIndex]] = [order[secondIndex], order[firstIndex]];
    lastSwapRef.current = [firstPlayerId, secondPlayerId];
    setOptimistic({ base: baseSignature, order });
    onSwap(firstPlayerId, secondPlayerId);
  }

  function handleSeatClick(playerId: string) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!editable || busy) return;
    if (!selectedId) {
      setSelectedId(playerId);
      return;
    }
    if (selectedId !== playerId) commitSwap(selectedId, playerId);
    setSelectedId(undefined);
  }

  function seatUnderPointer(clientX: number, clientY: number, draggedId: string) {
    const table = tableRef.current?.getBoundingClientRect();
    if (!table) return undefined;
    const x = ((clientX - table.left) / table.width) * 100;
    const y = ((clientY - table.top) / table.height) * 100;
    let nearest: { id: string; distance: number } | undefined;
    ordered.forEach((player, index) => {
      if (player.id === draggedId) return;
      const point = pointOnCircle(angleFor(index), ROUND_TABLE_SEAT_RADIUS);
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= DROP_RADIUS && (!nearest || distance < nearest.distance)) nearest = { id: player.id, distance };
    });
    return nearest?.id;
  }

  function markDropTarget(targetId: string | undefined) {
    seatRefs.current.forEach((element, id) => element.classList.toggle('drop-target', id === targetId));
  }

  function resetDraggedSeat(id: string) {
    const element = seatRefs.current.get(id);
    if (!element) return;
    element.classList.remove('dragging');
    element.style.transform = '';
    markDropTarget(undefined);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>, playerId: string) {
    suppressClickRef.current = false;
    if (!editable || busy || (event.pointerType === 'mouse' && event.button !== 0)) return;
    dragRef.current = { id: playerId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0, active: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.dx = event.clientX - drag.startX;
    drag.dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(drag.dx, drag.dy) < DRAG_START_PX) return;
      drag.active = true;
      setSelectedId(undefined);
      seatRefs.current.get(drag.id)?.classList.add('dragging');
    }
    const element = seatRefs.current.get(drag.id);
    if (element) element.style.transform = `translate(calc(-50% + ${drag.dx}px), calc(-50% + ${drag.dy}px)) scale(1.14)`;
    drag.targetId = seatUnderPointer(event.clientX, event.clientY, drag.id);
    markDropTarget(drag.targetId);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (!drag.active) return;
    // The click that follows this pointerup belongs to the drag, not a tap.
    suppressClickRef.current = true;
    resetDraggedSeat(drag.id);
    if (drag.targetId && !busy) {
      lastDropRef.current = { id: drag.id, dx: drag.dx, dy: drag.dy };
      commitSwap(drag.id, drag.targetId);
      return;
    }
    snapBack(drag);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (!drag.active) return;
    resetDraggedSeat(drag.id);
    snapBack(drag);
  }

  function snapBack(drag: DragState) {
    const element = seatRefs.current.get(drag.id);
    if (!element?.animate || prefersReducedMotion()) return;
    element.animate([
      { transform: `translate(calc(-50% + ${drag.dx}px), calc(-50% + ${drag.dy}px)) scale(1.14)` },
      { transform: 'translate(-50%, -50%) scale(1)' },
    ], { duration: DROP_SETTLE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
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
    <div ref={tableRef} className={[
      'round-table',
      editable ? 'editable' : '',
      selectedId ? 'has-selection' : '',
      leader ? 'in-game' : '',
      revealedRoles ? 'has-roles' : '',
      count >= 8 ? 'many-seats' : '',
    ].filter(Boolean).join(' ')}>
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
          const mark = readyPlayerIds ? (ready ? 'done' : 'waiting') : seatMarks?.[player.id];
          const revealed = revealedRoles?.[player.id];
          const tag = seatTags?.[player.id];
          const className = [
            'round-table-seat',
            isMe ? 'me' : '',
            player.isAi ? 'ai' : '',
            player.id === leaderId ? 'leader' : '',
            teamIds.includes(player.id) ? 'on-team' : '',
            player.id === selectedId ? 'selected' : '',
            readyPlayerIds && !revealed ? (ready ? 'ready' : 'waiting') : '',
            revealed ? `revealed-${revealed.allegiance}` : '',
          ].filter(Boolean).join(' ');
          const markLabel = readyPlayerIds ? (ready ? t('Ready') : t('Waiting')) : mark === 'done' ? t('Done') : mark ? t('Waiting') : '';
          const roleLabel = revealed ? ` · ${formatRole(revealed.role, language)}` : '';
          const label = `${t('Seat')} ${index + 1}: ${player.displayName}${player.isHost ? ` (${t('Host')})` : ''}${roleLabel}${tag ? ` · ${tag}` : ''}${markLabel ? ` · ${markLabel}` : ''}`;
          const content = (
            <>
              {player.id === leaderId && <span className="seat-crown" aria-hidden="true">♛</span>}
              <span className="seat-avatar" aria-hidden="true">
                <span className="seat-initial">{player.isAi ? 'AI' : Array.from(player.displayName.trim())[0]?.toUpperCase() ?? '?'}</span>
                <span className="seat-number">{index + 1}</span>
                {mark && <span className={`seat-ready ${mark === 'done' ? 'on' : 'off'}`}>{mark === 'done' ? '✓' : ''}</span>}
                {player.isHost && <span className="seat-host">{t('Host')}</span>}
                {tag && <span className="seat-tag" aria-hidden="true">{t('✕')}</span>}
              </span>
              <span className="seat-name" aria-hidden="true">{isMe ? `${player.displayName} · ${t('You')}` : player.displayName}</span>
              {revealed && <span className={`seat-role ${revealed.allegiance}`} aria-hidden="true">{formatRole(revealed.role, language)}</span>}
            </>
          );
          return (
            <li
              key={player.id}
              ref={(node) => {
                if (node) seatRefs.current.set(player.id, node);
                else seatRefs.current.delete(player.id);
              }}
              className={className}
              style={{ ...positionFor(index), animationDelay: `${index * 45}ms` }}
            >
              {editable
                ? (
                  <button
                    type="button"
                    onClick={() => handleSeatClick(player.id)}
                    onPointerDown={(event) => handlePointerDown(event, player.id)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    disabled={busy}
                    aria-pressed={player.id === selectedId}
                    aria-label={label}
                  >
                    {content}
                  </button>
                )
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
          {selectedId ? t('Now tap the player to swap with.') : t('Tap two players, or drag one onto another, to swap seats.')}
        </p>
      )}
    </div>
  );
}
