// Browser-preview mock for the `codex_accounts_*` commands. Data is entirely synthetic
// (example.test addresses, made-up ids); no credential material exists here.
// Scenario flags come from `?mockCodex=a,b` so UI tests can reach every state:
//   running      Codex processes are running, so a switch is blocked (codex_running)
//   unmanaged    the native login is not managed by the app (adopt flow)
//   api_key      native Codex is in API-key mode
//   keyring      native credential store is unsupported
//   external     an out-of-app account change is pending acknowledgement
//   recovery     a crash-recovery report is present
//   recovery_deferred  the recovery report says the rollback is waiting for Codex to close
//   block-<code> every switch is blocked with that code (may be a code the UI does not know)
//   vault_error  loading state fails with a vault error
//   file_permissions  vault protection is weaker than DPAPI

type JsonObject = Record<string, unknown>;
export type CodexMockResult = { handled: false } | { handled: true; value: unknown };

export interface CodexAccountsMockHost {
  authFiles: JsonObject[];
}

type MockAccount = {
  key: string; alias: string; email: string; plan: string; accountIdHint: string; sourceFile: string;
  cpaCopy: 'same' | 'vault_newer' | 'conflict' | 'missing';
  validity: 'valid' | 'refreshable' | 'expired'; accessExpiresInSec: number; addedAt: number; lastActivatedAt: number | null;
};

type MockSummary = { key: string; shortRemainingPct?: number | null; weeklyRemainingPct?: number | null; fetchedAt: number; status: string };

const DESKTOP_NOTE = 'Codex Desktop account switching is not an officially supported feature and could not be verified. After switching, restart Codex Desktop and confirm the account it shows.';
const COMMANDS = new Set([
  'codex_accounts_get_state', 'codex_accounts_switch', 'codex_accounts_toggle', 'codex_accounts_rename',
  'codex_accounts_set_pinned', 'codex_accounts_remove', 'codex_accounts_adopt_live', 'codex_accounts_update_settings',
  'codex_accounts_publish_quota', 'codex_accounts_recommendation', 'codex_accounts_ack_external_change', 'codex_accounts_reset_vault',
]);

export const resolveCodexMockFlags = (search: string): ReadonlySet<string> =>
  new Set((new URLSearchParams(search).get('mockCodex') ?? '').split(',').map((flag) => flag.trim()).filter(Boolean));

const clone = <Value,>(value: Value): Value => structuredClone(value);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const nowSeconds = () => Math.floor(Date.now() / 1000);

function seedAccounts(): MockAccount[] {
  const now = nowSeconds();
  return [
    { key: 'cx_mock_work', alias: 'Work', email: 'dev@example.test', plan: 'pro', accountIdHint: 'acct…0001', sourceFile: 'codex-personal.json', cpaCopy: 'same', validity: 'valid', accessExpiresInSec: 8 * 3600, addedAt: now - 30 * 86_400, lastActivatedAt: now - 3 * 3600 },
    { key: 'cx_mock_home', alias: 'Home', email: 'home@example.test', plan: 'plus', accountIdHint: 'acct…0002', sourceFile: 'codex-idle.json', cpaCopy: 'same', validity: 'refreshable', accessExpiresInSec: -600, addedAt: now - 20 * 86_400, lastActivatedAt: now - 2 * 86_400 },
    { key: 'cx_mock_reserve', alias: 'Reserve', email: 'dev@example.test', plan: 'plus', accountIdHint: 'acct…0003', sourceFile: 'codex-exhausted.json', cpaCopy: 'vault_newer', validity: 'expired', accessExpiresInSec: -86_400, addedAt: now - 10 * 86_400, lastActivatedAt: null },
  ];
}

