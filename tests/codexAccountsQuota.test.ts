import { describe, expect, test } from 'bun:test';
import { quotaRowsFor, type QuotaRow, type QuotaState } from '../src/services/quotaService';
import {
  buildQuotaSummaries,
  classifyCodexWindows,
  classifyQuotaFailure,
  entryFromQuotaState,
  expiredCredentialEntry,
  findAccountFile,
  isQuotaFresh,
  isQuotaStale,
  quotaBlockReason,
  runWithConcurrency,
  selectRefreshTargets,
  staleAfterMs,
  type AccountQuotaEntry,
} from '../src/services/codexAccountsQuota';
import type { AccountView } from '../src/services/codexAccounts';

const row = (label: string, remainingPercent: number | null, windowSeconds?: number, extra: Partial<QuotaRow> = {}): QuotaRow =>
  ({ label, remainingPercent, windowSeconds, scope: 'main', resetAtMs: 1_800_000_000_000, ...extra });

const account = (key: string, extra: Partial<AccountView> = {}): AccountView => ({
  key, alias: key, email: null, plan: null, accountIdHint: 'acct…0001', sourceFile: `${key}.json`, connected: true,
  proxyDisabled: false, cpaCopy: 'same', validity: 'valid', accessExpiresAt: null, lastRefresh: null, activeNative: false,
  pinnedSlot: null, duplicateEmail: false, addedAt: 0, lastSyncedAt: 0, lastActivatedAt: null, ...extra,
});

const success = (rows: QuotaRow[], fetchedAt = 1_000_000): QuotaState => ({ status: 'success', rows, fetchedAt, plan: 'pro' });
const NOW = 2_000_000_000_000;

describe('classifyCodexWindows', () => {
  test('ranks windows by the provider-reported length, not by label or position', () => {
    const swapped = classifyCodexWindows([row('Weekly limit', 40, 604_800), row('5-hour limit', 90, 18_000)]);
    expect(swapped.short?.windowSeconds).toBe(18_000);
    expect(swapped.long?.windowSeconds).toBe(604_800);
    // Nothing is hardcoded to 5h/weekly: a 1h and a 30-day window classify the same way.
    const odd = classifyCodexWindows([row('A', 10, 3_600), row('B', 20, 2_592_000)]);
    expect([odd.short?.remainingPct, odd.long?.remainingPct]).toEqual([10, 20]);
  });

  test('a lone window is placed by its length; unknown length is neither', () => {
    expect(classifyCodexWindows([row('W', 50, 604_800)])).toMatchObject({ short: null, long: { remainingPct: 50 } });
    expect(classifyCodexWindows([row('H', 50, 3_600)])).toMatchObject({ short: { remainingPct: 50 }, long: null });
    const unknown = classifyCodexWindows([row('?', 50)]);
    expect(unknown.short).toBeNull();
    expect(unknown.long).toBeNull();
    expect(unknown.extra).toHaveLength(1);
  });

  test('falls back to provider order only when a length is missing; extras stay separate', () => {
    const ordered = classifyCodexWindows([row('first', 11), row('second', 22), row('Code review Weekly', 99, 604_800, { scope: 'extra' })]);
    expect(ordered.short?.label).toBe('first');
    expect(ordered.long?.label).toBe('second');
    expect(ordered.extra.map((window) => window.label)).toEqual(['Code review Weekly']);
  });

  test('works on real rows produced by the shared quota parser', () => {
    const rows = quotaRowsFor('codex', {
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
        secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: 1_900_100_000 },
      },
      code_review_rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604_800 } },
    });
    const windows = classifyCodexWindows(rows);
    expect(windows.short).toMatchObject({ remainingPct: 75, resetAtSec: 1_900_000_000, windowSeconds: 18_000 });
    expect(windows.long).toMatchObject({ remainingPct: 40, resetAtSec: 1_900_100_000 });
    expect(windows.extra).toHaveLength(1);
  });
});

