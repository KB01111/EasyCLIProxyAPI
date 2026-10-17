use super::identity::{CodexCredential, CodexIdentity};
use super::*;

const MAX_CPA_FILE_BYTES: u64 = 512 * 1024;

/// A Codex credential file owned by the CLIProxyAPI core. Read-only for this feature.
pub(crate) struct CpaCodexFile {
    pub(crate) file_name: String,
    pub(crate) credential: CodexCredential,
    pub(crate) identity: CodexIdentity,
    pub(crate) disabled: bool,
}

#[derive(Default)]
pub(crate) struct CpaScan {
    pub(crate) files: Vec<CpaCodexFile>,
    /// Human-readable, secret-free problems (file names only).
    pub(crate) issues: Vec<String>,
}

/// Scan the core `auth-dir` for `type: codex` credentials. Never writes to the directory.
pub(crate) fn scan_cpa_directory(directory: &Path) -> CpaScan {
    let mut scan = CpaScan::default();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return scan,
        Err(_) => {
            scan.issues
                .push("The CLIProxyAPI credentials directory could not be read".into());
            return scan;
        }
    };
    let mut names = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            (metadata.is_file()
                && name.to_ascii_lowercase().ends_with(".json")
                && !name.starts_with('.')
                && metadata.len() <= MAX_CPA_FILE_BYTES)
                .then_some(name)
        })
        .collect::<Vec<_>>();
    names.sort();
    for name in names {
        let Ok(bytes) = fs::read(directory.join(&name)) else {
            scan.issues.push(format!("{name}: unreadable"));
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            // Non-JSON files in the directory are none of our business unless they claim to be Codex.
            continue;
        };
        let Some(credential) = CodexCredential::from_cpa_value(&value) else {
            continue;
        };
        let identity = match credential.identity() {
            Ok(identity) => identity,
            Err(_) => {
                scan.issues
                    .push(format!("{name}: account identity cannot be verified"));
                continue;
            }
        };
        let disabled = value
            .get("disabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        scan.files.push(CpaCodexFile {
            file_name: name,
            credential,
            identity,
            disabled,
        });
    }
    // Two files holding one login: keep the freshest as the canonical source.
    let mut canonical: Vec<CpaCodexFile> = Vec::new();
    for file in std::mem::take(&mut scan.files) {
        match canonical
            .iter()
            .position(|kept| kept.identity.key == file.identity.key)
        {
            Some(index) => {
                scan.issues.push(format!(
                    "{} and {} contain the same Codex login",
                    canonical[index].file_name, file.file_name
                ));
                if file.credential.generation() > canonical[index].credential.generation() {
                    canonical[index] = file;
                }
            }
            None => canonical.push(file),
        }
    }
    scan.files = canonical;
    scan
}
