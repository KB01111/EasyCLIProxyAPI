//! Codex Account Center backend: multi-account vault, safe native `auth.json` switching,
//! quota digests, recommendations and tray/shortcut integration. See
//! `docs/CODEX_ACCOUNT_CENTER_PLAN.md`.
use super::*;

mod commands;
mod discovery;
mod engine;
mod hotkey;
mod identity;
mod native;
mod recommend;
mod store;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) mod tray_menu;
mod vault;

#[cfg(test)]
mod tests;

pub(crate) use commands::*;
