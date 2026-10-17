use super::engine::{AccountEngine, AccountsSnapshot, StateContext, SwitchEnv, SwitchOutcome};
use super::hotkey::validate_accelerator;
use super::identity::unix_now;
use super::native::{running_codex_processes, RunningCodex};
use super::recommend::{recommend, sanitize_summaries, QuotaSummary, Recommendation};
use super::store::AccountSettings;
use super::vault::platform_protector;
use super::*;
use std::sync::{atomic::AtomicU64, Arc};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

pub(crate) const CODEX_ACCOUNTS_CHANGED_EVENT: &str = "codex-accounts-changed";
pub(crate) const CODEX_ACCOUNTS_REFRESH_EVENT: &str = "codex-accounts-refresh-request";
pub(crate) const CODEX_ACCOUNTS_OPEN_EVENT: &str = "codex-accounts-open";
const PROCESS_CACHE_SECONDS: u64 = 5;

/// Directory for the vault and account metadata: per-user, outside the (portable) app folder.
fn accounts_directory() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CPA_CODEX_ACCOUNTS_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    #[cfg(windows)]
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base =
        env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    base.map(|base| base.join("EasyCLIProxyAPI").join("codex-accounts"))
        .ok_or_else(|| "Unable to determine the per-user data directory".to_string())
}

pub(crate) struct CodexAccountsState {
    engine: Result<Arc<AccountEngine>, String>,
    quota: Mutex<Vec<QuotaSummary>>,
    /// `(ticket, snapshot)`: a slower, older refresh must not overwrite a newer snapshot.
    snapshot: Mutex<Option<(u64, AccountsSnapshot)>>,
    snapshot_ticket: AtomicU64,
    processes: Mutex<Option<(Instant, Vec<RunningCodex>)>>,
    /// Last tray/hotkey action result, shown in the tray header.
    last_message: Mutex<Option<String>>,
    busy: AtomicBool,
}

impl Default for CodexAccountsState {
    fn default() -> Self {
        let engine = accounts_directory()
            .and_then(|directory| AccountEngine::new(directory, platform_protector()))
            .map(Arc::new);
        Self {
            engine,
            quota: Mutex::default(),
            snapshot: Mutex::default(),
            snapshot_ticket: AtomicU64::new(0),
            processes: Mutex::default(),
            last_message: Mutex::default(),
            busy: AtomicBool::new(false),
        }
    }
}

impl CodexAccountsState {
    fn engine(&self) -> Result<Arc<AccountEngine>, String> {
        self.engine.clone()
    }

    pub(crate) fn cached_snapshot(&self) -> Option<AccountsSnapshot> {
        self.snapshot
            .lock()
            .ok()
            .and_then(|snapshot| snapshot.as_ref().map(|(_, snapshot)| snapshot.clone()))
    }

    pub(crate) fn quota_summaries(&self) -> Vec<QuotaSummary> {
        self.quota
            .lock()
            .map(|quota| quota.clone())
            .unwrap_or_default()
    }

    pub(crate) fn status_message(&self) -> Option<String> {
        self.last_message
            .lock()
            .ok()
            .and_then(|message| message.clone())
    }

    fn set_message(&self, message: Option<String>) {
        if let Ok(mut current) = self.last_message.lock() {
            *current = message;
        }
    }

    pub(crate) fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    fn processes(&self, force: bool) -> Result<Vec<RunningCodex>, String> {
        if !force {
            if let Ok(cache) = self.processes.lock() {
                if let Some((at, found)) = cache.as_ref() {
                    if at.elapsed() < Duration::from_secs(PROCESS_CACHE_SECONDS) {
                        return Ok(found.clone());
                    }
                }
            }
        }
        let found = running_codex_processes()?;
        if let Ok(mut cache) = self.processes.lock() {
            *cache = Some((Instant::now(), found.clone()));
        }
        Ok(found)
    }
}

struct Paths {
    cpa_dir: PathBuf,
    codex_home: PathBuf,
}

fn resolve_paths(app: &tauri::AppHandle) -> Result<Paths, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Failed to get user directory".to_string())?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    Ok(Paths {
        cpa_dir: auth_dir_path_for_core(&config.auth_dir, &core_install_dir()?)?,
        codex_home: codex_configuration_directory(&home),
    })
}

