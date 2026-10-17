//! Account Center tests. All credentials are synthetic: unsigned JWTs with made-up identifiers.
use super::engine::{
    AccountEngine, AccountsSnapshot, CpaCopy, StateContext, SwitchEnv, SwitchOutcome,
};
use super::identity::{
    parse_native_auth, render_native_auth, CodexCredential, CodexTokens, CredentialValidity,
    NativeAuth,
};
use super::native::{JournalFile, RunningCodex, SwitchJournal, JOURNAL_FILE, JOURNAL_LABEL};
use super::vault::platform_protector;
use super::*;
use base64::Engine as _;

const NOW: i64 = 1_800_000_000;

fn jwt(claims: serde_json::Value) -> String {
    let encode = |value: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value);
    format!(
        "{}.{}.{}",
        encode(br#"{"alg":"none"}"#),
        encode(claims.to_string().as_bytes()),
        encode(b"synthetic-signature")
    )
}

struct Login {
    account: &'static str,
    user: &'static str,
    email: &'static str,
    plan: &'static str,
}

const PERSONAL: Login = Login {
    account: "acct-personal-0001",
    user: "user-personal-0001",
    email: "dev@example.test",
    plan: "plus",
};
const WORK: Login = Login {
    account: "acct-work-0002",
    user: "user-work-0002",
    email: "dev@example.test",
    plan: "pro",
};
const RESERVE: Login = Login {
    account: "acct-reserve-0003",
    user: "user-reserve-0003",
    email: "reserve@example.test",
    plan: "plus",
};

/// `generation` doubles as the issue time; the refresh token encodes it so rotations are visible.
fn credential(
    login: &Login,
    generation: i64,
    expires_in: i64,
    with_refresh: bool,
) -> CodexCredential {
    CodexCredential {
        tokens: CodexTokens {
            id_token: jwt(serde_json::json!({
                "email": login.email,
                "sub": login.user,
                "https://api.openai.com/auth": {
                    "chatgpt_account_id": login.account,
                    "chatgpt_user_id": login.user,
                    "chatgpt_plan_type": login.plan,
                },
            })),
            access_token: jwt(serde_json::json!({
                "iat": generation,
                "exp": generation + expires_in,
                "https://api.openai.com/auth": { "chatgpt_account_id": login.account },
            })),
            refresh_token: if with_refresh {
                format!("refresh-{}-{generation}", login.account)
            } else {
                String::new()
            },
            account_id: login.account.to_string(),
        },
        last_refresh: Some(
            chrono::DateTime::from_timestamp(generation, 0)
                .unwrap()
                .to_rfc3339(),
        ),
    }
}

fn fresh(login: &Login) -> CodexCredential {
    credential(login, NOW - 600, 3600 * 10, true)
}

fn key_for(snapshot: &AccountsSnapshot, login: &Login) -> String {
    snapshot
        .accounts
        .iter()
        .find(|account| account.account_id_hint == super::identity::mask_identifier(login.account))
        .unwrap()
        .key
        .clone()
}

