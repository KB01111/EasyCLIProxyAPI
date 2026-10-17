import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, KeyRound, Link2Off, Star } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { AccountView, Validity } from '../../services/codexAccounts';

/** Every status is an icon plus text, so colour is never the only signal. */
export function AuthStatus({ validity }: { validity: Validity }) {
  const { t } = useI18n();
  if (validity === 'valid') {
    return <span className="cxa-chip ok" data-auth={validity}><CheckCircle2 size={12} aria-hidden="true" />{t('codexAccounts.auth.valid')}</span>;
  }
  if (validity === 'refreshable') {
    return <span className="cxa-chip info" data-auth={validity} title={t('codexAccounts.auth.refreshableHint')}><KeyRound size={12} aria-hidden="true" />{t('codexAccounts.auth.refreshable')}</span>;
  }
  return <span className="cxa-chip error" data-auth={validity}><AlertTriangle size={12} aria-hidden="true" />{t('codexAccounts.auth.expired')}</span>;
}

/** Connected-to-proxy and enabled-for-routing are two separate states, shown separately. */
export function ProxyStatus({ account }: { account: AccountView }) {
  const { t } = useI18n();
  return (
    <>
      {account.connected
        ? <span className="cxa-chip ok" data-proxy="connected"><CheckCircle2 size={12} aria-hidden="true" />{t('codexAccounts.proxy.connected')}</span>
        : <span className="cxa-chip neutral" data-proxy="not-connected"><Link2Off size={12} aria-hidden="true" />{t('codexAccounts.proxy.notConnected')}</span>}
      {account.connected && account.proxyDisabled
        ? <span className="cxa-chip warn" data-proxy="disabled"><CircleSlash size={12} aria-hidden="true" />{t('codexAccounts.proxy.disabled')}</span>
        : null}
      {account.cpaCopy === 'vault_newer'
        ? <span className="cxa-chip warn" data-cpa="vault_newer"><AlertTriangle size={12} aria-hidden="true" />{t('codexAccounts.proxy.vaultNewer')}</span>
        : null}
      {account.cpaCopy === 'conflict'
        ? <span className="cxa-chip warn" data-cpa="conflict"><AlertTriangle size={12} aria-hidden="true" />{t('codexAccounts.proxy.conflict')}</span>
        : null}
    </>
  );
}

export function NativeStatus({ active }: { active: boolean }) {
  const { t } = useI18n();
  return active
    ? <span className="cxa-chip active" data-native="active"><Star size={12} aria-hidden="true" />{t('codexAccounts.native.active')}</span>
    : <span className="cxa-chip neutral" data-native="inactive"><CircleDashed size={12} aria-hidden="true" />{t('codexAccounts.native.notActive')}</span>;
}