/// Rebuild the cached snapshot from disk (no process scan unless asked) and tell the UI + tray.
fn refresh_snapshot(
    app: &tauri::AppHandle,
    include_processes: bool,
    announce: bool,
) -> Result<AccountsSnapshot, String> {
    let state = app.state::<CodexAccountsState>();
    let engine = state.engine()?;
    let paths = resolve_paths(app)?;
    let running = if include_processes {
        state.processes(true).ok()
    } else {
        None
    };
    let ticket = state.snapshot_ticket.fetch_add(1, Ordering::AcqRel);
    let snapshot = engine.state(&StateContext {
        cpa_dir: &paths.cpa_dir,
        codex_home: &paths.codex_home,
        now: unix_now(),
        running,
    })?;
    if let Ok(mut cache) = state.snapshot.lock() {
        if cache.as_ref().is_none_or(|(held, _)| *held < ticket) {
            *cache = Some((ticket, snapshot.clone()));
        }
    }
    refresh_tray(app);
    if announce {
        let _ = app.emit(CODEX_ACCOUNTS_CHANGED_EVENT, "state");
    }
    Ok(snapshot)
}

fn refresh_tray(app: &tauri::AppHandle) {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    super::tray_menu::update_codex_tray(app);
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = app;
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    let enabled = app
        .state::<CodexAccountsState>()
        .cached_snapshot()
        .is_some_and(|snapshot| snapshot.settings.notifications);
    if enabled {
        if let Err(error) = app.notification().builder().title(title).body(body).show() {
            eprintln!("Failed to show a Codex account notification: {error}");
        }
    }
}

pub(crate) enum SwitchTarget {
    Account(String),
    Toggle,
}

/// Shared by the UI command, the tray and the global shortcut.
pub(crate) fn perform_codex_account_switch(
    app: &tauri::AppHandle,
    target: SwitchTarget,
) -> Result<SwitchOutcome, String> {
    let state = app.state::<CodexAccountsState>();
    if state
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("An account switch is already in progress".into());
    }
    refresh_tray(app);
    let result = (|| {
        let engine = state.engine()?;
        let paths = resolve_paths(app)?;
        // Sync first so the freshest tokens (CPA refresh or native refresh) are what gets written.
        let snapshot = refresh_snapshot(app, false, false)?;
        let key = match target {
            SwitchTarget::Account(key) => key,
            SwitchTarget::Toggle => {
                let (Some(primary), Some(secondary)) =
                    (&snapshot.pinned.primary, &snapshot.pinned.secondary)
                else {
                    return Err("Pin two accounts to use the quick-switch toggle".to_string());
                };
                if snapshot.active_native.as_deref() == Some(primary.as_str()) {
                    secondary.clone()
                } else {
                    primary.clone()
                }
            }
        };
        let outcome = engine.switch(
            &SwitchEnv {
                codex_home: &paths.codex_home,
                process_scan: &|| state.processes(true),
                now: unix_now(),
            },
            &key,
        )?;
        Ok(outcome)
    })();
    state.busy.store(false, Ordering::Release);
    match &result {
        Ok(outcome) => {
            state.set_message(Some(outcome.message.clone()));
            let title = if outcome.status == "blocked" {
                "Codex account not switched"
            } else {
                "Codex account"
            };
            notify(app, title, &outcome.message);
        }
        Err(error) => {
            state.set_message(Some(error.clone()));
            notify(app, "Codex account switch failed", error);
        }
    }
    let _ = refresh_snapshot(app, false, true);
    result
}

/// Called by the file watcher when the live Codex `auth.json` changed outside this app.
pub(crate) fn notify_codex_native_auth_changed(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = refresh_snapshot(&app, false, true) {
            eprintln!("Failed to refresh Codex accounts after an auth.json change: {error}");
        }
    });
}

/// Startup: recover an interrupted switch, load state, apply the saved shortcut.
pub(crate) fn initialize_codex_accounts(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CodexAccountsState>();
        match state.engine().and_then(|engine| engine.recover(unix_now())) {
            Ok(Some(report)) => {
                eprintln!("Codex account recovery: {}", report.message);
                notify(&app, "Codex account recovery", &report.message);
            }
            Ok(None) => {}
            Err(error) => eprintln!("Codex account recovery failed: {error}"),
        }
        match refresh_snapshot(&app, false, true) {
            Ok(snapshot) => {
                if let Some(accelerator) = snapshot.settings.hotkey.clone() {
                    if let Err(error) = apply_hotkey(&app, Some(&accelerator)) {
                        eprintln!("Failed to register the Codex account shortcut: {error}");
                    }
                }
            }
            Err(error) => eprintln!("Failed to load Codex accounts: {error}"),
        }
    });
}

fn apply_hotkey(app: &tauri::AppHandle, accelerator: Option<&str>) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    shortcuts
        .unregister_all()
        .map_err(|error| format!("Failed to clear the previous shortcut: {error}"))?;
    let Some(accelerator) = accelerator else {
        return Ok(());
    };
    let accelerator = validate_accelerator(accelerator)?;
    shortcuts
        .on_shortcut(accelerator.as_str(), |app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                // Result feedback (tray header + optional notification) is handled by the switch itself.
                let _ = perform_codex_account_switch(&app, SwitchTarget::Toggle);
            });
        })
        .map_err(|error| format!("The shortcut could not be registered (it may be in use by another application): {error}"))
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "Codex account task failed".to_string())?
}