struct Fixture {
    root: PathBuf,
    cpa: PathBuf,
    codex: PathBuf,
    accounts: PathBuf,
    engine: AccountEngine,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = unique_test_temp_path(&format!("codex-accounts-{name}"));
        let (cpa, codex, accounts) = (root.join("cpa"), root.join("codex"), root.join("accounts"));
        for directory in [&cpa, &codex] {
            fs::create_dir_all(directory).unwrap();
        }
        let engine = AccountEngine::new(accounts.clone(), platform_protector()).unwrap();
        Self {
            root,
            cpa,
            codex,
            accounts,
            engine,
        }
    }

    fn reopen(&self) -> AccountEngine {
        AccountEngine::new(self.accounts.clone(), platform_protector()).unwrap()
    }

    fn write_cpa(&self, file: &str, credential: &CodexCredential, disabled: bool) {
        let mut value = serde_json::json!({
            "type": "codex",
            "id_token": credential.tokens.id_token,
            "access_token": credential.tokens.access_token,
            "refresh_token": credential.tokens.refresh_token,
            "account_id": credential.tokens.account_id,
            "last_refresh": credential.last_refresh,
            "disabled": disabled,
        });
        value["email"] = serde_json::json!("ignored@example.test");
        fs::write(
            self.cpa.join(file),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    fn write_live(&self, credential: &CodexCredential) {
        let existing = fs::read(self.codex.join("auth.json")).ok();
        fs::write(
            self.codex.join("auth.json"),
            render_native_auth(existing.as_deref(), credential).unwrap(),
        )
        .unwrap();
    }

    fn live(&self) -> NativeAuth {
        parse_native_auth(fs::read(self.codex.join("auth.json")).ok().as_deref()).unwrap()
    }

    fn live_key(&self) -> String {
        match self.live() {
            NativeAuth::OAuth(credential) => credential.identity().unwrap().key,
            other => panic!("unexpected live auth: {other:?}"),
        }
    }

    fn state(&self) -> AccountsSnapshot {
        self.state_with(&self.engine, Vec::new())
    }

    fn state_with(&self, engine: &AccountEngine, running: Vec<RunningCodex>) -> AccountsSnapshot {
        engine
            .state(&StateContext {
                cpa_dir: &self.cpa,
                codex_home: &self.codex,
                now: NOW,
                running: Some(running),
            })
            .unwrap()
    }

    fn switch(&self, key: &str) -> SwitchOutcome {
        self.switch_with_running(key, Vec::new())
    }

    fn switch_with_running(&self, key: &str, running: Vec<RunningCodex>) -> SwitchOutcome {
        self.engine
            .switch(
                &SwitchEnv {
                    codex_home: &self.codex,
                    running,
                    now: NOW,
                },
                key,
            )
            .unwrap()
    }

    /// Three CLIProxyAPI logins, none active in Codex yet.
    fn with_three_accounts(name: &str) -> (Self, [String; 3]) {
        let fixture = Self::new(name);
        fixture.write_cpa("codex-personal.json", &fresh(&PERSONAL), false);
        fixture.write_cpa("codex-work.json", &fresh(&WORK), false);
        fixture.write_cpa("codex-reserve.json", &fresh(&RESERVE), true);
        let snapshot = fixture.state();
        let keys = [
            key_for(&snapshot, &PERSONAL),
            key_for(&snapshot, &WORK),
            key_for(&snapshot, &RESERVE),
        ];
        (fixture, keys)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn busy(name: &str) -> Vec<RunningCodex> {
    vec![RunningCodex {
        pid: 4242,
        name: name.into(),
        kind: "cli".into(),
    }]
}

// ---- Account management ------------------------------------------------------------------

#[test]
fn discovers_three_accounts_and_keeps_same_email_logins_distinct() {
    let (fixture, keys) = Fixture::with_three_accounts("discover");
    // A second file holding the Personal login, an API key file and a non-Codex credential.
    fixture.write_cpa("codex-personal-copy.json", &fresh(&PERSONAL), false);
    fs::write(
        fixture.cpa.join("claude.json"),
        r#"{"type":"claude","access_token":"x"}"#,
    )
    .unwrap();
    fs::write(fixture.cpa.join("notes.json"), "not json at all").unwrap();
    let snapshot = fixture.state();

    assert_eq!(snapshot.accounts.len(), 3);
    assert_eq!(
        keys.iter().collect::<HashSet<_>>().len(),
        3,
        "stable keys are unique"
    );
    let personal = snapshot.accounts.iter().find(|a| a.key == keys[0]).unwrap();
    let work = snapshot.accounts.iter().find(|a| a.key == keys[1]).unwrap();
    assert_eq!(
        personal.email, work.email,
        "same email, different verified identity"
    );
    assert!(personal.duplicate_email && work.duplicate_email);
    assert_eq!(personal.plan.as_deref(), Some("plus"));
    assert!(personal.connected && personal.proxy_disabled == Some(false));
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .find(|a| a.key == keys[2])
            .unwrap()
            .proxy_disabled,
        Some(true)
    );
    assert!(snapshot
        .issues
        .iter()
        .any(|issue| issue.contains("same Codex login")));
    assert_eq!(personal.validity, CredentialValidity::Valid);
}

#[test]
fn pinned_pair_persists_across_restart_and_third_account_stays_available() {
    let (fixture, keys) = Fixture::with_three_accounts("pinned");
    fixture
        .engine
        .set_pinned(Some(keys[0].clone()), Some(keys[1].clone()))
        .unwrap();
    assert!(fixture
        .engine
        .set_pinned(Some(keys[0].clone()), Some(keys[0].clone()))
        .is_err());
    assert!(fixture
        .engine
        .set_pinned(Some("cx_unknown".into()), None)
        .is_err());

    let reopened = fixture.reopen();
    let snapshot = fixture.state_with(&reopened, Vec::new());
    assert_eq!(snapshot.pinned.primary.as_deref(), Some(keys[0].as_str()));
    assert_eq!(snapshot.pinned.secondary.as_deref(), Some(keys[1].as_str()));
    let reserve = snapshot.accounts.iter().find(|a| a.key == keys[2]).unwrap();
    assert_eq!(reserve.pinned_slot, None);
    assert!(
        reopened
            .switch(
                &SwitchEnv {
                    codex_home: &fixture.codex,
                    running: vec![],
                    now: NOW
                },
                &keys[2]
            )
            .unwrap()
            .status
            == "switched"
    );
}

#[test]
fn rename_validates_and_removal_leaves_proxy_credentials_alone() {
    let (fixture, keys) = Fixture::with_three_accounts("rename");
    fixture.engine.rename(&keys[0], "Personal").unwrap();
    assert!(
        fixture.engine.rename(&keys[1], "personal").is_err(),
        "aliases are unique"
    );
    assert!(fixture.engine.rename(&keys[1], "   ").is_err());
    assert!(fixture.engine.rename(&keys[1], "bad\nname").is_err());
    fixture
        .engine
        .set_pinned(Some(keys[0].clone()), None)
        .unwrap();
    fixture.engine.remove(&keys[0]).unwrap();
    assert!(
        fixture.cpa.join("codex-personal.json").exists(),
        "CPA credential untouched"
    );
    // The CPA file still exists, so the next sync legitimately re-discovers it (never silently deleted).
    let snapshot = fixture.state();
    assert_eq!(snapshot.accounts.len(), 3);
    assert_eq!(snapshot.pinned.primary, None);
}

// ---- Switching ---------------------------------------------------------------------------

#[test]
fn switches_a_to_b_to_a_repeatedly_and_preserves_unrelated_codex_data() {
    let (fixture, keys) = Fixture::with_three_accounts("switch");
    fixture.write_live(&fresh(&PERSONAL));
    let mut auth: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.codex.join("auth.json")).unwrap()).unwrap();
    auth["custom_setting"] = serde_json::json!({"keep": true});
    fs::write(
        fixture.codex.join("auth.json"),
        serde_json::to_vec(&auth).unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.codex.join("config.toml"),
        "model = \"gpt-test\"\n[mcp_servers.demo]\ncommand = \"demo\"\n",
    )
    .unwrap();
    fs::create_dir_all(fixture.codex.join("sessions")).unwrap();
    fs::write(fixture.codex.join("sessions/history.jsonl"), "{}\n").unwrap();
    let config_before = fs::read(fixture.codex.join("config.toml")).unwrap();

    assert_eq!(
        fixture.state().active_native.as_deref(),
        Some(keys[0].as_str())
    );
    for round in 0..3 {
        let to_work = fixture.switch(&keys[1]);
        assert_eq!(
            (to_work.status, to_work.code),
            ("switched", None),
            "round {round}"
        );
        assert_eq!(fixture.live_key(), keys[1]);
        assert!(to_work.restart_required);
        assert_eq!(to_work.desktop, "unverified");
        let timings = to_work.timings.unwrap();
        assert!(timings.total_ms >= timings.write_ms);
        assert_eq!(fixture.switch(&keys[0]).status, "switched");
        assert_eq!(fixture.live_key(), keys[0]);
    }
    let after: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.codex.join("auth.json")).unwrap()).unwrap();
    assert_eq!(after["custom_setting"], serde_json::json!({"keep": true}));
    assert_eq!(
        fs::read(fixture.codex.join("config.toml")).unwrap(),
        config_before
    );
    assert_eq!(
        fs::read_to_string(fixture.codex.join("sessions/history.jsonl")).unwrap(),
        "{}\n"
    );
    assert!(
        !fixture.accounts.join(JOURNAL_FILE).exists(),
        "journal removed after success"
    );
    let snapshot = fixture.state();
    assert_eq!(snapshot.active_native.as_deref(), Some(keys[0].as_str()));
    assert_eq!(snapshot.last_switch.as_ref().unwrap().to, keys[0]);
}

