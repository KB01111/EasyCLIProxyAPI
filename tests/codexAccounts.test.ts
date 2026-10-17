import { describe, expect, test } from 'bun:test';
import {
  acceleratorFromKeyEvent, computePinned, createSettingsWriter, isVaultError, nativeSwitchBlockReason, shareSnapshotStructure,
  splitDuration, summarizeHealth, switchDisabledReason, type AccountView, type AccountsSnapshot,
} from '../src/services/codexAccounts';
import { createCodexAccountsMock } from '../src/mocks/codexAccountsMock';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';

const view = (key: string, extra: Partial<AccountView> = {}): AccountView => ({
  key, alias: key, email: null, plan: null, accountIdHint: 'acct…0001', sourceFile: null, connected: true, proxyDisabled: false,
  cpaCopy: 'same', validity: 'valid', accessExpiresAt: null, lastRefresh: null, activeNative: false, pinnedSlot: null,
  duplicateEmail: false, addedAt: 0, lastSyncedAt: 0, lastActivatedAt: null, ...extra,
});

const snapshot = (accounts: AccountView[], extra: Partial<AccountsSnapshot> = {}): AccountsSnapshot => ({
  accounts, pinned: { primary: null, secondary: null }, activeNative: null,
  native: { live: 'managed', unmanaged: null, credentialStore: { mode: 'file', supported: true, detail: '' }, authPath: '', error: null, running: null },
  desktop: { status: 'unverified', note: 'n' }, settings: { refreshMinutes: 15, hotkey: null, notifications: false, recommendations: true },
  lastSwitch: null, externalChange: null, recovery: null, issues: [], protection: 'windows-dpapi', generatedAt: 1, ...extra,
});

describe('pinning', () => {
  const pair = { primary: 'a', secondary: 'b' };
  test('pinning into an occupied slot replaces it; the other slot swaps', () => {
    expect(computePinned(pair, 'c', 'primary')).toEqual({ primary: 'c', secondary: 'b' });
    expect(computePinned(pair, 'b', 'primary')).toEqual({ primary: 'b', secondary: 'a' });
    expect(computePinned(pair, 'a', 'primary')).toEqual(pair);
    expect(computePinned({ primary: null, secondary: 'b' }, 'b', 'primary')).toEqual({ primary: 'b', secondary: null });
  });
  test('unpin clears only that account', () => {
    expect(computePinned(pair, 'a', 'unpin')).toEqual({ primary: null, secondary: 'b' });
    expect(computePinned(pair, 'zzz', 'unpin')).toEqual(pair);
  });
});

