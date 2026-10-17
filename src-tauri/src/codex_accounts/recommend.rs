use super::engine::AccountsSnapshot;
use super::store::{AccountSettings, PinnedPair};
use super::*;

const MAX_SUMMARIES: usize = 64;
/// Differences below this many percentage points are not worth steering the user for.
const SIMILAR_POINTS: f64 = 5.0;
/// Quota older than this is never trusted, whatever the refresh setting.
const MIN_STALE_SECONDS: i64 = 30 * 60;

/// Safe, numeric quota digest pushed by the webview (which fetches quota through the core).
/// It carries no credentials: only percentages, reset times and a fetch timestamp.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuotaSummary {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) short_remaining_pct: Option<f64>,
    #[serde(default)]
    pub(crate) short_reset_at: Option<i64>,
    #[serde(default)]
    pub(crate) weekly_remaining_pct: Option<f64>,
    #[serde(default)]
    pub(crate) weekly_reset_at: Option<i64>,
    pub(crate) fetched_at: i64,
    /// `ok` | `rate_limited` | `auth_error` | `unavailable`
    #[serde(default = "default_status")]
    pub(crate) status: String,
}

fn default_status() -> String {
    "unavailable".into()
}

impl QuotaSummary {
    /// Drop NaN/out-of-range values rather than trusting the caller.
    fn sanitized(mut self) -> Option<Self> {
        let clean = |value: Option<f64>| {
            value
                .filter(|value| value.is_finite())
                .map(|value| value.clamp(0.0, 100.0))
        };
        self.short_remaining_pct = clean(self.short_remaining_pct);
        self.weekly_remaining_pct = clean(self.weekly_remaining_pct);
        if !matches!(
            self.status.as_str(),
            "ok" | "rate_limited" | "auth_error" | "unavailable"
        ) {
            self.status = "unavailable".into();
        }
        (!self.key.is_empty() && self.fetched_at > 0).then_some(self)
    }

    /// Capacity the user can actually rely on: the scarcest known window.
    pub(crate) fn effective_pct(&self) -> Option<f64> {
        if self.status == "auth_error" {
            return None;
        }
        match (self.short_remaining_pct, self.weekly_remaining_pct) {
            (Some(short), Some(weekly)) => Some(short.min(weekly)),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        }
    }
}

pub(crate) fn sanitize_summaries(summaries: Vec<QuotaSummary>) -> Vec<QuotaSummary> {
    summaries
        .into_iter()
        .take(MAX_SUMMARIES)
        .filter_map(QuotaSummary::sanitized)
        .collect()
}

pub(crate) fn stale_after_seconds(settings: &AccountSettings) -> i64 {
    (i64::from(settings.refresh_minutes) * 60 * 2).max(MIN_STALE_SECONDS)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recommendation {
    pub(crate) recommended: Option<String>,
    /// `disabled` | `pair_incomplete` | `data_missing` | `data_stale` | `auth_error` | `similar`
    /// | `more_capacity` | `other_exhausted`
    pub(crate) code: &'static str,
    pub(crate) primary_pct: Option<f64>,
    pub(crate) secondary_pct: Option<f64>,
}

fn verdict(
    code: &'static str,
    primary: Option<f64>,
    secondary: Option<f64>,
    recommended: Option<String>,
) -> Recommendation {
    Recommendation {
        recommended,
        code,
        primary_pct: primary,
        secondary_pct: secondary,
    }
}

/// Advisory only: never triggers a switch. Requires fresh data for both pinned accounts.
pub(crate) fn recommend(
    pinned: &PinnedPair,
    settings: &AccountSettings,
    summaries: &[QuotaSummary],
    now: i64,
) -> Recommendation {
    if !settings.recommendations {
        return verdict("disabled", None, None, None);
    }
    let (Some(primary), Some(secondary)) = (&pinned.primary, &pinned.secondary) else {
        return verdict("pair_incomplete", None, None, None);
    };
    let find = |key: &String| summaries.iter().find(|summary| &summary.key == key);
    let (Some(first), Some(second)) = (find(primary), find(secondary)) else {
        return verdict("data_missing", None, None, None);
    };
    if [first, second]
        .iter()
        .any(|summary| now - summary.fetched_at > stale_after_seconds(settings))
    {
        return verdict(
            "data_stale",
            first.effective_pct(),
            second.effective_pct(),
            None,
        );
    }
    if first.status == "auth_error" || second.status == "auth_error" {
        return verdict("auth_error", None, None, None);
    }
    let (Some(a), Some(b)) = (first.effective_pct(), second.effective_pct()) else {
        return verdict(
            "data_missing",
            first.effective_pct(),
            second.effective_pct(),
            None,
        );
    };
    let (pick_a, pick_b) = (Some(primary.clone()), Some(secondary.clone()));
    if a <= 0.0 && b > 0.0 {
        return verdict("other_exhausted", Some(a), Some(b), pick_b);
    }
    if b <= 0.0 && a > 0.0 {
        return verdict("other_exhausted", Some(a), Some(b), pick_a);
    }
    if (a - b).abs() < SIMILAR_POINTS {
        return verdict("similar", Some(a), Some(b), None);
    }
    verdict(
        "more_capacity",
        Some(a),
        Some(b),
        if a > b { pick_a } else { pick_b },
    )
}

/// One account line in the tray: numbers only; the tray localizes the wording.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TrayLine {
    pub(crate) key: String,
    pub(crate) alias: String,
    pub(crate) remaining_pct: Option<f64>,
    pub(crate) stale: bool,
    pub(crate) active: bool,
}