#[test]
fn switching_to_the_active_account_is_a_no_op() {
    let (fixture, keys) = Fixture::with_three_accounts("noop");
    fixture.write_live(&fresh(&WORK));
    let before = fs::read(fixture.codex.join("auth.json")).unwrap();
    let outcome = fixture.switch(&keys[1]);
    assert_eq!(outcome.status, "unchanged");
    assert!(!outcome.restart_required);
    assert_eq!(fs::read(fixture.codex.join("auth.json")).unwrap(), before);
}

#[test]
fn first_switch_into_a_missing_auth_file_works() {
    let (fixture, keys) = Fixture::with_three_accounts("missing-auth");
    assert!(!fixture.codex.join("auth.json").exists());
    assert_eq!(fixture.state().native.live, "none");
    assert_eq!(fixture.switch(&keys[2]).status, "switched");
    assert_eq!(fixture.live_key(), keys[2]);
}

#[test]
fn expired_and_revoked_credentials_are_refused_but_refreshable_ones_are_allowed() {
    let fixture = Fixture::new("expiry");
    fixture.write_cpa("codex-personal.json", &fresh(&PERSONAL), false);
    // Work account: access token expired long ago, no refresh token left -> must re-authenticate.
    fixture.write_cpa(
        "codex-work.json",
        &credential(&WORK, NOW - 90_000, 3600, false),
        false,
    );
    let snapshot = fixture.state();
    let (personal, work) = (key_for(&snapshot, &PERSONAL), key_for(&snapshot, &WORK));
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .find(|a| a.key == work)
            .unwrap()
            .validity,
        CredentialValidity::Expired
    );
    fixture.write_live(&fresh(&PERSONAL));
    let blocked = fixture.switch(&work);
    assert_eq!(
        (blocked.status, blocked.code),
        ("blocked", Some("target_expired"))
    );
    assert_eq!(fixture.live_key(), personal, "nothing changed");

    // A newer login with an expired access token but a refresh token: Codex refreshes on next use.
    fixture.write_cpa(
        "codex-work.json",
        &credential(&WORK, NOW - 80_000, 3600, true),
        false,
    );
    let snapshot = fixture.state();
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .find(|a| a.key == work)
            .unwrap()
            .validity,
        CredentialValidity::Refreshable
    );
    assert_eq!(fixture.switch(&work).status, "switched");
}

