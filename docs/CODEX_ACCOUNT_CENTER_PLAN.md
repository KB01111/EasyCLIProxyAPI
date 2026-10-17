# Codex Account Center — Plan, Architecture and Status

This document is the implementation plan for the Codex Account Center and
records what was actually built. Sections marked **Compatibility findings** and
**Known limitations** are deliberately blunt about what has *not* been verified.

## 1. Current architecture (baseline audit)

| Area | Where | Notes |
| --- | --- | --- |
| CLIProxyAPI core OAuth + credential files | core process, `auth-dir` (default `~/.cli-proxy-api`) | Each Codex login is a flat `*.json` with `type: "codex"`, `id_token`, `access_token`, `refresh_token`, `account_id`, `last_refresh`, `email`, `expired`, `disabled`. The core rotates tokens in place. |
| Credential management / routing UI | `src/pages/AuthFileManagementPage.tsx`, `src/services/authFiles.ts`, `authFileSettings.ts` | Enable/disable, `priority`, prefix, cooldown reset go through the management API. Tokens are never sent to React. |
| Provider quota | `src/services/quotaService.ts`, `quotaCache.ts`, `quotaMetadata.ts`, `QuotaPage.tsx` | Calls `chatgpt.com/backend-api/wham/usage` **through the core's `api-call`** using the credential's `auth_index` — the webview never holds tokens. Window labels/resets come from the provider response. |
| Proxy usage | `src-tauri/src/usage.rs`, `UsageRecordsPage.tsx` | Requests/tokens observed by the proxy only. |
| Native Codex integration | `agents/native_oauth.rs`, `configuration.rs`, `discovery.rs`, `launch.rs`, `windows_probe.rs` | Switches Codex between "CPA routing" and "official OAuth" by rewriting `config.toml`/`auth.json` inside the shared transaction layer. Detects Codex Desktop/CLI, can restart Desktop, daemon status. |
| Config transactions | `agents/transactions.rs` (`config_images`, `commit_config*`) | Before-image compare, write, post-write verification, rollback. |
| File watching | `configuration_watcher.rs` | Already watches Codex `auth.json`/`config.toml`; emits `CONFIG_FILES_CHANGED_EVENT`. |
| Tray | `tray.rs` | Static Windows/Linux menu (open, core status, toggle/restart core, quit). |
| Single instance | `instance_lock.rs` | Guarantees one writer process. |

### Audit findings that shaped the design

1. `agents/native_oauth.rs` persists `native_auth` / `cpa_auth` — complete
   `auth.json` bodies including refresh tokens — in **plaintext**
   `cpa-native-oauth.json`. The Account Center does **not** extend that
   pattern: it stores credentials only in the encrypted vault. When a native
   switch occurs while that record holds an older OAuth snapshot, the record's
   `native_auth` is refreshed inside the same transaction so "Close" can never
   resurrect a stale account.
2. `write_codex_private_file` → `write_bytes_directly` overwrites `auth.json`
   in place (truncate/rewrite). A crash mid-write corrupts the only credential.
   The Account Center writes `auth.json` through the existing transaction layer
   but with an **atomic** (temp file + rename) writer plus an encrypted
   write-ahead journal.
3. Quota is fetched in the webview via core `api-call` — correct for secrecy, so
   quota logic stays in TypeScript; Rust receives only a *safe numeric summary*
   (for the tray/recommendation) pushed back by the frontend.

## 2. Reused vs. missing

Reused: management API + `authFiles`, quota service/cache/metadata, transaction
layer (`commit_config_with_writer`, `config_images`), `AGENT_CONFIG_FILE_LOCK`,
`codex_configuration_directory`, Windows process snapshot helpers, config
watcher events, tray, instance lock, privacy mode, i18n.

Missing (added): stable account identity, encrypted multi-account vault,
credential reconciliation, crash-safe native switch + recovery, process
blocking, credential-store detection, pinned-pair persistence, recommendations,
Account Center UI, tray section, optional global shortcut, notifications,
proxy routing-pool presets.

## 3. Module ownership

| Module | Responsibility |
| --- | --- |
| `src-tauri/src/codex_accounts/identity.rs` | JWT claim decode, stable identity key, credential generation/validity (no signature trust — see Security). |
| `…/vault.rs` | AES-256-GCM vault; master key wrapped by Windows DPAPI (user scope); 0600 key file elsewhere. |
| `…/store.rs` | Non-secret metadata (`accounts.json`): aliases, pinned pair, settings, active native key. |
| `…/discovery.rs` | Scan CPA `auth-dir` for `type: codex`, import into vault, reconcile newer tokens. |
| `…/native.rs` | Credential-store detection, process blocking, atomic switch, verification, rollback, journal + crash recovery. |
| `…/recommend.rs` | Pure recommendation + tray label logic over *pushed, fresh* quota summaries. |
| `…/commands.rs` | Tauri commands and shared `CodexAccountsState`. |
| `…/hotkey.rs` | Shortcut validation and registration. |
| `tray.rs` (extended) | “Codex Accounts” menu section. |
| `src/services/codexAccounts.ts`, `src/pages/CodexAccountsPage.tsx` (+ CSS, i18n) | Account Center UI. |

