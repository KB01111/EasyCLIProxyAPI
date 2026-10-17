import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  codexAccountsApi,
  errorText,
  type AccountsSnapshot,
  type Recommendation,
} from '../../services/codexAccounts';
import {
  buildQuotaSummaries,
  entryFromQuotaState,
  expiredCredentialEntry,
  findAccountFile,
  runWithConcurrency,
  selectRefreshTargets,
  type AccountQuotaEntry,
} from '../../services/codexAccountsQuota';
import { dedupeAuthFiles, type AuthFileRecord } from '../../services/authFiles';
import { managementApi, responseList } from '../../services/managementApi';
import { getQuotaCacheSnapshot, captureQuotaCacheGeneration } from '../../services/quotaCache';
import { commitFetchedQuota } from '../../services/quotaEnrichment';
import { loadQuota, quotaKey } from '../../services/quotaService';

const QUOTA_CONCURRENCY = 3;
const PUBLISH_DEBOUNCE_MS = 250;
const FILES_MIN_GAP_MS = 3_000;

export type FilesState = 'loading' | 'ready' | 'error' | 'offline';
type RefreshOptions = { force: boolean; only?: readonly string[] };

/**
 * Quota for the Account Center. It joins accounts to core credentials by file name, fetches
 * through the existing quota service (tokens never reach the webview), keeps results in
 * the page state with stale-while-revalidate semantics, and publishes safe summaries to
 * the backend. There are no timers other than a short publish debounce.
 */
