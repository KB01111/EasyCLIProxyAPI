import { useCallback, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { NoticeMessage, NoticeTone } from '../../appNotice';
import type { ConfirmationOptions } from '../ConfirmationDialog';
import {
  codexAccountsApi,
  computePinned,
  errorText,
  type AccountSettings,
  type AccountView,
  type AccountsSnapshot,
  type PinAction,
  type SwitchOutcome,
} from '../../services/codexAccounts';

export type OutcomeView = {
  result: SwitchOutcome;
  /** Click-to-rendered-result time measured in the webview; null until painted. */
  uiMs: number | null;
  /** Wall-clock stamp so the same outcome is not announced twice. */
  at: number;
};

type Deps = {
  snapshot: AccountsSnapshot | null;
  refresh: (includeProcesses?: boolean) => Promise<AccountsSnapshot | null>;
  showNotice: (message: NoticeMessage, tone?: NoticeTone) => void;
  askConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
  coreReady: boolean;
};

/** Every mutation re-fetches state afterwards; nothing here updates the UI optimistically. */
export function useCodexAccountActions({ snapshot, refresh, showNotice, askConfirmation, coreReady }: Deps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeView | null>(null);
  const busyRef = useRef<string | null>(null);

  const guarded = useCallback(async <T,>(label: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = label;
    setBusy(label);
    try {
      return await task();
    } catch (failure) {
      showNotice(errorText(failure), 'error');
      void refresh(false);
      return undefined;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [refresh, showNotice]);

  const finishSwitch = useCallback(async (result: SwitchOutcome, startedAt: number) => {
    await refresh(result.status === 'blocked');
    setOutcome({ result, uiMs: null, at: Date.now() });
    // Two frames: the first commits the new state, the second is after it was painted.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const uiMs = Math.round(performance.now() - startedAt);
      setOutcome((current) => current && current.result === result ? { ...current, uiMs } : current);
    }));
  }, [refresh]);

  const switchTo = useCallback((key: string) => guarded(`switch:${key}`, async () => {
    const startedAt = performance.now();
    await finishSwitch(await codexAccountsApi.switchTo(key), startedAt);
  }), [finishSwitch, guarded]);

  const toggle = useCallback(() => guarded('toggle', async () => {
    const startedAt = performance.now();
    await finishSwitch(await codexAccountsApi.toggle(), startedAt);
  }), [finishSwitch, guarded]);

  const rename = useCallback(async (key: string, alias: string): Promise<boolean> => {
    const done = await guarded(`rename:${key}`, async () => {
      await codexAccountsApi.rename(key, alias.trim());
      await refresh(false);
      return true;
    });
    return done === true;
  }, [guarded, refresh]);

  const pin = useCallback((key: string, action: PinAction) => guarded(`pin:${key}`, async () => {
    const current = snapshot?.pinned ?? { primary: null, secondary: null };
    const next = computePinned(current, key, action);
    await codexAccountsApi.setPinned(next.primary, next.secondary);
    await refresh(false);
  }), [guarded, refresh, snapshot?.pinned]);

  const setPair = useCallback((primary: string | null, secondary: string | null) =>
    guarded('pair', async () => {
      await codexAccountsApi.setPinned(primary, secondary);
      await refresh(false);
    }), [guarded, refresh]);

  /** Resolves true only when the account was actually removed. */
  const remove = useCallback(async (account: AccountView): Promise<boolean> => {
    const confirmed = await askConfirmation({
      title: t('codexAccounts.remove.title', { alias: account.alias }),
      message: t('codexAccounts.remove.message', { alias: account.alias }),
      warning: t('codexAccounts.remove.warning'),
      confirmText: t('codexAccounts.remove.confirm'),
      variant: 'danger',
    });
    if (!confirmed) return false;
    const removed = await guarded(`remove:${account.key}`, async () => {
      await codexAccountsApi.remove(account.key);
      await refresh(false);
      showNotice({ key: 'codexAccounts.toast.removed', variables: { alias: account.alias } }, 'success');
      return true;
    });
    return removed === true;
  }, [askConfirmation, guarded, refresh, showNotice, t]);

  /** Returns an error message for the dialog, or null on success. */
  const adopt = useCallback(async (alias: string): Promise<string | null> => {
    if (busyRef.current) return t('codexAccounts.busy');
    busyRef.current = 'adopt';
    setBusy('adopt');
    try {
      await codexAccountsApi.adoptLive(alias.trim());
      await refresh(false);
      showNotice({ key: 'codexAccounts.toast.adopted', variables: { alias: alias.trim() } }, 'success');
      return null;
    } catch (failure) {
      return errorText(failure);
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [refresh, showNotice, t]);

  /** Returns an error message to show next to the field, or null. The saved value only changes on success. */
  const saveSettings = useCallback(async (next: AccountSettings): Promise<string | null> => {
    try {
      await codexAccountsApi.updateSettings(next);
      await refresh(false);
      return null;
    } catch (failure) {
      void refresh(false);
      return errorText(failure);
    }
  }, [refresh]);

  const acknowledgeExternalChange = useCallback(() => guarded('ack', async () => {
    await codexAccountsApi.ackExternalChange();
    await refresh(false);
  }), [guarded, refresh]);

  const resetVault = useCallback(async () => {
    const confirmed = await askConfirmation({
      title: t('codexAccounts.vault.resetTitle'),
      message: t('codexAccounts.vault.resetMessage'),
      warning: t('codexAccounts.vault.resetWarning'),
      confirmText: t('codexAccounts.vault.resetConfirm'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await guarded('reset-vault', async () => {
      await codexAccountsApi.resetVault();
      await refresh(false);
      showNotice({ key: 'codexAccounts.toast.vaultReset' }, 'success');
    });
  }, [askConfirmation, guarded, refresh, showNotice, t]);

  const restartDesktop = useCallback(async () => {
    const confirmed = await askConfirmation({
      title: t('codexAccounts.restart.title'),
      message: t('codexAccounts.restart.message'),
      warning: t('codexAccounts.restart.warning'),
      confirmText: t('codexAccounts.restart.confirm'),
      variant: 'danger',
    });
    if (!confirmed) return;
    await guarded('restart', async () => {
      await codexAccountsApi.restartCodexApp();
      showNotice({ key: 'codexAccounts.toast.restarted' }, 'success');
    });
  }, [askConfirmation, guarded, showNotice, t]);

  /** Opens the existing OAuth login page; a login for the same identity is merged by the backend. */
  const startLogin = useCallback(() => {
    if (!coreReady) {
      showNotice({ key: 'codexAccounts.reauth.needsCore' }, 'error');
      return;
    }
    window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'oauth' }));
  }, [coreReady, showNotice]);

  return {
    busy, outcome, clearOutcome: () => setOutcome(null),
    switchTo, toggle, rename, pin, setPair, remove, adopt, saveSettings,
    acknowledgeExternalChange, resetVault, restartDesktop, startLogin,
  };
}
