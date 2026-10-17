use super::discovery::{scan_cpa_directory, CpaScan};
use super::identity::{
    mask_identifier, parse_native_auth, render_native_auth, CodexCredential, CodexIdentity,
    CredentialValidity, NativeAuth,
};
use super::native::{
    detect_credential_store, plan_recovery, CredentialStoreStatus, JournalFile, RecoveryAction,
    RunningCodex, SwitchJournal, JOURNAL_FILE, JOURNAL_LABEL,
};
use super::store::{
    load_store, save_store, AccountRecord, AccountSettings, PinnedPair, StoreData, SwitchRecord,
};
use super::vault::{write_private_atomic, KeyProtector, Vault, VaultData, VaultEntry};
use super::*;
use std::collections::HashMap;
use std::time::Instant;

const AUTH_FILE: &str = "auth.json";

/// How a CLIProxyAPI credential file compares with the vault copy of the same login.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CpaCopy {
    Same,
    /// The vault holds fresher tokens (the native client refreshed): the CPA copy may be rejected.
    VaultNewer,
    /// Same generation but different token bytes: never auto-resolved.
    Conflict,
    /// No CPA credential file backs this account any more.
    Missing,
}

#[derive(Clone, Debug)]
pub(crate) struct CpaState {
    pub(crate) file_name: String,
    pub(crate) disabled: bool,
    pub(crate) copy: CpaCopy,
}

