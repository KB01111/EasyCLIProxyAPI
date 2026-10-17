import { RefreshCw, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import type { CoreStatus } from '../../coreRuntime';
import { summarizeHealth, type AccountsSnapshot } from '../../services/codexAccounts';

type Props = {
  snapshot: AccountsSnapshot | null;
  coreStatus: CoreStatus | null;
  refreshing: boolean;
  onRefresh: () => void;
};

function useNativeLabel(snapshot: AccountsSnapshot) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const active = snapshot.accounts.find((account) => account.activeNative);
  switch (snapshot.native.live) {
    case 'managed': return active ? privacy.text(active.alias) : t('codexAccounts.header.nativeNone');
    case 'unmanaged': return t('codexAccounts.header.nativeUnmanaged');
    case 'api_key': return t('codexAccounts.header.nativeApiKey');
    case 'error': return t('codexAccounts.header.nativeError');
    default: return t('codexAccounts.header.nativeNone');
  }
}

function Facts({ snapshot, coreStatus }: { snapshot: AccountsSnapshot; coreStatus: CoreStatus | null }) {
  const { t } = useI18n();
  const nativeLabel = useNativeLabel(snapshot);
  const health = summarizeHealth(snapshot.accounts);
  const connected = snapshot.accounts.filter((account) => account.connected).length;
  const healthParts = [
    health.valid ? t('codexAccounts.header.healthValid', { count: health.valid }) : '',
    health.refreshable ? t('codexAccounts.header.healthRefreshable', { count: health.refreshable }) : '',
    health.expired ? t('codexAccounts.header.healthExpired', { count: health.expired }) : '',
  ].filter(Boolean);
  const proxy = coreStatus?.ready ? t('codexAccounts.header.proxyRunning')
    : coreStatus?.starting ? t('codexAccounts.header.proxyStarting')
      : coreStatus && !coreStatus.installed ? t('codexAccounts.header.proxyNotInstalled')
        : t('codexAccounts.header.proxyStopped');
  return (
    <dl className="cxa-header-facts">
      <div><dt>{t('codexAccounts.header.connected')}</dt><dd data-testid="fact-connected">{t('codexAccounts.header.connectedValue', { connected, total: snapshot.accounts.length })}</dd></div>
      <div><dt>{t('codexAccounts.header.native')}</dt><dd data-testid="fact-native">{nativeLabel}</dd></div>
      <div><dt>{t('codexAccounts.header.proxy')}</dt><dd data-testid="fact-proxy">{proxy}</dd></div>
      <div><dt>{t('codexAccounts.header.health')}</dt><dd data-testid="fact-health">{healthParts.length ? healthParts.join(' · ') : '—'}</dd></div>
    </dl>
  );
}

export function CodexAccountsHeader({ snapshot, coreStatus, refreshing, onRefresh }: Props) {
  const { t } = useI18n();
  const weak = snapshot?.protection === 'file-permissions';
  return (
    <header className="cxa-header panel">
      <div className="cxa-header-top">
        <div className="cxa-title">
          <span className="cxa-title-icon" aria-hidden="true"><Users size={20} /></span>
          <div>
            <h1>{t('codexAccounts.title')}</h1>
            <p>{t('codexAccounts.subtitle')}</p>
          </div>
        </div>
        <button type="button" className="primary-button compact-button" onClick={onRefresh} disabled={refreshing} data-testid="refresh-all">
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} aria-hidden="true" />{t('codexAccounts.refresh')}
        </button>
      </div>
      {snapshot ? <Facts snapshot={snapshot} coreStatus={coreStatus} /> : null}
      {snapshot ? (
        <p className={weak ? 'cxa-protection warn' : 'cxa-protection'} data-testid="protection-note" data-protection={snapshot.protection}>
          {weak ? <ShieldAlert size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
          {t(weak ? 'codexAccounts.protection.filePermissions' : 'codexAccounts.protection.dpapi')}
        </p>
      ) : null}
    </header>
  );
}