#[tauri::command]
pub(crate) async fn codex_accounts_get_state(
    app: tauri::AppHandle,
    include_processes: bool,
) -> Result<AccountsSnapshot, String> {
    blocking(move || refresh_snapshot(&app, include_processes, false)).await
}

#[tauri::command]
pub(crate) async fn codex_accounts_switch(
    app: tauri::AppHandle,
    key: String,
) -> Result<SwitchOutcome, String> {
    blocking(move || perform_codex_account_switch(&app, SwitchTarget::Account(key))).await
}

#[tauri::command]
pub(crate) async fn codex_accounts_toggle(app: tauri::AppHandle) -> Result<SwitchOutcome, String> {
    blocking(move || perform_codex_account_switch(&app, SwitchTarget::Toggle)).await
}

#[tauri::command]
pub(crate) async fn codex_accounts_rename(
    app: tauri::AppHandle,
    key: String,
    alias: String,
) -> Result<(), String> {
    blocking(move || {
        app.state::<CodexAccountsState>()
            .engine()?
            .rename(&key, &alias)?;
        let _ = refresh_snapshot(&app, false, true);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn codex_accounts_set_pinned(
    app: tauri::AppHandle,
    primary: Option<String>,
    secondary: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        app.state::<CodexAccountsState>()
            .engine()?
            .set_pinned(primary, secondary)?;
        let _ = refresh_snapshot(&app, false, true);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn codex_accounts_remove(
    app: tauri::AppHandle,
    key: String,
) -> Result<(), String> {
    blocking(move || {
        app.state::<CodexAccountsState>().engine()?.remove(&key)?;
        let _ = refresh_snapshot(&app, false, true);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn codex_accounts_adopt_live(
    app: tauri::AppHandle,
    alias: String,
) -> Result<String, String> {
    blocking(move || {
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
        let paths = resolve_paths(&app)?;
        let key = app.state::<CodexAccountsState>().engine()?.adopt_live(
            &paths.codex_home,
            &alias,
            unix_now(),
        )?;
        drop(_guard);
        let _ = refresh_snapshot(&app, false, true);
        Ok(key)
    })
    .await
}

#[tauri::command]
pub(crate) async fn codex_accounts_update_settings(
    app: tauri::AppHandle,
    settings: AccountSettings,
) -> Result<AccountSettings, String> {
    blocking(move || {
        if let Some(accelerator) = settings
            .hotkey
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            validate_accelerator(accelerator)?;
        }
        let engine = app.state::<CodexAccountsState>().engine()?;
        let previous = engine.settings()?;
        let saved = engine.update_settings(settings)?;
        if saved.hotkey != previous.hotkey {
            if let Err(error) = apply_hotkey(&app, saved.hotkey.as_deref()) {
                // Roll the setting back: a saved-but-dead shortcut would mislead.
                let _ = engine.update_settings(previous);
                let _ = apply_hotkey(
                    &app,
                    engine
                        .settings()
                        .ok()
                        .and_then(|value| value.hotkey)
                        .as_deref(),
                );
                return Err(error);
            }
        }
        let _ = refresh_snapshot(&app, false, true);
        Ok(saved)
    })
    .await
}

#[tauri::command]
pub(crate) async fn codex_accounts_publish_quota(
    app: tauri::AppHandle,
    summaries: Vec<QuotaSummary>,
) -> Result<Recommendation, String> {
    blocking(move || {
        let state = app.state::<CodexAccountsState>();
        let summaries = sanitize_summaries(summaries, unix_now());
        if let Ok(mut quota) = state.quota.lock() {
            *quota = summaries;
        }
        refresh_tray(&app);
        current_recommendation(&app)
    })
    .await
}

fn current_recommendation(app: &tauri::AppHandle) -> Result<Recommendation, String> {
    let state = app.state::<CodexAccountsState>();
    let snapshot = state
        .cached_snapshot()
        .ok_or("Codex accounts are not loaded yet")?;
    Ok(recommend(
        &snapshot.pinned,
        &snapshot.settings,
        &state.quota_summaries(),
        unix_now(),
    ))
}

#[tauri::command]
pub(crate) async fn codex_accounts_recommendation(
    app: tauri::AppHandle,
) -> Result<Recommendation, String> {
    blocking(move || current_recommendation(&app)).await
}

#[tauri::command]
pub(crate) fn codex_accounts_ack_external_change(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<CodexAccountsState>()
        .engine()?
        .acknowledge_external_change();
    Ok(())
}

#[tauri::command]
pub(crate) async fn codex_accounts_reset_vault(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || {
        app.state::<CodexAccountsState>()
            .engine()?
            .quarantine_vault()?;
        let _ = refresh_snapshot(&app, false, true);
        Ok(())
    })
    .await
}