#[derive(Default)]
pub(crate) struct SyncReport {
    pub(crate) by_key: HashMap<String, CpaState>,
    pub(crate) issues: Vec<String>,
    pub(crate) dirty_store: bool,
    pub(crate) dirty_vault: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reconcile {
    Same,
    Adopted,
    KeptNewer,
    Conflict,
}

/// Fold `candidate` into `entry` only when it is strictly newer. Callers guarantee equal identity.
fn reconcile(entry: &mut VaultEntry, candidate: &CodexCredential, now: i64) -> Reconcile {
    if entry.credential == *candidate {
        return Reconcile::Same;
    }
    let (held, offered) = (entry.credential.generation(now), candidate.generation(now));
    // A "newer" copy that lost a token part would downgrade what the vault can do.
    let loses_parts =
        |held: &str, offered: &str| !held.trim().is_empty() && offered.trim().is_empty();
    let downgrades = loses_parts(
        &entry.credential.tokens.refresh_token,
        &candidate.tokens.refresh_token,
    ) || loses_parts(
        &entry.credential.tokens.id_token,
        &candidate.tokens.id_token,
    );
    if offered > held && downgrades {
        Reconcile::KeptNewer
    } else if offered > held {
        entry.credential = candidate.clone();
        entry.updated_at = now;
        Reconcile::Adopted
    } else if offered < held {
        Reconcile::KeptNewer
    } else {
        Reconcile::Conflict
    }
}

fn default_alias(store: &StoreData, identity: &CodexIdentity, file_name: Option<&str>) -> String {
    let base = identity
        .email
        .clone()
        .or_else(|| {
            file_name.map(|name| {
                name.trim_end_matches(".json")
                    .trim_end_matches(".JSON")
                    .to_string()
            })
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Codex account".into());
    let base = base.chars().take(32).collect::<String>();
    let mut candidate = base.clone();
    // Suffixes keep the alias within the length limit; the search is bounded so a sync can never hang.
    for counter in 2..1000 {
        if store.validate_alias("", &candidate).is_ok() {
            return candidate;
        }
        candidate = format!("{base} ({counter})");
    }
    format!(
        "Codex account {}",
        identity
            .key
            .trim_start_matches("cx_")
            .get(..8)
            .unwrap_or("x")
    )
}

fn record_from(
    store: &StoreData,
    identity: &CodexIdentity,
    file_name: Option<&str>,
    now: i64,
) -> AccountRecord {
    AccountRecord {
        key: identity.key.clone(),
        alias: default_alias(store, identity, file_name),
        email: identity.email.clone(),
        plan: identity.plan.clone(),
        account_id_hint: mask_identifier(&identity.account_id),
        source_file: file_name.map(str::to_string),
        added_at: now,
        last_synced_at: now,
        last_activated_at: None,
    }
}

// ---------------------------------------------------------------------------------------------
// Frontend-safe views. Nothing in this section can carry token material.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountView {
    pub(crate) key: String,
    pub(crate) alias: String,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) account_id_hint: String,
    pub(crate) source_file: Option<String>,
    /// A CPA credential file for this login exists (proxy-connected).
    pub(crate) connected: bool,
    /// `disabled` flag of the CPA file (proxy routing); `None` when not connected.
    pub(crate) proxy_disabled: Option<bool>,
    pub(crate) cpa_copy: CpaCopy,
    pub(crate) validity: CredentialValidity,
    pub(crate) access_expires_at: Option<i64>,
    pub(crate) last_refresh: Option<String>,
    /// This identity is what the live Codex `auth.json` verifiably holds.
    pub(crate) active_native: bool,
    /// `primary` | `secondary` when pinned for quick switching.
    pub(crate) pinned_slot: Option<&'static str>,
    pub(crate) duplicate_email: bool,
    pub(crate) added_at: i64,
    pub(crate) last_synced_at: i64,
    pub(crate) last_activated_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnmanagedLogin {
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) account_id_hint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeView {
    /// `managed` | `unmanaged` | `api_key` | `none` | `error`
    pub(crate) live: &'static str,
    pub(crate) unmanaged: Option<UnmanagedLogin>,
    pub(crate) credential_store: CredentialStoreStatus,
    pub(crate) auth_path: String,
    pub(crate) error: Option<String>,
    pub(crate) running: Option<Vec<RunningCodex>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalChange {
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryReport {
    /// `completed` | `rolled_back` | `diverged` | `untouched` | `failed`
    pub(crate) outcome: &'static str,
    pub(crate) message: String,
    pub(crate) at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountsSnapshot {
    pub(crate) accounts: Vec<AccountView>,
    pub(crate) pinned: PinnedPair,
    pub(crate) active_native: Option<String>,
    pub(crate) native: NativeView,
    /// Codex Desktop switching has no verified contract: always reported as unverified.
    pub(crate) desktop: DesktopView,
    pub(crate) settings: AccountSettings,
    pub(crate) last_switch: Option<SwitchRecord>,
    pub(crate) external_change: Option<ExternalChange>,
    pub(crate) recovery: Option<RecoveryReport>,
    pub(crate) issues: Vec<String>,
    pub(crate) protection: &'static str,
    pub(crate) generated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopView {
    pub(crate) status: &'static str,
    pub(crate) note: &'static str,
}

pub(crate) const DESKTOP_NOTE: &str = "Codex Desktop account switching is not an officially supported feature and could not be verified. After switching, restart Codex Desktop and confirm the account it shows.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchTimings {
    pub(crate) validate_ms: f64,
    pub(crate) write_ms: f64,
    pub(crate) verify_ms: f64,
    pub(crate) total_ms: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchOutcome {
    /// `switched` | `unchanged` | `blocked`
    pub(crate) status: &'static str,
    /// Machine-readable reason for `blocked`.
    pub(crate) code: Option<&'static str>,
    pub(crate) message: String,
    pub(crate) from: Option<String>,
    pub(crate) to: String,
    pub(crate) restart_required: bool,
    /// `unverified` after a switch: Desktop re-read behavior is not observable.
    pub(crate) desktop: &'static str,
    pub(crate) running: Vec<RunningCodex>,
    pub(crate) timings: Option<SwitchTimings>,
}

pub(crate) struct StateContext<'a> {
    pub(crate) cpa_dir: &'a Path,
    pub(crate) codex_home: &'a Path,
    pub(crate) now: i64,
    pub(crate) running: Option<Vec<RunningCodex>>,
}

pub(crate) struct SwitchEnv<'a> {
    pub(crate) codex_home: &'a Path,
    /// Evaluated inside the locks, immediately before the credentials are written, so a Codex that
    /// started while the switch waited is still seen. An `Err` (scan failed) blocks the switch.
    pub(crate) process_scan: &'a dyn Fn() -> Result<Vec<RunningCodex>, String>,
    pub(crate) now: i64,
}

/// Releases both locks on drop (closing the file drops the advisory lock).
struct EngineGuard<'a> {
    _mutex: std::sync::MutexGuard<'a, ()>,
    _file: File,
}

pub(crate) struct AccountEngine {
    directory: PathBuf,
    vault: Vault,
    guard: Mutex<()>,
    recovery: Mutex<Option<RecoveryReport>>,
    /// Sticky until acknowledged, so a tray refresh cannot swallow the notice before the UI shows it.
    external: Mutex<Option<ExternalChange>>,
}

fn blocked(
    code: &'static str,
    message: impl Into<String>,
    from: Option<String>,
    to: &str,
    running: Vec<RunningCodex>,
) -> SwitchOutcome {
    SwitchOutcome {
        status: "blocked",
        code: Some(code),
        message: message.into(),
        from,
        to: to.to_string(),
        restart_required: false,
        desktop: "unverified",
        running,
        timings: None,
    }
}

fn millis(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0
}

/// The production writer: atomic temp-file replace with owner-only permissions.
pub(crate) fn atomic_images_writer(_client: &str, images: &Images) -> Result<(), String> {
    for (path, bytes) in images {
        match bytes {
            Some(bytes) => write_private_atomic(path, bytes)?,
            None => match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err("Failed to remove a credential file".into()),
            },
        }
    }
    Ok(())
}

impl AccountEngine {
    pub(crate) fn new(
        directory: PathBuf,
        protector: Box<dyn KeyProtector>,
    ) -> Result<Self, String> {
        let vault = Vault::open(directory.clone(), protector)?;
        Ok(Self {
            directory,
            vault,
            guard: Mutex::new(()),
            recovery: Mutex::new(None),
            external: Mutex::new(None),
        })
    }

    /// In-process mutex plus an advisory file lock, so two app copies sharing the per-user vault
    /// cannot interleave load-modify-save cycles and drop each other's updates.
    fn lock(&self) -> Result<EngineGuard<'_>, String> {
        let mutex = self
            .guard
            .lock()
            .map_err(|_| "Codex account state lock is poisoned".to_string())?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.directory.join("vault.lock"))
            .map_err(|_| "Unable to open the Codex account lock file".to_string())?;
        file.lock()
            .map_err(|_| "Unable to lock the Codex account vault".to_string())?;
        Ok(EngineGuard {
            _mutex: mutex,
            _file: file,
        })
    }

