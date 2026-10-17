import { authFileName, type AuthFileRecord } from './authFiles';
import { normalizeAuthIndex } from './managementApi';
import type { QuotaRow, QuotaState } from './quotaService';
import type { AccountView, QuotaSummary } from './codexAccounts';

// Pure helpers that turn the shared quota service output into per-account entries
// and the safe numeric summaries published to the Rust side. Nothing here fetches.

/** A lone window shorter than this is "short-term"; windows are otherwise ranked by reported length. */
export const SHORT_WINDOW_MAX_SECONDS = 86_400;
/** The backend never trusts quota older than this, whatever the refresh setting. */
export const MIN_STALE_MS = 30 * 60_000;

export type QuotaEntryStatus = 'ok' | 'rate_limited' | 'auth_error' | 'unavailable';

export type QuotaWindow = {
  label: string;
  /** Remaining quota, 0..100; null when the provider did not report a usable value. */
  remainingPct: number | null;
  resetAtSec: number | null;
  windowSeconds: number | null;
};

export type ClassifiedWindows = {
  short: QuotaWindow | null;
  long: QuotaWindow | null;
  extra: QuotaWindow[];
};

export type AccountQuotaEntry = ClassifiedWindows & {
  /** Outcome of the latest attempt. Windows below are retained from the last success. */
  status: QuotaEntryStatus;
  plan?: string;
  /** Real time of the last successful fetch; null when never fetched. */
  fetchedAtMs: number | null;
  attemptedAtMs: number;
  error?: string;
};

const clampPct = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
    : null;

export function windowFromRow(row: QuotaRow): QuotaWindow {
  return {
    label: row.label,
    remainingPct: clampPct(row.remainingPercent),
    resetAtSec: typeof row.resetAtMs === 'number' && Number.isFinite(row.resetAtMs)
      ? Math.floor(row.resetAtMs / 1000) : null,
    windowSeconds: typeof row.windowSeconds === 'number' && row.windowSeconds > 0 ? row.windowSeconds : null,
  };
}

/**
 * Split the account's own rate-limit windows into short-term and long-term using the
 * window lengths the provider reported (never a hardcoded 5h/weekly). Only when a
 * length is missing does provider order decide (first = shorter), mirroring the
 * existing quota labels. Code-review and add-on limits are returned as `extra`.
 */
export function classifyCodexWindows(rows: readonly QuotaRow[]): ClassifiedWindows {
  const main = rows.filter((row) => row.scope !== 'extra').map(windowFromRow);
  const extra = rows.filter((row) => row.scope === 'extra').map(windowFromRow);
  if (main.length === 0) return { short: null, long: null, extra };
  if (main.length === 1) {
    const [only] = main;
    if (only.windowSeconds === null) return { short: null, long: null, extra: [only, ...extra] };
    return only.windowSeconds <= SHORT_WINDOW_MAX_SECONDS
      ? { short: only, long: null, extra }
      : { short: null, long: only, extra };
  }
  const [first, second, ...rest] = main;
  const known = first.windowSeconds !== null && second.windowSeconds !== null;
  const swap = known && first.windowSeconds! > second.windowSeconds!;
  const [short, long] = swap ? [second, first] : [first, second];
  return { short, long, extra: [...rest, ...extra] };
}

/** Maps a quota error message to the status published to the backend. */
export function classifyQuotaFailure(message: string | undefined): QuotaEntryStatus {
  const text = message ?? '';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]?(grant|token)|token[^.]{0,40}(expired|invalid|revoked)|expired|re-?auth|sign in again/i.test(text)) {
    return 'auth_error';
  }
  if (/\b429\b|rate[- ]?limit|too many requests/i.test(text)) return 'rate_limited';
  return 'unavailable';
}

/**
 * Entry for a finished quota attempt. A failed refresh keeps the previous windows
 * (stale-while-revalidate) but reports the failure status and error.
 */
export function entryFromQuotaState(
  state: QuotaState,
  nowMs: number,
  previous?: AccountQuotaEntry,
): AccountQuotaEntry {
  if (state.status === 'success') {
    const windows = classifyCodexWindows(state.rows);
    const hasValue = [windows.short, windows.long, ...windows.extra].some((w) => w?.remainingPct != null);
    return {
      ...windows,
      status: hasValue ? 'ok' : 'unavailable',
      plan: state.plan,
      fetchedAtMs: state.fetchedAt ?? nowMs,
      attemptedAtMs: nowMs,
      error: hasValue ? undefined : state.error,
    };
  }
  const status = classifyQuotaFailure(state.error);
  return {
    short: previous?.short ?? null,
    long: previous?.long ?? null,
    extra: previous?.extra ?? [],
    plan: previous?.plan,
    fetchedAtMs: previous?.fetchedAtMs ?? null,
    status,
    attemptedAtMs: nowMs,
    error: state.error,
  };
}