describe('quota entries and summaries', () => {
  test('remaining percent is clamped and reset is unix seconds', () => {
    const entry = entryFromQuotaState(success([row('S', 100.04, 18_000), row('L', -3, 604_800)]), NOW);
    expect(entry.status).toBe('ok');
    expect(entry.short?.remainingPct).toBe(100);
    expect(entry.long?.remainingPct).toBe(0);
    expect(entry.short?.resetAtSec).toBe(1_800_000_000);
  });

  test('summary carries the real fetch time, not the publish time', () => {
    const entry = entryFromQuotaState(success([row('S', 70, 18_000), row('L', 55, 604_800)], 1_700_000_123_456), NOW);
    expect(buildQuotaSummaries([{ key: 'a' }], { a: entry })).toEqual([{
      key: 'a', status: 'ok', shortRemainingPct: 70, shortResetAt: 1_800_000_000,
      weeklyRemainingPct: 55, weeklyResetAt: 1_800_000_000, fetchedAt: 1_700_000_123,
    }]);
  });

  test('unavailable accounts publish nothing; auth and rate-limit failures publish status only', () => {
    const unavailable = entryFromQuotaState({ status: 'error', rows: [], error: 'socket hang up' }, NOW);
    const auth = entryFromQuotaState({ status: 'error', rows: [], error: 'Upstream returned 401 Unauthorized' }, NOW);
    const limited = entryFromQuotaState({ status: 'error', rows: [], error: 'HTTP 429 Too Many Requests' }, NOW);
    expect([unavailable.status, auth.status, limited.status]).toEqual(['unavailable', 'auth_error', 'rate_limited']);
    const summaries = buildQuotaSummaries(
      ['u', 'a', 'l', 'missing'].map((key) => ({ key })),
      { u: unavailable, a: auth, l: limited },
    );
    expect(summaries).toEqual([
      { key: 'a', status: 'auth_error', fetchedAt: NOW / 1000 },
      { key: 'l', status: 'rate_limited', fetchedAt: NOW / 1000 },
    ]);
    expect(summaries.every((summary) => !('shortRemainingPct' in summary))).toBe(true);
  });

  test('a failed refresh keeps the last good numbers at their real age', () => {
    const good = entryFromQuotaState(success([row('S', 70, 18_000), row('L', 55, 604_800)], NOW - 3_600_000), NOW - 3_600_000);
    const failed = entryFromQuotaState({ status: 'error', rows: [], error: 'timeout' }, NOW, good);
    expect(failed.status).toBe('unavailable');
    expect(failed.short?.remainingPct).toBe(70);
    const [summary] = buildQuotaSummaries([{ key: 'a' }], { a: failed });
    expect(summary).toMatchObject({ status: 'ok', fetchedAt: (NOW - 3_600_000) / 1000 });
  });

  test('success without any usable percentage is treated as unavailable', () => {
    const entry = entryFromQuotaState(success([row('S', null, 18_000)]), NOW);
    expect(entry.status).toBe('unavailable');
    expect(buildQuotaSummaries([{ key: 'a' }], { a: entry })).toEqual([]);
  });

  test('expired credentials publish an auth error without any request', () => {
    expect(buildQuotaSummaries([{ key: 'a' }], { a: expiredCredentialEntry(NOW) })).toEqual([
      { key: 'a', status: 'auth_error', fetchedAt: NOW / 1000 },
    ]);
  });

  test('only accounts that still exist are published', () => {
    const entry = entryFromQuotaState(success([row('S', 70, 18_000)]), NOW);
    expect(buildQuotaSummaries([{ key: 'kept' }], { kept: entry, removed: entry }).map((summary) => summary.key)).toEqual(['kept']);
  });
});

describe('failure classification', () => {
  test.each([
    ['Upstream returned 403 Forbidden', 'auth_error'],
    ['token expired, sign in again', 'auth_error'],
    ['rate limit exceeded', 'rate_limited'],
    ['request timed out', 'unavailable'],
    [undefined, 'unavailable'],
  ] as const)('%s -> %s', (message, expected) => {
    expect(classifyQuotaFailure(message)).toBe(expected);
  });
});