#[test]
fn running_codex_blocks_switching_without_touching_files() {
    let (fixture, keys) = Fixture::with_three_accounts("running");
    fixture.write_live(&fresh(&PERSONAL));
    let before = fs::read(fixture.codex.join("auth.json")).unwrap();
    let outcome = fixture.switch_with_running(&keys[1], busy("codex.exe"));
    assert_eq!(
        (outcome.status, outcome.code),
        ("blocked", Some("codex_running"))
    );
    assert_eq!(outcome.running.len(), 1);
    assert_eq!(fs::read(fixture.codex.join("auth.json")).unwrap(), before);
    assert!(!fixture.accounts.join(JOURNAL_FILE).exists());
    // Switching to the account that is already active is still a harmless no-op while running.
    assert_eq!(
        fixture
            .switch_with_running(&keys[0], busy("codex.exe"))
            .status,
        "unchanged"
    );
}

#[test]
fn unsupported_credential_stores_and_api_key_mode_are_refused() {
    let (fixture, keys) = Fixture::with_three_accounts("unsupported");
    fixture.write_live(&fresh(&PERSONAL));
    for mode in ["keyring", "auto"] {
        fs::write(
            fixture.codex.join("config.toml"),
            format!("cli_auth_credentials_store = \"{mode}\"\n"),
        )
        .unwrap();
        let outcome = fixture.switch(&keys[1]);
        assert_eq!(
            (outcome.status, outcome.code),
            ("blocked", Some("unsupported_store")),
            "{mode}"
        );
        assert!(!fixture.state().native.credential_store.supported);
    }
    fs::write(
        fixture.codex.join("config.toml"),
        "cli_auth_credentials_store = \"file\"\n",
    )
    .unwrap();
    fs::write(
        fixture.codex.join("auth.json"),
        r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-synthetic"}"#,
    )
    .unwrap();
    let outcome = fixture.switch(&keys[1]);
    assert_eq!(
        (outcome.status, outcome.code),
        ("blocked", Some("api_key_mode"))
    );
    assert_eq!(fixture.state().native.live, "api_key");
    assert_eq!(
        fs::read_to_string(fixture.codex.join("auth.json")).unwrap(),
        r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-synthetic"}"#
    );
    fs::write(fixture.codex.join("auth.json"), "{ truncated").unwrap();
    assert_eq!(fixture.switch(&keys[1]).code, Some("live_auth_corrupt"));
    assert_eq!(fixture.state().native.live, "error");
}

#[test]
fn unknown_live_login_must_be_adopted_explicitly_and_is_never_overwritten() {
    let fixture = Fixture::new("unknown");
    fixture.write_cpa("codex-personal.json", &fresh(&PERSONAL), false);
    let key = fixture.state().accounts[0].key.clone();
    fixture.write_live(&fresh(&RESERVE));
    let snapshot = fixture.state();
    assert_eq!(snapshot.native.live, "unmanaged");
    assert_eq!(
        snapshot.native.unmanaged.as_ref().unwrap().email.as_deref(),
        Some("reserve@example.test")
    );
    let before = fs::read(fixture.codex.join("auth.json")).unwrap();
    let outcome = fixture.switch(&key);
    assert_eq!(
        (outcome.status, outcome.code),
        ("blocked", Some("unknown_live_identity"))
    );
    assert_eq!(fs::read(fixture.codex.join("auth.json")).unwrap(), before);

    let adopted = fixture
        .engine
        .adopt_live(&fixture.codex, "Reserve", NOW)
        .unwrap();
    assert!(
        fixture
            .engine
            .adopt_live(&fixture.codex, "Again", NOW)
            .is_err(),
        "already managed"
    );
    assert_eq!(fixture.switch(&key).status, "switched");
    assert_eq!(
        fixture.switch(&adopted).status,
        "switched",
        "the adopted session was preserved"
    );
    assert_eq!(fixture.live_key(), adopted);
}

