import { memo } from 'react';
import { ArrowLeftRight, LogIn, Pin } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import {
  nativeSwitchBlockReason,
  switchDisabledReason,
  type AccountView,
  type AccountsSnapshot,
  type PinnedSlot,
} from '../../services/codexAccounts';
import type { AccountQuotaEntry, QuotaBlockReason } from '../../services/codexAccountsQuota';
import { QuotaWindows } from './QuotaWindows';
import { AuthStatus } from './StatusChips';

type CardProps = {
  slot: PinnedSlot;
  account: AccountView | null;
  entry: AccountQuotaEntry | undefined;
  quotaLoading: boolean;
  blocked: QuotaBlockReason;
  refreshMinutes: number;
  switchDisabled: boolean;
  busy: boolean;
  switchHint: string | undefined;
  recommended: boolean;
  onSwitch: (key: string) => void;
  onReauthenticate: () => void;
};

const FeaturedCard = memo(function FeaturedCard(props: CardProps) {
  const { slot, account, entry, quotaLoading, blocked, refreshMinutes, switchDisabled, busy } = props;
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const slotLabel = t(slot === 'primary' ? 'codexAccounts.pin.primary' : 'codexAccounts.pin.secondary');
  if (!account) {
    return (
      <article className="cxa-featured empty" data-slot={slot} data-testid="featured-card" data-empty="true">
        <header><span className="cxa-chip pin"><Pin size={11} aria-hidden="true" />{slotLabel}</span></header>
        <p className="cxa-empty-text">{t(slot === 'primary' ? 'codexAccounts.quick.emptyPrimary' : 'codexAccounts.quick.emptySecondary')}</p>
      </article>
    );
  }
  const alias = privacy.text(account.alias);
  return (
    <article className="cxa-featured" data-slot={slot} data-testid="featured-card" data-account-key={account.key}
      data-active={account.activeNative ? 'true' : undefined} aria-label={`${slotLabel}: ${alias}`}>
      <header>
        <span className="cxa-chip pin"><Pin size={11} aria-hidden="true" />{slotLabel}</span>
        {account.plan ? <span className="cxa-chip plan">{account.plan}</span> : null}
        {account.activeNative
          ? <span className="cxa-chip active" data-native="active">{t('codexAccounts.native.active')}</span> : null}
        {props.recommended ? <span className="cxa-chip info">{t('codexAccounts.recommend.badge')}</span> : null}
      </header>
      <h3 className="cxa-featured-name" title={alias}>{alias}</h3>
      <p className="cxa-email">
        {account.email ? <span className="cxa-email-text">{privacy.text(account.email)}</span> : null}
        <code className="cxa-hint">{account.accountIdHint}</code>
        <AuthStatus validity={account.validity} />
      </p>
      <QuotaWindows entry={entry} loading={quotaLoading} blocked={blocked} refreshMinutes={refreshMinutes} />
      <div className="cxa-featured-actions">
        <button type="button" className="primary-button cxa-switch-big" disabled={busy || switchDisabled}
          onClick={() => props.onSwitch(account.key)} title={props.switchHint}>
          <ArrowLeftRight size={16} aria-hidden="true" />{t('codexAccounts.switch.to', { alias })}
        </button>
        {account.validity === 'expired'
          ? <button type="button" className="secondary-button" onClick={props.onReauthenticate}><LogIn size={15} aria-hidden="true" />{t('codexAccounts.reauth.action')}</button>
          : null}
      </div>
    </article>
  );
});

type PanelProps = {
  snapshot: AccountsSnapshot;
  entries: Readonly<Record<string, AccountQuotaEntry | undefined>>;
  loadingKeys: ReadonlySet<string>;
  blockedByKey: Readonly<Record<string, QuotaBlockReason>>;
  recommendedKey: string | null;
  busy: boolean;
  onSwitch: (key: string) => void;
  onToggle: () => void;
  onReauthenticate: () => void;
};

export function QuickSwitchPanel({ snapshot, entries, loadingKeys, blockedByKey, recommendedKey, busy, onSwitch, onToggle, onReauthenticate }: PanelProps) {
  const { t } = useI18n();
  const byKey = (key: string | null) => snapshot.accounts.find((account) => account.key === key) ?? null;
  const primary = byKey(snapshot.pinned.primary);
  const secondary = byKey(snapshot.pinned.secondary);
  const globalBlock = nativeSwitchBlockReason(snapshot);
  const hint = (account: AccountView | null) => {
    if (!account) return undefined;
    const reason = switchDisabledReason(account, snapshot);
    return reason === 'expired' ? t('codexAccounts.switch.needsLogin')
      : reason === 'api_key' ? t('codexAccounts.switch.apiKeyMode')
        : reason === 'unsupported_store' ? t('codexAccounts.switch.unsupportedStore')
          : reason === 'active' ? t('codexAccounts.switch.alreadyActive') : undefined;
  };
  const card = (slot: PinnedSlot, account: AccountView | null) => (
    <FeaturedCard key={slot} slot={slot} account={account}
      entry={account ? entries[account.key] : undefined}
      quotaLoading={account ? loadingKeys.has(account.key) : false}
      blocked={account ? blockedByKey[account.key] ?? null : null}
      refreshMinutes={snapshot.settings.refreshMinutes}
      switchDisabled={account ? switchDisabledReason(account, snapshot) !== null : true}
      switchHint={hint(account)} busy={busy} recommended={Boolean(account && account.key === recommendedKey)}
      onSwitch={onSwitch} onReauthenticate={onReauthenticate} />
  );
  const pairReady = Boolean(primary && secondary);
  const toggleDisabled = busy || !pairReady || globalBlock !== null;
  return (
    <section className="panel cxa-section" aria-labelledby="cxa-quick-title" data-testid="quick-switch">
      <div className="cxa-section-head">
        <div>
          <h2 id="cxa-quick-title">{t('codexAccounts.quick.title')}</h2>
          <p>{t('codexAccounts.quick.description')}</p>
        </div>
        <button type="button" className="secondary-button cxa-toggle" disabled={toggleDisabled} onClick={onToggle}
          title={pairReady ? undefined : t('codexAccounts.quick.needPair')}>
          <ArrowLeftRight size={15} aria-hidden="true" />{t('codexAccounts.quick.toggle')}
        </button>
      </div>
      <div className="cxa-featured-grid">
        {card('primary', primary)}
        {card('secondary', secondary)}
      </div>
      {!pairReady ? <p className="cxa-hint-text" data-testid="pair-hint">{t('codexAccounts.quick.needPair')}</p> : null}
    </section>
  );
}
