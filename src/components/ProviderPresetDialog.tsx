import { useRef, useState, type FormEvent } from 'react';
import {
  Boxes, Brain, Cpu, Layers, LoaderCircle, Moon, Route, Sparkles, Terminal, Wind, X, Zap, type LucideIcon,
} from 'lucide-react';
import opencodeIcon from '../assets/icons/opencode.svg';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import {
  applyProviderPresetPlan,
  discoverProviderPresetModels,
  modalProxyToken,
  PRESET_ROUTES,
  PresetConflictError,
  PROVIDER_PRESETS,
  planProviderPreset,
  routeProviderPresetModels,
  routingModelCount,
  splitModalProxyToken,
  type PresetRouting,
  type PresetRoute,
  type PresetSection,
  type ProviderPreset,
  type ProviderPresetId,
} from '../services/providerPresets';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import './ProviderPresetDialog.css';

const PRESET_ICONS: Record<Exclude<ProviderPresetId, 'opencode-go' | 'opencode-zen'>, LucideIcon> = {
  modal: Boxes,
  'command-code': Terminal,
  openrouter: Route,
  groq: Zap,
  mistral: Wind,
  moonshot: Moon,
  zai: Brain,
  cerebras: Cpu,
  together: Layers,
};

const ROUTE_LABEL_KEYS: Record<PresetRoute, MessageKey> = {
  openai: 'apiAccess.presets.route.openai',
  claude: 'apiAccess.presets.route.claude',
  codex: 'apiAccess.presets.route.codex',
};

const SECTION_LABEL_KEYS: Record<PresetSection, MessageKey> = {
  'openai-compatibility': 'aliases.source.openAiCompatible',
  'claude-api-key': 'apiAccess.provider.claude',
  'codex-api-key': 'apiAccess.provider.codex',
};

const NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function PresetIcon({ preset }: { preset: ProviderPreset }) {
  if (preset.id === 'opencode-go' || preset.id === 'opencode-zen') {
    return <img src={opencodeIcon} alt="" className="provider-preset-logo" />;
  }
  const Icon = PRESET_ICONS[preset.id];
  return <Icon size={20} aria-hidden="true" />;
}

function RoutingPreview({ routing }: { routing: PresetRouting }) {
  const { t } = useI18n();
  const routes = PRESET_ROUTES.filter((route) => routing.routes[route].length > 0);
  return (
    <div className="provider-preset-routing" aria-live="polite">
      <strong>{t('apiAccess.presets.summary', { count: routingModelCount(routing) })}</strong>
      <p>{t('apiAccess.presets.routing')}</p>
      <ul>
        {routes.map((route) => {
          const names = routing.routes[route];
          return (
            <li key={route}>
              <span>{t(ROUTE_LABEL_KEYS[route])}</span>
              <b>{names.length}</b>
              <small title={names.join(', ')}>{names.slice(0, 3).join(', ')}{names.length > 3 ? ', …' : ''}</small>
            </li>
          );
        })}
      </ul>
      {routing.skipped.length > 0
        ? <small>{t('apiAccess.presets.skipped', { count: routing.skipped.length })}</small>
        : null}
    </div>
  );
}

export type ProviderPresetCreated = { route: PresetRoute; name: string; models: number };