    fn load(&self) -> Result<(StoreData, VaultData), String> {
        Ok((load_store(&self.directory)?, self.vault.load()?))
    }

    fn persist(&self, store: Option<&StoreData>, vault: Option<&VaultData>) -> Result<(), String> {
        // Vault first: a store entry without credentials is repairable, the reverse leaks nothing.
        if let Some(vault) = vault {
            self.vault.save(vault)?;
        }
        if let Some(store) = store {
            save_store(&self.directory, store)?;
        }
        Ok(())
    }

    pub(crate) fn acknowledge_external_change(&self) {
        if let Ok(mut external) = self.external.lock() {
            *external = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn write_journal_for_test(&self, label: &str, plain: &[u8]) {
        let sealed = self.vault.seal(label, plain).unwrap();
        write_private_atomic(&self.directory.join(JOURNAL_FILE), &sealed).unwrap();
    }

    pub(crate) fn quarantine_vault(&self) -> Result<(), String> {
        let _guard = self.lock()?;
        self.vault.quarantine()
    }

    // ----- CPA synchronisation ---------------------------------------------------------------

    fn sync_scan(
        &self,
        scan: CpaScan,
        store: &mut StoreData,
        vault: &mut VaultData,
        now: i64,
    ) -> SyncReport {
        let mut report = SyncReport {
            issues: scan.issues,
            ..Default::default()
        };
        for file in scan.files {
            let key = file.identity.key.clone();
            let copy = match vault.entries.get_mut(&key) {
                None => {
                    vault.entries.insert(
                        key.clone(),
                        VaultEntry {
                            credential: file.credential.clone(),
                            updated_at: now,
                        },
                    );
                    report.dirty_vault = true;
                    CpaCopy::Same
                }
                Some(entry) => match reconcile(entry, &file.credential, now) {
                    Reconcile::Same => CpaCopy::Same,
                    Reconcile::Adopted => {
                        report.dirty_vault = true;
                        CpaCopy::Same
                    }
                    Reconcile::KeptNewer => CpaCopy::VaultNewer,
                    Reconcile::Conflict => CpaCopy::Conflict,
                },
            };
            match store.account_mut(&key) {
                Some(record) => {
                    let mut changed = false;
                    for (slot, value) in [
                        (&mut record.email, file.identity.email.clone()),
                        (&mut record.plan, file.identity.plan.clone()),
                    ] {
                        if value.is_some() && *slot != value {
                            *slot = value;
                            changed = true;
                        }
                    }
                    if record.source_file.as_deref() != Some(file.file_name.as_str()) {
                        record.source_file = Some(file.file_name.clone());
                        changed = true;
                    }
                    if changed {
                        record.last_synced_at = now;
                        report.dirty_store = true;
                    }
                }
                None => {
                    let record = record_from(store, &file.identity, Some(&file.file_name), now);
                    store.accounts.push(record);
                    report.dirty_store = true;
                }
            }
            report.by_key.insert(
                key,
                CpaState {
                    file_name: file.file_name,
                    disabled: file.disabled,
                    copy,
                },
            );
        }
        report
    }

    // ----- Snapshot --------------------------------------------------------------------------

    pub(crate) fn state(&self, context: &StateContext<'_>) -> Result<AccountsSnapshot, String> {
        let _guard = self.lock()?;
        let (mut store, mut vault) = self.load()?;
        let now = context.now;
        let mut report = self.sync_scan(
            scan_cpa_directory(context.cpa_dir, now),
            &mut store,
            &mut vault,
            now,
        );

        let auth_path = context.codex_home.join(AUTH_FILE);
        let credential_store = detect_credential_store(context.codex_home);
        let mut live = "none";
        let mut unmanaged = None;
        let mut native_error = None;
        let mut live_key: Option<String> = None;
        match read_agent_bytes(&auth_path).and_then(|bytes| parse_native_auth(bytes.as_deref())) {
            Ok(NativeAuth::Missing) => {}
            Ok(NativeAuth::ApiKey) => live = "api_key",
            Ok(NativeAuth::OAuth(credential)) => match credential.identity() {
                Ok(identity) => {
                    if store.account(&identity.key).is_some() {
                        live = "managed";
                        // Capture tokens the native client refreshed since the last visit.
                        match vault.entries.get_mut(&identity.key) {
                            Some(entry) => {
                                if reconcile(entry, &credential, now) == Reconcile::Adopted {
                                    report.dirty_vault = true;
                                }
                            }
                            // A reset vault must not strand the login Codex is using right now.
                            None => {
                                vault.entries.insert(
                                    identity.key.clone(),
                                    VaultEntry {
                                        credential,
                                        updated_at: now,
                                    },
                                );
                                report.dirty_vault = true;
                            }
                        }
                        live_key = Some(identity.key);
                    } else {
                        live = "unmanaged";
                        unmanaged = Some(UnmanagedLogin {
                            email: identity.email,
                            plan: identity.plan,
                            account_id_hint: mask_identifier(&identity.account_id),
                        });
                    }
                }
                Err(message) => {
                    live = "error";
                    native_error = Some(message);
                }
            },
            Err(message) => {
                live = "error";
                native_error = Some(message);
            }
        }

        // An unreadable auth.json (for example mid-write by Codex) says nothing about who is active.
        if live == "error" {
            live_key = store.active_native.clone();
        }
        if store.active_native != live_key
            // A first observation (nothing remembered yet) is not a change.
            && (store.active_native.is_some() || store.last_switch.is_some())
        {
            if let Ok(mut external) = self.external.lock() {
                *external = Some(ExternalChange {
                    from: store.active_native.clone(),
                    to: live_key.clone(),
                });
            }
        }
        if store.active_native != live_key {
            store.active_native = live_key.clone();
            report.dirty_store = true;
        }

        if report.dirty_vault || report.dirty_store {
            self.persist(
                report.dirty_store.then_some(&store),
                report.dirty_vault.then_some(&vault),
            )?;
        }

        let email_counts =
            store
                .accounts
                .iter()
                .fold(HashMap::<String, usize>::new(), |mut counts, account| {
                    if let Some(email) = &account.email {
                        *counts.entry(email.to_ascii_lowercase()).or_default() += 1;
                    }
                    counts
                });
        let accounts = store
            .accounts
            .iter()
            .map(|record| {
                let credential = vault
                    .entries
                    .get(&record.key)
                    .map(|entry| &entry.credential);
                let cpa = report.by_key.get(&record.key);
                AccountView {
                    key: record.key.clone(),
                    alias: record.alias.clone(),
                    email: record.email.clone(),
                    plan: record.plan.clone(),
                    account_id_hint: record.account_id_hint.clone(),
                    source_file: cpa
                        .map(|state| state.file_name.clone())
                        .or_else(|| record.source_file.clone()),
                    connected: cpa.is_some(),
                    proxy_disabled: cpa.map(|state| state.disabled),
                    cpa_copy: cpa.map_or(CpaCopy::Missing, |state| state.copy),
                    validity: credential
                        .map_or(CredentialValidity::Expired, |value| value.validity(now)),
                    access_expires_at: credential.and_then(CodexCredential::access_expiry),
                    last_refresh: credential.and_then(|value| value.last_refresh.clone()),
                    active_native: live_key.as_deref() == Some(record.key.as_str()),
                    pinned_slot: if store.pinned.primary.as_deref() == Some(record.key.as_str()) {
                        Some("primary")
                    } else if store.pinned.secondary.as_deref() == Some(record.key.as_str()) {
                        Some("secondary")
                    } else {
                        None
                    },
                    duplicate_email: record.email.as_ref().is_some_and(|email| {
                        email_counts
                            .get(&email.to_ascii_lowercase())
                            .copied()
                            .unwrap_or(0)
                            > 1
                    }),
                    added_at: record.added_at,
                    last_synced_at: record.last_synced_at,
                    last_activated_at: record.last_activated_at,
                }
            })
            .collect();

        Ok(AccountsSnapshot {
            accounts,
            pinned: store.pinned.clone(),
            active_native: live_key,
            native: NativeView {
                live,
                unmanaged,
                credential_store,
                auth_path: path_to_string(&auth_path),
                error: native_error,
                running: context.running.clone(),
            },
            desktop: DesktopView {
                status: "unverified",
                note: DESKTOP_NOTE,
            },
            settings: store.settings.clone(),
            last_switch: store.last_switch.clone(),
            external_change: self.external.lock().ok().and_then(|change| change.clone()),
            recovery: self.recovery.lock().ok().and_then(|report| report.clone()),
            issues: report.issues,
            protection: self.vault.protection(),
            generated_at: now,
        })
    }

    // ----- Simple metadata operations --------------------------------------------------------

    pub(crate) fn rename(&self, key: &str, alias: &str) -> Result<(), String> {
        let _guard = self.lock()?;
        let mut store = load_store(&self.directory)?;
        store.rename(key, alias)?;
        save_store(&self.directory, &store)
    }

    pub(crate) fn set_pinned(
        &self,
        primary: Option<String>,
        secondary: Option<String>,
    ) -> Result<(), String> {
        let _guard = self.lock()?;
        let mut store = load_store(&self.directory)?;
        store.set_pinned(primary, secondary)?;
        save_store(&self.directory, &store)
    }

    pub(crate) fn update_settings(
        &self,
        mut settings: AccountSettings,
    ) -> Result<AccountSettings, String> {
        let _guard = self.lock()?;
        StoreData::sanitize_settings(&mut settings);
        let mut store = load_store(&self.directory)?;
        store.settings = settings.clone();
        save_store(&self.directory, &store)?;
        Ok(settings)
    }

    pub(crate) fn settings(&self) -> Result<AccountSettings, String> {
        let _guard = self.lock()?;
        Ok(load_store(&self.directory)?.settings)
    }

    /// Forget an account (store + vault). CPA credential files and Codex files are never touched.
    pub(crate) fn remove(&self, key: &str) -> Result<(), String> {
        let _guard = self.lock()?;
        let (mut store, mut vault) = self.load()?;
        if !store.remove(key) {
            return Err("Unknown Codex account".into());
        }
        if store.active_native.as_deref() == Some(key) {
            store.active_native = None;
        }
        vault.entries.remove(key);
        // Metadata first: a failure between the two writes leaves an unreferenced (harmless) vault
        // entry instead of an account whose credentials are gone.
        save_store(&self.directory, &store)?;
        self.vault.save(&vault)
    }

    // ----- Adopt the live login --------------------------------------------------------------

    /// Explicitly add the login currently in native `auth.json` as a new managed account.
    pub(crate) fn adopt_live(
        &self,
        codex_home: &Path,
        alias: &str,
        now: i64,
    ) -> Result<String, String> {
        let _guard = self.lock()?;
        let (mut store, mut vault) = self.load()?;
        let bytes = read_agent_bytes(&codex_home.join(AUTH_FILE))?;
        let NativeAuth::OAuth(credential) = parse_native_auth(bytes.as_deref())? else {
            return Err("Codex has no ChatGPT login to add".into());
        };
        let identity = credential.identity()?;
        if store.account(&identity.key).is_some() {
            return Err("This Codex login is already managed".into());
        }
        let alias = store.validate_alias("", alias)?;
        let mut record = record_from(&store, &identity, None, now);
        record.alias = alias;
        record.last_activated_at = Some(now);
        store.accounts.push(record);
        store.active_native = Some(identity.key.clone());
        vault.entries.insert(
            identity.key.clone(),
            VaultEntry {
                credential,
                updated_at: now,
            },
        );
        self.persist(Some(&store), Some(&vault))?;
        Ok(identity.key)
    }

    // ----- Switching -------------------------------------------------------------------------

    pub(crate) fn switch(
        &self,
        env: &SwitchEnv<'_>,
        target: &str,
    ) -> Result<SwitchOutcome, String> {
        self.switch_with(env, target, &mut atomic_images_writer)
    }

    pub(crate) fn switch_with<W>(
        &self,
        env: &SwitchEnv<'_>,
        target: &str,
        writer: &mut W,
    ) -> Result<SwitchOutcome, String>
    where
        W: FnMut(&str, &Images) -> Result<(), String>,
    {
        let started = Instant::now();
        let _config_guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
        let _guard = self.lock()?;
        let (mut store, mut vault) = self.load()?;
        let block = |code: &'static str, message: &str, from: Option<String>| {
            Ok(blocked(code, message, from, target, Vec::new()))
        };

        let Some(record) = store.account(target).cloned() else {
            return block(
                "target_unknown",
                "The selected account is not managed by the Account Center",
                None,
            );
        };
        let Some(target_entry) = vault.entries.get(target).cloned() else {
            return block(
                "target_missing_credentials",
                "No saved credentials exist for this account; add it again",
                None,
            );
        };
        let credential_store = detect_credential_store(env.codex_home);
        if !credential_store.supported {
            return block("unsupported_store", &credential_store.detail, None);
        }
        let auth_path = env.codex_home.join(AUTH_FILE);
        let state_path = env.codex_home.join(CODEX_NATIVE_OAUTH_STATE_FILE);
        let paths = vec![auth_path.clone(), state_path.clone()];
        let before = config_images(&paths)?;
        if self.directory.join(JOURNAL_FILE).exists() {
            return block(
                "recovery_pending",
                "A previous account switch was interrupted and is still being recovered; try again in a moment",
                None,
            );
        }

        // Identity of whatever Codex holds right now.
        let mut from_key = None;
        // The live copy of the active account is older than the saved one (another writer refreshed).
        let mut live_is_stale = false;
        match parse_native_auth(before[0].1.as_deref()) {
            Err(message) => return block("live_auth_corrupt", &message, None),
            Ok(NativeAuth::ApiKey) => {
                return block(
                    "api_key_mode",
                    "Codex is using an API key (for example CPA proxy access). Switch Codex to ChatGPT sign-in first; an account switch would replace that key",
                    None,
                );
            }
            Ok(NativeAuth::Missing) => {}
            Ok(NativeAuth::OAuth(live)) => match live.identity() {
                Err(message) => return block("live_identity_unverifiable", &message, None),
                Ok(identity) => {
                    if store.account(&identity.key).is_some() {
                        let inserted = !vault.entries.contains_key(&identity.key);
                        if inserted {
                            // Vault was reset while this login was live: keep the session.
                            vault.entries.insert(
                                identity.key.clone(),
                                VaultEntry {
                                    credential: live.clone(),
                                    updated_at: env.now,
                                },
                            );
                        }
                        let outcome = reconcile(
                            vault.entries.get_mut(&identity.key).expect("entry exists"),
                            &live,
                            env.now,
                        );
                        live_is_stale = outcome == Reconcile::KeptNewer;
                        if inserted || outcome == Reconcile::Adopted {
                            // Persist refreshed tokens first: this is worth keeping even if the switch fails.
                            self.vault.save(&vault)?;
                        }
                        from_key = Some(identity.key);
                    } else {
                        return block(
                            "unknown_live_identity",
                            "Codex is signed in to an account that is not managed here. Add it to the Account Center before switching so its session is not lost",
                            None,
                        );
                    }
                }
            },
        }
        let mut target_entry = vault.entries.get(target).cloned().unwrap_or(target_entry);

        if from_key.as_deref() == Some(target) && !live_is_stale {
            store.active_native = Some(target.to_string());
            save_store(&self.directory, &store)?;
            return Ok(SwitchOutcome {
                status: "unchanged",
                code: None,
                message: format!("{} is already the active Codex account", record.alias),
                from: from_key,
                to: target.to_string(),
                restart_required: false,
                desktop: "unverified",
                running: Vec::new(),
                timings: None,
            });
        }

        // Validate the target: stored identity must still match, and it must be usable.
        let validate_started = Instant::now();
        match target_entry.credential.identity() {
            Ok(identity) if identity.key == target => {}
            _ => {
                return block(
                    "identity_mismatch",
                    "The saved credentials no longer match this account; re-authenticate it",
                    from_key,
                );
            }
        }
        if target_entry.credential.validity(env.now) == CredentialValidity::Expired {
            return block(
                "target_expired",
                "This account's login has expired; re-authenticate it first",
                from_key,
            );
        }
        if !target_entry.credential.is_complete() {
            return block(
                "target_incomplete",
                "The saved credentials are missing token parts; re-authenticate this account",
                from_key,
            );
        }
        let validate_ms = millis(validate_started);

        // Build the new file images; unrelated fields in auth.json are preserved.
        let mut after_auth = render_native_auth(before[0].1.as_deref(), &target_entry.credential)?;
        let mut after_state = before[1].1.clone();
        if let Some(bytes) = before[1].1.as_deref() {
            // The existing access-mode record caches a full auth.json: never leave a stale account there.
            if let Ok(serde_json::Value::Object(mut record_root)) = serde_json::from_slice(bytes) {
                if record_root
                    .get("native_auth")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    let rendered = String::from_utf8(after_auth.clone())
                        .map_err(|_| "Failed to render Codex auth.json".to_string())?;
                    record_root.insert("native_auth".into(), serde_json::Value::String(rendered));
                    after_state = Some(
                        serde_json::to_vec_pretty(&serde_json::Value::Object(record_root))
                            .map_err(|_| {
                                "Failed to update the Codex access mode record".to_string()
                            })?,
                    );
                }
            }
        }
        after_auth.push(b'\n');
        let after: Images = vec![
            (auth_path.clone(), Some(after_auth)),
            (state_path.clone(), after_state),
        ];

        // Block while Codex may hold (and later rewrite) credentials in memory. Checked last, right
        // before the first write, and fail closed when the scan itself cannot be completed.
        match (env.process_scan)() {
            Err(message) => {
                return block(
                    "process_scan_failed",
                    &format!("{message}; cannot confirm Codex is closed, so the account was not switched"),
                    from_key,
                );
            }
            Ok(running) if !running.is_empty() => {
                return Ok(blocked(
                    "codex_running",
                    "Codex is running. Close Codex (CLI sessions and the desktop app), then switch. Running sessions would keep the previous account and may overwrite the new credentials",
                    from_key,
                    target,
                    running,
                ));
            }
            Ok(_) => {}
        }

        // Write-ahead journal (sealed) so a crash at any point is recoverable.
        let journal = SwitchJournal {
            started_at: env.now,
            target_key: target.to_string(),
            from_key: from_key.clone(),
            files: before
                .iter()
                .zip(&after)
                .map(|((path, old), (_, new))| JournalFile {
                    path: path.clone(),
                    before_hash: image_hash(old.as_deref()),
                    after_hash: image_hash(new.as_deref()),
                    before: old.clone(),
                })
                .collect(),
        };
        let journal_path = self.directory.join(JOURNAL_FILE);
        let sealed = self.vault.seal(
            JOURNAL_LABEL,
            &serde_json::to_vec(&journal)
                .map_err(|_| "Failed to prepare the switch journal".to_string())?,
        )?;
        write_private_atomic(&journal_path, &sealed)?;

        let write_started = Instant::now();
        if let Err(error) = commit_config_with_writer(
            "codex",
            &paths,
            &before,
            &after,
            "account-switch",
            None,
            None,
            writer,
        ) {
            // The shared transaction already restored the previous images (or reported it could not).
            if config_images(&paths).is_ok_and(|current| current == before) {
                let _ = fs::remove_file(&journal_path);
            }
            return Err(error);
        }
        let write_ms = millis(write_started);

        // Verify the identity that is actually live now; roll back if it is not the target.
        let verify_started = Instant::now();
        let verified = config_images(&paths).ok().and_then(|current| {
            match parse_native_auth(current[0].1.as_deref()) {
                Ok(NativeAuth::OAuth(live)) => live
                    .identity()
                    .ok()
                    .filter(|identity| identity.key == target),
                _ => None,
            }
        });
        if verified.is_none() {
            let restored = writer("codex", &before).is_ok()
                && config_images(&paths).is_ok_and(|current| current == before);
            if restored {
                let _ = fs::remove_file(&journal_path);
            }
            return Err(if restored {
                "Switching could not be verified; the previous Codex account was restored".into()
            } else {
                "Switching could not be verified and restoring failed; restart the app to run crash recovery".into()
            });
        }
        let verify_ms = millis(verify_started);

        target_entry.updated_at = env.now;
        store.active_native = Some(target.to_string());
        store.last_switch = Some(SwitchRecord {
            from: from_key.clone(),
            to: target.to_string(),
            at: env.now,
        });
        if let Some(record) = store.account_mut(target) {
            record.last_activated_at = Some(env.now);
        }
        // Keep the journal if the metadata cannot be saved: startup recovery sees every file already
        // switched and completes the bookkeeping instead of losing it.
        save_store(&self.directory, &store).map_err(|_| {
            "Codex was switched, but the account list could not be updated; it will be reconciled on next start"
                .to_string()
        })?;
        let _ = fs::remove_file(&journal_path);
        if let Ok(mut external) = self.external.lock() {
            *external = None;
        }

        Ok(SwitchOutcome {
            status: "switched",
            code: None,
            message: if from_key.as_deref() == Some(target) {
                format!("Refreshed the Codex login for {}", record.alias)
            } else {
                format!("Codex now uses {}", record.alias)
            },
            from: from_key,
            to: target.to_string(),
            restart_required: true,
            desktop: "unverified",
            running: Vec::new(),
            timings: Some(SwitchTimings {
                validate_ms,
                write_ms,
                verify_ms,
                total_ms: millis(started),
            }),
        })
    }