describe('freshness and refresh selection', () => {
  test('cache lifetime is honoured and stale means 2x lifetime with a 30 minute floor', () => {
    expect(isQuotaFresh(NOW - 14 * 60_000, 15, NOW)).toBe(true);
    expect(isQuotaFresh(NOW - 15 * 60_000, 15, NOW)).toBe(false);
    expect(isQuotaFresh(null, 15, NOW)).toBe(false);
    expect(staleAfterMs(60)).toBe(120 * 60_000);
    expect(staleAfterMs(5)).toBe(30 * 60_000);
    expect(isQuotaStale(NOW - 31 * 60_000, 5, NOW)).toBe(true);
    expect(isQuotaStale(NOW - 29 * 60_000, 5, NOW)).toBe(false);
    expect(isQuotaStale(null, 5, NOW)).toBe(false);
  });

  test('block reasons explain why an account cannot be queried', () => {
    const file = { name: 'a.json', auth_index: 'idx-1' };
    expect(quotaBlockReason(account('a'), file, true)).toBeNull();
    expect(quotaBlockReason(account('a', { connected: false, sourceFile: null }), undefined, true)).toBe('not_connected');
    expect(quotaBlockReason(account('a', { validity: 'expired' }), file, true)).toBe('expired');
    expect(quotaBlockReason(account('a', { proxyDisabled: true }), file, true)).toBe('proxy_disabled');
    expect(quotaBlockReason(account('a'), file, false)).toBe('core_offline');
    expect(quotaBlockReason(account('a'), undefined, true)).toBe('no_file');
    expect(quotaBlockReason(account('a'), { name: 'a.json' }, true)).toBe('no_auth_index');
  });

  test('joins accounts to credential files by file name', () => {
    const files = [{ name: 'Other.json' }, { name: 'a.json', auth_index: 'x' }];
    expect(findAccountFile({ sourceFile: 'a.json' }, files)).toBe(files[1]);
    expect(findAccountFile({ sourceFile: 'A.JSON' }, files)).toBe(files[1]);
    expect(findAccountFile({ sourceFile: null }, files)).toBeUndefined();
  });

  test('refreshes only missing or expired cache entries unless forced', () => {
    const accounts = [account('fresh'), account('old'), account('none'), account('dead', { validity: 'expired' }), account('off', { proxyDisabled: true })];
    const files = accounts.map((a) => ({ name: a.sourceFile, auth_index: `i-${a.key}` }));
    const ok = (ageMs: number): AccountQuotaEntry => ({ ...entryFromQuotaState(success([row('S', 50, 18_000)]), NOW - ageMs), fetchedAtMs: NOW - ageMs });
    const entries = { fresh: ok(60_000), old: ok(20 * 60_000) };
    const base = { accounts, files, entries, refreshMinutes: 15, nowMs: NOW, coreReady: true };
    expect(selectRefreshTargets({ ...base, force: false })).toEqual(['old', 'none']);
    expect(selectRefreshTargets({ ...base, force: true })).toEqual(['fresh', 'old', 'none']);
    expect(selectRefreshTargets({ ...base, force: true, only: ['none'] })).toEqual(['none']);
    expect(selectRefreshTargets({ ...base, force: true, coreReady: false })).toEqual([]);
  });

  test('a recent failed attempt backs off until the cache lifetime passes', () => {
    const failed: AccountQuotaEntry = { ...expiredCredentialEntry(NOW - 60_000), status: 'unavailable' };
    const options = { accounts: [account('a')], files: [{ name: 'a.json', auth_index: 'i' }], entries: { a: failed }, refreshMinutes: 15, coreReady: true, force: false };
    expect(selectRefreshTargets({ ...options, nowMs: NOW })).toEqual([]);
    expect(selectRefreshTargets({ ...options, nowMs: NOW + 15 * 60_000 })).toEqual(['a']);
  });
});

describe('runWithConcurrency', () => {
  test('never exceeds the limit and survives failing workers', async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--; done.push(item);
      if (item === 2) throw new Error('boom');
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
