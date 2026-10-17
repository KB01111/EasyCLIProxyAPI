import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CODEX_ACCOUNTS_EVENTS,
  codexAccountsApi,
  errorText,
  listenCodexAccountsEvent,
  shareSnapshotStructure,
  type AccountsSnapshot,
  type RunningCodex,
} from '../../services/codexAccounts';

const FOCUS_REFRESH_MIN_GAP_MS = 2_000;
const EVENT_DEBOUNCE_MS = 150;

export type ProcessScan = { list: RunningCodex[]; at: number };

/**
 * Loads the account snapshot. It refreshes on mount, on window focus and when the
 * backend reports a change; there is no polling timer. Process scans (not free) run
 * only on mount and on an explicit refresh while the page is visible.
 */
export function useCodexAccounts(onRefreshRequest?: () => void) {
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<ProcessScan | null>(null);
  const sequence = useRef(0);
  const lastLoadedAt = useRef(0);
  const mounted = useRef(true);
  const refreshRequest = useRef(onRefreshRequest);
  refreshRequest.current = onRefreshRequest;

  const refresh = useCallback(async (includeProcesses = false): Promise<AccountsSnapshot | null> => {
    const id = ++sequence.current;
    try {
      const next = await codexAccountsApi.getState(includeProcesses && document.visibilityState !== 'hidden');
      if (!mounted.current || id !== sequence.current) return null;
      lastLoadedAt.current = Date.now();
      setSnapshot((previous) => shareSnapshotStructure(previous, next));
      if (next.native.running) setScan({ list: next.native.running, at: Date.now() });
      setError(null);
      return next;
    } catch (failure) {
      if (mounted.current && id === sequence.current) setError(errorText(failure));
      return null;
    } finally {
      if (mounted.current && id === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const stopChanged = listenCodexAccountsEvent(CODEX_ACCOUNTS_EVENTS.changed, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(false), EVENT_DEBOUNCE_MS);
    });
    const stopRefresh = listenCodexAccountsEvent(CODEX_ACCOUNTS_EVENTS.refreshRequest, () => {
      refreshRequest.current?.();
    });
    const onFocus = () => {
      if (Date.now() - lastLoadedAt.current < FOCUS_REFRESH_MIN_GAP_MS) return;
      void refresh(false);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      clearTimeout(debounce);
      stopChanged();
      stopRefresh();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { snapshot, loading, error, scan, refresh };
}
