use super::vault::write_private_atomic;
use super::*;

const STORE_FILE: &str = "accounts.json";
const MAX_ALIAS_CHARS: usize = 40;

/// Non-secret account metadata. Credentials live only in the vault.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountRecord {
    pub(crate) key: String,
    pub(crate) alias: String,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    /// Masked identifier suitable for display.
    pub(crate) account_id_hint: String,
    /// File name (not path) of the CLIProxyAPI credential this account came from.
    pub(crate) source_file: Option<String>,
    pub(crate) added_at: i64,
    pub(crate) last_synced_at: i64,
    pub(crate) last_activated_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PinnedPair {
    pub(crate) primary: Option<String>,
    pub(crate) secondary: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AccountSettings {
    /// Cache lifetime for provider quota (minutes). No background polling beyond this.
    pub(crate) refresh_minutes: u32,
    /// Accelerator such as `Ctrl+Alt+F9`; `None` disables the shortcut.
    pub(crate) hotkey: Option<String>,
    pub(crate) notifications: bool,
    pub(crate) recommendations: bool,
}

impl Default for AccountSettings {
    fn default() -> Self {
        Self {
            refresh_minutes: 15,
            hotkey: None,
            notifications: false,
            recommendations: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchRecord {
    pub(crate) from: Option<String>,
    pub(crate) to: String,
    pub(crate) at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct StoreData {
    pub(crate) version: u32,
    pub(crate) accounts: Vec<AccountRecord>,
    pub(crate) pinned: PinnedPair,
    /// Identity last *verified* in the live native `auth.json`.
    pub(crate) active_native: Option<String>,
    pub(crate) settings: AccountSettings,
    pub(crate) last_switch: Option<SwitchRecord>,
}

impl StoreData {
    pub(crate) fn account(&self, key: &str) -> Option<&AccountRecord> {
        self.accounts.iter().find(|account| account.key == key)
    }

    pub(crate) fn account_mut(&mut self, key: &str) -> Option<&mut AccountRecord> {
        self.accounts.iter_mut().find(|account| account.key == key)
    }

    pub(crate) fn validate_alias(&self, key: &str, alias: &str) -> Result<String, String> {
        let alias = alias.trim();
        if alias.is_empty() || alias.chars().count() > MAX_ALIAS_CHARS {
            return Err(format!(
                "Account alias must be 1-{MAX_ALIAS_CHARS} characters"
            ));
        }
        // Control, zero-width and bidi-override characters could disguise one account as another.
        if alias.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
        }) {
            return Err("Account alias cannot contain control or invisible characters".into());
        }
        if self
            .accounts
            .iter()
            .any(|account| account.key != key && account.alias.eq_ignore_ascii_case(alias))
        {
            return Err("Another account already uses this alias".into());
        }
        Ok(alias.to_string())
    }

    pub(crate) fn rename(&mut self, key: &str, alias: &str) -> Result<(), String> {
        let alias = self.validate_alias(key, alias)?;
        self.account_mut(key)
            .ok_or_else(|| "Unknown Codex account".to_string())?
            .alias = alias;
        Ok(())
    }

    /// Pin up to two distinct accounts. `None` clears a slot.
    pub(crate) fn set_pinned(
        &mut self,
        primary: Option<String>,
        secondary: Option<String>,
    ) -> Result<(), String> {
        for key in [&primary, &secondary].into_iter().flatten() {
            if self.account(key).is_none() {
                return Err("Cannot pin an unknown account".into());
            }
        }
        if primary.is_some() && primary == secondary {
            return Err("The two quick-switch accounts must be different".into());
        }
        self.pinned = PinnedPair { primary, secondary };
        Ok(())
    }

    pub(crate) fn remove(&mut self, key: &str) -> bool {
        let before = self.accounts.len();
        self.accounts.retain(|account| account.key != key);
        if self.pinned.primary.as_deref() == Some(key) {
            self.pinned.primary = None;
        }
        if self.pinned.secondary.as_deref() == Some(key) {
            self.pinned.secondary = None;
        }
        self.accounts.len() != before
    }

    pub(crate) fn sanitize_settings(settings: &mut AccountSettings) {
        settings.refresh_minutes = settings.refresh_minutes.clamp(1, 24 * 60);
        settings.hotkey = settings
            .hotkey
            .take()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
}

pub(crate) fn load_store(directory: &Path) -> Result<StoreData, String> {
    let path = directory.join(STORE_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            let mut data: StoreData = serde_json::from_slice(&bytes).map_err(|_| {
                "The Codex account list is unreadable; it was left untouched".to_string()
            })?;
            if data.version > 1 {
                return Err("The Codex account list was written by a newer version".into());
            }
            data.version = 1;
            StoreData::sanitize_settings(&mut data.settings);
            Ok(data)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(StoreData {
            version: 1,
            ..Default::default()
        }),
        Err(_) => Err("Unable to read the Codex account list".into()),
    }
}

pub(crate) fn save_store(directory: &Path, data: &StoreData) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(data)
        .map_err(|_| "Failed to serialize the Codex account list".to_string())?;
    write_private_atomic(&directory.join(STORE_FILE), &bytes)
}
