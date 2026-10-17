import { useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeftRight, Info, KeyRound, Lightbulb, RefreshCw, UserPlus } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import type { AccountsSnapshot, Recommendation } from '../../services/codexAccounts';

type Tone = 'info' | 'warn' | 'error' | 'success' | 'muted';

export function Banner({ tone, icon, children, actions, testId, role }: {
  tone: Tone; icon: ReactNode; children: ReactNode; actions?: ReactNode; testId?: string; role?: 'alert' | 'status';
}) {
  return (
    <div className={`cxa-banner ${tone}`} data-testid={testId} role={role}>
      <span className="cxa-banner-icon" aria-hidden="true">{icon}</span>
      <div className="cxa-banner-body">{children}</div>
      {actions ? <div className="cxa-banner-actions">{actions}</div> : null}
    </div>
  );
}

let dismissedRecoveryAt = 0;

type Props = {
  snapshot: AccountsSnapshot;
  recommendation: Recommendation | null;
  busy: boolean;
  onAcknowledgeExternal: () => void;
  onAdoptLive: () => void;
  onSwitch: (key: string) => void;
};

export function CodexAccountsBanners({ snapshot, recommendation, busy, onAcknowledgeExternal, onAdoptLive, onSwitch }: Props) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const [recoveryHidden, setRecoveryHidden] = useState(() => dismissedRecoveryAt);
  const aliasOf = (key: string | null) => {
    if (!key) return t('codexAccounts.external.none');
    const account = snapshot.accounts.find((candidate) => candidate.key === key);
    return account ? privacy.text(account.alias) : t('codexAccounts.external.unmanaged');
  };
  const { native, externalChange, recovery } = snapshot;
  const showRecovery = recovery !== null && recovery.at !== recoveryHidden;
  return (
    <div className="cxa-banners" data-testid="banners">
      {externalChange ? (
        <Banner tone="warn" icon={<AlertTriangle size={16} />} testId="banner-external" role="alert"
          actions={<button type="button" className="secondary-button compact-button" disabled={busy} onClick={onAcknowledgeExternal}>{t('codexAccounts.ok')}</button>}>
          <strong>{t('codexAccounts.external.title')}</strong>
          <span>{t('codexAccounts.external.message', { from: aliasOf(externalChange.from), to: aliasOf(externalChange.to) })}</span>
        </Banner>
      ) : null}
      {showRecovery && recovery ? (
        <Banner tone={recovery.outcome === 'completed' || recovery.outcome === 'untouched' ? 'info' : 'warn'}
          icon={<Info size={16} />} testId="banner-recovery"
          actions={<button type="button" className="secondary-button compact-button" onClick={() => { dismissedRecoveryAt = recovery.at; setRecoveryHidden(recovery.at); }}>{t('codexAccounts.dismiss')}</button>}>
          <strong>{t(`codexAccounts.recovery.${recovery.outcome}` as const)}</strong>
          <span>{recovery.message}</span>
        </Banner>
      ) : null}
      {native.live === 'unmanaged' ? (
        <Banner tone="warn" icon={<UserPlus size={16} />} testId="banner-unmanaged"
          actions={<button type="button" className="primary-button compact-button" disabled={busy} onClick={onAdoptLive}>{t('codexAccounts.adopt.action')}</button>}>
          <strong>{t('codexAccounts.unmanaged.title')}</strong>
          <span>{t('codexAccounts.unmanaged.message', {
            who: privacy.text([native.unmanaged?.email, native.unmanaged?.accountIdHint].filter(Boolean).join(' · ')) || '—',
          })}</span>
        </Banner>
      ) : null}
      {native.live === 'api_key' ? (
        <Banner tone="info" icon={<KeyRound size={16} />} testId="banner-api-key">
          <strong>{t('codexAccounts.apiKey.title')}</strong>
          <span>{t('codexAccounts.apiKey.message')}</span>
        </Banner>
      ) : null}
      {!native.credentialStore.supported ? (
        <Banner tone="warn" icon={<AlertTriangle size={16} />} testId="banner-store">
          <strong>{t('codexAccounts.store.title', { mode: native.credentialStore.mode })}</strong>
          <span>{t('codexAccounts.store.message')}</span>
          <small>{native.credentialStore.detail}</small>
        </Banner>
      ) : null}
      {native.error ? (
        <Banner tone="error" icon={<AlertTriangle size={16} />} testId="banner-native-error" role="alert">
          <strong>{t('codexAccounts.nativeError.title')}</strong>
          <span>{privacy.text(native.error)}</span>
        </Banner>
      ) : null}
      {snapshot.issues.length ? (
        <Banner tone="warn" icon={<AlertTriangle size={16} />} testId="banner-issues">
          <strong>{t('codexAccounts.issues.title')}</strong>
          <ul>{snapshot.issues.map((issue, index) => <li key={index}>{privacy.text(issue)}</li>)}</ul>
        </Banner>
      ) : null}
      <RecommendationBanner snapshot={snapshot} recommendation={recommendation} busy={busy} onSwitch={onSwitch} />
    </div>
  );
}

