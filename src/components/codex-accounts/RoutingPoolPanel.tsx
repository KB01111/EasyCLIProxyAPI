import { useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Globe2, Route } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { usePrivacyMask } from '../../privacy';
import type { NoticeMessage, NoticeTone } from '../../appNotice';
import type { ConfirmationOptions } from '../ConfirmationDialog';
import type { AccountsSnapshot } from '../../services/codexAccounts';
import { errorText } from '../../services/codexAccounts';
import type { FilesState } from './useCodexAccountQuota';
import type { AuthFileRecord } from '../../services/authFiles';
import {
  applyPoolPlan,
  codexPoolFiles,
  loadPoolRecord,
  planPoolMode,
  savePoolRecord,
  poolFileFrom,
  type PoolMode,
  type PoolPlan,
} from '../../services/codexRoutingPool';

const MODES: { mode: PoolMode; label: MessageKey; hint: MessageKey }[] = [
  { mode: 'all', label: 'codexAccounts.pool.all', hint: 'codexAccounts.pool.allHint' },
  { mode: 'only-ab', label: 'codexAccounts.pool.onlyAb', hint: 'codexAccounts.pool.onlyAbHint' },
  { mode: 'prefer-a', label: 'codexAccounts.pool.preferA', hint: 'codexAccounts.pool.preferAHint' },
  { mode: 'prefer-b', label: 'codexAccounts.pool.preferB', hint: 'codexAccounts.pool.preferBHint' },
];

type Props = {
  snapshot: AccountsSnapshot;
  files: readonly AuthFileRecord[];
  filesState: FilesState;
  busy: boolean;
  askConfirmation: (options: ConfirmationOptions) => Promise<boolean>;
  showNotice: (message: NoticeMessage, tone?: NoticeTone) => void;
  onApplied: () => Promise<void>;
  onOpenRoutingSettings: () => void;
};