type ProviderPresetDialogProps = {
  onClose: () => void;
  onCreated: (created: ProviderPresetCreated) => Promise<void>;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ProviderPresetDialog({ onClose, onCreated }: ProviderPresetDialogProps) {
  const { t } = useI18n();
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [tokenSecret, setTokenSecret] = useState('');
  const [secretVisible, setSecretVisible] = useState(false);
  const [routing, setRouting] = useState<PresetRouting | null>(null);
  const [working, setWorking] = useState<'find' | 'create' | null>(null);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const dialogRef = useDialogFocusTrap<HTMLElement>({
    onEscape: working ? undefined : onClose,
    preventEscape: working !== null,
  });

  const credentialFor = (current: ProviderPreset) => (current.auth === 'modal-token'
    ? modalProxyToken(tokenId, tokenSecret)
    : apiKey.trim());

  const inputProblem = (current: ProviderPreset): string => {
    if (!name.trim() || name.trim().length > 80 || NAME_CONTROL_CHARACTERS.test(name)) return t('apiAccess.entries.nameRequired');
    if (!baseUrl.trim()) return t('apiAccess.error.requiredBaseKey');
    if (!credentialFor(current)) {
      return t(current.auth === 'modal-token' ? 'apiAccess.presets.tokenRequired' : 'apiAccess.error.requiredKey');
    }
    return '';
  };

  // Changing the endpoint or the credential invalidates any routing already found for them.
  const changeConnection = (update: () => void) => {
    requestRef.current += 1;
    setWorking(null);
    setRouting(null);
    setError('');
    update();
  };

  const choose = (item: ProviderPreset) => {
    requestRef.current += 1;
    setPreset(item);
    setName(item.name);
    setBaseUrl(item.baseUrl);
    setApiKey('');
    setTokenId('');
    setTokenSecret('');
    setSecretVisible(false);
    setRouting(null);
    setWorking(null);
    setError('');
  };

  const back = () => {
    requestRef.current += 1;
    setPreset(null);
    setRouting(null);
    setWorking(null);
    setError('');
  };

  const find = async (current: ProviderPreset) => {
    const problem = inputProblem(current);
    if (problem) {
      setError(problem);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setWorking('find');
    setError('');
    try {
      const discovered = await discoverProviderPresetModels({ name, baseUrl, apiKey: credentialFor(current) });
      if (requestRef.current !== requestId) return;
      const next = routeProviderPresetModels(current, discovered);
      if (routingModelCount(next) === 0) {
        setError(t('apiAccess.presets.noRoutes'));
        return;
      }
      setRouting(next);
    } catch (requestError) {
      if (requestRef.current === requestId) setError(errorText(requestError));
    } finally {
      if (requestRef.current === requestId) setWorking(null);
    }
  };

  const create = async (current: ProviderPreset, found: PresetRouting) => {
    const problem = inputProblem(current);
    if (problem) {
      setError(problem);
      return;
    }
    setWorking('create');
    setError('');
    try {
      const plan = planProviderPreset(current, { name, baseUrl, apiKey: credentialFor(current) }, found);
      await applyProviderPresetPlan(plan);
      await onCreated({ route: plan.entries[0].route, name: name.trim(), models: routingModelCount(found) });
    } catch (requestError) {
      setError(requestError instanceof PresetConflictError
        ? t('apiAccess.presets.duplicate', { name: requestError.groupName, section: t(SECTION_LABEL_KEYS[requestError.section]) })
        : errorText(requestError));
    } finally {
      setWorking(null);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preset || working) return;
    if (routing) void create(preset, routing);
    else void find(preset);
  };

  const secretInput = preset?.auth === 'modal-token' ? tokenSecret : apiKey;
  const setSecret = (value: string) => changeConnection(() => {
    if (preset?.auth === 'modal-token') setTokenSecret(value);
    else setApiKey(value);
  });

  return (
    <div className="config-dialog-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !working && onClose()}>
      <section ref={dialogRef} className="config-dialog management-dialog provider-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-preset-title" tabIndex={-1}>
        <div className="config-dialog-heading">
          <div>
            <Sparkles size={19} aria-hidden="true" />
            <h2 id="provider-preset-title">{preset ? t('apiAccess.presets.step.connect', { name: preset.name }) : t('apiAccess.presets.title')}</h2>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} disabled={working !== null} title={t('common.close')} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {preset ? (
          <form className="provider-preset-form" onSubmit={submit}>
            <fieldset className="provider-preset-fields" disabled={working === 'create'}>
              <div className="provider-dialog-basic-grid">
                <label><span>{t('apiAccess.entries.name')}</span>
                  <input value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} />
                </label>
                <label><span>{t('apiAccess.field.baseUrl')}</span>
                  <input value={baseUrl} onChange={(event) => {
                    const value = event.currentTarget.value;
                    changeConnection(() => setBaseUrl(value));
                  }} />
                </label>
              </div>

              {preset.auth === 'modal-token' ? (
                <div className="provider-dialog-basic-grid">
                  <label><span>{t('apiAccess.presets.field.tokenId')}</span>
                    <input value={tokenId} autoComplete="off" spellCheck={false} onChange={(event) => {
                      const value = event.currentTarget.value;
                      const split = splitModalProxyToken(value);
                      changeConnection(() => {
                        if (split) {
                          setTokenId(split.tokenId);
                          setTokenSecret(split.tokenSecret);
                        } else {
                          setTokenId(value);
                        }
                      });
                    }} />
                  </label>
                  <div className="provider-dialog-secret">
                    <label><span>{t('apiAccess.presets.field.tokenSecret')}</span>
                      <input type={secretVisible ? 'text' : 'password'} value={secretInput} autoComplete="off" spellCheck={false} onChange={(event) => setSecret(event.currentTarget.value)} />
                    </label>
                    <button type="button" className="secondary-button compact-button" aria-pressed={secretVisible} onClick={() => setSecretVisible((value) => !value)}>
                      {t(secretVisible ? 'apiAccess.entries.hideKey' : 'apiAccess.entries.showKey')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="provider-dialog-secret">
                  <label><span>{t('apiAccess.field.key')}</span>
                    <input type={secretVisible ? 'text' : 'password'} value={secretInput} autoComplete="off" spellCheck={false} placeholder="sk-..." onChange={(event) => setSecret(event.currentTarget.value)} />
                  </label>
                  <button type="button" className="secondary-button compact-button" aria-pressed={secretVisible} onClick={() => setSecretVisible((value) => !value)}>
                    {t(secretVisible ? 'apiAccess.entries.hideKey' : 'apiAccess.entries.showKey')}
                  </button>
                </div>
              )}

              {preset.auth === 'modal-token' ? <p className="provider-preset-hint">{t('apiAccess.presets.modal.hint')}</p> : null}
            </fieldset>
            {preset.keyUrl ? <p className="provider-preset-hint">{t('apiAccess.presets.keyHint', { url: preset.keyUrl })}</p> : null}
            {routing ? <RoutingPreview routing={routing} /> : null}
            {error ? <p className="provider-preset-error" role="alert">{error}</p> : null}

            <div className="provider-preset-actions">
              <button type="button" className="secondary-button compact-button" onClick={back} disabled={working !== null}>
                {t('apiAccess.presets.back')}
              </button>
              <button type="submit" className="primary-button compact-button" disabled={working !== null}>
                {working !== null ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : null}
                {routing
                  ? t(working === 'create' ? 'apiAccess.presets.creating' : 'apiAccess.presets.create')
                  : t(working === 'find' ? 'apiAccess.presets.finding' : 'apiAccess.presets.find')}
              </button>
            </div>
          </form>
        ) : (
          <div className="provider-preset-chooser">
            <p className="provider-preset-intro">{t('apiAccess.presets.intro')}</p>
            <div className="provider-preset-grid">
              {PROVIDER_PRESETS.map((item) => (
                <button type="button" key={item.id} className="provider-preset-card" onClick={() => choose(item)}>
                  <span className="provider-preset-icon"><PresetIcon preset={item} /></span>
                  <strong>{item.name}</strong>
                  <span className="provider-preset-description">{t(item.descriptionKey)}</span>
                  <span className="provider-preset-badges">
                    {item.routes.map((route) => <small key={route}>{t(ROUTE_LABEL_KEYS[route])}</small>)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
