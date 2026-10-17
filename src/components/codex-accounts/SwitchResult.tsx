import { AlertTriangle, CheckCircle2, Info, LogIn, RefreshCw, RotateCw, UserPlus, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { usePrivacyMask } from '../../privacy';
import { processLabel, type AccountsSnapshot, type SwitchBlockCode } from '../../services/codexAccounts';
import type { OutcomeView } from './useCodexAccountActions';

const BLOCKED_KEYS: Record<SwitchBlockCode, MessageKey> = {
  codex_running: 'codexAccounts.blocked.codex_running',
  unsupported_store: 'codexAccounts.blocked.unsupported_store',
  api_key_mode: 'codexAccounts.blocked.api_key_mode',
  unknown_live_identity: 'codexAccounts.blocked.unknown_live_identity',
  target_expired: 'codexAccounts.blocked.target_expired',
  identity_mismatch: 'codexAccounts.blocked.identity_mismatch',
  live_auth_corrupt: 'codexAccounts.blocked.live_auth_corrupt',
  live_identity_unverifiable: 'codexAccounts.blocked.live_identity_unverifiable',
  target_unknown: 'codexAccounts.blocked.target_unknown',
  target_missing_credentials: 'codexAccounts.blocked.target_missing_credentials',
  process_scan_failed: 'codexAccounts.blocked.process_scan_failed',
  target_incomplete: 'codexAccounts.blocked.target_incomplete',
  recovery_pending: 'codexAccounts.blocked.recovery_pending',
  live_conflict: 'codexAccounts.blocked.live_conflict',
};

/** Codes from a newer backend may not be mapped yet: those fall back to the generic text plus the backend message. */
const blockedKey = (code: string | null): MessageKey | null =>
  code !== null && Object.prototype.hasOwnProperty.call(BLOCKED_KEYS, code) ? BLOCKED_KEYS[code as SwitchBlockCode] : null;

type Props = {
  outcome: OutcomeView | null;
  snapshot: AccountsSnapshot;
  busy: boolean;
  onDismiss: () => void;
  onAdoptLive: () => void;
  onReauthenticate: () => void;
  onCheckAgain: () => void;
  onRestartDesktop: () => void;
};

export function SwitchResult({ outcome, snapshot, busy, onDismiss, onAdoptLive, onReauthenticate, onCheckAgain, onRestartDesktop }: Props) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const result = outcome?.result;
  const target = result ? snapshot.accounts.find((account) => account.key === result.to) : undefined;
  const alias = privacy.text(target?.alias ?? '');
  const code = result?.code ?? null;
  const processes = result?.running.map(processLabel).join(', ') ?? '';

  let summary = '';
  if (result) {
    summary = result.status === 'switched' ? t('codexAccounts.result.switched', { alias })
      : result.status === 'unchanged' ? t('codexAccounts.result.unchanged', { alias })
        : t(blockedKey(code) ?? 'codexAccounts.blocked.generic', { processes });
  }

  return (
    <>
      <div className="cxa-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="switch-live">{summary}</div>
      {result ? (
        <section className={`cxa-result ${result.status}`} data-testid="switch-result" data-status={result.status} data-code={code ?? undefined}
          aria-label={t('codexAccounts.result.label')}>
          <div className="cxa-result-head">
            <span className="cxa-banner-icon" aria-hidden="true">
              {result.status === 'switched' ? <CheckCircle2 size={18} /> : result.status === 'blocked' ? <AlertTriangle size={18} /> : <Info size={18} />}
            </span>
            <strong data-testid="switch-result-title">{summary}</strong>
            <button type="button" className="icon-button quiet cxa-icon-btn" onClick={onDismiss} aria-label={t('common.close')} title={t('common.close')}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          {result.status === 'switched' ? (
            <div className="cxa-result-body">
              <p data-testid="restart-note">{t('codexAccounts.result.restartRequired')}</p>
              <p className="cxa-desktop-note" data-testid="desktop-note">
                <span className="cxa-chip warn" data-testid="desktop-unverified">{t('codexAccounts.desktop.unverified')}</span>
                <span>{snapshot.desktop.note}</span>
              </p>
              <div className="cxa-result-actions">
                <button type="button" className="secondary-button compact-button" disabled={busy} onClick={onRestartDesktop}>
                  <RotateCw size={14} aria-hidden="true" />{t('codexAccounts.restart.action')}
                </button>
              </div>
            </div>
          ) : null}

          {result.status === 'blocked' ? (
            <div className="cxa-result-body">
              {code === 'codex_running' && result.running.length ? (
                <ul className="cxa-process-list" data-testid="running-list">
                  {result.running.map((process) => <li key={process.pid}>{processLabel(process)}</li>)}
                </ul>
              ) : null}
              {blockedKey(code) === null ? <p className="cxa-muted" data-testid="backend-message">{privacy.text(result.message)}</p> : null}
              <div className="cxa-result-actions">
                {code === 'codex_running' || code === 'process_scan_failed' || code === 'recovery_pending' ? <button type="button" className="secondary-button compact-button" disabled={busy} onClick={onCheckAgain}><RefreshCw size={14} aria-hidden="true" />{t('codexAccounts.blocked.checkAgain')}</button> : null}
                {code === 'unknown_live_identity' ? <button type="button" className="primary-button compact-button" disabled={busy} onClick={onAdoptLive}><UserPlus size={14} aria-hidden="true" />{t('codexAccounts.adopt.action')}</button> : null}
                {code === 'target_expired' || code === 'identity_mismatch' || code === 'target_incomplete' || code === 'live_conflict' ? <button type="button" className="primary-button compact-button" onClick={onReauthenticate}><LogIn size={14} aria-hidden="true" />{t('codexAccounts.reauth.action')}</button> : null}
              </div>
            </div>
          ) : null}

          {result.status === 'unchanged' ? <div className="cxa-result-body"><p>{t('codexAccounts.result.unchangedDetail')}</p></div> : null}

          {result.status !== 'blocked' ? (
            <details className="cxa-perf" data-testid="perf-details">
              <summary>{t('codexAccounts.perf.title')}</summary>
              <dl>
                {result.timings ? (
                  <>
                    <div><dt>{t('codexAccounts.perf.validate')}</dt><dd>{Math.round(result.timings.validateMs)} ms</dd></div>
                    <div><dt>{t('codexAccounts.perf.write')}</dt><dd>{Math.round(result.timings.writeMs)} ms</dd></div>
                    <div><dt>{t('codexAccounts.perf.verify')}</dt><dd>{Math.round(result.timings.verifyMs)} ms</dd></div>
                    <div><dt>{t('codexAccounts.perf.backend')}</dt><dd>{Math.round(result.timings.totalMs)} ms</dd></div>
                  </>
                ) : null}
                <div><dt>{t('codexAccounts.perf.ui')}</dt><dd data-testid="perf-ui">{outcome?.uiMs === null || outcome === null ? '…' : `${outcome.uiMs} ms`}</dd></div>
              </dl>
            </details>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
