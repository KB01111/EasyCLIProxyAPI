import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Types mirror "Appendix A - Backend command contract" in
// docs/CODEX_ACCOUNT_CENTER_PLAN.md. None of them can carry token material.

export type Validity = 'valid' | 'refreshable' | 'expired';
export type CpaCopy = 'same' | 'vault_newer' | 'conflict' | 'missing';
export type PinnedSlot = 'primary' | 'secondary';

export interface AccountView {
  key: string;
  alias: string;
  email: string | null;
  plan: string | null;
  accountIdHint: string;
  sourceFile: string | null;
  connected: boolean;
  proxyDisabled: boolean | null;
  cpaCopy: CpaCopy;
  validity: Validity;
  accessExpiresAt: number | null;
  lastRefresh: string | null;
  activeNative: boolean;
  pinnedSlot: PinnedSlot | null;
  duplicateEmail: boolean;
  addedAt: number;
  lastSyncedAt: number;
  lastActivatedAt: number | null;
}

export interface AccountSettings {
  refreshMinutes: number;
  hotkey: string | null;
  notifications: boolean;
  recommendations: boolean;
}

export interface RunningCodex { pid: number; name: string; kind: 'desktop' | 'cli' }

export interface AccountsSnapshot {
  accounts: AccountView[];
  pinned: { primary: string | null; secondary: string | null };
  activeNative: string | null;
  native: {
    live: 'managed' | 'unmanaged' | 'api_key' | 'none' | 'error';
    unmanaged: { email: string | null; plan: string | null; accountIdHint: string } | null;
    credentialStore: { mode: 'file' | 'keyring' | 'auto' | 'unknown'; supported: boolean; detail: string };
    authPath: string;
    error: string | null;
    running: RunningCodex[] | null;
  };
  desktop: { status: 'unverified'; note: string };
  settings: AccountSettings;
  lastSwitch: { from: string | null; to: string; at: number } | null;
  externalChange: { from: string | null; to: string | null } | null;
  recovery: {
    outcome: 'completed' | 'rolled_back' | 'diverged' | 'untouched' | 'failed';
    message: string;
    at: number;
  } | null;
  issues: string[];
  protection: 'windows-dpapi' | 'file-permissions';
  generatedAt: number;
}

export type SwitchBlockCode =
  | 'target_unknown' | 'target_missing_credentials' | 'unsupported_store' | 'live_auth_corrupt'
  | 'api_key_mode' | 'live_identity_unverifiable' | 'unknown_live_identity' | 'codex_running'
  | 'identity_mismatch' | 'target_expired';

export interface SwitchOutcome {
  status: 'switched' | 'unchanged' | 'blocked';
  code: null | SwitchBlockCode;
  message: string;
  from: string | null;
  to: string;
  restartRequired: boolean;
  desktop: 'unverified';
  running: { pid: number; name: string; kind: string }[];
  timings: { validateMs: number; writeMs: number; verifyMs: number; totalMs: number } | null;
}

export interface QuotaSummary {
  key: string;
  shortRemainingPct?: number | null;
  shortResetAt?: number | null;
  weeklyRemainingPct?: number | null;
  weeklyResetAt?: number | null;
  fetchedAt: number;
  status: 'ok' | 'rate_limited' | 'auth_error' | 'unavailable';
}

export type RecommendationCode =
  | 'disabled' | 'pair_incomplete' | 'data_missing' | 'data_stale' | 'auth_error'
  | 'similar' | 'more_capacity' | 'other_exhausted';

export interface Recommendation {
  recommended: string | null;
  primaryPct: number | null;
  secondaryPct: number | null;
  code: RecommendationCode;
}

export const CODEX_ACCOUNTS_PAGE_ID = 'codex-accounts';
export const CODEX_ACCOUNTS_EVENTS = {
  changed: 'codex-accounts-changed',
  refreshRequest: 'codex-accounts-refresh-request',
  open: 'codex-accounts-open',
} as const;

/** Typed wrappers over the Tauri commands. Rejections carry the backend string. */
export const codexAccountsApi = {
  getState: (includeProcesses: boolean) =>
    invoke<AccountsSnapshot>('codex_accounts_get_state', { includeProcesses }),
  switchTo: (key: string) => invoke<SwitchOutcome>('codex_accounts_switch', { key }),
  toggle: () => invoke<SwitchOutcome>('codex_accounts_toggle'),
  rename: (key: string, alias: string) => invoke<void>('codex_accounts_rename', { key, alias }),
  setPinned: (primary: string | null, secondary: string | null) =>
    invoke<void>('codex_accounts_set_pinned', { primary, secondary }),
  remove: (key: string) => invoke<void>('codex_accounts_remove', { key }),
  adoptLive: (alias: string) => invoke<string>('codex_accounts_adopt_live', { alias }),
  updateSettings: (settings: AccountSettings) =>
    invoke<AccountSettings>('codex_accounts_update_settings', { settings }),
  publishQuota: (summaries: QuotaSummary[]) =>
    invoke<Recommendation>('codex_accounts_publish_quota', { summaries }),
  recommendation: () => invoke<Recommendation>('codex_accounts_recommendation'),
  ackExternalChange: () => invoke<void>('codex_accounts_ack_external_change'),
  resetVault: () => invoke<void>('codex_accounts_reset_vault'),
  /** Existing command (agents/launch.rs); closes and reopens Codex Desktop. */
  restartCodexApp: () => invoke<void>('restart_codex_app'),
};