## 4. Five separate states (never conflated)

1. **Connected to CLIProxyAPI** – a `type: codex` auth file exists.
2. **Enabled for proxy routing** – that file's `disabled` flag/priority.
3. **Pinned for quick-switch** – Account Center preference (A/B).
4. **Active in native Codex** – identity of the live `auth.json`, read and verified.
5. **Recognized by Codex Desktop** – *not observable*; reported as `unverified`.

## 5. Data flow

```
 CPA auth-dir/*.json ──discover/import──► Vault (AES-GCM, DPAPI-wrapped key)
        ▲                                     │ reconcile newest generation
        │ (read only)                         ▼
 Core refresh rotates ───────────────► Account metadata (accounts.json, no secrets)
                                              │
 live CODEX_HOME/auth.json ◄──atomic switch───┤ journal.bin (encrypted before-image)
        │ capture refreshed tokens ──────────►│
        ▼ verify identity after write         │
 Tauri events ◄───────────────────────────────┘
        │
 React Account Center ──quota via core api-call──► provider
        │ push safe summary (% / reset / fetchedAt)
        ▼
 Rust tray + recommendation state ──► tray menu / global hotkey / notifications
```

## 6. Security considerations

* Credentials live only in the vault; React receives aliases, key, masked id,
  email, plan, validity state and timestamps — never tokens or raw JSON.
* Master key: random 32 bytes. Windows: wrapped with DPAPI `CryptProtectData`
  (user scope + application entropy). Other OSes (dev/CI only): 0600 key file;
  state reports `protection: "file-permissions"` so the UI can say so.
* JWT claims are decoded **without signature verification**. They are used for
  identity *labelling and equality*, which is safe because the tokens came from
  OpenAI via the official login and are then used only against OpenAI; a forged
  token would simply fail upstream. Equality of `(chatgpt_account_id, user id)`
  across before/after is the verification contract; it is not an authenticity
  proof.
* Never overwrite newer with older: generation = max(access-token `iat`,
  `last_refresh`); ties with different bytes are conflicts, not overwrites.
* Unknown live identities are never auto-associated: switching is refused until
  the user explicitly adopts or discards the login.
* Logs/errors are redacted by construction: credential types have manual
  `Debug` impls that print nothing sensitive and error strings never embed
  token text.
* Residual risk: native Codex and the CPA core may share one refresh-token
  chain; if either refreshes first, the other copy can be rejected. The
  newest-generation reconciliation heals this on the next sync; a rejected copy
  needs Reauthenticate.

## 7. Compatibility findings

* **Codex CLI** – with `cli_auth_credentials_store = "file"` (or unset;
  documented default) the CLI reads `$CODEX_HOME/auth.json` (default
  `~/.codex`). Switching is supported in this mode only. `keyring` and `auto`
  (which prefers the OS credential manager on Windows) are detected and
  reported **unsupported**; the app never touches the Windows Credential
  Manager entry.
* **Codex Desktop** – no documented contract for account switching. The app
  detects installation/processes, but **cannot verify** that Desktop re-reads
  `auth.json`. Status is always `unverified`; after a switch the app tells the
  user to restart Desktop and confirm the account shown in Desktop. It never
  kills Codex and never touches Desktop private stores.
* Verification against an actual installed Desktop was **not possible** in the
  build environment (Linux CI sandbox).

## 8. Implementation phases (and status)

1. Architecture audit — done (this document).
2. Domain model — identity, store, pinned pair.
3. Credential management — vault, reconcile, atomic switch, journal, recovery.
4. Native compatibility — store detection, process blocking, verification.
5. Usage/quota integration — frontend reuses quota service; summary pushed to Rust.
6. UI — Account Center page.
7. Windows integration — tray section, optional hotkey, notifications.
8. QA — unit/integration tests, clippy, fmt, build, UI smoke.
9. Release prep — README/doc updates.

## 9. Test strategy

Rust unit/integration tests with synthetic JWTs in temp directories (identity
dedupe, vault round-trip/tamper, switch A→B→A, same-account no-op, expired,
running-process block, unknown-login conflict, write failure + rollback,
journal crash recovery, newer-token preservation, quota recommendation, hotkey
validation, secret redaction). TypeScript type-check and build; existing
Playwright-style UI tests are extended with a browser-mock smoke test.

## 10. Definition of done

See the acceptance criteria of the task; this document's final section in the
PR description lists each criterion as verified / conditional / unsupported.

## Appendix A — Backend command contract (Tauri `invoke`)

All commands live in `src-tauri/src/codex_accounts/commands.rs`. They never return token material.
Expected conditions (Codex running, unsupported store, unknown login …) come back as a normal
`SwitchOutcome` with `status: "blocked"` and a `code`; only unexpected failures reject with a string.

