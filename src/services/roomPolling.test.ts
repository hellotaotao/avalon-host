import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOM_POLL_INTERVAL_MS, subscribeByPolling, type PollingEnvironment } from './roomService';
import type { RoomSnapshot } from './roomService';

function makeEnvironment() {
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const fakeDocument = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  };
  const fakeWindow = {
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  };
  return {
    environment: { document: fakeDocument, window: fakeWindow } as unknown as PollingEnvironment,
    fakeDocument,
    showPage: () => documentEvents.dispatchEvent(new Event('visibilitychange')),
    focusWindow: () => windowEvents.dispatchEvent(new Event('focus')),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const snapshot = { room: { id: 'room-1' }, players: [] } as unknown as RoomSnapshot;

describe('room polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops an answer that arrives after unsubscribing', async () => {
    const pending = deferred<RoomSnapshot | undefined>();
    const listener = vi.fn();
    const { environment } = makeEnvironment();
    const unsubscribe = subscribeByPolling(() => pending.promise, listener, environment);

    // The player leaves or switches rooms while the first poll is in flight.
    unsubscribe();
    pending.resolve(snapshot);
    await vi.runAllTimersAsync();

    expect(listener).not.toHaveBeenCalled();
  });

  it('polls right away when the page comes back into view, without waiting for the next tick', async () => {
    const load = vi.fn().mockResolvedValue(snapshot);
    const { environment, showPage } = makeEnvironment();
    const unsubscribe = subscribeByPolling(load, vi.fn(), environment);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    showPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('does not poll on a visibility change that hides the page', async () => {
    const load = vi.fn().mockResolvedValue(snapshot);
    const { environment, fakeDocument, showPage } = makeEnvironment();
    const unsubscribe = subscribeByPolling(load, vi.fn(), environment);
    await vi.advanceTimersByTimeAsync(0);

    fakeDocument.visibilityState = 'hidden';
    showPage();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('runs one request at a time when focus and visibility fire together', async () => {
    const pending = deferred<RoomSnapshot | undefined>();
    const load = vi.fn().mockReturnValueOnce(Promise.resolve(snapshot)).mockReturnValue(pending.promise);
    const { environment, showPage, focusWindow } = makeEnvironment();
    const unsubscribe = subscribeByPolling(load, vi.fn(), environment);
    await vi.advanceTimersByTimeAsync(0);

    showPage();
    focusWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    pending.resolve(snapshot);
    unsubscribe();
  });

  it('keeps polling through failed requests and stops after unsubscribing', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(snapshot);
    const listener = vi.fn();
    const { environment } = makeEnvironment();
    const unsubscribe = subscribeByPolling(load, listener, environment);

    await vi.advanceTimersByTimeAsync(ROOM_POLL_INTERVAL_MS);
    expect(listener).toHaveBeenCalledWith(snapshot);

    unsubscribe();
    const callsAtStop = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ROOM_POLL_INTERVAL_MS * 3);
    expect(load).toHaveBeenCalledTimes(callsAtStop);
  });
});
