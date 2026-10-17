//! "Codex Accounts" section of the Windows/Linux tray menu. Entries are computed by a pure function
//! (testable) and applied to a native submenu on the main thread only when state changes.
use super::engine::AccountsSnapshot;
use super::recommend::{tray_lines, QuotaSummary};
use super::*;
use crate::native_i18n::{native_text, NativeText};
use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};

pub(crate) const CODEX_TRAY_SUBMENU_ID: &str = "codex-accounts";
const SWITCH_PREFIX: &str = "codex-switch:";
const TOGGLE_ID: &str = "codex-toggle";
const REFRESH_ID: &str = "codex-refresh";
const OPEN_ID: &str = "codex-open";
const MESSAGE_LIMIT: usize = 56;

pub(crate) struct CodexTrayMenu(pub(crate) Submenu<tauri::Wry>);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    Separator,
    Item {
        id: String,
        text: String,
        enabled: bool,
    },
}

fn info(text: String) -> Entry {
    // Ids of informational rows are assigned once the full list is known (see `build_entries`).
    Entry::Item {
        id: String::new(),
        text,
        enabled: false,
    }
}

fn action(id: impl Into<String>, text: String, enabled: bool) -> Entry {
    Entry::Item {
        id: id.into(),
        text,
        enabled,
    }
}

fn truncate(message: &str) -> String {
    let mut text = message.chars().take(MESSAGE_LIMIT).collect::<String>();
    if message.chars().count() > MESSAGE_LIMIT {
        text.push('…');
    }
    text
}

/// Pure menu model. Quota numbers come only from the pushed summaries; anything missing or old is
/// labelled as such instead of guessed.
pub(crate) fn build_entries(
    locale: &str,
    snapshot: Option<&AccountsSnapshot>,
    summaries: &[QuotaSummary],
    now: i64,
    busy: bool,
    message: Option<&str>,
) -> Vec<Entry> {
    let text = |item| native_text(locale, item);
    let refresh = action(REFRESH_ID, text(NativeText::CodexRefresh).into(), !busy);
    let open = action(OPEN_ID, text(NativeText::CodexOpenCenter).into(), true);
    let Some(snapshot) = snapshot.filter(|snapshot| !snapshot.accounts.is_empty()) else {
        let mut entries = vec![
            info(text(NativeText::CodexNoAccounts).into()),
            Entry::Separator,
            open,
        ];
        number_info_rows(&mut entries);
        return entries;
    };
    let active = snapshot
        .accounts
        .iter()
        .find(|account| account.active_native)
        .map_or(text(NativeText::CodexNoActive), |account| {
            account.alias.as_str()
        });
    let mut entries = vec![info(format!("{}: {active}", text(NativeText::CodexActive)))];
    if busy {
        entries.push(info(text(NativeText::CodexSwitching).into()));
    } else if let Some(message) = message {
        entries.push(info(truncate(message)));
    }
    entries.push(Entry::Separator);

    let mut lines = tray_lines(snapshot, summaries, now);
    let pinned_rank = |key: &str| {
        if snapshot.pinned.primary.as_deref() == Some(key) {
            0
        } else if snapshot.pinned.secondary.as_deref() == Some(key) {
            1
        } else {
            2
        }
    };
    lines.sort_by_key(|line| pinned_rank(&line.key));
    for line in &lines {
        let marker = if line.active { "● " } else { "   " };
        let detail = match line.remaining_pct {
            None => text(NativeText::CodexQuotaUnavailable).to_string(),
            Some(pct) if line.stale => {
                format!(
                    "{pct:.0}% {} ({})",
                    text(NativeText::CodexRemaining),
                    text(NativeText::CodexStale)
                )
            }
            Some(pct) => format!("{pct:.0}% {}", text(NativeText::CodexRemaining)),
        };
        entries.push(info(format!("{marker}{} — {detail}", line.alias)));
    }
    entries.push(Entry::Separator);

    let mut pinned_ready = 0;
    for key in [&snapshot.pinned.primary, &snapshot.pinned.secondary]
        .into_iter()
        .flatten()
    {
        if let Some(account) = snapshot.accounts.iter().find(|account| &account.key == key) {
            pinned_ready += 1;
            entries.push(action(
                format!("{SWITCH_PREFIX}{key}"),
                format!("{} {}", text(NativeText::CodexSwitchTo), account.alias),
                !busy && !account.active_native,
            ));
        }
    }
    entries.push(action(
        TOGGLE_ID,
        text(NativeText::CodexToggle).into(),
        !busy && pinned_ready == 2,
    ));
    entries.push(Entry::Separator);
    entries.push(refresh);
    entries.push(open);
    number_info_rows(&mut entries);
    entries
}