```ts
type Validity = 'valid' | 'refreshable' | 'expired';
type CpaCopy = 'same' | 'vault_newer' | 'conflict' | 'missing';

interface AccountView {
  key: string;                 // stable primary key (never the email)
  alias: string;
  email: string | null;
  plan: string | null;         // lower-case plan type from the ID token
  accountIdHint: string;       // masked, e.g. "acct…0001"
  sourceFile: string | null;   // CLIProxyAPI credential file NAME (join key to management API auth files)
  connected: boolean;          // CPA credential file exists
  proxyDisabled: boolean | null; // CPA `disabled` flag; null when not connected
  cpaCopy: CpaCopy;
  validity: Validity;
  accessExpiresAt: number | null; // unix seconds
  lastRefresh: string | null;     // RFC 3339
  activeNative: boolean;       // verified: live auth.json holds this identity
  pinnedSlot: 'primary' | 'secondary' | null;
  duplicateEmail: boolean;
  addedAt: number; lastSyncedAt: number; lastActivatedAt: number | null;
}

interface AccountSettings {
  refreshMinutes: number;      // quota cache lifetime, 1..1440
  hotkey: string | null;       // e.g. "Ctrl+Alt+F9"; null = disabled
  notifications: boolean;
  recommendations: boolean;
}

interface AccountsSnapshot {
  accounts: AccountView[];
  pinned: { primary: string | null; secondary: string | null };
  activeNative: string | null;
  native: {
    live: 'managed' | 'unmanaged' | 'api_key' | 'none' | 'error';
    unmanaged: { email: string | null; plan: string | null; accountIdHint: string } | null;
    credentialStore: { mode: 'file' | 'keyring' | 'auto' | 'unknown'; supported: boolean; detail: string };
    authPath: string; error: string | null;
    running: { pid: number; name: string; kind: 'desktop' | 'cli' }[] | null; // only when requested
  };
  desktop: { status: 'unverified'; note: string };   // ALWAYS unverified
  settings: AccountSettings;
  lastSwitch: { from: string | null; to: string; at: number } | null;
  externalChange: { from: string | null; to: string | null } | null; // sticky until acknowledged
  recovery: { outcome: 'completed' | 'rolled_back' | 'diverged' | 'untouched' | 'failed'; message: string; at: number } | null;
  issues: string[];
  protection: 'windows-dpapi' | 'file-permissions';
  generatedAt: number;
}

interface SwitchOutcome {
  status: 'switched' | 'unchanged' | 'blocked';
  code: null | 'target_unknown' | 'target_missing_credentials' | 'unsupported_store' | 'live_auth_corrupt'
    | 'api_key_mode' | 'live_identity_unverifiable' | 'unknown_live_identity' | 'codex_running'
    | 'identity_mismatch' | 'target_expired';
  message: string; from: string | null; to: string;
  restartRequired: boolean; desktop: 'unverified';
  running: { pid: number; name: string; kind: string }[];
  timings: { validateMs: number; writeMs: number; verifyMs: number; totalMs: number } | null;
}

interface QuotaSummary {       // pushed by the webview; percentages are REMAINING, 0..100
  key: string; shortRemainingPct?: number | null; shortResetAt?: number | null;
  weeklyRemainingPct?: number | null; weeklyResetAt?: number | null;   // unix seconds
  fetchedAt: number; status: 'ok' | 'rate_limited' | 'auth_error' | 'unavailable';
}
interface Recommendation {
  recommended: string | null; primaryPct: number | null; secondaryPct: number | null;
  code: 'disabled' | 'pair_incomplete' | 'data_missing' | 'data_stale' | 'auth_error'
    | 'similar' | 'more_capacity' | 'other_exhausted';
}
```

| Command | Args | Returns |
| --- | --- | --- |
| `codex_accounts_get_state` | `includeProcesses: boolean` | `AccountsSnapshot` (syncs CPA files → vault, captures refreshed native tokens) |
| `codex_accounts_switch` | `key` | `SwitchOutcome` |
| `codex_accounts_toggle` | – | `SwitchOutcome` (A↔B using the pinned pair) |
| `codex_accounts_rename` | `key, alias` | `void` |
| `codex_accounts_set_pinned` | `primary, secondary` (`string \| null`) | `void` |
| `codex_accounts_remove` | `key` | `void` (forgets vault copy only) |
| `codex_accounts_adopt_live` | `alias` | `string` (new key) – explicit adoption of an unmanaged native login |
| `codex_accounts_update_settings` | `settings: AccountSettings` | saved `AccountSettings` (rejects invalid/unavailable shortcut) |
| `codex_accounts_publish_quota` | `summaries: QuotaSummary[]` | `Recommendation` |
| `codex_accounts_recommendation` | – | `Recommendation` |
| `codex_accounts_ack_external_change` | – | `void` |
| `codex_accounts_reset_vault` | – | `void` (moves an undecryptable vault aside) |

Events emitted to the webview: `codex-accounts-changed` (state changed; re-fetch),
`codex-accounts-refresh-request` (tray “Refresh Quotas”), `codex-accounts-open` (tray “Open Account Center”).