    // ----- Crash recovery --------------------------------------------------------------------

    /// Examine a journal left by an interrupted switch. Never overwrites newer credentials:
    /// files that diverged from both the before and after images are left alone.
    pub(crate) fn recover(&self, now: i64) -> Result<Option<RecoveryReport>, String> {
        let _config_guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
        let _guard = self.lock()?;
        let journal_path = self.directory.join(JOURNAL_FILE);
        let sealed = match fs::read(&journal_path) {
            Ok(sealed) => sealed,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Unable to read the switch journal".into()),
        };
        let report = |outcome: &'static str, message: &str| RecoveryReport {
            outcome,
            message: message.to_string(),
            at: now,
        };
        let journal: SwitchJournal =
            match self
                .vault
                .open_sealed(JOURNAL_LABEL, &sealed)
                .and_then(|plain| {
                    serde_json::from_slice(&plain)
                        .map_err(|_| "Switch journal is corrupted".to_string())
                }) {
                Ok(journal) => journal,
                Err(message) => {
                    // Keep the evidence; do not guess.
                    let _ = fs::rename(
                        &journal_path,
                        self.directory
                            .join(format!("{JOURNAL_FILE}.unreadable-{now}")),
                    );
                    let result = report("failed", &message);
                    *self
                        .recovery
                        .lock()
                        .map_err(|_| "Recovery state lock is poisoned".to_string())? =
                        Some(result.clone());
                    return Ok(Some(result));
                }
            };
        let paths = journal
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        let current = config_images(&paths)?;
        let observed = current
            .iter()
            .map(|(_, bytes)| bytes.clone())
            .collect::<Vec<_>>();
        let result = match plan_recovery(&journal, &observed) {
            RecoveryAction::Untouched => {
                let _ = fs::remove_file(&journal_path);
                report(
                    "untouched",
                    "An interrupted account switch had not changed any files",
                )
            }
            RecoveryAction::Completed => {
                let mut store = load_store(&self.directory)?;
                store.active_native = Some(journal.target_key.clone());
                store.last_switch = Some(SwitchRecord {
                    from: journal.from_key.clone(),
                    to: journal.target_key.clone(),
                    at: journal.started_at,
                });
                if let Some(record) = store.account_mut(&journal.target_key) {
                    record.last_activated_at = Some(journal.started_at);
                }
                save_store(&self.directory, &store)?;
                let _ = fs::remove_file(&journal_path);
                report(
                    "completed",
                    "An interrupted account switch had completed; state was updated",
                )
            }
            RecoveryAction::RollBack(indexes) => {
                let restore: Images = indexes
                    .into_iter()
                    .map(|index| {
                        (
                            journal.files[index].path.clone(),
                            journal.files[index].before.clone(),
                        )
                    })
                    .collect();
                let paths_to_check = restore
                    .iter()
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>();
                atomic_images_writer("codex", &restore)?;
                if config_images(&paths_to_check)? != restore {
                    return Err(
                        "Restoring the interrupted account switch could not be verified".into(),
                    );
                }
                let _ = fs::remove_file(&journal_path);
                report(
                    "rolled_back",
                    "An interrupted account switch was rolled back",
                )
            }
            RecoveryAction::Diverged => {
                let _ = fs::rename(
                    &journal_path,
                    self.directory
                        .join(format!("{JOURNAL_FILE}.diverged-{now}")),
                );
                report(
                    "diverged",
                    "Codex credentials changed after an interrupted account switch; they were left untouched",
                )
            }
        };
        *self
            .recovery
            .lock()
            .map_err(|_| "Recovery state lock is poisoned".to_string())? = Some(result.clone());
        Ok(Some(result))
    }
}
