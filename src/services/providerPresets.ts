import type { MessageKey } from '../i18n/resources';
import { isRecord, providerGroupsApi, readString } from './managementApi';
import { fetchModels, normalizeBaseUrl, type ModelOption } from './modelService';
import { cleanProviderGroup } from './providerGroups';

// Presets only create ordinary provider records. Once written they are edited,
// health-checked and ordered like any hand-made entry, with no special cases.

export type PresetRoute = 'openai' | 'claude' | 'codex';
export type PresetSection = 'openai-compatibility' | 'claude-api-key' | 'codex-api-key';

export const PRESET_ROUTES: readonly PresetRoute[] = ['openai', 'claude', 'codex'];
export const PRESET_ROUTE_SECTIONS: Record<PresetRoute, PresetSection> = {
  openai: 'openai-compatibility',
  claude: 'claude-api-key',
  codex: 'codex-api-key',
};

export type PresetModel = Pick<ModelOption, 'name' | 'supportedEndpoints'>;

export type ProviderPresetId =
  | 'modal'
  | 'opencode-go'
  | 'opencode-zen'
  | 'command-code'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'moonshot'
  | 'zai'
  | 'cerebras'
  | 'together';

export type ProviderPreset = {
  id: ProviderPresetId;
  name: string;
  descriptionKey: MessageKey;
  auth: 'api-key' | 'modal-token';
  /** OpenAI-format endpoint. The Anthropic and Responses routes are derived from it. */
  baseUrl: string;
  /** Routes this preset can create, shown as badges on its card. */
  routes: readonly PresetRoute[];
  keyUrl?: string;
  /** Headers the upstream requires on every route; the session id is generated per setup. */
  headers?: (sessionId: string) => Record<string, string>;
  routeModel: (model: PresetModel) => PresetRoute | null;
};

const openAiOnly = (): PresetRoute => 'openai';

// OpenCode serves Anthropic-format models, Responses-format models and Google-native
// models from different paths. The chat route only carries the rest, so the other
// two are routed explicitly and Google-native models are left out. Zen's free models
// answer only inside OpenCode itself, so they are left out there.
const openCodeRoute = (anthropicModels: RegExp, excludeFreeTier: boolean) => (model: PresetModel): PresetRoute | null => {
  if (/^gemini-/i.test(model.name)) return null;
  if (excludeFreeTier && /^big-pickle$|-free$/i.test(model.name)) return null;
  if (anthropicModels.test(model.name)) return 'claude';
  if (/^(?:gpt|grok|muse)-/i.test(model.name)) return 'codex';
  return 'openai';
};

// Command Code reports the protocols each model accepts, so routing follows that list.
const commandCodeRoute = (model: PresetModel): PresetRoute | null => {
  const endpoints = model.supportedEndpoints ?? [];
  if (endpoints.length === 0) return /^claude-/i.test(model.name) ? 'claude' : 'openai';
  if (endpoints.includes('/chat/completions')) return 'openai';
  if (endpoints.includes('/messages')) return 'claude';
  if (endpoints.includes('/responses')) return 'codex';
  return null;
};

const openAiCompatible = (
  id: ProviderPresetId, name: string, baseUrl: string, keyUrl?: string,
): ProviderPreset => ({
  id,
  name,
  descriptionKey: 'apiAccess.presets.desc.openAiCompatible',
  auth: 'api-key',
  baseUrl,
  routes: ['openai'],
  ...(keyUrl ? { keyUrl } : {}),
  routeModel: openAiOnly,
});

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'modal',
    name: 'Modal shared endpoint',
    descriptionKey: 'apiAccess.presets.desc.modal',
    auth: 'modal-token',
    baseUrl: 'https://inference.us-west.modal.direct/v1',
    routes: ['openai'],
    routeModel: openAiOnly,
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    descriptionKey: 'apiAccess.presets.desc.opencodeGo',
    auth: 'api-key',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    keyUrl: 'https://opencode.ai/console',
    routes: PRESET_ROUTES,
    headers: (sessionId) => ({ 'x-opencode-session': sessionId }),
    routeModel: openCodeRoute(/^(?:claude-|minimax-|qwen3\.[78]-)/i, false),
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    descriptionKey: 'apiAccess.presets.desc.opencodeZen',
    auth: 'api-key',
    baseUrl: 'https://opencode.ai/zen/v1',
    keyUrl: 'https://opencode.ai/console',
    routes: PRESET_ROUTES,
    routeModel: openCodeRoute(/^claude-/i, true),
  },
  {
    id: 'command-code',
    name: 'Command Code',
    descriptionKey: 'apiAccess.presets.desc.commandCode',
    auth: 'api-key',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    routes: PRESET_ROUTES,
    routeModel: commandCodeRoute,
  },
  openAiCompatible('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'),
  openAiCompatible('groq', 'Groq', 'https://api.groq.com/openai/v1'),
  openAiCompatible('mistral', 'Mistral AI', 'https://api.mistral.ai/v1'),
  openAiCompatible('moonshot', 'Moonshot AI (Kimi)', 'https://api.moonshot.ai/v1'),
  openAiCompatible('zai', 'Z.ai (GLM)', 'https://api.z.ai/api/paas/v4'),
  openAiCompatible('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1'),
  openAiCompatible('together', 'Together AI', 'https://api.together.xyz/v1'),
];

