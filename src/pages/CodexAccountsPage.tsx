import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw, ShieldAlert, UserPlus } from 'lucide-react';
import { FloatingNotice, useAppNotice } from '../appNotice';
import { useConfirmation } from '../components/ConfirmationDialog';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { ActivityPanel } from '../components/codex-accounts/ActivityPanel';
import { AccountCard } from '../components/codex-accounts/AccountCard';
import { AdoptDialog, DetailsDialog } from '../components/codex-accounts/AccountDialogs';
import { CodexAccountsBanners } from '../components/codex-accounts/CodexAccountsBanners';
import { CodexAccountsHeader } from '../components/codex-accounts/CodexAccountsHeader';
import { QuickSwitchPanel } from '../components/codex-accounts/QuickSwitchPanel';
import { RoutingPoolPanel } from '../components/codex-accounts/RoutingPoolPanel';
import { SettingsPanel } from '../components/codex-accounts/SettingsPanel';
import { SwitchResult } from '../components/codex-accounts/SwitchResult';
import { useCodexAccountActions } from '../components/codex-accounts/useCodexAccountActions';
import { useCodexAccountQuota } from '../components/codex-accounts/useCodexAccountQuota';
import { useCodexAccounts } from '../components/codex-accounts/useCodexAccounts';
import { isVaultError, switchDisabledReason, type AccountView } from '../services/codexAccounts';
import { findAccountFile, quotaBlockReason, type QuotaBlockReason } from '../services/codexAccountsQuota';
import './CodexAccountsPage.css';

