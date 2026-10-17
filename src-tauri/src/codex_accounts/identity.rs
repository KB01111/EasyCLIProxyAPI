use super::*;
use base64::Engine;
use std::fmt;

/// Refresh/rotation safety margin: an access token this close to expiry counts as expired.
const ACCESS_TOKEN_SKEW_SECONDS: i64 = 60;

/// OAuth token set. Never printed: `Debug` is redacted and no `Display` exists.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CodexTokens {
    #[serde(default)]
    pub(crate) id_token: String,
    #[serde(default)]
    pub(crate) access_token: String,
    #[serde(default)]
    pub(crate) refresh_token: String,
    #[serde(default)]
    pub(crate) account_id: String,
}

impl fmt::Debug for CodexTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CodexTokens(<redacted>)")
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CodexCredential {
    pub(crate) tokens: CodexTokens,
    #[serde(default)]
    pub(crate) last_refresh: Option<String>,
}

impl fmt::Debug for CodexCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CodexCredential(<redacted>)")
    }
}

/// Verified-equality identity of a Codex login. `key` is the stable primary key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexIdentity {
    pub(crate) key: String,
    pub(crate) account_id: String,
    pub(crate) user_id: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CredentialValidity {
    /// Access token is unexpired.
    Valid,
    /// Access token expired but a refresh token is present (Codex refreshes on next use).
    Refreshable,
    /// No usable token material remains: re-authentication is required.
    Expired,
}

/// What a native `auth.json` currently holds.
#[derive(Debug)]
pub(crate) enum NativeAuth {
    Missing,
    /// API-key mode (for example the CPA proxy key). Not an OAuth identity.
    ApiKey,
    OAuth(CodexCredential),
}

fn jwt_claims(token: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    match serde_json::from_slice::<serde_json::Value>(&bytes).ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

fn claim_string(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn auth_claims(
    claims: &serde_json::Map<String, serde_json::Value>,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    claims
        .get("https://api.openai.com/auth")
        .and_then(serde_json::Value::as_object)
}

fn parse_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|time| time.timestamp())
}

pub(crate) fn derive_account_key(account_id: &str, user_id: Option<&str>) -> String {
    let digest = sha256_bytes(
        format!(
            "codex-account-v1\0{}\0{}",
            account_id,
            user_id.unwrap_or("")
        )
        .as_bytes(),
    );
    format!("cx_{}", &digest[..20])
}

/// Short, non-secret hint of an identifier for display (never the whole value).
pub(crate) fn mask_identifier(value: &str) -> String {
    let characters = value.chars().collect::<Vec<_>>();
    if characters.len() <= 8 {
        return "…".into();
    }
    format!(
        "{}…{}",
        characters[..4].iter().collect::<String>(),
        characters[characters.len() - 4..]
            .iter()
            .collect::<String>()
    )
}

impl CodexCredential {
    pub(crate) fn has_token_material(&self) -> bool {
        !self.tokens.access_token.trim().is_empty() || !self.tokens.refresh_token.trim().is_empty()
    }

    /// Verified account identity. Fails when the stored `account_id` contradicts the ID token or no
    /// account identifier exists at all (the login then cannot be told apart from another).
    pub(crate) fn identity(&self) -> Result<CodexIdentity, String> {
        let id_claims = jwt_claims(&self.tokens.id_token);
        let access_claims = jwt_claims(&self.tokens.access_token);
        let id_auth = id_claims.as_ref().and_then(auth_claims);
        let access_auth = access_claims.as_ref().and_then(auth_claims);
        let id_account = id_auth.and_then(|auth| claim_string(auth, "chatgpt_account_id"));
        let access_account = access_auth.and_then(|auth| claim_string(auth, "chatgpt_account_id"));
        if let (Some(from_id), Some(from_access)) = (&id_account, &access_account) {
            if from_id != from_access {
                return Err(
                    "Credential ID token and access token belong to different accounts".into(),
                );
            }
        }
        let claimed_account = id_account.or(access_account);
        let stored_account =
            Some(self.tokens.account_id.trim().to_string()).filter(|value| !value.is_empty());
        let account_id = match (stored_account, claimed_account) {
            (Some(stored), Some(claimed)) if stored != claimed => {
                return Err("Credential account id does not match its ID token".into());
            }
            (Some(value), _) | (None, Some(value)) => value,
            (None, None) => return Err("Credential has no verifiable account identifier".into()),
        };
        let user_id = id_auth
            .and_then(|auth| {
                claim_string(auth, "chatgpt_user_id").or_else(|| claim_string(auth, "user_id"))
            })
            .or_else(|| access_auth.and_then(|auth| claim_string(auth, "chatgpt_user_id")))
            .or_else(|| {
                id_claims
                    .as_ref()
                    .and_then(|claims| claim_string(claims, "sub"))
            });
        let email = id_claims
            .as_ref()
            .and_then(|claims| claim_string(claims, "email"))
            .or_else(|| {
                access_claims
                    .as_ref()
                    .and_then(|claims| claims.get("https://api.openai.com/profile"))
                    .and_then(serde_json::Value::as_object)
                    .and_then(|profile| claim_string(profile, "email"))
            });
        let plan = id_auth
            .and_then(|auth| claim_string(auth, "chatgpt_plan_type"))
            .or_else(|| access_auth.and_then(|auth| claim_string(auth, "chatgpt_plan_type")))
            .map(|plan| plan.to_ascii_lowercase());
        Ok(CodexIdentity {
            key: derive_account_key(&account_id, user_id.as_deref()),
            account_id,
            user_id,
            email,
            plan,
        })
    }

