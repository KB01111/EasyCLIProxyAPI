import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeftRight, Check, Info, LogIn, Pencil, Pin, PinOff, RefreshCw, Trash2, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import {
  unixToMs,
  type AccountView,
  type PinAction,
  type SwitchDisabledReason,
} from '../../services/codexAccounts';
import type { AccountQuotaEntry, QuotaBlockReason } from '../../services/codexAccountsQuota';
import { AgeLabel } from './Countdown';
import { QuotaWindows } from './QuotaWindows';
import { AuthStatus, NativeStatus, ProxyStatus } from './StatusChips';

export type AccountCardProps = {
  account: AccountView;
  entry: AccountQuotaEntry | undefined;
  quotaLoading: boolean;
  blocked: QuotaBlockReason;
  refreshMinutes: number;
  switchReason: SwitchDisabledReason;
  busy: boolean;
  onSwitch: (key: string) => void;
  onPin: (key: string, action: PinAction) => void;
  onRefreshQuota: (key: string) => void;
  onReauthenticate: () => void;
  onDetails: (account: AccountView) => void;
  onRemove: (account: AccountView) => void;
  onRename: (key: string, alias: string) => Promise<boolean>;
};

function AliasEditor({ account, busy, onRename }: Pick<AccountCardProps, 'account' | 'busy' | 'onRename'>) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.alias);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
    else if (wasEditing.current) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const begin = () => { setDraft(account.alias); setEditing(true); };
  const cancel = () => setEditing(false);
  const commit = async () => {
    const alias = draft.trim();
    if (!alias || alias === account.alias) { setEditing(false); return; }
    setSaving(true);
    const ok = await onRename(account.key, alias);
    setSaving(false);
    if (ok) setEditing(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); void commit(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
  };

  if (!editing) {
    return (
      <span className="cxa-alias">
        <strong className="cxa-alias-text" title={privacy.text(account.alias)}>{privacy.text(account.alias)}</strong>
        <button ref={editButtonRef} type="button" className="icon-button quiet cxa-icon-btn" disabled={busy}
          onClick={begin} aria-label={t('codexAccounts.rename.start', { alias: privacy.text(account.alias) })}
          title={t('codexAccounts.rename.title')}>
          <Pencil size={13} aria-hidden="true" />
        </button>
      </span>
    );
  }
  return (
    <span className="cxa-alias editing">
      <input ref={inputRef} className="cxa-input" value={draft} maxLength={64} disabled={saving}
        aria-label={t('codexAccounts.rename.label')} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown} />
      <button type="button" className="icon-button quiet cxa-icon-btn" onClick={() => void commit()}
        disabled={saving || !draft.trim()} aria-label={t('codexAccounts.rename.save')} title={t('codexAccounts.rename.save')}>
        <Check size={14} aria-hidden="true" />
      </button>
      <button type="button" className="icon-button quiet cxa-icon-btn" onClick={cancel} disabled={saving}
        aria-label={t('common.cancel')} title={t('common.cancel')}>
        <X size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

function AccountCardImpl(props: AccountCardProps) {
  const { account, entry, quotaLoading, blocked, refreshMinutes, switchReason, busy } = props;
  const { t, formatDate } = useI18n();
  const privacy = usePrivacyMask();
  const alias = privacy.text(account.alias);
  const lastRefreshMs = account.lastRefresh ? Date.parse(account.lastRefresh) : NaN;
  const activatedMs = unixToMs(account.lastActivatedAt);
  const switchHint = switchReason === 'expired' ? t('codexAccounts.switch.needsLogin')
    : switchReason === 'api_key' ? t('codexAccounts.switch.apiKeyMode')
      : switchReason === 'unsupported_store' ? t('codexAccounts.switch.unsupportedStore') : undefined;

  return (
    <li className="cxa-account" data-testid="codex-account" data-account-key={account.key}
      data-active={account.activeNative ? 'true' : undefined} data-pinned={account.pinnedSlot ?? undefined}>
      <div className="cxa-account-identity">
        <AliasEditor account={account} busy={busy} onRename={props.onRename} />
        <div className="cxa-badges">
          {account.pinnedSlot
            ? <span className="cxa-chip pin" data-slot={account.pinnedSlot}><Pin size={11} aria-hidden="true" />{t(account.pinnedSlot === 'primary' ? 'codexAccounts.pin.primaryBadge' : 'codexAccounts.pin.secondaryBadge')}</span>
            : null}
          {account.plan ? <span className="cxa-chip plan">{account.plan}</span> : null}
        </div>
        <p className="cxa-email">
          {account.email ? <span className="cxa-email-text">{privacy.text(account.email)}</span> : <span className="cxa-muted">{t('codexAccounts.email.none')}</span>}
          <code className="cxa-hint" title={t('codexAccounts.idHint.title')}>{account.accountIdHint}</code>
          {account.duplicateEmail ? <span className="cxa-chip warn" data-testid="duplicate-email">{t('codexAccounts.email.duplicate')}</span> : null}
        </p>
      </div>

      <dl className="cxa-facts">
        <div><dt>{t('codexAccounts.col.auth')}</dt><dd><AuthStatus validity={account.validity} /></dd></div>
        <div><dt>{t('codexAccounts.col.proxy')}</dt><dd><ProxyStatus account={account} /></dd></div>
        <div><dt>{t('codexAccounts.col.native')}</dt><dd><NativeStatus active={account.activeNative} /></dd></div>
        <div>
          <dt>{t('codexAccounts.col.lastRefresh')}</dt>
          <dd>{Number.isFinite(lastRefreshMs) ? <AgeLabel atMs={lastRefreshMs} /> : <span className="cxa-muted">—</span>}</dd>
        </div>
        <div>
          <dt>{t('codexAccounts.col.lastActivity')}</dt>
          <dd>{activatedMs === null ? <span className="cxa-muted">—</span> : <span title={t('codexAccounts.activity.activatedHint')}>{formatDate(activatedMs, { dateStyle: 'medium', timeStyle: 'short' })}</span>}</dd>
        </div>
      </dl>

      <div className="cxa-account-quota" aria-label={t('codexAccounts.col.quota')}>
        <QuotaWindows entry={entry} loading={quotaLoading} blocked={blocked} refreshMinutes={refreshMinutes} compact />
      </div>

      <div className="cxa-actions" role="group" aria-label={t('codexAccounts.actions.label', { alias })}>
        <button type="button" className="primary-button compact-button cxa-switch" disabled={busy || switchReason !== null}
          onClick={() => props.onSwitch(account.key)} title={switchHint}>
          <ArrowLeftRight size={14} aria-hidden="true" />{t('codexAccounts.switch.to', { alias })}
        </button>
        {account.pinnedSlot !== 'primary'
          ? <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => props.onPin(account.key, 'primary')}><Pin size={13} aria-hidden="true" />{t('codexAccounts.pin.asPrimary')}</button> : null}
        {account.pinnedSlot !== 'secondary'
          ? <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => props.onPin(account.key, 'secondary')}><Pin size={13} aria-hidden="true" />{t('codexAccounts.pin.asSecondary')}</button> : null}
        {account.pinnedSlot
          ? <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => props.onPin(account.key, 'unpin')}><PinOff size={13} aria-hidden="true" />{t('codexAccounts.pin.unpin')}</button> : null}
        <button type="button" className="secondary-button compact-button" disabled={quotaLoading || blocked !== null}
          onClick={() => props.onRefreshQuota(account.key)}>
          <RefreshCw size={13} className={quotaLoading ? 'spin' : undefined} aria-hidden="true" />{t('codexAccounts.quota.refreshOne')}
        </button>
        <button type="button" className={account.validity === 'expired' ? 'primary-button compact-button' : 'secondary-button compact-button'}
          onClick={props.onReauthenticate}>
          <LogIn size={13} aria-hidden="true" />{t('codexAccounts.reauth.action')}
        </button>
        <button type="button" className="secondary-button compact-button" onClick={() => props.onDetails(account)}>
          <Info size={13} aria-hidden="true" />{t('codexAccounts.details.action')}
        </button>
        <button type="button" className="danger-button compact-button" disabled={busy} onClick={() => props.onRemove(account)}>
          <Trash2 size={13} aria-hidden="true" />{t('codexAccounts.remove.action')}
        </button>
      </div>
    </li>
  );
}

export const AccountCard = memo(AccountCardImpl);
