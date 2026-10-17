import { memo } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import type { MessageKey } from '../../i18n/resources';
import {
  staleAfterMs,
  type AccountQuotaEntry,
  type QuotaBlockReason,
  type QuotaWindow,
} from '../../services/codexAccountsQuota';
import { AgeLabel, ResetCountdown } from './Countdown';

const BLOCK_TEXT: Record<Exclude<QuotaBlockReason, null>, MessageKey> = {
  core_offline: 'codexAccounts.quota.coreOffline',
  not_connected: 'codexAccounts.quota.notConnected',
  proxy_disabled: 'codexAccounts.quota.proxyDisabled',
  expired: 'codexAccounts.quota.expired',
  no_file: 'codexAccounts.quota.noFile',
  no_auth_index: 'codexAccounts.quota.noFile',
};

const level = (pct: number) => (pct <= 10 ? 'low' : pct <= 30 ? 'mid' : 'high');

function WindowRow({ kind, window }: { kind: 'short' | 'long'; window: QuotaWindow | null }) {
  const { t } = useI18n();
  const heading = t(kind === 'short' ? 'codexAccounts.quota.short' : 'codexAccounts.quota.long');
  const pct = window?.remainingPct ?? null;
  return (
    <div className="cxa-window" data-window={kind}>
      <div className="cxa-window-head">
        <span>{heading}{window ? <small>{window.label}</small> : null}</span>
        <strong>{pct === null ? t('codexAccounts.quota.unavailable') : `${Math.round(pct)}%`}</strong>
      </div>
      <div
        className="cxa-bar"
        role="progressbar"
        aria-label={`${heading}${window ? ` (${window.label})` : ''}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        aria-valuetext={pct === null ? t('codexAccounts.quota.unavailable') : t('codexAccounts.quota.remaining', { percent: Math.round(pct) })}
      >
        {pct === null ? null : <span className={`cxa-bar-fill ${level(pct)}`} style={{ width: `${pct}%` }} />}
      </div>
      <div className="cxa-window-foot">
        {window ? <ResetCountdown resetAtSec={window.resetAtSec} /> : <span className="cxa-muted">—</span>}
      </div>
    </div>
  );
}

type Props = {
  entry: AccountQuotaEntry | undefined;
  loading: boolean;
  blocked: QuotaBlockReason;
  refreshMinutes: number;
  compact?: boolean;
};

/** Short-term and long-term quota windows for one account, with per-account loading state. */
export const QuotaWindows = memo(function QuotaWindows({ entry, loading, blocked, refreshMinutes, compact }: Props) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  if (blocked && blocked !== 'core_offline' && !entry?.fetchedAtMs) {
    return <p className="cxa-quota-note" data-quota-state="blocked">{t(BLOCK_TEXT[blocked])}</p>;
  }
  if (!entry?.fetchedAtMs) {
    if (loading || (!entry && !blocked)) {
      return (
        <div className="cxa-quota-skeleton" data-quota-state="loading" role="status" aria-label={t('codexAccounts.quota.loading')}>
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
          <span>{t('codexAccounts.quota.loading')}</span>
          <i /><i />
        </div>
      );
    }
    if (blocked) return <p className="cxa-quota-note" data-quota-state="blocked">{t(BLOCK_TEXT[blocked])}</p>;
    return (
      <p className="cxa-quota-note error" data-quota-state="unavailable">
        {t(entry?.status === 'auth_error' ? 'codexAccounts.quota.authError'
          : entry?.status === 'rate_limited' ? 'codexAccounts.quota.rateLimited' : 'codexAccounts.quota.unavailable')}
        {entry?.error ? <small>{privacy.text(entry.error)}</small> : null}
      </p>
    );
  }
  return (
    <div className={compact ? 'cxa-windows compact' : 'cxa-windows'} data-quota-state={loading ? 'refreshing' : 'ready'}>
      <WindowRow kind="short" window={entry.short} />
      <WindowRow kind="long" window={entry.long} />
      <div className="cxa-quota-meta">
        <span>{t('codexAccounts.quota.updated')} <AgeLabel atMs={entry.fetchedAtMs} staleAfterMs={staleAfterMs(refreshMinutes)} /></span>
        {loading ? <span className="cxa-chip"><LoaderCircle size={11} className="spin" aria-hidden="true" />{t('codexAccounts.quota.refreshing')}</span> : null}
        {!loading && entry.status !== 'ok' ? (
          <span className="cxa-chip warn" title={privacy.text(entry.error ?? '')}>
            {t(entry.status === 'auth_error' ? 'codexAccounts.quota.authError'
              : entry.status === 'rate_limited' ? 'codexAccounts.quota.rateLimited' : 'codexAccounts.quota.refreshFailed')}
          </span>
        ) : null}
      </div>
    </div>
  );
});
