use super::identity::CodexCredential;
use super::*;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use std::collections::BTreeMap;

const MAGIC: &[u8; 4] = b"CXV1";
const NONCE_LEN: usize = 12;
const KEY_FILE: &str = "vault.key";
const VAULT_FILE: &str = "vault.bin";
#[cfg(windows)]
const DPAPI_ENTROPY: &[u8] = b"EasyCLIProxyAPI.codex-accounts.v1";

/// Wraps the vault master key with an OS user-scoped facility.
pub(crate) trait KeyProtector: Send + Sync {
    /// Reported to the UI so the protection level is never overstated.
    fn name(&self) -> &'static str;
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, wrapped: &[u8]) -> Result<Vec<u8>, String>;
}

#[cfg(windows)]
pub(crate) struct DpapiProtector;

#[cfg(windows)]
impl DpapiProtector {
    fn transform(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: the blobs point at live slices for the call; `output` is OS-allocated and freed below.
        let succeeded = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    &entropy,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    &entropy,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if succeeded == 0 || output.pbData.is_null() {
            return Err(if protect {
                "Windows could not protect the credential vault key".into()
            } else {
                "Windows could not unlock the credential vault key (it belongs to a different Windows user or machine)".into()
            });
        }
        // SAFETY: DPAPI returned `cbData` readable bytes at `pbData`.
        let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        // SAFETY: the buffer was allocated by DPAPI with LocalAlloc.
        unsafe { LocalFree(output.pbData as _) };
        Ok(result)
    }
}

#[cfg(windows)]
impl KeyProtector for DpapiProtector {
    fn name(&self) -> &'static str {
        "windows-dpapi"
    }
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Self::transform(plain, true)
    }
    fn unprotect(&self, wrapped: &[u8]) -> Result<Vec<u8>, String> {
        Self::transform(wrapped, false)
    }
}

/// Non-Windows fallback (development, CI): the key file is protected by 0600 permissions only.
#[cfg(not(windows))]
pub(crate) struct FilePermissionProtector;

#[cfg(not(windows))]
impl KeyProtector for FilePermissionProtector {
    fn name(&self) -> &'static str {
        "file-permissions"
    }
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    fn unprotect(&self, wrapped: &[u8]) -> Result<Vec<u8>, String> {
        Ok(wrapped.to_vec())
    }
}

pub(crate) fn platform_protector() -> Box<dyn KeyProtector> {
    #[cfg(windows)]
    {
        Box::new(DpapiProtector)
    }
    #[cfg(not(windows))]
    {
        Box::new(FilePermissionProtector)
    }
}

/// Write `content` to `path` atomically (temp file, fsync, rename) with owner-only permissions.
pub(crate) fn write_private_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let directory = path
        .parent()
        .ok_or_else(|| "Invalid credential path".to_string())?;
    fs::create_dir_all(directory).map_err(|_| "Failed to create the credential directory".to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let temporary = directory.join(format!(
        ".{name}.tmp.{}.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomically(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to write credential file atomically: {}", error.kind()));
    }
    remember_software_write(path, content);
    Ok(())
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct VaultData {
    #[serde(default)]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) entries: BTreeMap<String, VaultEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct VaultEntry {
    pub(crate) credential: CodexCredential,
    #[serde(default)]
    pub(crate) updated_at: i64,
}

pub(crate) struct Vault {
    directory: PathBuf,
    protector: Box<dyn KeyProtector>,
}

impl Vault {
    pub(crate) fn open(directory: PathBuf, protector: Box<dyn KeyProtector>) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|_| "Failed to create the Codex account vault directory".to_string())?;
        Ok(Self { directory, protector })
    }

    pub(crate) fn protection(&self) -> &'static str {
        self.protector.name()
    }

    fn key(&self) -> Result<[u8; 32], String> {
        let path = self.directory.join(KEY_FILE);
        match fs::read(&path) {
            Ok(wrapped) => {
                let raw = self.protector.unprotect(&wrapped)?;
                <[u8; 32]>::try_from(raw.as_slice())
                    .map_err(|_| "The Codex account vault key is corrupted".to_string())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Never mint a fresh key while encrypted data exists: that would orphan it silently.
                if self.directory.join(VAULT_FILE).exists() {
                    return Err("The Codex account vault key is missing; reset the vault and re-import accounts".into());
                }
                let mut raw = [0u8; 32];
                getrandom::fill(&mut raw).map_err(|_| "Failed to generate a vault key".to_string())?;
                let wrapped = self.protector.protect(&raw)?;
                write_private_atomic(&path, &wrapped)?;
                Ok(raw)
            }
            Err(_) => Err("Unable to read the Codex account vault key".into()),
        }
    }

    /// Authenticated encryption; `label` is bound as associated data so blobs cannot be swapped.
    pub(crate) fn seal(&self, label: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
        let key = self.key()?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|_| "Failed to generate an encryption nonce".to_string())?;
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: label.as_bytes() })
            .map_err(|_| "Failed to encrypt credential data".to_string())?;
        let mut output = Vec::with_capacity(MAGIC.len() + NONCE_LEN + encrypted.len());
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&encrypted);
        Ok(output)
    }

    pub(crate) fn open_sealed(&self, label: &str, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < MAGIC.len() + NONCE_LEN || &sealed[..MAGIC.len()] != MAGIC {
            return Err("Encrypted credential data has an unknown format".into());
        }
        let key = self.key()?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let nonce = &sealed[MAGIC.len()..MAGIC.len() + NONCE_LEN];
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload { msg: &sealed[MAGIC.len() + NONCE_LEN..], aad: label.as_bytes() },
            )
            .map_err(|_| "Encrypted credential data failed authentication (tampered or wrong key)".to_string())
    }

    pub(crate) fn load(&self) -> Result<VaultData, String> {
        let path = self.directory.join(VAULT_FILE);
        let sealed = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(VaultData { version: 1, ..Default::default() });
            }
            Err(_) => return Err("Unable to read the Codex account vault".into()),
        };
        let plain = self.open_sealed("vault", &sealed)?;
        serde_json::from_slice(&plain).map_err(|_| "The Codex account vault is corrupted".to_string())
    }

    pub(crate) fn save(&self, data: &VaultData) -> Result<(), String> {
        let plain = serde_json::to_vec(data).map_err(|_| "Failed to serialize the account vault".to_string())?;
        let sealed = self.seal("vault", &plain)?;
        write_private_atomic(&self.directory.join(VAULT_FILE), &sealed)
    }

    /// Move the vault aside (never deletes) so a fresh one can be created after key loss.
    pub(crate) fn quarantine(&self) -> Result<(), String> {
        let stamp = super::identity::unix_now();
        for name in [VAULT_FILE, KEY_FILE] {
            let path = self.directory.join(name);
            if path.exists() {
                fs::rename(&path, self.directory.join(format!("{name}.unusable-{stamp}")))
                    .map_err(|_| "Failed to move the old vault aside".to_string())?;
            }
        }
        Ok(())
    }
}