fn number_info_rows(entries: &mut [Entry]) {
    for (index, entry) in entries.iter_mut().enumerate() {
        if let Entry::Item { id, .. } = entry {
            if id.is_empty() {
                *id = format!("codex-info-{index}");
            }
        }
    }
}

fn apply(
    submenu: &Submenu<tauri::Wry>,
    app: &tauri::AppHandle,
    entries: &[Entry],
) -> tauri::Result<()> {
    for item in submenu.items()? {
        submenu.remove(&item)?;
    }
    for entry in entries {
        match entry {
            Entry::Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Item { id, text, enabled } => {
                submenu.append(&MenuItem::with_id(app, id, text, *enabled, None::<&str>)?)?
            }
        }
    }
    Ok(())
}

fn locale(app: &tauri::AppHandle) -> String {
    app.state::<GuiConfigState>()
        .snapshot()
        .map(|config| config.locale)
        .unwrap_or_else(|_| "en".into())
}

/// Create the submenu (initially "loading"-free: just the open action) during tray setup.
pub(crate) fn create_submenu(
    app: &tauri::App<tauri::Wry>,
    locale: &str,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let submenu = Submenu::with_id(
        app,
        CODEX_TRAY_SUBMENU_ID,
        native_text(locale, NativeText::CodexAccounts),
        true,
    )?;
    apply(
        &submenu,
        app.handle(),
        &build_entries(locale, None, &[], 0, false, None),
    )?;
    Ok(submenu)
}

pub(crate) fn update_codex_tray(app: &tauri::AppHandle) {
    let Some(menu) = app.try_state::<CodexTrayMenu>() else {
        return;
    };
    let submenu = menu.0.clone();
    let handle = app.clone();
    // Entries are computed on the main thread, in queue order, so a stale "Switching…" snapshot
    // can never be applied after a newer one.
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<CodexAccountsState>();
        let locale = locale(&handle);
        let entries = build_entries(
            &locale,
            state.cached_snapshot().as_ref(),
            &state.quota_summaries(),
            identity::unix_now(),
            state.is_busy(),
            state.status_message().as_deref(),
        );
        let title = native_text(&locale, NativeText::CodexAccounts);
        if let Err(error) = submenu
            .set_text(title)
            .and_then(|_| apply(&submenu, &handle, &entries))
        {
            eprintln!("Failed to update the Codex accounts tray section: {error}");
        }
    });
}