export function RoutingPoolPanel({ snapshot, files, filesState, busy, askConfirmation, showNotice, onApplied, onOpenRoutingSettings }: Props) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState(() => loadPoolRecord());
  const [selected, setSelected] = useState<PoolMode>(() => record.mode);
  const [applying, setApplying] = useState(false);
  const bodyId = useId();

  const accountA = snapshot.accounts.find((account) => account.key === snapshot.pinned.primary) ?? null;
  const accountB = snapshot.accounts.find((account) => account.key === snapshot.pinned.secondary) ?? null;
  const names = { a: accountA?.sourceFile ?? null, b: accountB?.sourceFile ?? null };
  const codexFiles = useMemo(() => codexPoolFiles(files), [files]);
  const poolFiles = useMemo(() => codexFiles.map(poolFileFrom), [codexFiles]);
  const plan: PoolPlan = useMemo(() => planPoolMode(selected, poolFiles, names, record),
    [selected, poolFiles, names.a, names.b, record]);
  const identities = snapshot.accounts.flatMap((account) => account.email ? [account.email] : []);
  const label = (name: string) => privacy.text(name, identities);
  const modeAvailable = (mode: PoolMode) => mode === 'all' || (mode === 'only-ab' ? Boolean(names.a && names.b)
    : mode === 'prefer-a' ? Boolean(names.a) : Boolean(names.b));
  const aliasFor = (name: string) => {
    const account = snapshot.accounts.find((candidate) => candidate.sourceFile === name);
    return account ? privacy.text(account.alias) : null;
  };

  const describeStep = (step: PoolPlan['steps'][number]) => {
    const parts: string[] = [];
    if (step.disabled !== undefined) parts.push(t(step.disabled ? 'codexAccounts.pool.willDisable' : 'codexAccounts.pool.willEnable'));
    if (step.priority !== undefined) {
      const before = poolFiles.find((file) => file.name === step.name)?.priority ?? 0;
      parts.push(t('codexAccounts.pool.willPriority', { from: before, to: step.priority }));
    }
    return parts.join(', ');
  };

  const apply = async () => {
    if (applying || busy) return;
    const visibleSteps = plan.steps.filter((step) => step.disabled !== undefined || step.priority !== undefined);
    if (visibleSteps.length) {
      const confirmed = await askConfirmation({
        title: t('codexAccounts.pool.confirmTitle'),
        message: t('codexAccounts.pool.confirmMessage'),
        warning: t('codexAccounts.pool.global'),
        details: visibleSteps.map((step) => ({ label: label(step.name), value: describeStep(step) })),
        confirmText: t('codexAccounts.pool.apply'),
        variant: 'danger',
      });
      if (!confirmed) return;
    }
    setApplying(true);
    let latest = record;
    try {
      latest = await applyPoolPlan(plan, files, record, { persist: (next) => { latest = next; savePoolRecord(next); setRecord(next); } });
      showNotice({ key: 'codexAccounts.pool.applied' }, 'success');
    } catch (failure) {
      showNotice({ key: 'codexAccounts.pool.failed', variables: { message: errorText(failure) } }, 'error');
    } finally {
      setRecord(latest);
      try {
        await onApplied();
      } finally {
        setApplying(false);
      }
    }
  };

  const changedNames = Object.keys(record.changes);
  const recordMode = MODES.find((entry) => entry.mode === record.mode);
  return (
    <section className="panel cxa-section" aria-labelledby="cxa-pool-title" data-testid="routing-pool">
      <button type="button" className="cxa-collapse" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} data-testid="pool-toggle">
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <h2 id="cxa-pool-title"><Route size={17} aria-hidden="true" />{t('codexAccounts.pool.title')}</h2>
        <span className="cxa-chip warn"><Globe2 size={11} aria-hidden="true" />{t('codexAccounts.pool.globalBadge')}</span>
      </button>
      {open ? (
        <div id={bodyId} className="cxa-settings-body">
          <div className="cxa-banner warn" role="note" data-testid="pool-global-banner">
            <span className="cxa-banner-icon" aria-hidden="true"><Globe2 size={16} /></span>
            <div className="cxa-banner-body"><strong>{t('codexAccounts.pool.global')}</strong><span>{t('codexAccounts.pool.independent')}</span></div>
          </div>
          <p className="cxa-muted">{t('codexAccounts.pool.strategy')} <button type="button" className="cxa-link" onClick={onOpenRoutingSettings}>{t('codexAccounts.pool.openSettings')}</button></p>

          {filesState !== 'ready' ? (
            <p className="cxa-quota-note">{t(filesState === 'offline' ? 'codexAccounts.pool.coreOffline' : filesState === 'loading' ? 'codexAccounts.quota.loading' : 'codexAccounts.pool.filesError')}</p>
          ) : (
            <>
              <fieldset className="cxa-fieldset">
                <legend>{t('codexAccounts.pool.mode')}</legend>
                <div className="cxa-radio-list" role="radiogroup" aria-label={t('codexAccounts.pool.mode')}>
                  {MODES.map(({ mode, label: modeLabel, hint }) => {
                    const available = modeAvailable(mode);
                    return (
                      <label key={mode} className={selected === mode ? 'cxa-radio selected' : 'cxa-radio'} aria-disabled={!available}>
                        <input type="radio" name="cxa-pool-mode" value={mode} checked={selected === mode} disabled={!available || applying}
                          onChange={() => setSelected(mode)} data-testid={`pool-mode-${mode}`} />
                        <span><strong>{t(modeLabel, { a: accountA ? privacy.text(accountA.alias) : 'A', b: accountB ? privacy.text(accountB.alias) : 'B' })}</strong>
                          <small>{available ? t(hint) : t('codexAccounts.pool.needPinned')}</small></span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="cxa-table-scroll">
                <table className="cxa-activity-table" data-testid="pool-table">
                  <thead><tr>
                    <th scope="col">{t('codexAccounts.pool.credential')}</th>
                    <th scope="col">{t('codexAccounts.pool.state')}</th>
                    <th scope="col">{t('codexAccounts.pool.priority')}</th>
                  </tr></thead>
                  <tbody>
                    {poolFiles.length === 0 ? <tr><td colSpan={3} className="cxa-muted">{t('codexAccounts.pool.none')}</td></tr> : null}
                    {poolFiles.map((file) => (
                      <tr key={file.name}>
                        <th scope="row">{label(file.name)}{aliasFor(file.name) ? <small className="cxa-muted"> · {aliasFor(file.name)}</small> : null}</th>
                        <td>
                          <span className={file.disabled ? 'cxa-chip neutral' : 'cxa-chip ok'}>{t(file.disabled ? 'codexAccounts.pool.disabled' : 'codexAccounts.pool.enabled')}</span>
                          {record.changes[file.name] ? <span className="cxa-chip info">{t('codexAccounts.pool.changedByApp')}</span> : null}
                        </td>
                        <td>{file.priority}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {plan.warnings.length ? (
                <ul className="cxa-warning-list">
                  {plan.warnings.map((warning) => (
                    <li key={`${warning.name}:${warning.reason}`}>{t(`codexAccounts.pool.warn.${warning.reason}` as const, { name: label(warning.name) })}</li>
                  ))}
                </ul>
              ) : null}

              <p className="cxa-muted" data-testid="pool-status">
                {changedNames.length || record.mode !== 'all'
                  ? t('codexAccounts.pool.current', { mode: recordMode ? t(recordMode.label, { a: 'A', b: 'B' }) : record.mode, count: changedNames.length })
                  : t('codexAccounts.pool.noneChanged')}
              </p>
              <div className="cxa-setting-actions">
                <button type="button" className="primary-button compact-button" disabled={applying || busy || !modeAvailable(selected)} onClick={() => void apply()} data-testid="pool-apply">
                  {t('codexAccounts.pool.apply')}
                </button>
                {plan.steps.some((step) => step.disabled !== undefined || step.priority !== undefined) ? null : <small className="cxa-muted">{t('codexAccounts.pool.nothingToChange')}</small>}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