export const presetById = (id: ProviderPresetId): ProviderPreset => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(`Unknown provider preset: ${id}`);
  return preset;
};

// Modal's proxy token is "<Token ID>.<Token secret>", e.g. wk-<id>.ws-<secret>
export function modalProxyToken(tokenId: string, tokenSecret: string): string {
  const id = tokenId.trim();
  const secret = tokenSecret.trim();
  return id && secret ? `${id}.${secret}` : '';
}

// A complete proxy token pasted into the Token ID field is split back into both parts.
export function splitModalProxyToken(value: string): { tokenId: string; tokenSecret: string } | null {
  const match = value.trim().match(/^(wk-[^\s.]+)\.(ws-\S+)$/);
  return match ? { tokenId: match[1], tokenSecret: match[2] } : null;
}

// Anthropic clients append /v1/messages themselves, so that route stops before /v1.
export function presetRouteBaseUrl(route: PresetRoute, baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return route === 'claude' ? normalized.replace(/\/v1$/i, '') : normalized;
}

export type PresetRouting = {
  routes: Record<PresetRoute, string[]>;
  skipped: string[];
};

export function routeProviderPresetModels(preset: ProviderPreset, models: readonly PresetModel[]): PresetRouting {
  const routes: Record<PresetRoute, string[]> = { openai: [], claude: [], codex: [] };
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const name = model.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const route = preset.routeModel({ name, supportedEndpoints: model.supportedEndpoints });
    if (route) routes[route].push(name);
    else skipped.push(name);
  }
  return { routes, skipped };
}

export const routingModelCount = (routing: PresetRouting) =>
  PRESET_ROUTES.reduce((total, route) => total + routing.routes[route].length, 0);

export type PresetInput = { name: string; baseUrl: string; apiKey: string };

export type PresetPlanEntry = {
  route: PresetRoute;
  section: PresetSection;
  group: Record<string, unknown>;
};

export type PresetPlan = {
  presetId: ProviderPresetId;
  entries: PresetPlanEntry[];
};

// Groups mirror the shapes the provider editor writes: OpenAI-format groups keep
// keys and models at group level, Anthropic and Responses groups keep them per key.
export function planProviderPreset(
  preset: ProviderPreset,
  input: PresetInput,
  routing: PresetRouting,
  newSessionId: () => string = () => crypto.randomUUID(),
): PresetPlan {
  const name = input.name.trim();
  const apiKey = input.apiKey.trim();
  const headers = preset.headers?.(newSessionId());
  const entries = PRESET_ROUTES.flatMap((route): PresetPlanEntry[] => {
    const names = routing.routes[route];
    if (names.length === 0) return [];
    const baseUrl = presetRouteBaseUrl(route, input.baseUrl);
    const models = names.map((model) => ({ name: model }));
    const section = PRESET_ROUTE_SECTIONS[route];
    const group: Record<string, unknown> = route === 'openai'
      ? {
        name,
        'base-url': baseUrl,
        ...(headers ? { headers: { ...headers } } : {}),
        keys: [{ 'api-key': apiKey }],
        models,
      }
      : {
        name,
        'base-url': baseUrl,
        keys: [{ 'api-key': apiKey, ...(headers ? { headers: { ...headers } } : {}), models }],
      };
    return [{ route, section, group }];
  });
  if (entries.length === 0) throw new Error('No discovered model can be routed through a supported format.');
  return { presetId: preset.id, entries };
}

export class PresetConflictError extends Error {
  readonly groupName: string;
  readonly section: PresetSection;

  constructor(groupName: string, section: PresetSection) {
    super(`A connection named "${groupName}" already exists in ${section}.`);
    this.groupName = groupName;
    this.section = section;
  }
}

export type ProviderGroupStore = Pick<typeof providerGroupsApi, 'get' | 'put'>;

const sameGroupName = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

// Every section is checked before anything is written. If a later write fails, the
// earlier sections are restored, so a setup never leaves a half-created service.
export async function applyProviderPresetPlan(
  plan: PresetPlan,
  store: ProviderGroupStore = providerGroupsApi,
): Promise<void> {
  const current = new Map<PresetSection, Record<string, unknown>[]>();
  for (const entry of plan.entries) {
    if (!current.has(entry.section)) current.set(entry.section, await store.get(entry.section));
  }
  for (const entry of plan.entries) {
    const groupName = readString(entry.group, 'name');
    const existing = current.get(entry.section) ?? [];
    if (existing.some((group) => isRecord(group) && sameGroupName(readString(group, 'name'), groupName))) {
      throw new PresetConflictError(groupName, entry.section);
    }
  }

  const written: PresetSection[] = [];
  try {
    for (const entry of plan.entries) {
      const existing = (current.get(entry.section) ?? []).map(cleanProviderGroup);
      await store.put(entry.section, [...existing, cleanProviderGroup(entry.group)]);
      written.push(entry.section);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const section of written.reverse()) {
      try {
        await store.put(section, (current.get(section) ?? []).map(cleanProviderGroup));
      } catch (rollbackError) {
        rollbackErrors.push(String(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
}

// Discovery always goes through the OpenAI-format endpoint, which lists every model
// the upstream offers. Routing then decides which route each model is created on.
export function discoverProviderPresetModels(input: PresetInput): Promise<ModelOption[]> {
  return fetchModels('openai', presetRouteBaseUrl('openai', input.baseUrl), input.apiKey.trim());
}