/** Subscribes without throwing when the Tauri event bridge is unavailable. */
export function listenCodexAccountsEvent(
  event: (typeof CODEX_ACCOUNTS_EVENTS)[keyof typeof CODEX_ACCOUNTS_EVENTS],
  handler: () => void,
): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  try {
    void listen(event, () => handler())
      .then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; })
      .catch(() => undefined);
  } catch {
    // No event bridge (plain browser): the page still works through focus/manual refresh.
  }
  return () => { disposed = true; stop?.(); };
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Vault failures are the only load errors that offer the destructive reset. */
export const isVaultError = (message: string | null | undefined): boolean =>
  /vault/i.test(message ?? '');

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export type SwitchBlockReason = 'api_key' | 'unsupported_store' | null;

/** Native switching is impossible up front in these modes; the UI explains instead of failing later. */
export function nativeSwitchBlockReason(snapshot: AccountsSnapshot): SwitchBlockReason {
  if (!snapshot.native.credentialStore.supported) return 'unsupported_store';
  if (snapshot.native.live === 'api_key') return 'api_key';
  return null;
}

export type SwitchDisabledReason = SwitchBlockReason | 'active' | 'expired' | null;

export function switchDisabledReason(account: AccountView, snapshot: AccountsSnapshot): SwitchDisabledReason {
  const global = nativeSwitchBlockReason(snapshot);
  if (global) return global;
  if (account.activeNative) return 'active';
  if (account.validity === 'expired') return 'expired';
  return null;
}

export type HealthCounts = { valid: number; refreshable: number; expired: number };

export function summarizeHealth(accounts: readonly AccountView[]): HealthCounts {
  return accounts.reduce<HealthCounts>((counts, account) => {
    counts[account.validity] += 1;
    return counts;
  }, { valid: 0, refreshable: 0, expired: 0 });
}

export type PinAction = 'primary' | 'secondary' | 'unpin';

/**
 * Next pinned pair after a pin action. An account occupies at most one slot;
 * pinning an account that holds the other slot swaps the pair.
 */
export function computePinned(
  current: { primary: string | null; secondary: string | null },
  key: string,
  action: PinAction,
): { primary: string | null; secondary: string | null } {
  if (action === 'unpin') {
    return {
      primary: current.primary === key ? null : current.primary,
      secondary: current.secondary === key ? null : current.secondary,
    };
  }
  const other = action === 'primary' ? 'secondary' : 'primary';
  const next = { ...current };
  const displaced = next[action];
  next[action] = key;
  if (next[other] === key) next[other] = displaced !== key ? displaced : null;
  return next;
}

/**
 * Reuse previous object identities for unchanged parts of a snapshot so memoized
 * cards skip re-rendering when only `generatedAt` or another account changed.
 */
export function shareSnapshotStructure(
  previous: AccountsSnapshot | null,
  next: AccountsSnapshot,
): AccountsSnapshot {
  if (!previous) return next;
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const previousByKey = new Map(previous.accounts.map((account) => [account.key, account]));
  const accounts = next.accounts.map((account) => {
    const old = previousByKey.get(account.key);
    return old && same(old, account) ? old : account;
  });
  const merged: AccountsSnapshot = { ...next, accounts };
  if (accounts.length === previous.accounts.length && accounts.every((a, i) => a === previous.accounts[i])) {
    merged.accounts = previous.accounts;
  }
  for (const field of ['pinned', 'native', 'settings', 'desktop', 'lastSwitch', 'externalChange', 'recovery', 'issues'] as const) {
    if (same(previous[field], next[field])) (merged as unknown as Record<string, unknown>)[field] = previous[field];
  }
  return merged;
}

export type DurationParts = { days: number; hours: number; minutes: number };

/** Whole days/hours/minutes in `ms`; `null` for non-finite input. */
export function splitDuration(ms: number): DurationParts | null {
  if (!Number.isFinite(ms)) return null;
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

/** Matching accounts that share a sign-in email are distinguished by the masked id hint. */
export const accountSubtitle = (account: Pick<AccountView, 'email' | 'accountIdHint'>): string =>
  [account.email, account.accountIdHint].filter(Boolean).join(' · ');

export const processLabel = (process: { pid: number; name: string; kind: string }): string =>
  `${process.name} (${process.kind}, PID ${process.pid})`;

/** Seconds since epoch -> ms, or null for missing/zero values. */
export const unixToMs = (seconds: number | null | undefined): number | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;

/** Accelerator string for a keyboard event, e.g. `Ctrl+Alt+F9`; null while only modifiers are held. */
export function acceleratorFromKeyEvent(event: {
  key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean;
}): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'].includes(event.key)) return null;
  const { code } = event;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else {
    const named: Record<string, string> = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
      Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
      Backquote: '`', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    };
    key = named[code] ?? null;
  }
  if (!key) return null;
  const parts = [
    event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '', event.metaKey ? 'Super' : '', key,
  ].filter(Boolean);
  return parts.join('+');
}
