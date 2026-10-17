use super::*;

/// How the installed Codex stores `auth.json`-equivalent credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialStoreStatus {
    /// `file`, `keyring`, `auto` or `unknown`.
    pub(crate) mode: String,
    /// Only `file` is switchable: the others keep live credentials outside `auth.json`.
    pub(crate) supported: bool,
    pub(crate) detail: String,
}

/// Read `cli_auth_credentials_store` from the effective Codex `config.toml`.
pub(crate) fn detect_credential_store(codex_home: &Path) -> CredentialStoreStatus {
    let path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => {
            return CredentialStoreStatus {
                mode: "unknown".into(),
                supported: false,
                detail: "Codex config.toml could not be read".into(),
            };
        }
    };
    let configured = match content.as_deref() {
        None => None,
        Some(content) => match toml::from_str::<toml::Value>(content) {
            Ok(value) => value
                .get("cli_auth_credentials_store")
                .and_then(toml::Value::as_str)
                .map(|mode| mode.trim().to_ascii_lowercase()),
            Err(_) => {
                return CredentialStoreStatus {
                    mode: "unknown".into(),
                    supported: false,
                    detail: "Codex config.toml is not valid TOML".into(),
                };
            }
        },
    };
    match configured.as_deref() {
        None | Some("file") => CredentialStoreStatus {
            mode: "file".into(),
            supported: true,
            detail: "Codex keeps credentials in auth.json".into(),
        },
        Some("keyring") => CredentialStoreStatus {
            mode: "keyring".into(),
            supported: false,
            detail: "Codex keeps credentials in the OS credential store; set cli_auth_credentials_store = \"file\" to enable switching".into(),
        },
        Some("auto") => CredentialStoreStatus {
            mode: "auto".into(),
            supported: false,
            detail: "Codex prefers the OS credential store in auto mode, so auth.json may not be the live credential; set cli_auth_credentials_store = \"file\" to enable switching".into(),
        },
        Some(_) => CredentialStoreStatus {
            mode: "unknown".into(),
            supported: false,
            detail: "Codex uses an unrecognized credential store mode".into(),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunningCodex {
    pub(crate) pid: u32,
    pub(crate) name: String,
    /// `desktop` or `cli` (heuristic, based on the executable).
    pub(crate) kind: String,
}

fn classify_process(name: &str, path: Option<&str>) -> Option<RunningCodex> {
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    let lowered_path = path.map(|path| path.to_ascii_lowercase().replace('\\', "/"));
    let in_desktop_install = lowered_path.as_deref().is_some_and(|path| {
        path.contains("/windowsapps/") || path.contains("/openai/codex/") || path.contains("/programs/codex/")
    });
    match stem {
        "codex" if in_desktop_install => Some("desktop"),
        "codex" => Some("cli"),
        "chatgpt" if in_desktop_install => Some("desktop"),
        // `codex-*` helper binaries (app-server, exec) shipped with the CLI.
        other if other.starts_with("codex-") => Some("cli"),
        _ => None,
    }
    .map(|kind| RunningCodex {
        pid: 0,
        name: name.to_string(),
        kind: kind.into(),
    })
}

/// Processes that may hold Codex credentials in memory. Called on demand only (no polling).
pub(crate) fn running_codex_processes() -> Vec<RunningCodex> {
    let own = std::process::id();
    let mut found = Vec::new();
    #[cfg(windows)]
    for (pid, path) in find_windows_process_snapshot() {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if let Some(mut process) = classify_process(name, path.to_str()) {
            process.pid = pid;
            found.push(process);
        }
    }
    #[cfg(target_os = "linux")]
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(name) = fs::read_to_string(entry.path().join("comm")) else {
                continue;
            };
            let path = fs::read_link(entry.path().join("exe")).ok();
            if let Some(mut process) =
                classify_process(name.trim(), path.as_deref().and_then(Path::to_str))
            {
                process.pid = pid;
                found.push(process);
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(output) = Command::new("ps").args(["-axo", "pid=,comm="]).output() {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut parts = line.trim().splitn(2, ' ');
            let (Some(pid), Some(command)) = (parts.next(), parts.next()) else {
                continue;
            };
            let Ok(pid) = pid.parse::<u32>() else { continue };
            let name = Path::new(command.trim())
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if let Some(mut process) = classify_process(name, Some(command.trim())) {
                process.pid = pid;
                found.push(process);
            }
        }
    }
    found.retain(|process| process.pid != own);
    found.sort_by_key(|process| process.pid);
    found
}

/// Write-ahead record of an in-flight credential transaction, sealed in the vault format.
#[derive(Serialize, Deserialize)]
pub(crate) struct SwitchJournal {
    pub(crate) started_at: i64,
    pub(crate) target_key: String,
    pub(crate) from_key: Option<String>,
    pub(crate) files: Vec<JournalFile>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct JournalFile {
    pub(crate) path: PathBuf,
    pub(crate) before_hash: String,
    pub(crate) after_hash: String,
    /// Complete previous bytes (encrypted along with the rest of the journal).
    pub(crate) before: Option<Vec<u8>>,
}

pub(crate) const JOURNAL_FILE: &str = "switch-journal.bin";
pub(crate) const JOURNAL_LABEL: &str = "journal";

/// Result of examining a journal left behind by an interrupted switch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    /// Every file already holds the target contents.
    Completed,
    /// Nothing had been written.
    Untouched,
    /// Some files were written: they are restored to the previous contents.
    RollBack(Vec<usize>),
    /// A file diverged from both images (refreshed tokens, external login): leave everything.
    Diverged,
}

pub(crate) fn plan_recovery(journal: &SwitchJournal, current: &[Option<Vec<u8>>]) -> RecoveryAction {
    let hash = |bytes: &Option<Vec<u8>>| image_hash(bytes.as_deref());
    let mut written = Vec::new();
    for (index, (file, observed)) in journal.files.iter().zip(current).enumerate() {
        let observed_hash = hash(observed);
        if observed_hash == file.after_hash && file.after_hash != file.before_hash {
            written.push(index);
        } else if observed_hash != file.before_hash {
            return RecoveryAction::Diverged;
        }
    }
    let changing = journal
        .files
        .iter()
        .filter(|file| file.after_hash != file.before_hash)
        .count();
    if written.is_empty() {
        RecoveryAction::Untouched
    } else if written.len() == changing {
        RecoveryAction::Completed
    } else {
        RecoveryAction::RollBack(written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_codex_processes_without_matching_unrelated_ones() {
        assert_eq!(classify_process("codex.exe", Some(r"C:\Users\a\AppData\Roaming\npm\codex.exe")).unwrap().kind, "cli");
        assert_eq!(
            classify_process("Codex.exe", Some(r"C:\Program Files\WindowsApps\OpenAI.Codex_1\Codex.exe")).unwrap().kind,
            "desktop"
        );
        assert_eq!(classify_process("codex-app-server", None).unwrap().kind, "cli");
        assert!(classify_process("chrome.exe", None).is_none());
        assert!(classify_process("chatgpt.exe", Some(r"C:\Tools\chatgpt.exe")).is_none());
        assert!(classify_process("codexbar", None).is_none());
    }

    #[test]
    fn credential_store_mode_gates_switching() {
        let root = unique_test_temp_path("codex-store-mode");
        fs::create_dir_all(&root).unwrap();
        assert!(detect_credential_store(&root).supported);
        for (content, mode, supported) in [
            ("cli_auth_credentials_store = \"file\"\n", "file", true),
            ("cli_auth_credentials_store = \"keyring\"\n", "keyring", false),
            ("cli_auth_credentials_store = \"auto\"\n", "auto", false),
            ("cli_auth_credentials_store = \"mystery\"\n", "unknown", false),
            ("model = \"x\"\n", "file", true),
            ("not = [valid", "unknown", false),
        ] {
            fs::write(root.join("config.toml"), content).unwrap();
            let status = detect_credential_store(&root);
            assert_eq!((status.mode.as_str(), status.supported), (mode, supported), "{content}");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