#[test]
fn refreshed_native_tokens_are_captured_and_never_replaced_by_older_snapshots() {
    let (fixture, keys) = Fixture::with_three_accounts("reconcile");
    fixture.write_live(&fresh(&PERSONAL));
    // Codex refreshed its tokens after the CPA copy was made.
    let refreshed = credential(&PERSONAL, NOW - 60, 3600 * 10, true);
    fixture.write_live(&refreshed);
    assert_eq!(fixture.switch(&keys[1]).status, "switched");
    // Switching away captured the refresh; switching back restores the NEWER tokens, not the CPA copy.
    assert_eq!(fixture.switch(&keys[0]).status, "switched");
    match fixture.live() {
        NativeAuth::OAuth(live) => assert_eq!(live.tokens, refreshed.tokens),
        other => panic!("{other:?}"),
    }
    // The CPA copy is now behind the vault: reported, not "fixed" by overwriting the newer one.
    let snapshot = fixture.state();
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .find(|a| a.key == keys[0])
            .unwrap()
            .cpa_copy,
        CpaCopy::VaultNewer
    );

    // An older live snapshot (stale restore of a backup) must not downgrade the vault.
    fixture.write_live(&credential(&PERSONAL, NOW - 5000, 3600 * 10, true));
    assert_eq!(fixture.switch(&keys[1]).status, "switched");
    assert_eq!(fixture.switch(&keys[0]).status, "switched");
    match fixture.live() {
        NativeAuth::OAuth(live) => assert_eq!(live.tokens, refreshed.tokens),
        other => panic!("{other:?}"),
    }
}

#[test]
fn reauthenticating_replaces_stale_tokens_for_the_same_identity_only() {
    let (fixture, keys) = Fixture::with_three_accounts("reauth");
    let renewed = credential(&WORK, NOW - 30, 3600 * 10, true);
    fixture.write_cpa("codex-work.json", &renewed, false);
    let snapshot = fixture.state();
    assert_eq!(snapshot.accounts.len(), 3, "same identity, no new account");
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .find(|a| a.key == keys[1])
            .unwrap()
            .last_refresh,
        renewed.last_refresh
    );
    assert_eq!(fixture.switch(&keys[1]).status, "switched");
    match fixture.live() {
        NativeAuth::OAuth(live) => assert_eq!(live.tokens, renewed.tokens),
        other => panic!("{other:?}"),
    }
}