const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value)}%`);

function RecommendationBanner({ snapshot, recommendation, busy, onSwitch }: {
  snapshot: AccountsSnapshot; recommendation: Recommendation | null; busy: boolean; onSwitch: (key: string) => void;
}) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  if (!recommendation || recommendation.code === 'disabled') return null;
  const alias = (key: string | null) => privacy.text(snapshot.accounts.find((account) => account.key === key)?.alias ?? '');
  const primary = alias(snapshot.pinned.primary);
  const secondary = alias(snapshot.pinned.secondary);
  const { code } = recommendation;
  if (code === 'more_capacity' || code === 'other_exhausted') {
    const target = snapshot.accounts.find((account) => account.key === recommendation.recommended);
    if (!target) return null;
    const reason = code === 'more_capacity'
      ? t('codexAccounts.recommend.moreCapacity', {
        primary, secondary, primaryPct: pct(recommendation.primaryPct), secondaryPct: pct(recommendation.secondaryPct),
      })
      : t('codexAccounts.recommend.otherExhausted', {
        other: target.key === snapshot.pinned.primary ? secondary : primary,
        pct: pct(target.key === snapshot.pinned.primary ? recommendation.secondaryPct : recommendation.primaryPct),
      });
    return (
      <Banner tone="success" icon={<Lightbulb size={16} />} testId="banner-recommendation"
        actions={target.activeNative ? undefined : (
          <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => onSwitch(target.key)}>
            <ArrowLeftRight size={13} aria-hidden="true" />{t('codexAccounts.switch.to', { alias: privacy.text(target.alias) })}
          </button>
        )}>
        <strong>{t('codexAccounts.recommend.title', { alias: privacy.text(target.alias) })}{target.activeNative ? ` (${t('codexAccounts.recommend.alreadyActive')})` : ''}</strong>
        <span>{reason}</span>
        <small>{t('codexAccounts.recommend.advisory')}</small>
      </Banner>
    );
  }
  const text = code === 'similar'
    ? t('codexAccounts.recommend.similar', { primaryPct: pct(recommendation.primaryPct), secondaryPct: pct(recommendation.secondaryPct) })
    : code === 'auth_error' ? t('codexAccounts.recommend.authError')
      : code === 'data_stale' ? t('codexAccounts.recommend.dataStale')
        : code === 'data_missing' ? t('codexAccounts.recommend.dataMissing')
          : t('codexAccounts.recommend.pairIncomplete');
  return (
    <Banner tone="muted" icon={code === 'auth_error' ? <AlertTriangle size={16} /> : <RefreshCw size={16} />} testId="banner-recommendation-hint">
      <span>{text}</span>
    </Banner>
  );
}