/// Returns `true` when the id belonged to this section.
pub(crate) fn handle_menu_event(app: &tauri::AppHandle, id: &str) -> bool {
    if !id.starts_with("codex-") {
        return false;
    }
    let app = app.clone();
    match id {
        TOGGLE_ID => {
            tauri::async_runtime::spawn_blocking(move || {
                let _ = perform_codex_account_switch(&app, SwitchTarget::Toggle);
            });
        }
        REFRESH_ID => {
            let _ = app.emit(CODEX_ACCOUNTS_REFRESH_EVENT, ());
        }
        OPEN_ID => {
            crate::tray::show_windows_main_window(&app);
            let _ = app.emit(CODEX_ACCOUNTS_OPEN_EVENT, ());
        }
        other => {
            if let Some(key) = other.strip_prefix(SWITCH_PREFIX) {
                let key = key.to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = perform_codex_account_switch(&app, SwitchTarget::Account(key));
                });
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::super::engine::{AccountEngine, StateContext};
    use super::super::vault::platform_protector;
    use super::*;

    fn summary(key: &str, short: f64, fetched_at: i64) -> QuotaSummary {
        QuotaSummary {
            key: key.into(),
            short_remaining_pct: Some(short),
            short_reset_at: None,
            weekly_remaining_pct: None,
            weekly_reset_at: None,
            fetched_at,
            status: "ok".into(),
        }
    }

    fn texts(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Item { text, .. } => Some(text.clone()),
                Entry::Separator => None,
            })
            .collect()
    }

    #[test]
    fn menu_reports_real_quota_and_marks_stale_or_missing_data() {
        let root = unique_test_temp_path("codex-tray-model");
        let (cpa, codex) = (root.join("cpa"), root.join("codex"));
        fs::create_dir_all(&cpa).unwrap();
        fs::create_dir_all(&codex).unwrap();
        let credential = |account: &str, user: &str, email: &str| {
            let encode = |value: &[u8]| {
                base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, value)
            };
            let claims = serde_json::json!({
                "email": email,
                "https://api.openai.com/auth": {"chatgpt_account_id": account, "chatgpt_user_id": user}
            });
            serde_json::json!({
                "type": "codex",
                "id_token": format!("{}.{}.s", encode(b"{}"), encode(claims.to_string().as_bytes())),
                "access_token": format!("{}.{}.s", encode(b"{}"), encode(br#"{"iat":1799999000,"exp":1899999999}"#)),
                "refresh_token": "r",
                "account_id": account,
            })
        };
        fs::write(
            cpa.join("a.json"),
            credential("acct-a-000001", "u-a", "a@example.test").to_string(),
        )
        .unwrap();
        fs::write(
            cpa.join("b.json"),
            credential("acct-b-000002", "u-b", "b@example.test").to_string(),
        )
        .unwrap();
        let engine = AccountEngine::new(root.join("accounts"), platform_protector()).unwrap();
        let now = 1_800_000_000;
        let snapshot = engine
            .state(&StateContext {
                cpa_dir: &cpa,
                codex_home: &codex,
                now,
                running: None,
            })
            .unwrap();
        let (a, b) = (
            snapshot.accounts[0].key.clone(),
            snapshot.accounts[1].key.clone(),
        );
        engine.set_pinned(Some(a.clone()), Some(b.clone())).unwrap();
        let snapshot = engine
            .state(&StateContext {
                cpa_dir: &cpa,
                codex_home: &codex,
                now,
                running: None,
            })
            .unwrap();

        let entries = build_entries(
            "en",
            Some(&snapshot),
            &[
                summary(&a, 18.0, now - 60),
                summary(&b, 82.0, now - 10 * 3600),
            ],
            now,
            false,
            None,
        );
        let lines = texts(&entries);
        assert!(
            lines[0].starts_with("Active native account: none"),
            "{lines:?}"
        );
        assert!(lines.iter().any(|line| line.contains("18% remaining")));
        assert!(
            lines
                .iter()
                .any(|line| line.contains("82% remaining (stale)")),
            "{lines:?}"
        );
        assert!(lines.contains(&format!("Switch to {}", snapshot.accounts[0].alias)));
        assert!(entries.iter().any(
            |entry| matches!(entry, Entry::Item { id, enabled: true, .. } if id == TOGGLE_ID)
        ));

        // No quota published for an account: say so instead of inventing a number.
        let lines = texts(&build_entries("en", Some(&snapshot), &[], now, false, None));
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("quota unavailable"))
                .count(),
            2
        );

        // While switching nothing is clickable except Open; localized text is used.
        let busy = build_entries("ja", Some(&snapshot), &[], now, true, None);
        assert!(busy.iter().all(|entry| !matches!(entry, Entry::Item { id, enabled: true, .. } if id.starts_with("codex-switch") || id == TOGGLE_ID || id == REFRESH_ID)));
        assert!(texts(&busy).iter().any(|line| line.contains("切り替え中")));

        // An unpinned pair disables the toggle.
        engine.set_pinned(Some(a), None).unwrap();
        let snapshot = engine
            .state(&StateContext {
                cpa_dir: &cpa,
                codex_home: &codex,
                now,
                running: None,
            })
            .unwrap();
        let entries = build_entries("en", Some(&snapshot), &[], now, false, None);
        assert!(entries.iter().any(
            |entry| matches!(entry, Entry::Item { id, enabled: false, .. } if id == TOGGLE_ID)
        ));

        let empty = build_entries("en", None, &[], now, false, None);
        assert_eq!(
            texts(&empty),
            vec!["No Codex accounts yet", "Open Account Center"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn long_messages_are_truncated_for_the_menu() {
        assert_eq!(
            truncate(&"x".repeat(100)).chars().count(),
            MESSAGE_LIMIT + 1
        );
        assert_eq!(truncate("short"), "short");
    }
}