#[test]
fn same_generation_with_different_tokens_is_a_conflict_not_an_overwrite() {
    let (fixture, keys) = Fixture::with_three_accounts("conflict");
    let mut twin = fresh(&PERSONAL);
    twin.tokens.refresh_token = "refresh-twin".into();
    fixture.write_cpa("codex-personal.json", &twin, false);
    let snapshot = fixture.state();
    assert_eq!(
        snapshot
            .accounts
            .iter()
            .find(|a| a.key == keys[0])
            .unwrap()
            .cpa_copy,
        CpaCopy::Conflict
    );
    assert_eq!(fixture.switch(&keys[0]).status, "switched");
    match fixture.live() {
        NativeAuth::OAuth(live) => {
            assert_eq!(live.tokens, fresh(&PERSONAL).tokens, "vault copy kept")
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn external_account_changes_are_detected_and_sticky_until_acknowledged() {
    let (fixture, keys) = Fixture::with_three_accounts("external");
    fixture.write_live(&fresh(&PERSONAL));
    assert!(fixture.state().external_change.is_none());
    assert_eq!(fixture.switch(&keys[1]).status, "switched");
    // Someone runs `codex login` for another saved account behind our back.
    fixture.write_live(&fresh(&RESERVE));
    let first = fixture.state();
    let change = first.external_change.as_ref().expect("change detected");
    assert_eq!(
        (change.from.as_deref(), change.to.as_deref()),
        (Some(keys[1].as_str()), Some(keys[2].as_str()))
    );
    assert_eq!(
        fixture
            .state()
            .external_change
            .as_ref()
            .map(|c| c.to.clone()),
        Some(Some(keys[2].clone())),
        "sticky"
    );
    fixture.engine.acknowledge_external_change();
    assert!(fixture.state().external_change.is_none());
    // Logout is also an external change.
    fs::remove_file(fixture.codex.join("auth.json")).unwrap();
    let snapshot = fixture.state();
    assert_eq!(snapshot.active_native, None);
    assert!(snapshot.external_change.is_some());
}

#[test]
fn native_oauth_record_never_keeps_a_stale_account() {
    let (fixture, keys) = Fixture::with_three_accounts("state-record");
    fixture.write_live(&fresh(&PERSONAL));
    let stale = String::from_utf8(fs::read(fixture.codex.join("auth.json")).unwrap()).unwrap();
    fs::write(
        fixture.codex.join(CODEX_NATIVE_OAUTH_STATE_FILE),
        serde_json::to_vec(&serde_json::json!({
            "version": 1, "enabled": false, "cpa_settings": "", "cpa_auth": null,
            "native_auth": stale, "restore_full_routing": false
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture.switch(&keys[1]).status, "switched");
    let record: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.codex.join(CODEX_NATIVE_OAUTH_STATE_FILE)).unwrap(),
    )
    .unwrap();
    assert_eq!(record["version"], 1);
    let native = record["native_auth"].as_str().unwrap();
    assert_eq!(
        native.as_bytes(),
        fs::read(fixture.codex.join("auth.json"))
            .unwrap()
            .trim_ascii_end()
    );
    match parse_native_auth(Some(native.as_bytes())).unwrap() {
        NativeAuth::OAuth(credential) => assert_eq!(credential.identity().unwrap().key, keys[1]),
        other => panic!("{other:?}"),
    }
}

// ---- Failure handling --------------------------------------------------------------------

#[test]
fn write_failures_roll_back_and_leave_no_journal() {
    let (fixture, keys) = Fixture::with_three_accounts("rollback");
    fixture.write_live(&fresh(&PERSONAL));
    let before = fs::read(fixture.codex.join("auth.json")).unwrap();
    let env = SwitchEnv {
        codex_home: &fixture.codex,
        running: vec![],
        now: NOW,
    };
    let mut calls = 0;
    let result =
        fixture
            .engine
            .switch_with(&env, &keys[1], &mut |client: &str, images: &Images| {
                calls += 1;
                if calls == 1 {
                    // Partial write: auth.json gets truncated garbage, then the disk "fails".
                    fs::write(&images[0].0, b"{\"auth_mode\":").unwrap();
                    return Err("simulated disk failure".into());
                }
                super::engine::atomic_images_writer(client, images)
            });
    assert!(result.unwrap_err().contains("rolled back"));
    assert_eq!(fs::read(fixture.codex.join("auth.json")).unwrap(), before);
    assert!(!fixture.accounts.join(JOURNAL_FILE).exists());
    assert_eq!(fixture.live_key(), keys[0]);
    // The engine is healthy afterwards.
    assert_eq!(fixture.switch(&keys[1]).status, "switched");
}

#[test]
fn a_write_that_produces_the_wrong_identity_is_rejected() {
    let (fixture, keys) = Fixture::with_three_accounts("verify");
    fixture.write_live(&fresh(&PERSONAL));
    let before = fs::read(fixture.codex.join("auth.json")).unwrap();
    let env = SwitchEnv {
        codex_home: &fixture.codex,
        running: vec![],
        now: NOW,
    };
    let wrong = render_native_auth(None, &fresh(&RESERVE)).unwrap();
    let mut substituted = false;
    let result =
        fixture
            .engine
            .switch_with(&env, &keys[1], &mut |client: &str, images: &Images| {
                let mut images = images.clone();
                if !substituted && images[0].1.as_deref() != Some(before.as_slice()) {
                    substituted = true;
                    images[0].1 = Some(wrong.clone());
                }
                super::engine::atomic_images_writer(client, &images)
            });
    assert!(
        result.is_err(),
        "identity substitution must never be reported as success"
    );
    assert_eq!(fs::read(fixture.codex.join("auth.json")).unwrap(), before);
}

fn seal_journal(fixture: &Fixture, journal: &SwitchJournal) {
    fixture
        .engine
        .write_journal_for_test(JOURNAL_LABEL, &serde_json::to_vec(journal).unwrap());
}

fn journal_for(
    fixture: &Fixture,
    target: &str,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
) -> SwitchJournal {
    SwitchJournal {
        started_at: NOW,
        target_key: target.to_string(),
        from_key: None,
        files: vec![
            JournalFile {
                path: fixture.codex.join("auth.json"),
                before_hash: image_hash(before.as_deref()),
                after_hash: image_hash(Some(&after)),
                before,
            },
            JournalFile {
                path: fixture.codex.join(CODEX_NATIVE_OAUTH_STATE_FILE),
                before_hash: image_hash(Some(b"{\"version\":1}")),
                after_hash: image_hash(Some(b"{\"version\":1,\"x\":1}")),
                before: Some(b"{\"version\":1}".to_vec()),
            },
        ],
    }
}

#[test]
fn crash_recovery_rolls_back_partial_switches_and_finishes_complete_ones() {
    let (fixture, keys) = Fixture::with_three_accounts("recovery");
    let old = render_native_auth(None, &fresh(&PERSONAL)).unwrap();
    let new = render_native_auth(None, &fresh(&WORK)).unwrap();
    let journal = journal_for(&fixture, &keys[1], Some(old.clone()), new.clone());
    let state_file = fixture.codex.join(CODEX_NATIVE_OAUTH_STATE_FILE);

    // Crash after auth.json was replaced but before the record was: roll back.
    fs::write(fixture.codex.join("auth.json"), &new).unwrap();
    fs::write(&state_file, b"{\"version\":1}").unwrap();
    seal_journal(&fixture, &journal);
    let report = fixture.engine.recover(NOW + 5).unwrap().unwrap();
    assert_eq!(report.outcome, "rolled_back");
    assert_eq!(fs::read(fixture.codex.join("auth.json")).unwrap(), old);
    assert!(!fixture.accounts.join(JOURNAL_FILE).exists());

    // Nothing written yet: nothing to do.
    seal_journal(&fixture, &journal);
    assert_eq!(
        fixture.engine.recover(NOW + 6).unwrap().unwrap().outcome,
        "untouched"
    );

    // Crash after every file was written: the switch completed, state catches up.
    fs::write(fixture.codex.join("auth.json"), &new).unwrap();
    fs::write(&state_file, b"{\"version\":1,\"x\":1}").unwrap();
    seal_journal(&fixture, &journal);
    assert_eq!(
        fixture.engine.recover(NOW + 7).unwrap().unwrap().outcome,
        "completed"
    );
    assert_eq!(
        fixture.state().active_native.as_deref(),
        Some(keys[1].as_str())
    );

    // No journal -> no-op.
    assert!(fixture.engine.recover(NOW + 8).unwrap().is_none());
}

#[test]
fn recovery_never_overwrites_credentials_that_changed_after_the_crash() {
    let (fixture, keys) = Fixture::with_three_accounts("recovery-newer");
    let old = render_native_auth(None, &fresh(&PERSONAL)).unwrap();
    let new = render_native_auth(None, &fresh(&WORK)).unwrap();
    let journal = journal_for(&fixture, &keys[1], Some(old), new);
    // After the crash Codex ran and refreshed the (already switched) account.
    let refreshed =
        render_native_auth(None, &credential(&WORK, NOW + 100, 3600 * 10, true)).unwrap();
    fs::write(fixture.codex.join("auth.json"), &refreshed).unwrap();
    fs::write(
        fixture.codex.join(CODEX_NATIVE_OAUTH_STATE_FILE),
        b"{\"version\":1}",
    )
    .unwrap();
    seal_journal(&fixture, &journal);
    let report = fixture.engine.recover(NOW + 9).unwrap().unwrap();
    assert_eq!(report.outcome, "diverged");
    assert_eq!(
        fs::read(fixture.codex.join("auth.json")).unwrap(),
        refreshed
    );
    assert!(!fixture.accounts.join(JOURNAL_FILE).exists());
    // The next snapshot still reports the interrupted-switch recovery to the UI.
    assert_eq!(fixture.state().recovery.unwrap().outcome, "diverged");
}

#[test]
fn a_tampered_journal_is_quarantined_not_trusted() {
    let (fixture, _keys) = Fixture::with_three_accounts("journal-tamper");
    fixture.engine.write_journal_for_test(JOURNAL_LABEL, b"{}");
    let path = fixture.accounts.join(JOURNAL_FILE);
    let mut bytes = fs::read(&path).unwrap();
    *bytes.last_mut().unwrap() ^= 0xff;
    fs::write(&path, bytes).unwrap();
    let report = fixture.engine.recover(NOW).unwrap().unwrap();
    assert_eq!(report.outcome, "failed");
    assert!(!path.exists());
}

// ---- Security ----------------------------------------------------------------------------

#[test]
fn credentials_are_encrypted_at_rest_and_tamper_evident() {
    let (fixture, keys) = Fixture::with_three_accounts("vault");
    let secret = fresh(&WORK).tokens.refresh_token;
    for entry in fs::read_dir(&fixture.accounts).unwrap().flatten() {
        let bytes = fs::read(entry.path()).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        for token in [
            &secret,
            &fresh(&PERSONAL).tokens.access_token,
            &fresh(&PERSONAL).tokens.id_token,
        ] {
            assert!(
                !text.contains(token.as_str()),
                "{:?} leaks a token",
                entry.file_name()
            );
        }
    }
    #[cfg(unix)]
    for name in ["vault.bin", "vault.key", "accounts.json"] {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(fixture.accounts.join(name))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "{name}");
    }
    // Flip one ciphertext byte: the vault must refuse to load rather than return garbage.
    let path = fixture.accounts.join("vault.bin");
    let mut bytes = fs::read(&path).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 1;
    fs::write(&path, bytes).unwrap();
    let error = fixture
        .engine
        .state(&StateContext {
            cpa_dir: &fixture.cpa,
            codex_home: &fixture.codex,
            now: NOW,
            running: None,
        })
        .unwrap_err();
    assert!(error.contains("authentication") || error.contains("corrupted"));
    // Losing the key never silently mints a new one over existing ciphertext.
    fs::remove_file(fixture.accounts.join("vault.key")).unwrap();
    let error = fixture.reopen().switch(
        &SwitchEnv {
            codex_home: &fixture.codex,
            running: vec![],
            now: NOW,
        },
        &keys[0],
    );
    assert!(error.unwrap_err().contains("vault key is missing"));
    // Explicit reset keeps the old files and starts clean.
    fixture.engine.quarantine_vault().unwrap();
    assert!(fs::read_dir(&fixture.accounts)
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().contains("unusable")));
}

#[test]
fn frontend_views_never_contain_token_material() {
    let (fixture, keys) = Fixture::with_three_accounts("views");
    fixture.write_live(&fresh(&PERSONAL));
    let outcome = fixture.switch(&keys[1]);
    let serialized = format!(
        "{}{}",
        serde_json::to_string(&fixture.state()).unwrap(),
        serde_json::to_string(&outcome).unwrap()
    );
    for login in [&PERSONAL, &WORK, &RESERVE] {
        let credential = fresh(login);
        for token in [
            &credential.tokens.access_token,
            &credential.tokens.refresh_token,
            &credential.tokens.id_token,
        ] {
            assert!(!serialized.contains(token.as_str()));
        }
        assert!(
            !serialized.contains(login.account),
            "full account ids are masked"
        );
        assert!(!serialized.contains(login.user));
    }
    assert!(!serialized.contains("refresh_token") && !serialized.contains("access_token"));
    assert_eq!(
        format!("{:?}", fresh(&PERSONAL)),
        "CodexCredential(<redacted>)"
    );
    assert_eq!(
        format!("{:?}", fresh(&PERSONAL).tokens),
        "CodexTokens(<redacted>)"
    );
}

#[test]
fn account_identity_cannot_be_substituted_by_a_mismatched_credential() {
    let mut forged = fresh(&PERSONAL);
    forged.tokens.account_id = WORK.account.to_string();
    assert!(
        forged.identity().is_err(),
        "stored id contradicts the ID token"
    );
    let anonymous = CodexCredential {
        tokens: CodexTokens {
            id_token: String::new(),
            access_token: "opaque".into(),
            refresh_token: String::new(),
            account_id: String::new(),
        },
        last_refresh: None,
    };
    assert!(anonymous.identity().is_err());
    assert_ne!(
        fresh(&PERSONAL).identity().unwrap().key,
        fresh(&WORK).identity().unwrap().key
    );
    assert_eq!(
        fresh(&PERSONAL).identity().unwrap(),
        credential(&PERSONAL, 1, 1, false).identity().unwrap()
    );
    // A CPA file that lies about its account id is reported, not imported.
    let fixture = Fixture::new("forged-cpa");
    fixture.write_cpa("codex-forged.json", &forged, false);
    let snapshot = fixture.state();
    assert!(snapshot.accounts.is_empty());
    assert!(snapshot
        .issues
        .iter()
        .any(|issue| issue.contains("codex-forged.json")));
}

#[test]
fn native_auth_parsing_distinguishes_oauth_api_key_and_empty() {
    assert!(matches!(parse_native_auth(None), Ok(NativeAuth::Missing)));
    assert!(matches!(
        parse_native_auth(Some(b"  \n")),
        Ok(NativeAuth::Missing)
    ));
    assert!(matches!(
        parse_native_auth(Some(br#"{"OPENAI_API_KEY":"sk-x"}"#)),
        Ok(NativeAuth::ApiKey)
    ));
    assert!(matches!(
        parse_native_auth(Some(br#"{"OPENAI_API_KEY":null}"#)),
        Ok(NativeAuth::Missing)
    ));
    let error = parse_native_auth(Some(b"{\"tokens\": sk-secret-value")).unwrap_err();
    assert!(
        !error.contains("sk-secret-value"),
        "parse errors never echo file content"
    );
    assert!(parse_native_auth(Some(b"[]")).is_err());
}

#[test]
fn a_credential_removed_from_the_proxy_is_reported_but_stays_switchable() {
    let (fixture, keys) = Fixture::with_three_accounts("cpa-removed");
    fs::remove_file(fixture.cpa.join("codex-work.json")).unwrap();
    let snapshot = fixture.state();
    let work = snapshot.accounts.iter().find(|a| a.key == keys[1]).unwrap();
    assert!(!work.connected);
    assert_eq!((work.cpa_copy, work.proxy_disabled), (CpaCopy::Missing, None));
    // The saved native session survives, so quick switching keeps working without the proxy copy.
    assert_eq!(fixture.switch(&keys[1]).status, "switched");
    assert_eq!(fixture.live_key(), keys[1]);
}

#[test]
fn switch_latency_is_measured_per_stage_and_stays_small() {
    let (fixture, keys) = Fixture::with_three_accounts("latency");
    fixture.write_live(&fresh(&PERSONAL));
    let mut totals = Vec::new();
    for round in 0..20 {
        let outcome = fixture.switch(&keys[(round + 1) % 2]);
        let timings = outcome.timings.expect("switched outcomes carry timings");
        assert!(timings.validate_ms >= 0.0 && timings.write_ms > 0.0 && timings.verify_ms >= 0.0);
        totals.push((timings.validate_ms, timings.write_ms, timings.verify_ms, timings.total_ms));
    }
    let average = |select: fn(&(f64, f64, f64, f64)) -> f64| totals.iter().map(select).sum::<f64>() / totals.len() as f64;
    println!(
        "switch latency (avg of {}): validate {:.2} ms, atomic write+verify {:.2} ms, identity verify {:.2} ms, total {:.2} ms",
        totals.len(),
        average(|t| t.0),
        average(|t| t.1),
        average(|t| t.2),
        average(|t| t.3)
    );
    assert!(average(|t| t.3) < 500.0, "a local switch should be far below half a second");
}