describe('state helpers', () => {
  test('health counts, vault errors and switch gating', () => {
    expect(summarizeHealth([view('a'), view('b', { validity: 'refreshable' }), view('c', { validity: 'expired' }), view('d')])).toEqual({ valid: 2, refreshable: 1, expired: 1 });
    expect(isVaultError('The Codex account vault could not be decrypted')).toBe(true);
    expect(isVaultError('Failed to read config')).toBe(false);
    const active = view('a', { activeNative: true });
    const expired = view('x', { validity: 'expired' });
    const base = snapshot([active, expired]);
    expect(switchDisabledReason(active, base)).toBe('active');
    expect(switchDisabledReason(expired, base)).toBe('expired');
    expect(switchDisabledReason(view('ok'), base)).toBeNull();
    const apiKey = snapshot([], { native: { ...base.native, live: 'api_key' } });
    expect(nativeSwitchBlockReason(apiKey)).toBe('api_key');
    const keyring = snapshot([], { native: { ...base.native, credentialStore: { mode: 'keyring', supported: false, detail: '' } } });
    expect(switchDisabledReason(view('ok'), keyring)).toBe('unsupported_store');
  });

  test('structural sharing keeps unchanged accounts identical across refreshes', () => {
    const first = snapshot([view('a'), view('b')]);
    const second = shareSnapshotStructure(first, snapshot([view('a'), view('b', { alias: 'renamed' })], { generatedAt: 2 }));
    expect(second.accounts[0]).toBe(first.accounts[0]);
    expect(second.accounts[1]).not.toBe(first.accounts[1]);
    expect(second.settings).toBe(first.settings);
    const same = shareSnapshotStructure(first, snapshot([view('a'), view('b')], { generatedAt: 3 }));
    expect(same.accounts).toBe(first.accounts);
  });

  test('countdown parts and accelerator recording', () => {
    expect(splitDuration(((2 * 24 + 3) * 60 + 5) * 60_000 + 59_000)).toEqual({ days: 2, hours: 3, minutes: 5 });
    expect(splitDuration(-5)).toEqual({ days: 0, hours: 0, minutes: 0 });
    const key = (code: string, extra: Record<string, boolean> = {}) => acceleratorFromKeyEvent({
      key: code, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra,
    });
    expect(key('F9', { ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+F9');
    expect(key('KeyK', { ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+K');
    expect(acceleratorFromKeyEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull();
  });
});

describe('settings writer', () => {
  const base = { refreshMinutes: 15, hotkey: null, notifications: false, recommendations: true };

  test('quick successive changes are serialised and never overwrite each other', async () => {
    const written: unknown[] = [];
    const writer = createSettingsWriter(async (settings) => {
      await new Promise((resolve) => setTimeout(resolve, written.length === 0 ? 20 : 1));
      written.push(settings);
      return settings;
    });
    writer.sync(base);
    const results = await Promise.all([writer.save({ notifications: true }), writer.save({ recommendations: false })]);
    expect(results).toEqual([null, null]);
    expect(written).toEqual([
      { ...base, notifications: true },
      { ...base, notifications: true, recommendations: false },
    ]);
  });

  test('a rejected write reports the error and the next write starts from the last saved value', async () => {
    let calls = 0;
    const writer = createSettingsWriter(async (settings) => {
      if (++calls === 1) throw new Error('shortcut in use');
      return settings;
    });
    writer.sync(base);
    expect(await writer.save({ hotkey: 'Ctrl+Alt+F1' })).toBe('shortcut in use');
    expect(await writer.save({ notifications: true })).toBeNull();
    writer.sync({ ...base, refreshMinutes: 30 });
    let sent: unknown;
    const second = createSettingsWriter(async (settings) => { sent = settings; return settings; });
    expect(await second.save({ notifications: true })).toMatch(/not loaded/);
    second.sync(base);
    await second.save({ refreshMinutes: 5 });
    expect(sent).toEqual({ ...base, refreshMinutes: 5 });
  });
});

describe('backend contract additions in the mock', () => {
  test('recovery can be deferred and unknown block codes are passed through', async () => {
    const deferred = createCodexAccountsMock({ authFiles: [] }, new Set(['recovery_deferred']));
    const state = (deferred.handle('codex_accounts_get_state', { includeProcesses: false }) as { value: AccountsSnapshot }).value;
    expect(state.recovery?.outcome).toBe('deferred');
    const blocked = createCodexAccountsMock({ authFiles: [] }, new Set(['block-live_conflict']));
    expect(blocked.handle('codex_accounts_switch', { key: 'cx_mock_home' })).toMatchObject({ value: { status: 'blocked', code: 'live_conflict' } });
  });
});

describe('browser mock for codex_accounts_* commands', () => {
  test('serves realistic synthetic state and keeps the five states distinct', async () => {
    const runtime = createBrowserMockRuntime('running');
    const state = await runtime.invoke('codex_accounts_get_state', { includeProcesses: false }) as AccountsSnapshot;
    expect(state.accounts).toHaveLength(3);
    expect(state.pinned).toEqual({ primary: 'cx_mock_work', secondary: 'cx_mock_home' });
    expect(state.desktop.status).toBe('unverified');
    expect(state.native.running).toBeNull();
    expect(state.accounts.filter((account) => account.validity === 'expired')).toHaveLength(1);
    expect(JSON.stringify(state)).not.toMatch(/token|eyJ/i);
    const switched = await runtime.invoke('codex_accounts_switch', { key: 'cx_mock_home' }) as { status: string; timings: unknown };
    expect(switched.status).toBe('switched');
    expect(switched.timings).not.toBeNull();
    const after = await runtime.invoke('codex_accounts_get_state', { includeProcesses: true }) as AccountsSnapshot;
    expect(after.activeNative).toBe('cx_mock_home');
    expect(after.native.running).toEqual([]);
    expect(await runtime.invoke('codex_accounts_switch', { key: 'cx_mock_reserve' })).toMatchObject({ status: 'blocked', code: 'target_expired' });
    await expect(runtime.invoke('codex_accounts_update_settings', { settings: { ...after.settings, hotkey: 'Ctrl+F9' } })).rejects.toThrow(/two modifier/);
  });

  test('recommendation follows the published summaries', async () => {
    const runtime = createBrowserMockRuntime('running');
    expect(await runtime.invoke('codex_accounts_recommendation')).toMatchObject({ code: 'data_missing' });
    const fetchedAt = Math.floor(Date.now() / 1000);
    const result = await runtime.invoke('codex_accounts_publish_quota', { summaries: [
      { key: 'cx_mock_work', shortRemainingPct: 70, weeklyRemainingPct: 60, fetchedAt, status: 'ok' },
      { key: 'cx_mock_home', shortRemainingPct: 10, weeklyRemainingPct: 80, fetchedAt, status: 'ok' },
    ] });
    expect(result).toEqual({ recommended: 'cx_mock_work', primaryPct: 60, secondaryPct: 10, code: 'more_capacity' });
  });
});