export function CodexAccountsPage() {
  const { t } = useI18n();
  const { status: coreStatus } = useCoreRuntime();
  const coreReady = Boolean(coreStatus?.ready);
  const feedback = useAppNotice();
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const refreshQuotaRef = useRef<(force: boolean) => void>(() => undefined);
  const { snapshot, loading, error, scan, refresh } = useCodexAccounts(() => refreshQuotaRef.current(true));
  const quota = useCodexAccountQuota(snapshot, coreReady);
  refreshQuotaRef.current = (force) => void quota.refreshAll(force);
  const actions = useCodexAccountActions({
    snapshot, refresh, showNotice: feedback.showNotice, askConfirmation, coreReady,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [details, setDetails] = useState<AccountView | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const busy = actions.busy !== null;

  const refreshEverything = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([refresh(true), quota.refreshAll(true)]); } finally { setRefreshing(false); }
  }, [refresh, quota]);

  const { rename, pin, remove: removeAccount, startLogin } = actions;
  const handleRemove = useCallback(async (account: AccountView) => {
    if (await removeAccount(account)) listHeadingRef.current?.focus();
  }, [removeAccount]);
  const handleDetails = useCallback((account: AccountView) => setDetails(account), []);
  const handleRefreshOne = useCallback((key: string) => void quota.refreshOne(key), [quota.refreshOne]);
  const openRoutingSettings = useCallback(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config' })), []);
  const checkAgain = useCallback(() => void refresh(true), [refresh]);
  const afterPoolChange = useCallback(async () => {
    await quota.reloadFiles();
    await refresh(false);
  }, [quota, refresh]);

  useEffect(() => {
    if (actions.outcome) resultRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [actions.outcome?.at]);

  const accounts = snapshot?.accounts;
  const blockedByKey = useMemo(() => {
    const map: Record<string, QuotaBlockReason> = {};
    for (const account of accounts ?? []) {
      map[account.key] = quotaBlockReason(account, findAccountFile(account, quota.files), coreReady);
    }
    return map;
  }, [accounts, quota.files, coreReady]);

  const ordered = useMemo(() => [...(accounts ?? [])].sort((left, right) => {
    const rank = (account: AccountView) => (account.pinnedSlot === 'primary' ? 0 : account.pinnedSlot === 'secondary' ? 1 : 2);
    return rank(left) - rank(right) || left.alias.localeCompare(right.alias, undefined, { sensitivity: 'base' });
  }), [accounts]);

  const recommendedKey = quota.recommendation
    && (quota.recommendation.code === 'more_capacity' || quota.recommendation.code === 'other_exhausted')
    ? quota.recommendation.recommended : null;

  return (
    <section className="page management-page cxa-page" aria-label={t('codexAccounts.title')} data-testid="codex-accounts-page">
      {confirmationDialog}
      <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
      <CodexAccountsHeader snapshot={snapshot} coreStatus={coreStatus} refreshing={refreshing} onRefresh={() => void refreshEverything()} />

      {error ? (
        <div className="cxa-banner error" role="alert" data-testid="load-error">
          <span className="cxa-banner-icon" aria-hidden="true"><AlertCircle size={16} /></span>
          <div className="cxa-banner-body"><strong>{t('codexAccounts.error.load')}</strong><span>{error}</span></div>
          <div className="cxa-banner-actions">
            <button type="button" className="secondary-button compact-button" onClick={() => void refresh(true)}><RefreshCw size={13} aria-hidden="true" />{t('common.retry')}</button>
            {isVaultError(error) ? (
              <button type="button" className="danger-button compact-button" disabled={busy} onClick={() => void actions.resetVault()} data-testid="reset-vault">
                <ShieldAlert size={13} aria-hidden="true" />{t('codexAccounts.vault.reset')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="management-loading" role="status"><LoaderCircle size={20} className="spin" />{t('codexAccounts.loading')}</div>
      ) : null}

      {snapshot ? (
        <>
          <CodexAccountsBanners snapshot={snapshot} recommendation={quota.recommendation} busy={busy}
            onAcknowledgeExternal={() => void actions.acknowledgeExternalChange()}
            onAdoptLive={() => setAdoptOpen(true)} onSwitch={(key) => void actions.switchTo(key)} />

          <QuickSwitchPanel snapshot={snapshot} entries={quota.entries} loadingKeys={quota.loadingKeys}
            blockedByKey={blockedByKey} recommendedKey={recommendedKey} busy={busy}
            onSwitch={(key) => void actions.switchTo(key)} onToggle={() => void actions.toggle()} onReauthenticate={startLogin} />

          <div ref={resultRef}>
            <SwitchResult outcome={actions.outcome} snapshot={snapshot} busy={busy} onDismiss={actions.clearOutcome}
              onAdoptLive={() => setAdoptOpen(true)} onReauthenticate={startLogin} onCheckAgain={checkAgain}
              onRestartDesktop={() => void actions.restartDesktop()} />
          </div>

          <section className="panel cxa-section" aria-labelledby="cxa-list-title" data-testid="accounts-list">
            <div className="cxa-section-head">
              <div>
                <h2 id="cxa-list-title" ref={listHeadingRef} tabIndex={-1}>{t('codexAccounts.list.title')}</h2>
                <p>{t('codexAccounts.list.description', { count: ordered.length })}</p>
              </div>
              <button type="button" className="secondary-button compact-button" onClick={startLogin} data-testid="add-account">
                <UserPlus size={14} aria-hidden="true" />{t('codexAccounts.add.action')}
              </button>
            </div>
            {scan && scan.list.length ? (
              <p className="cxa-muted" data-testid="running-note">{t('codexAccounts.running.note', { count: scan.list.length })}</p>
            ) : null}
            {ordered.length === 0 ? (
              <div className="management-empty" data-testid="accounts-empty">
                <AlertCircle size={24} /><strong>{t('codexAccounts.empty.title')}</strong><span>{t('codexAccounts.empty.description')}</span>
              </div>
            ) : (
              <ul className="cxa-accounts" role="list">
                {ordered.map((account) => (
                  <AccountCard key={account.key} account={account} entry={quota.entries[account.key]}
                    quotaLoading={quota.loadingKeys.has(account.key)} blocked={blockedByKey[account.key] ?? null}
                    refreshMinutes={snapshot.settings.refreshMinutes} switchReason={switchDisabledReason(account, snapshot)}
                    busy={busy} onSwitch={actions.switchTo} onPin={pin} onRefreshQuota={handleRefreshOne}
                    onReauthenticate={startLogin} onDetails={handleDetails} onRemove={handleRemove} onRename={rename} />
                ))}
              </ul>
            )}
          </section>

          <ActivityPanel accounts={ordered} files={quota.files} filesState={quota.filesState} />
          <SettingsPanel snapshot={snapshot} busy={busy} onSaveSettings={actions.saveSettings} onSetPair={(primary, secondary) => void actions.setPair(primary, secondary)} />
          <RoutingPoolPanel snapshot={snapshot} files={quota.files} filesState={quota.filesState} busy={busy}
            askConfirmation={askConfirmation} showNotice={feedback.showNotice} onApplied={afterPoolChange}
            onOpenRoutingSettings={openRoutingSettings} />
        </>
      ) : null}

      {adoptOpen ? <AdoptDialog onSubmit={actions.adopt} onClose={() => setAdoptOpen(false)} /> : null}
      {details ? <DetailsDialog account={details} onClose={() => setDetails(null)} /> : null}
    </section>
  );
}