export function useCodexAccountQuota(snapshot: AccountsSnapshot | null, coreReady: boolean) {
  const [files, setFiles] = useState<AuthFileRecord[]>([]);
  const [filesState, setFilesState] = useState<FilesState>('loading');
  const [filesError, setFilesError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, AccountQuotaEntry>>({});
  const [loadingKeys, setLoadingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);

  const snapshotRef = useRef(snapshot);
  const coreReadyRef = useRef(coreReady);
  const filesRef = useRef<AuthFileRecord[]>([]);
  const entriesRef = useRef<Record<string, AccountQuotaEntry>>({});
  const filesLoadedAt = useRef(0);
  const filesRequest = useRef<Promise<AuthFileRecord[]> | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const queued = useRef<RefreshOptions | null>(null);
  const lastPublished = useRef('');
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  snapshotRef.current = snapshot;
  coreReadyRef.current = coreReady;

  const commitEntries = useCallback((update: (current: Record<string, AccountQuotaEntry>) => Record<string, AccountQuotaEntry>) => {
    entriesRef.current = update(entriesRef.current);
    if (mounted.current) setEntries(entriesRef.current);
  }, []);

  const publish = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current || !mounted.current) return;
    const summaries = buildQuotaSummaries(current.accounts, entriesRef.current);
    const signature = JSON.stringify(summaries);
    if (signature === lastPublished.current) return;
    // Publishing an empty list on first load would wipe fresher data the backend already holds.
    if (summaries.length === 0 && lastPublished.current === '') return;
    lastPublished.current = signature;
    try {
      const next = await codexAccountsApi.publishQuota(summaries);
      if (mounted.current) setRecommendation(next);
    } catch {
      lastPublished.current = '';
    }
  }, []);

  const schedulePublish = useCallback(() => {
    clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => void publish(), PUBLISH_DEBOUNCE_MS);
  }, [publish]);

  const reloadFiles = useCallback(async (): Promise<AuthFileRecord[]> => {
    if (!coreReadyRef.current) {
      filesRef.current = [];
      if (mounted.current) { setFiles([]); setFilesState('offline'); setFilesError(null); }
      return [];
    }
    if (filesRequest.current) return filesRequest.current;
    const request = (async () => {
      try {
        const payload = await managementApi.get('/credentials');
        const list = dedupeAuthFiles(responseList(payload, 'files'));
        filesRef.current = list;
        filesLoadedAt.current = Date.now();
        if (mounted.current) { setFiles(list); setFilesState('ready'); setFilesError(null); }
        return list;
      } catch (failure) {
        if (mounted.current) { setFilesState('error'); setFilesError(errorText(failure)); }
        return filesRef.current;
      } finally {
        filesRequest.current = null;
      }
    })();
    filesRequest.current = request;
    return request;
  }, []);

  const execute = useCallback(async ({ force, only }: RefreshOptions) => {
    const current = snapshotRef.current;
    if (!current) return;
    const nowMs = Date.now();
    const ready = coreReadyRef.current;
    // Seed from the shared quota cache (other pages may already have fetched), then
    // mark credentials without usable tokens; neither needs a request.
    const cache = getQuotaCacheSnapshot();
    const seeded: Record<string, AccountQuotaEntry> = { ...entriesRef.current };
    for (const account of current.accounts) {
      if (account.validity === 'expired') {
        if (seeded[account.key]?.status !== 'auth_error') seeded[account.key] = expiredCredentialEntry(nowMs);
        continue;
      }
      if (seeded[account.key]) continue;
      const file = findAccountFile(account, filesRef.current);
      const cached = file ? cache[quotaKey(file)] : undefined;
      if (cached?.status === 'success') seeded[account.key] = entryFromQuotaState(cached, cached.fetchedAt ?? nowMs);
    }
    commitEntries(() => seeded);
    const targets = selectRefreshTargets({
      accounts: current.accounts,
      files: filesRef.current,
      entries: seeded,
      refreshMinutes: current.settings.refreshMinutes,
      nowMs,
      coreReady: ready,
      force,
      only,
    });
    if (targets.length) {
      setLoadingKeys((keys) => new Set([...keys, ...targets]));
      const generation = captureQuotaCacheGeneration();
      await runWithConcurrency(targets, QUOTA_CONCURRENCY, async (key) => {
        const account = current.accounts.find((candidate) => candidate.key === key);
        const file = account ? findAccountFile(account, filesRef.current) : undefined;
        if (!account || !file) return;
        try {
          const state = await loadQuota(file);
          commitFetchedQuota(generation, file, state);
          const finishedAt = Date.now();
          commitEntries((existing) => ({ ...existing, [key]: entryFromQuotaState(state, finishedAt, existing[key]) }));
        } finally {
          if (mounted.current) {
            setLoadingKeys((keys) => { const next = new Set(keys); next.delete(key); return next; });
          }
          schedulePublish();
        }
      });
    }
    clearTimeout(publishTimer.current);
    await publish();
  }, [commitEntries, publish, schedulePublish]);

  /** Serialises refreshes; a request that arrives mid-run runs once more afterwards. */
  const refreshQuota = useCallback(async (options: RefreshOptions) => {
    if (running.current) {
      queued.current = queued.current
        ? { force: queued.current.force || options.force, only: queued.current.only && options.only ? [...queued.current.only, ...options.only] : undefined }
        : options;
      return running.current;
    }
    const run = (async () => {
      let next: RefreshOptions | null = options;
      while (next) {
        queued.current = null;
        await execute(next);
        next = queued.current;
      }
    })().finally(() => { running.current = null; });
    running.current = run;
    return run;
  }, [execute]);

  const refreshAll = useCallback(async (force: boolean) => {
    await reloadFiles();
    await refreshQuota({ force });
  }, [refreshQuota, reloadFiles]);

  const refreshOne = useCallback(async (key: string) => {
    await reloadFiles();
    await refreshQuota({ force: true, only: [key] });
  }, [refreshQuota, reloadFiles]);

  // Refresh when the account set or the cache lifetime changes (this includes page open).
  const signature = useMemo(() => snapshot
    ? `${snapshot.settings.refreshMinutes}|${coreReady}|${snapshot.accounts.map((account) =>
      [account.key, account.sourceFile, account.connected, account.proxyDisabled, account.validity].join(':')).join(',')}`
    : '', [snapshot, coreReady]);
  useEffect(() => {
    if (!signature) return;
    void refreshAll(false);
  }, [signature, refreshAll]);

  // Refresh on window focus, but only data that is no longer fresh.
  useEffect(() => {
    const onFocus = () => {
      if (!snapshotRef.current) return;
      if (Date.now() - filesLoadedAt.current < FILES_MIN_GAP_MS) void refreshQuota({ force: false });
      else void refreshAll(false);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshAll, refreshQuota]);

  // The recommendation depends on the pinned pair and settings as well as on quota.
  const primaryKey = snapshot?.pinned.primary ?? null;
  const secondaryKey = snapshot?.pinned.secondary ?? null;
  const recommendationsOn = snapshot?.settings.recommendations ?? true;
  const refreshMinutes = snapshot?.settings.refreshMinutes ?? 0;
  const hasSnapshot = snapshot !== null;
  useEffect(() => {
    if (!hasSnapshot) return;
    void codexAccountsApi.recommendation().then((next) => { if (mounted.current) setRecommendation(next); }).catch(() => undefined);
  }, [hasSnapshot, primaryKey, secondaryKey, recommendationsOn, refreshMinutes]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(publishTimer.current); };
  }, []);

  return { files, filesState, filesError, entries, loadingKeys, recommendation, reloadFiles, refreshAll, refreshOne };
}
