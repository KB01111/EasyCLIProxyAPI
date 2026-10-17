import { useSyncExternalStore } from 'react';

// One shared 30-second ticker for every countdown on the page. It only runs while
// something is subscribed and the document is visible, so a hidden window does no work.
const TICK_MS = 30_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

const tick = () => {
  now = Date.now();
  listeners.forEach((notify) => notify());
};

const sync = () => {
  const shouldRun = listeners.size > 0 && visible();
  if (shouldRun && !timer) {
    tick();
    timer = setInterval(tick, TICK_MS);
  } else if (!shouldRun && timer) {
    clearInterval(timer);
    timer = undefined;
  }
};

const onVisibility = () => sync();

const subscribe = (listener: () => void) => {
  if (listeners.size === 0 && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    sync();
  };
};

/** Current time in ms, refreshed every 30 seconds while the page is visible. */
export const useNowTick = () => useSyncExternalStore(subscribe, () => now, () => now);