/** Credential with no usable tokens: the backend already knows it cannot authenticate. */
export const expiredCredentialEntry = (nowMs: number): AccountQuotaEntry => ({
  short: null, long: null, extra: [], status: 'auth_error', fetchedAtMs: null, attemptedAtMs: nowMs,
});

const toSummary = (key: string, entry: AccountQuotaEntry): QuotaSummary | null => {
  if (entry.status === 'auth_error' || entry.status === 'rate_limited') {
    return { key, status: entry.status, fetchedAt: Math.floor(entry.attemptedAtMs / 1000) };
  }
  // 'ok' or an unavailable refresh that still holds the last good numbers (kept at its real age).
  if (entry.fetchedAtMs === null || (entry.short === null && entry.long === null)) return null;
  const short = entry.short;
  const long = entry.long;
  if (short?.remainingPct == null && long?.remainingPct == null) return null;
  return {
    key,
    status: 'ok',
    shortRemainingPct: short?.remainingPct ?? null,
    shortResetAt: short?.resetAtSec ?? null,
    weeklyRemainingPct: long?.remainingPct ?? null,
    weeklyResetAt: long?.resetAtSec ?? null,
    fetchedAt: Math.floor(entry.fetchedAtMs / 1000),
  };
};

/**
 * Summaries for every known account. The backend replaces its whole list on each
 * publish, so this always covers all accounts with data. Unavailable accounts publish nothing.
 */
export function buildQuotaSummaries(
  accounts: readonly Pick<AccountView, 'key'>[],
  entries: Readonly<Record<string, AccountQuotaEntry | undefined>>,
): QuotaSummary[] {
  return accounts.flatMap((account) => {
    const entry = entries[account.key];
    const summary = entry ? toSummary(account.key, entry) : null;
    return summary ? [summary] : [];
  });
}

export const staleAfterMs = (refreshMinutes: number): number =>
  Math.max(refreshMinutes * 2 * 60_000, MIN_STALE_MS);

export const isQuotaFresh = (fetchedAtMs: number | null, refreshMinutes: number, nowMs: number): boolean =>
  fetchedAtMs !== null && nowMs - fetchedAtMs < refreshMinutes * 60_000;

/** Same threshold as the backend's `data_stale`: 2x the cache lifetime, at least 30 minutes. */
export const isQuotaStale = (fetchedAtMs: number | null, refreshMinutes: number, nowMs: number): boolean =>
  fetchedAtMs !== null && nowMs - fetchedAtMs > staleAfterMs(refreshMinutes);

export type QuotaBlockReason =
  | 'core_offline' | 'not_connected' | 'proxy_disabled' | 'expired' | 'no_file' | 'no_auth_index' | null;

/** Why this account cannot be queried through the core right now (null = queryable). */
export function quotaBlockReason(
  account: AccountView,
  file: AuthFileRecord | undefined,
  coreReady: boolean,
): QuotaBlockReason {
  if (!account.connected || !account.sourceFile) return 'not_connected';
  if (account.validity === 'expired') return 'expired';
  if (account.proxyDisabled) return 'proxy_disabled';
  if (!coreReady) return 'core_offline';
  if (!file) return 'no_file';
  if (!normalizeAuthIndex(file.auth_index ?? file.authIndex)) return 'no_auth_index';
  return null;
}

/** Joins an account to its core credential by file name (case-insensitive fallback for Windows). */
export function findAccountFile(
  account: Pick<AccountView, 'sourceFile'>,
  files: readonly AuthFileRecord[],
): AuthFileRecord | undefined {
  const name = account.sourceFile;
  if (!name) return undefined;
  return files.find((file) => authFileName(file) === name)
    ?? files.find((file) => authFileName(file).toLowerCase() === name.toLowerCase());
}

/** Accounts whose cached quota is missing or older than the configured cache lifetime. */
export function selectRefreshTargets(options: {
  accounts: readonly AccountView[];
  files: readonly AuthFileRecord[];
  entries: Readonly<Record<string, AccountQuotaEntry | undefined>>;
  refreshMinutes: number;
  nowMs: number;
  coreReady: boolean;
  force: boolean;
  only?: readonly string[];
}): string[] {
  const { accounts, files, entries, refreshMinutes, nowMs, coreReady, force, only } = options;
  return accounts.flatMap((account) => {
    if (only && !only.includes(account.key)) return [];
    if (quotaBlockReason(account, findAccountFile(account, files), coreReady) !== null) return [];
    const entry = entries[account.key];
    if (!force && entry && entry.status === 'ok' && isQuotaFresh(entry.fetchedAtMs, refreshMinutes, nowMs)) return [];
    // Back off from a failed attempt for the cache lifetime instead of retrying on every focus.
    if (!force && entry && entry.status !== 'ok' && nowMs - entry.attemptedAtMs < refreshMinutes * 60_000) return [];
    return [account.key];
  });
}

/** Runs `worker` over `items` with at most `limit` in flight. Never rejects. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch { /* each worker reports its own failure */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
}
