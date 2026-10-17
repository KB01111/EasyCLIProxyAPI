import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Keyboard, Settings2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask, usePrivacyMode } from '../../privacy';
import { SelectMenu } from '../SelectMenu';
import {
  acceleratorFromKeyEvent,
  computePinned,
  type AccountSettings,
  type AccountsSnapshot,
} from '../../services/codexAccounts';

const NONE = '';

type Props = {
  snapshot: AccountsSnapshot;
  busy: boolean;
  onSaveSettings: (patch: Partial<AccountSettings>) => Promise<string | null>;
  onSetPair: (primary: string | null, secondary: string | null) => void;
};

function Toggle({ label, hint, checked, disabled, onChange, testId }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; testId?: string;
}) {
  const id = useId();
  return (
    <div className="cxa-setting-row">
      <div>
        <label htmlFor={id}>{label}</label>
        {hint ? <small>{hint}</small> : null}
      </div>
      <span className="switch-control">
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} data-testid={testId}
          onChange={(event) => onChange(event.currentTarget.checked)} />
        <span className="switch-track" />
      </span>
    </div>
  );
}

export function SettingsPanel({ snapshot, busy, onSaveSettings, onSetPair }: Props) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const [privacyMode, setPrivacyMode] = usePrivacyMode();
  const [open, setOpen] = useState(false);
  const { settings } = snapshot;
  const [minutes, setMinutes] = useState(String(settings.refreshMinutes));
  const [hotkey, setHotkey] = useState(settings.hotkey ?? '');
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyId = useId();
  const minutesId = useId();
  const hotkeyId = useId();

  // A successful save (or a change from elsewhere) resets the drafts to the stored values.
  useEffect(() => {
    setMinutes(String(settings.refreshMinutes));
    setHotkey(settings.hotkey ?? '');
  }, [settings.refreshMinutes, settings.hotkey]);

  const dirty = minutes.trim() !== String(settings.refreshMinutes) || hotkey.trim() !== (settings.hotkey ?? '');
  const accountOptions = [
    { value: NONE, label: t('codexAccounts.settings.none') },
    ...snapshot.accounts.map((account) => ({ value: account.key, label: privacy.text(account.alias) })),
  ];
  const setSlot = (slot: 'primary' | 'secondary', key: string) => {
    const next = key === NONE
      ? computePinned(snapshot.pinned, snapshot.pinned[slot] ?? '', 'unpin')
      : computePinned(snapshot.pinned, key, slot);
    onSetPair(next.primary, next.secondary);
  };

  const save = async () => {
    const value = Number(minutes.trim());
    if (!Number.isInteger(value) || value < 1 || value > 1440) { setError(t('codexAccounts.settings.minutesInvalid')); return; }
    setSaving(true);
    setError(null);
    const failure = await onSaveSettings({ refreshMinutes: value, hotkey: hotkey.trim() || null });
    setSaving(false);
    if (failure) {
      // The backend rejected it: keep showing the value that is actually in effect.
      setMinutes(String(settings.refreshMinutes));
      setHotkey(settings.hotkey ?? '');
      setError(failure);
    }
  };
  const toggle = async (patch: Partial<AccountSettings>) => {
    setError(null);
    const failure = await onSaveSettings(patch);
    if (failure) setError(failure);
  };
  const onHotkeyKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!recording) return;
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      setRecording(false);
      return;
    }
    event.preventDefault();
    const accelerator = acceleratorFromKeyEvent(event.nativeEvent);
    if (accelerator) { setHotkey(accelerator); setRecording(false); }
  };

  const { credentialStore } = snapshot.native;
  return (
    <section className="panel cxa-section" aria-labelledby="cxa-settings-title" data-testid="settings-panel">
      <button type="button" className="cxa-collapse" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} data-testid="settings-toggle">
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <h2 id="cxa-settings-title"><Settings2 size={17} aria-hidden="true" />{t('codexAccounts.settings.title')}</h2>
      </button>
      {open ? (
        <div id={bodyId} className="cxa-settings-body">
          <fieldset className="cxa-fieldset">
            <legend>{t('codexAccounts.settings.pair')}</legend>
            <div className="cxa-pair-select">
              <span>{t('codexAccounts.settings.accountA')}
                <SelectMenu value={snapshot.pinned.primary ?? NONE} options={accountOptions} disabled={busy}
                  ariaLabel={t('codexAccounts.settings.accountA')} onChange={(key) => setSlot('primary', key)} />
              </span>
              <span>{t('codexAccounts.settings.accountB')}
                <SelectMenu value={snapshot.pinned.secondary ?? NONE} options={accountOptions} disabled={busy}
                  ariaLabel={t('codexAccounts.settings.accountB')} onChange={(key) => setSlot('secondary', key)} />
              </span>
            </div>
          </fieldset>

          <div className="cxa-setting-row stacked">
            <label htmlFor={minutesId}>{t('codexAccounts.settings.cache')}</label>
            <small>{t('codexAccounts.settings.cacheHint')}</small>
            <input id={minutesId} className="cxa-input narrow" type="number" min={1} max={1440} step={1} inputMode="numeric"
              value={minutes} onChange={(event) => setMinutes(event.currentTarget.value)} disabled={saving} data-testid="setting-minutes" />
          </div>

          <div className="cxa-setting-row stacked">
            <label htmlFor={hotkeyId}>{t('codexAccounts.settings.hotkey')}</label>
            <small>{t('codexAccounts.settings.hotkeyHint')}</small>
            <div className="cxa-hotkey">
              <input id={hotkeyId} className="cxa-input" value={recording ? '' : hotkey} readOnly={recording} disabled={saving}
                placeholder={recording ? t('codexAccounts.settings.hotkeyPress') : t('codexAccounts.settings.hotkeyPlaceholder')}
                onChange={(event) => setHotkey(event.currentTarget.value)} onKeyDown={onHotkeyKeyDown} onBlur={() => setRecording(false)}
                data-testid="setting-hotkey" />
              <button type="button" className="secondary-button compact-button" disabled={saving}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { setRecording(true); document.getElementById(hotkeyId)?.focus(); }}>
                <Keyboard size={14} aria-hidden="true" />{t('codexAccounts.settings.record')}
              </button>
              <button type="button" className="secondary-button compact-button" disabled={saving || !hotkey} onClick={() => { setHotkey(''); setRecording(false); }}>
                {t('codexAccounts.settings.clearHotkey')}
              </button>
            </div>
            <small className="cxa-sr-only" role="status" aria-live="polite">{recording ? t('codexAccounts.settings.hotkeyPress') : ''}</small>
          </div>

          <div className="cxa-setting-actions">
            <button type="button" className="primary-button compact-button" disabled={!dirty || saving} onClick={() => void save()} data-testid="settings-save">
              {t('common.save')}
            </button>
            {error ? <p className="cxa-field-error" role="alert" data-testid="settings-error">{error}</p> : null}
          </div>

          <Toggle label={t('codexAccounts.settings.notifications')} hint={t('codexAccounts.settings.notificationsHint')}
            checked={settings.notifications} onChange={(value) => void toggle({ notifications: value })} />
          <Toggle label={t('codexAccounts.settings.recommendations')} hint={t('codexAccounts.settings.recommendationsHint')}
            checked={settings.recommendations} onChange={(value) => void toggle({ recommendations: value })} />
          <Toggle label={t('codexAccounts.settings.privacy')} hint={t('codexAccounts.settings.privacyHint')}
            checked={privacyMode} onChange={setPrivacyMode} />

          <div className="cxa-compat" data-testid="compat-readout">
            <h3>{t('codexAccounts.compat.title')}</h3>
            <dl>
              <div><dt>{t('codexAccounts.compat.store')}</dt>
                <dd>{credentialStore.mode} · {t(credentialStore.supported ? 'codexAccounts.compat.supported' : 'codexAccounts.compat.unsupported')}</dd></div>
              <div><dt>{t('codexAccounts.compat.detail')}</dt><dd>{credentialStore.detail}</dd></div>
              <div><dt>{t('codexAccounts.compat.authPath')}</dt><dd><code>{privacy.text(snapshot.native.authPath)}</code></dd></div>
              <div><dt>{t('codexAccounts.compat.desktop')}</dt>
                <dd><span className="cxa-chip warn">{t('codexAccounts.desktop.unverified')}</span> {snapshot.desktop.note}</dd></div>
            </dl>
          </div>
        </div>
      ) : null}
    </section>
  );
}