pub(crate) fn tray_lines(
    snapshot: &AccountsSnapshot,
    summaries: &[QuotaSummary],
    now: i64,
) -> Vec<TrayLine> {
    let stale_after = stale_after_seconds(&snapshot.settings);
    snapshot
        .accounts
        .iter()
        .map(|account| {
            let summary = summaries.iter().find(|summary| summary.key == account.key);
            TrayLine {
                key: account.key.clone(),
                alias: account.alias.clone(),
                remaining_pct: summary.and_then(QuotaSummary::effective_pct),
                stale: summary.is_some_and(|summary| now - summary.fetched_at > stale_after),
                active: account.active_native,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(
        key: &str,
        short: Option<f64>,
        weekly: Option<f64>,
        fetched_at: i64,
        status: &str,
    ) -> QuotaSummary {
        QuotaSummary {
            key: key.into(),
            short_remaining_pct: short,
            short_reset_at: None,
            weekly_remaining_pct: weekly,
            weekly_reset_at: None,
            fetched_at,
            status: status.into(),
        }
    }

    fn pair() -> PinnedPair {
        PinnedPair {
            primary: Some("a".into()),
            secondary: Some("b".into()),
        }
    }

    #[test]
    fn recommends_the_account_with_more_scarce_window_headroom() {
        let now = 10_000;
        let summaries = vec![
            summary("a", Some(18.0), Some(90.0), now - 60, "ok"),
            summary("b", Some(82.0), Some(80.0), now - 60, "ok"),
        ];
        let result = recommend(&pair(), &AccountSettings::default(), &summaries, now);
        assert_eq!(result.recommended.as_deref(), Some("b"));
        assert_eq!(result.code, "more_capacity");
        assert_eq!(
            (result.primary_pct, result.secondary_pct),
            (Some(18.0), Some(80.0))
        );
    }

    #[test]
    fn weekly_exhaustion_beats_a_healthy_short_window() {
        let now = 10_000;
        let summaries = vec![
            summary("a", Some(95.0), Some(0.0), now, "rate_limited"),
            summary("b", Some(20.0), Some(30.0), now, "ok"),
        ];
        let result = recommend(&pair(), &AccountSettings::default(), &summaries, now);
        assert_eq!(
            (result.recommended.as_deref(), result.code),
            (Some("b"), "other_exhausted")
        );
    }

    #[test]
    fn stays_silent_without_fresh_complete_data() {
        let now = 100_000;
        let settings = AccountSettings::default();
        let old = now - stale_after_seconds(&settings) - 1;
        let stale = vec![
            summary("a", Some(10.0), None, old, "ok"),
            summary("b", Some(90.0), None, now, "ok"),
        ];
        assert_eq!(
            recommend(&pair(), &settings, &stale, now).code,
            "data_stale"
        );
        let missing = vec![summary("a", Some(10.0), None, now, "ok")];
        assert_eq!(
            recommend(&pair(), &settings, &missing, now).code,
            "data_missing"
        );
        let auth = vec![
            summary("a", None, None, now, "auth_error"),
            summary("b", Some(90.0), None, now, "ok"),
        ];
        let result = recommend(&pair(), &settings, &auth, now);
        assert_eq!((result.code, result.recommended), ("auth_error", None));
        let close = vec![
            summary("a", Some(50.0), None, now, "ok"),
            summary("b", Some(53.0), None, now, "ok"),
        ];
        assert_eq!(recommend(&pair(), &settings, &close, now).code, "similar");
        let disabled = AccountSettings {
            recommendations: false,
            ..settings.clone()
        };
        assert_eq!(recommend(&pair(), &disabled, &close, now).code, "disabled");
        assert_eq!(
            recommend(&PinnedPair::default(), &settings, &close, now).code,
            "pair_incomplete"
        );
    }

    #[test]
    fn untrusted_summaries_are_sanitized() {
        let cleaned = sanitize_summaries(vec![
            summary("a", Some(f64::NAN), Some(250.0), 5, "weird"),
            summary("", Some(1.0), None, 5, "ok"),
            summary("c", Some(1.0), None, 0, "ok"),
        ]);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].short_remaining_pct, None);
        assert_eq!(cleaned[0].weekly_remaining_pct, Some(100.0));
        assert_eq!(cleaned[0].status, "unavailable");
    }
}
