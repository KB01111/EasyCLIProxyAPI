import { Activity } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import type { AccountView } from '../../services/codexAccounts';
import { findAccountFile } from '../../services/codexAccountsQuota';
import { authFileRequestStats } from '../../services/authFileRequests';
import type { AuthFileRecord } from '../../services/authFiles';
import { formatUsageNumber } from '../../services/usageNumber';
import type { FilesState } from './useCodexAccountQuota';

/**
 * Proxy-side request counters per account, read from the same credential list the
 * Credentials page shows. Native Codex traffic never passes through the proxy and is not measured.
 */
export function ActivityPanel({ accounts, files, filesState }: {
  accounts: readonly AccountView[]; files: readonly AuthFileRecord[]; filesState: FilesState;
}) {
  const { t, locale } = useI18n();
  const privacy = usePrivacyMask();
  const count = (value: number | null) => (value === null ? '—' : formatUsageNumber(value, locale));
  return (
    <section className="panel cxa-section" aria-labelledby="cxa-activity-title" data-testid="activity-panel">
      <div className="cxa-section-head">
        <div>
          <h2 id="cxa-activity-title"><Activity size={17} aria-hidden="true" />{t('codexAccounts.activity.title')}</h2>
          <p data-testid="activity-scope">{t('codexAccounts.activity.scope')}</p>
        </div>
      </div>
      {filesState !== 'ready' ? (
        <p className="cxa-quota-note" data-testid="activity-unavailable">{t('codexAccounts.activity.unavailable')}</p>
      ) : (
        <div className="cxa-table-scroll">
          <table className="cxa-activity-table">
            <thead>
              <tr>
                <th scope="col">{t('codexAccounts.activity.account')}</th>
                <th scope="col">{t('codexAccounts.activity.requests')}</th>
                <th scope="col">{t('codexAccounts.activity.success')}</th>
                <th scope="col">{t('codexAccounts.activity.failed')}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const file = findAccountFile(account, files);
                const stats = file ? authFileRequestStats(file) : null;
                const total = stats && stats.success !== null && stats.failure !== null ? stats.success + stats.failure : null;
                return (
                  <tr key={account.key}>
                    <th scope="row">{privacy.text(account.alias)}</th>
                    {stats ? (
                      <>
                        <td>{count(total)}</td>
                        <td>{count(stats.success)}</td>
                        <td>{count(stats.failure)}</td>
                      </>
                    ) : (
                      <td colSpan={3} className="cxa-muted">{t('codexAccounts.activity.noneForAccount')}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="cxa-muted">{t('codexAccounts.activity.footnote')}</p>
    </section>
  );
}