export function createCodexAccountsMock(host: CodexAccountsMockHost, flags: ReadonlySet<string> = new Set()) {
  let accounts = seedAccounts();
  let pinned: { primary: string | null; secondary: string | null } = { primary: 'cx_mock_work', secondary: 'cx_mock_home' };
  let active: string | null = flags.has('unmanaged') || flags.has('api_key') ? null : 'cx_mock_work';
  let unmanaged = flags.has('unmanaged');
  let settings = { refreshMinutes: 15, hotkey: null as string | null, notifications: false, recommendations: true };
  let lastSwitch: { from: string | null; to: string; at: number } | null = null;
  let externalChange: { from: string | null; to: string | null } | null = flags.has('external') ? { from: 'cx_mock_work', to: null } : null;
  const recovery = flags.has('recovery_deferred')
    ? { outcome: 'deferred', message: 'An interrupted switch could not be rolled back yet because Codex is running. Close Codex and it completes on the next refresh.', at: nowSeconds() - 300 }
    : flags.has('recovery')
      ? { outcome: 'rolled_back', message: 'Restored the previous Codex login after an interrupted switch.', at: nowSeconds() - 600 } : null;
  let vaultBroken = flags.has('vault_error');
  let summaries: MockSummary[] = [];

  const file = (name: string) => host.authFiles.find((candidate) => candidate.name === name);

  const view = (account: MockAccount) => {
    const credential = file(account.sourceFile);
    const now = nowSeconds();
    return {
      key: account.key, alias: account.alias, email: account.email, plan: account.plan,
      accountIdHint: account.accountIdHint,
      sourceFile: credential ? account.sourceFile : null,
      connected: Boolean(credential),
      proxyDisabled: credential ? credential.disabled === true : null,
      cpaCopy: credential ? account.cpaCopy : 'missing',
      validity: account.validity,
      accessExpiresAt: now + account.accessExpiresInSec,
      lastRefresh: new Date((now - 1800) * 1000).toISOString(),
      activeNative: account.key === active,
      pinnedSlot: pinned.primary === account.key ? 'primary' : pinned.secondary === account.key ? 'secondary' : null,
      duplicateEmail: accounts.filter((other) => other.email === account.email).length > 1,
      addedAt: account.addedAt, lastSyncedAt: now - 60, lastActivatedAt: account.lastActivatedAt,
    };
  };

  const running = () => (flags.has('running') ? [{ pid: 4242, name: 'Codex.exe', kind: 'desktop' }] : []);

  const snapshot = (includeProcesses: boolean) => {
    if (vaultBroken) throw new Error('The Codex account vault could not be decrypted (vault key mismatch).');
    return {
      accounts: accounts.map(view),
      pinned: clone(pinned),
      activeNative: active,
      native: {
        live: flags.has('api_key') ? 'api_key' : unmanaged ? 'unmanaged' : active ? 'managed' : 'none',
        unmanaged: unmanaged ? { email: 'stranger@example.test', plan: 'plus', accountIdHint: 'acct…0099' } : null,
        credentialStore: flags.has('keyring')
          ? { mode: 'keyring', supported: false, detail: 'cli_auth_credentials_store = "keyring" keeps the login in the system credential manager.' }
          : { mode: 'file', supported: true, detail: 'Codex reads its login from auth.json.' },
        authPath: 'C:\\Users\\Mock\\.codex\\auth.json',
        error: null,
        running: includeProcesses ? running() : null,
      },
      desktop: { status: 'unverified', note: DESKTOP_NOTE },
      settings: clone(settings),
      lastSwitch: clone(lastSwitch),
      externalChange: clone(externalChange),
      recovery: clone(recovery),
      issues: [],
      protection: flags.has('file_permissions') ? 'file-permissions' : 'windows-dpapi',
      generatedAt: nowSeconds(),
    };
  };

  const blocked = (code: string, message: string, to: string) => ({
    status: 'blocked', code, message, from: active, to, restartRequired: false, desktop: 'unverified', running: running(), timings: null,
  });

  const switchTo = (key: string) => {
    const target = accounts.find((account) => account.key === key);
    if (!target) return blocked('target_unknown', 'No such account.', key);
    const forced = [...flags].find((flag) => flag.startsWith('block-'));
    if (forced) return blocked(forced.slice('block-'.length), `Blocked by the backend (${forced.slice('block-'.length)}).`, key);
    if (flags.has('keyring')) return blocked('unsupported_store', 'Credential store not supported.', key);
    if (flags.has('api_key')) return blocked('api_key_mode', 'Codex is in API key mode.', key);
    if (unmanaged) return blocked('unknown_live_identity', 'The live login is not saved.', key);
    if (flags.has('running')) return blocked('codex_running', 'Codex is running.', key);
    if (target.validity === 'expired') return blocked('target_expired', 'The saved login has expired.', key);
    if (active === key) {
      return { status: 'unchanged', code: null, message: 'Already active.', from: key, to: key, restartRequired: false, desktop: 'unverified', running: [], timings: null };
    }
    const from = active;
    active = key;
    target.lastActivatedAt = nowSeconds();
    lastSwitch = { from, to: key, at: nowSeconds() };
    return {
      status: 'switched', code: null, message: 'Switched.', from, to: key, restartRequired: true, desktop: 'unverified', running: [],
      timings: { validateMs: 1.4, writeMs: 3.2, verifyMs: 2.1, totalMs: 7.6 },
    };
  };

  const recommend = () => {
    if (!settings.recommendations) return { recommended: null, primaryPct: null, secondaryPct: null, code: 'disabled' };
    const { primary, secondary } = pinned;
    if (!primary || !secondary) return { recommended: null, primaryPct: null, secondaryPct: null, code: 'pair_incomplete' };
    const first = summaries.find((summary) => summary.key === primary);
    const second = summaries.find((summary) => summary.key === secondary);
    if (!first || !second) return { recommended: null, primaryPct: null, secondaryPct: null, code: 'data_missing' };
    const staleAfter = Math.max(settings.refreshMinutes * 120, 1800);
    const effective = (summary: MockSummary) => summary.status === 'auth_error' ? null
      : Math.min(...[summary.shortRemainingPct, summary.weeklyRemainingPct].filter((value): value is number => typeof value === 'number'), Infinity);
    const finite = (value: number | null) => (value === null || !Number.isFinite(value) ? null : value);
    if ([first, second].some((summary) => nowSeconds() - summary.fetchedAt > staleAfter)) {
      return { recommended: null, primaryPct: finite(effective(first)), secondaryPct: finite(effective(second)), code: 'data_stale' };
    }
    if (first.status === 'auth_error' || second.status === 'auth_error') return { recommended: null, primaryPct: null, secondaryPct: null, code: 'auth_error' };
    const a = finite(effective(first));
    const b = finite(effective(second));
    if (a === null || b === null) return { recommended: null, primaryPct: a, secondaryPct: b, code: 'data_missing' };
    if (a <= 0 && b > 0) return { recommended: secondary, primaryPct: a, secondaryPct: b, code: 'other_exhausted' };
    if (b <= 0 && a > 0) return { recommended: primary, primaryPct: a, secondaryPct: b, code: 'other_exhausted' };
    if (Math.abs(a - b) < 5) return { recommended: null, primaryPct: a, secondaryPct: b, code: 'similar' };
    return { recommended: a > b ? primary : secondary, primaryPct: a, secondaryPct: b, code: 'more_capacity' };
  };

  function handle(command: string, payload: JsonObject): CodexMockResult {
    if (!COMMANDS.has(command)) return { handled: false };
    const result = (value: unknown): CodexMockResult => ({ handled: true, value: clone(value) });
    switch (command) {
      case 'codex_accounts_get_state': return result(snapshot(payload.includeProcesses === true));
      case 'codex_accounts_switch': return result(switchTo(text(payload.key)));
      case 'codex_accounts_toggle': {
        if (!pinned.primary || !pinned.secondary) throw new Error('Pin two accounts to use the quick-switch toggle');
        return result(switchTo(active === pinned.primary ? pinned.secondary : pinned.primary));
      }
      case 'codex_accounts_rename': {
        const alias = text(payload.alias).trim();
        if (!alias || alias.length > 64) throw new Error('Enter an account name of 1 to 64 characters.');
        const account = accounts.find((candidate) => candidate.key === payload.key);
        if (!account) throw new Error('No such account.');
        account.alias = alias;
        return result(null);
      }
      case 'codex_accounts_set_pinned': {
        const primary = typeof payload.primary === 'string' ? payload.primary : null;
        const secondary = typeof payload.secondary === 'string' ? payload.secondary : null;
        if (primary && primary === secondary) throw new Error('Choose two different accounts.');
        pinned = { primary, secondary };
        return result(null);
      }
      case 'codex_accounts_remove': {
        accounts = accounts.filter((account) => account.key !== payload.key);
        if (pinned.primary === payload.key) pinned.primary = null;
        if (pinned.secondary === payload.key) pinned.secondary = null;
        if (active === payload.key) active = null;
        return result(null);
      }
      case 'codex_accounts_adopt_live': {
        if (!unmanaged) throw new Error('There is no unmanaged login to add.');
        const alias = text(payload.alias).trim();
        if (!alias) throw new Error('Enter an account name.');
        const key = 'cx_mock_adopted';
        accounts.push({ key, alias, email: 'stranger@example.test', plan: 'plus', accountIdHint: 'acct…0099', sourceFile: 'none.json', cpaCopy: 'missing', validity: 'valid', accessExpiresInSec: 3600, addedAt: nowSeconds(), lastActivatedAt: null });
        active = key;
        unmanaged = false;
        return result(key);
      }
      case 'codex_accounts_update_settings': {
        const next = payload.settings as typeof settings;
        const hotkey = typeof next.hotkey === 'string' && next.hotkey.trim() ? next.hotkey.trim() : null;
        if (hotkey) {
          const parts = hotkey.split('+').map((part) => part.trim().toLowerCase());
          const modifiers = parts.filter((part) => ['ctrl', 'alt', 'shift', 'super'].includes(part));
          if (modifiers.length < 2) throw new Error('Use at least two modifier keys (for example Ctrl+Alt) to avoid conflicts');
          if (hotkey.toLowerCase() === 'ctrl+alt+f1') throw new Error('The shortcut could not be registered (it may be in use by another application)');
        }
        if (!Number.isInteger(next.refreshMinutes) || next.refreshMinutes < 1 || next.refreshMinutes > 1440) throw new Error('Quota cache duration must be 1 to 1440 minutes.');
        settings = { refreshMinutes: next.refreshMinutes, hotkey, notifications: next.notifications === true, recommendations: next.recommendations === true };
        return result(settings);
      }
      case 'codex_accounts_publish_quota': {
        summaries = (Array.isArray(payload.summaries) ? payload.summaries : []) as MockSummary[];
        return result(recommend());
      }
      case 'codex_accounts_recommendation': return result(recommend());
      case 'codex_accounts_ack_external_change': externalChange = null; return result(null);
      case 'codex_accounts_reset_vault': vaultBroken = false; return result(null);
      default: return { handled: false };
    }
  }

  return { handle };
}