    /// Access-token expiry (unix seconds) when readable.
    pub(crate) fn access_expiry(&self) -> Option<i64> {
        jwt_claims(&self.tokens.access_token)?
            .get("exp")
            .and_then(serde_json::Value::as_i64)
    }

    /// Monotonic freshness marker: the later of the access-token issue time and `last_refresh`.
    pub(crate) fn generation(&self) -> i64 {
        let issued = jwt_claims(&self.tokens.access_token)
            .and_then(|claims| claims.get("iat").and_then(serde_json::Value::as_i64))
            .unwrap_or(0);
        let refreshed = self
            .last_refresh
            .as_deref()
            .and_then(parse_timestamp)
            .unwrap_or(0);
        issued.max(refreshed)
    }

    pub(crate) fn validity(&self, now: i64) -> CredentialValidity {
        if !self.tokens.access_token.trim().is_empty() {
            match self.access_expiry() {
                Some(expiry) if expiry > now + ACCESS_TOKEN_SKEW_SECONDS => {
                    return CredentialValidity::Valid;
                }
                None if self.tokens.refresh_token.trim().is_empty() => {
                    // Opaque access token with no readable expiry and nothing to refresh with.
                    return CredentialValidity::Valid;
                }
                _ => {}
            }
        }
        if self.tokens.refresh_token.trim().is_empty() {
            CredentialValidity::Expired
        } else {
            CredentialValidity::Refreshable
        }
    }

    /// Parse the flat credential file written by the CLIProxyAPI core.
    pub(crate) fn from_cpa_value(value: &serde_json::Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.get("type").and_then(serde_json::Value::as_str) != Some("codex") {
            return None;
        }
        let text = |key: &str| {
            object
                .get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let credential = Self {
            tokens: CodexTokens {
                id_token: text("id_token"),
                access_token: text("access_token"),
                refresh_token: text("refresh_token"),
                account_id: text("account_id"),
            },
            last_refresh: Some(text("last_refresh")).filter(|value| !value.is_empty()),
        };
        credential.has_token_material().then_some(credential)
    }

    /// Fields this app owns inside a Codex `auth.json`.
    pub(crate) fn native_fields(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut map = serde_json::Map::new();
        map.insert("auth_mode".into(), serde_json::json!("chatgpt"));
        map.insert("OPENAI_API_KEY".into(), serde_json::Value::Null);
        map.insert(
            "tokens".into(),
            serde_json::json!({
                "id_token": self.tokens.id_token,
                "access_token": self.tokens.access_token,
                "refresh_token": self.tokens.refresh_token,
                "account_id": self.tokens.account_id,
            }),
        );
        if let Some(refreshed) = &self.last_refresh {
            map.insert("last_refresh".into(), serde_json::json!(refreshed));
        }
        map
    }
}

/// Parse a native `auth.json` body without exposing any token text in errors.
pub(crate) fn parse_native_auth(content: Option<&[u8]>) -> Result<NativeAuth, String> {
    let Some(content) = content else {
        return Ok(NativeAuth::Missing);
    };
    if content.iter().all(u8::is_ascii_whitespace) {
        return Ok(NativeAuth::Missing);
    }
    let root: serde_json::Value = serde_json::from_slice(content)
        .map_err(|_| "Codex auth.json is not valid JSON".to_string())?;
    let object = root
        .as_object()
        .ok_or_else(|| "Codex auth.json must contain a JSON object".to_string())?;
    let tokens = object.get("tokens").and_then(serde_json::Value::as_object);
    let text = |source: Option<&serde_json::Map<String, serde_json::Value>>, key: &str| {
        source
            .and_then(|map| map.get(key))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let credential = CodexCredential {
        tokens: CodexTokens {
            id_token: text(tokens, "id_token"),
            access_token: text(tokens, "access_token"),
            refresh_token: text(tokens, "refresh_token"),
            account_id: text(tokens, "account_id"),
        },
        last_refresh: object
            .get("last_refresh")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    };
    if credential.has_token_material() {
        return Ok(NativeAuth::OAuth(credential));
    }
    let api_key = object
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    if api_key || object.get("auth_mode").and_then(serde_json::Value::as_str) == Some("apikey") {
        return Ok(NativeAuth::ApiKey);
    }
    Ok(NativeAuth::Missing)
}

/// Merge the credential into an existing `auth.json` body, preserving unrelated fields.
pub(crate) fn render_native_auth(
    existing: Option<&[u8]>,
    credential: &CodexCredential,
) -> Result<Vec<u8>, String> {
    let mut root = match existing {
        Some(bytes) if !bytes.iter().all(u8::is_ascii_whitespace) => {
            match serde_json::from_slice::<serde_json::Value>(bytes)
                .map_err(|_| "Codex auth.json is not valid JSON".to_string())?
            {
                serde_json::Value::Object(map) => map,
                _ => return Err("Codex auth.json must contain a JSON object".into()),
            }
        }
        _ => serde_json::Map::new(),
    };
    for (key, value) in credential.native_fields() {
        root.insert(key, value);
    }
    if credential.last_refresh.is_none() {
        root.remove("last_refresh");
    }
    serde_json::to_vec_pretty(&serde_json::Value::Object(root))
        .map_err(|_| "Failed to render Codex auth.json".to_string())
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}
