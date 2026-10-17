import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info, UserPlus, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import { unixToMs, type AccountView } from '../../services/codexAccounts';
import { useDialogFocusTrap } from '../useDialogFocusTrap';
import { AuthStatus, NativeStatus, ProxyStatus } from './StatusChips';

function DialogShell({ title, icon, onClose, children, testId }: {
  title: string; icon: ReactNode; onClose: () => void; children: ReactNode; testId: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useDialogFocusTrap<HTMLElement>({ onEscape: onClose });
  const content = (
    <div className="cxa-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="cxa-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} tabIndex={-1}>
        <div className="cxa-dialog-head">
          <h2 id={titleId}>{icon}{title}</h2>
          <button type="button" className="icon-button quiet" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

/** Alias prompt for explicitly adopting the unmanaged login Codex is currently using. */
export function AdoptDialog({ onSubmit, onClose }: { onSubmit: (alias: string) => Promise<string | null>; onClose: () => void }) {
  const { t } = useI18n();
  const [alias, setAlias] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!alias.trim() || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onSubmit(alias);
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };
  return (
    <DialogShell title={t('codexAccounts.adopt.title')} icon={<UserPlus size={18} aria-hidden="true" />} onClose={onClose} testId="adopt-dialog">
      <form onSubmit={(event) => void submit(event)} className="cxa-dialog-form">
        <p>{t('codexAccounts.adopt.description')}</p>
        <label htmlFor={inputId}>{t('codexAccounts.adopt.alias')}</label>
        <input id={inputId} ref={inputRef} className="cxa-input" value={alias} maxLength={64} autoFocus
          onChange={(event) => setAlias(event.currentTarget.value)} placeholder={t('codexAccounts.adopt.placeholder')} disabled={saving}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-error` : undefined} />
        {error ? <p id={`${inputId}-error`} className="cxa-field-error" role="alert">{error}</p> : null}
        <div className="cxa-dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
          <button type="submit" className="primary-button" disabled={saving || !alias.trim()}>{t('codexAccounts.adopt.confirm')}</button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Safe metadata only: the backend never sends tokens, so there is nothing secret to hide here. */
export function DetailsDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const { t, formatDate } = useI18n();
  const privacy = usePrivacyMask();
  const when = (seconds: number | null) => {
    const ms = unixToMs(seconds);
    return ms === null ? '—' : formatDate(ms, { dateStyle: 'medium', timeStyle: 'medium' });
  };
  const rows: [string, ReactNode][] = [
    [t('codexAccounts.details.alias'), privacy.text(account.alias)],
    [t('codexAccounts.details.email'), account.email ? privacy.text(account.email) : '—'],
    [t('codexAccounts.details.plan'), account.plan ?? '—'],
    [t('codexAccounts.details.accountId'), <code key="id">{account.accountIdHint}</code>],
    [t('codexAccounts.details.key'), <code key="key">{account.key}</code>],
    [t('codexAccounts.details.sourceFile'), account.sourceFile ? privacy.text(account.sourceFile, [account.email ?? '']) : '—'],
    [t('codexAccounts.col.auth'), <AuthStatus key="auth" validity={account.validity} />],
    [t('codexAccounts.details.accessExpires'), when(account.accessExpiresAt)],
    [t('codexAccounts.col.proxy'), <span key="proxy" className="cxa-chips"><ProxyStatus account={account} /></span>],
    [t('codexAccounts.col.native'), <NativeStatus key="native" active={account.activeNative} />],
    [t('codexAccounts.details.pinned'), account.pinnedSlot ? t(account.pinnedSlot === 'primary' ? 'codexAccounts.pin.primary' : 'codexAccounts.pin.secondary') : '—'],
    [t('codexAccounts.col.lastRefresh'), account.lastRefresh ?? '—'],
    [t('codexAccounts.details.added'), when(account.addedAt)],
    [t('codexAccounts.details.synced'), when(account.lastSyncedAt)],
    [t('codexAccounts.col.lastActivity'), when(account.lastActivatedAt)],
  ];
  return (
    <DialogShell title={t('codexAccounts.details.title', { alias: privacy.text(account.alias) })} icon={<Info size={18} aria-hidden="true" />} onClose={onClose} testId="details-dialog">
      <dl className="cxa-details">
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <p className="cxa-muted">{t('codexAccounts.details.noTokens')}</p>
      <div className="cxa-dialog-actions">
        <button type="button" className="primary-button" onClick={onClose}>{t('common.close')}</button>
      </div>
    </DialogShell>
  );
}
