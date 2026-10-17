import { describe, expect, it } from 'bun:test';
import {
  applyProviderPresetPlan,
  modalProxyToken,
  planProviderPreset,
  PRESET_ROUTE_SECTIONS,
  PRESET_ROUTES,
  PresetConflictError,
  PROVIDER_PRESETS,
  presetById,
  presetRouteBaseUrl,
  routeProviderPresetModels,
  routingModelCount,
  splitModalProxyToken,
  type PresetPlan,
  type ProviderGroupStore,
} from '../src/services/providerPresets';
import { modelsFromDiscoveredPayload, normalizeBaseUrl } from '../src/services/modelService';
import { cleanProviderGroup } from '../src/services/providerGroups';

type Value = Record<string, unknown>;

const names = (models: string[]) => models.map((name) => ({ name }));

describe('provider presets catalog', () => {
  it('uses unique ids and endpoints that normalize to themselves', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(normalizeBaseUrl(preset.baseUrl)).toBe(preset.baseUrl);
      expect(preset.routes.length).toBeGreaterThan(0);
    }
  });

  it('keeps the verified Modal, OpenCode and Command Code endpoints', () => {
    expect(presetById('modal')).toMatchObject({ auth: 'modal-token', baseUrl: 'https://inference.us-west.modal.direct/v1', routes: ['openai'] });
    expect(presetById('opencode-go').baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(presetById('opencode-zen').baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(presetById('command-code').baseUrl).toBe('https://api.commandcode.ai/provider/v1');
    expect(presetById('command-code').routes).toEqual(PRESET_ROUTES);
  });

  it('maps each route to the section the provider page already uses', () => {
    expect(PRESET_ROUTE_SECTIONS).toEqual({
      openai: 'openai-compatibility',
      claude: 'claude-api-key',
      codex: 'codex-api-key',
    });
  });

  it('throws for an unknown preset id', () => {
    expect(() => presetById('missing' as never)).toThrow('Unknown provider preset');
  });
});

describe('modal proxy token', () => {
  it('joins the Token ID and secret into one bearer token', () => {
    expect(modalProxyToken(' wk-abc123 ', 'ws-def456\n')).toBe('wk-abc123.ws-def456');
  });

  it('requires both parts', () => {
    expect(modalProxyToken('wk-abc123', '  ')).toBe('');
    expect(modalProxyToken('', 'ws-def456')).toBe('');
  });

  it('splits a complete pasted token back into both parts', () => {
    expect(splitModalProxyToken('wk-abc123.ws-def456')).toEqual({ tokenId: 'wk-abc123', tokenSecret: 'ws-def456' });
    expect(splitModalProxyToken('  wk-abc123.ws-de.f456  ')).toEqual({ tokenId: 'wk-abc123', tokenSecret: 'ws-de.f456' });
  });

  it('leaves partial or foreign values alone', () => {
    expect(splitModalProxyToken('wk-abc123')).toBeNull();
    expect(splitModalProxyToken('sk-abc.def')).toBeNull();
    expect(splitModalProxyToken('wk-abc123.')).toBeNull();
  });
});

describe('presetRouteBaseUrl', () => {
  it('stops the Anthropic route before /v1 because clients append /v1/messages', () => {
    expect(presetRouteBaseUrl('claude', 'https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/go');
    expect(presetRouteBaseUrl('claude', 'https://api.commandcode.ai/provider/v1/')).toBe('https://api.commandcode.ai/provider');
  });

  it('keeps /v1 for the chat and Responses routes', () => {
    expect(presetRouteBaseUrl('openai', 'https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/go/v1');
    expect(presetRouteBaseUrl('codex', 'https://opencode.ai/zen/v1')).toBe('https://opencode.ai/zen/v1');
  });
});

describe('routeProviderPresetModels', () => {
  it('sends every Modal endpoint through the chat route', () => {
    const routing = routeProviderPresetModels(presetById('modal'), [
      { name: 'my-endpoint.us-west.modal.direct' },
      { name: 'other.us-west.modal.direct' },
    ]);
    expect(routing.routes).toEqual({ openai: ['my-endpoint.us-west.modal.direct', 'other.us-west.modal.direct'], claude: [], codex: [] });
    expect(routing.skipped).toEqual([]);
  });

  it('routes OpenCode Go by the endpoint families in its documentation', () => {
    const routing = routeProviderPresetModels(presetById('opencode-go'), names([
      'claude-haiku-5-5', 'minimax-m3', 'qwen3.8-max', 'qwen3.7-plus',
      'gpt-5.6-luna', 'grok-4.7', 'muse-spark-1.3-contributor',
      'glm-5.3', 'kimi-k3', 'deepseek-v4-pro', 'qwen3.6-plus',
      'gemini-4-argon-contributor',
    ]));
    expect(routing.routes.claude).toEqual(['claude-haiku-5-5', 'minimax-m3', 'qwen3.8-max', 'qwen3.7-plus']);
    expect(routing.routes.codex).toEqual(['gpt-5.6-luna', 'grok-4.7', 'muse-spark-1.3-contributor']);
    expect(routing.routes.openai).toEqual(['glm-5.3', 'kimi-k3', 'deepseek-v4-pro', 'qwen3.6-plus']);
    expect(routing.skipped).toEqual(['gemini-4-argon-contributor']);
  });

  it('routes OpenCode Zen Claude and Qwen models by its endpoint table', () => {
    const routing = routeProviderPresetModels(presetById('opencode-zen'), names([
      'claude-opus-5-5', 'minimax-m3', 'gpt-5.5', 'glm-5.2', 'qwen3.6-plus', 'qwen3.8-max', 'qwen3.8-flash',
    ]));
    expect(routing.routes.claude).toEqual(['claude-opus-5-5', 'qwen3.6-plus', 'qwen3.8-flash']);
    expect(routing.routes.openai).toEqual(['minimax-m3', 'glm-5.2', 'qwen3.8-max']);
    expect(routing.routes.codex).toEqual(['gpt-5.5']);
  });

  it('leaves out OpenCode Zen free-tier models, which answer only inside OpenCode', () => {
    const zen = routeProviderPresetModels(presetById('opencode-zen'), names(['glm-5.3-flash-free', 'big-pickle', 'glm-5.3']));
    expect(zen.routes.openai).toEqual(['glm-5.3']);
    expect(zen.skipped).toEqual(['glm-5.3-flash-free', 'big-pickle']);
    const go = routeProviderPresetModels(presetById('opencode-go'), names(['beam-free']));
    expect(go.routes.openai).toEqual(['beam-free']);
  });

  it('follows Command Code supported_endpoints for each model', () => {
    const routing = routeProviderPresetModels(presetById('command-code'), [
      { name: 'claude-sonnet-5-5', supportedEndpoints: ['/messages'] },
      { name: 'deepseek/deepseek-v4-pro', supportedEndpoints: ['/chat/completions', '/responses'] },
      { name: 'responses-only', supportedEndpoints: ['/responses'] },
      { name: 'no-route', supportedEndpoints: ['/embeddings'] },
    ]);
    expect(routing.routes).toEqual({
      openai: ['deepseek/deepseek-v4-pro'],
      claude: ['claude-sonnet-5-5'],
      codex: ['responses-only'],
    });
    expect(routing.skipped).toEqual(['no-route']);
  });

  it('falls back to the model family when a Command Code model reports no endpoints', () => {
    const routing = routeProviderPresetModels(presetById('command-code'), names(['claude-opus-5-5', 'gpt-5.5']));
    expect(routing.routes.claude).toEqual(['claude-opus-5-5']);
    expect(routing.routes.openai).toEqual(['gpt-5.5']);
  });

  it('skips a Command Code model that reports an empty endpoint list instead of guessing from its name', () => {
    const routing = routeProviderPresetModels(presetById('command-code'), [
      { name: 'claude-sonnet-5-5', supportedEndpoints: [] },
    ]);
    expect(routing.routes).toEqual({ openai: [], claude: [], codex: [] });
    expect(routing.skipped).toEqual(['claude-sonnet-5-5']);
  });

  it('drops blank and case-insensitive duplicate names and counts only routed models', () => {
    const routing = routeProviderPresetModels(presetById('openrouter'), names(['Model-A', 'model-a', '  ', 'Model-B']));
    expect(routing.routes.openai).toEqual(['Model-A', 'Model-B']);
    expect(routingModelCount(routing)).toBe(2);
  });
});

describe('planProviderPreset', () => {
  it('builds an OpenAI-format group with keys and models at group level', () => {
    const preset = presetById('modal');
    const plan = planProviderPreset(preset, {
      name: '  Modal  ',
      baseUrl: 'https://inference.us-west.modal.direct/v1',
      apiKey: ' wk-abc.ws-def ',
    }, routeProviderPresetModels(preset, names(['host.us-west.modal.direct'])));
    expect(plan.presetId).toBe('modal');
    expect(plan.entries).toEqual([{
      route: 'openai',
      section: 'openai-compatibility',
      group: {
        name: 'Modal',
        'base-url': 'https://inference.us-west.modal.direct/v1',
        keys: [{ 'api-key': 'wk-abc.ws-def' }],
        models: [{ name: 'host.us-west.modal.direct' }],
      },
    }]);
  });

  it('creates OpenCode Go routes that share one session header', () => {
    const preset = presetById('opencode-go');
    const plan = planProviderPreset(preset, {
      name: 'OpenCode Go', baseUrl: preset.baseUrl, apiKey: 'key-go',
    }, routeProviderPresetModels(preset, names(['claude-haiku-5-5', 'gpt-5.6-luna', 'glm-5.3'])),
    () => 'session-1');
    const byRoute = Object.fromEntries(plan.entries.map((entry) => [entry.route, entry]));
    expect(Object.keys(byRoute).sort()).toEqual(['claude', 'codex', 'openai']);

    const openai = byRoute.openai.group as Value;
    expect(openai['base-url']).toBe('https://opencode.ai/zen/go/v1');
    expect(openai.headers).toEqual({ 'x-opencode-session': 'session-1' });
    expect(openai.models).toEqual([{ name: 'glm-5.3' }]);

    const claude = byRoute.claude.group as Value;
    expect(claude['base-url']).toBe('https://opencode.ai/zen/go');
    expect(claude.keys).toEqual([{
      'api-key': 'key-go',
      headers: { 'x-opencode-session': 'session-1' },
      models: [{ name: 'claude-haiku-5-5' }],
    }]);

    const codex = byRoute.codex.group as Value;
    expect(codex['base-url']).toBe('https://opencode.ai/zen/go/v1');
    expect((codex.keys as Value[])[0].headers).toEqual({ 'x-opencode-session': 'session-1' });
  });

  it('gives each OpenCode Go setup its own session id', () => {
    const preset = presetById('opencode-go');
    const routing = routeProviderPresetModels(preset, names(['glm-5.3']));
    const ids = [planProviderPreset(preset, { name: 'a', baseUrl: preset.baseUrl, apiKey: 'k' }, routing, () => 'first'),
      planProviderPreset(preset, { name: 'a', baseUrl: preset.baseUrl, apiKey: 'k' }, routing, () => 'second')]
      .map((plan) => (plan.entries[0].group as Value).headers);
    expect(ids).toEqual([{ 'x-opencode-session': 'first' }, { 'x-opencode-session': 'second' }]);
  });

  it('creates OpenCode Zen without a session header', () => {
    const preset = presetById('opencode-zen');
    const plan = planProviderPreset(preset, { name: 'OpenCode Zen', baseUrl: preset.baseUrl, apiKey: 'k' },
      routeProviderPresetModels(preset, names(['claude-opus-5-5', 'glm-5.2'])));
    expect(JSON.stringify(plan)).not.toContain('x-opencode-session');
    expect(plan.entries.map((entry) => entry.group['base-url'])).toEqual([
      'https://opencode.ai/zen/v1',
      'https://opencode.ai/zen',
    ]);
  });

  it('derives Command Code chat and Anthropic bases from one endpoint', () => {
    const preset = presetById('command-code');
    const plan = planProviderPreset(preset, { name: 'Command Code', baseUrl: preset.baseUrl, apiKey: 'user-key' }, routeProviderPresetModels(preset, [
      { name: 'claude-sonnet-5-5', supportedEndpoints: ['/messages'] },
      { name: 'deepseek/deepseek-v4-pro', supportedEndpoints: ['/chat/completions'] },
    ]));
    expect(plan.entries.map((entry) => [entry.section, entry.group['base-url']])).toEqual([
      ['openai-compatibility', 'https://api.commandcode.ai/provider/v1'],
      ['claude-api-key', 'https://api.commandcode.ai/provider'],
    ]);
  });

  it('refuses a plan when no model can be routed', () => {
    const preset = presetById('command-code');
    expect(() => planProviderPreset(preset, { name: 'x', baseUrl: preset.baseUrl, apiKey: 'k' },
      routeProviderPresetModels(preset, [{ name: 'a', supportedEndpoints: ['/embeddings'] }]))).toThrow('supported format');
  });
});

describe('applyProviderPresetPlan', () => {
  const existingOpenAi = { name: 'Existing', 'base-url': 'https://example.test/v1', keys: [{ 'api-key': 'old' }], models: [] };
  const existingClaude = { name: 'claude-1', 'base-url': 'https://api.anthropic.com', keys: [{ 'api-key': 'anthropic' }] };

  const fakeStore = (initial: Partial<Record<string, Value[]>>, failOn?: string) => {
    const state: Record<string, Value[]> = {
      'openai-compatibility': [existingOpenAi],
      'claude-api-key': [existingClaude],
      'codex-api-key': [],
      ...initial,
    };
    const puts: [string, Value[]][] = [];
    const store: ProviderGroupStore = {
      get: async (section) => structuredClone(state[section] ?? []),
      put: async (section, groups) => {
        if (section === failOn) throw new Error(`put ${section} failed`);
        puts.push([section, structuredClone(groups)]);
        state[section] = structuredClone(groups);
      },
    };
    return { state, puts, store };
  };

  const planFor = (name: string): PresetPlan => {
    const preset = presetById('opencode-go');
    return planProviderPreset(preset, { name, baseUrl: preset.baseUrl, apiKey: 'key' },
      routeProviderPresetModels(preset, names(['claude-haiku-5-5', 'gpt-5.6-luna', 'glm-5.3'])), () => 'session');
  };

  it('appends every route group and keeps the existing records untouched', async () => {
    const { state, puts, store } = fakeStore({});
    await applyProviderPresetPlan(planFor('OpenCode Go'), store);
    expect(puts.map(([section]) => section)).toEqual(['openai-compatibility', 'claude-api-key', 'codex-api-key']);
    expect(state['openai-compatibility']).toEqual([cleanProviderGroup(existingOpenAi), expect.objectContaining({ name: 'OpenCode Go' })]);
    expect(state['claude-api-key'][0]).toEqual(cleanProviderGroup(existingClaude));
    expect(state['claude-api-key'][1]).toMatchObject({ name: 'OpenCode Go', 'base-url': 'https://opencode.ai/zen/go' });
  });

  it('rejects an existing name case-insensitively before writing anything', async () => {
    const { puts, store } = fakeStore({ 'openai-compatibility': [{ name: 'opencode go', 'base-url': 'x', keys: [] }] });
    const attempt = applyProviderPresetPlan(planFor('OpenCode Go'), store);
    await expect(attempt).rejects.toBeInstanceOf(PresetConflictError);
    await expect(applyProviderPresetPlan(planFor('OpenCode Go'), store)).rejects.toMatchObject({ groupName: 'OpenCode Go', section: 'openai-compatibility' });
    expect(puts).toEqual([]);
  });

  it('restores the earlier sections when a later write fails', async () => {
    const { state, puts, store } = fakeStore({}, 'claude-api-key');
    await expect(applyProviderPresetPlan(planFor('OpenCode Go'), store)).rejects.toThrow('put claude-api-key failed');
    expect(state['openai-compatibility']).toEqual([cleanProviderGroup(existingOpenAi)]);
    expect(puts.filter(([section]) => section === 'openai-compatibility')).toHaveLength(2);
  });

  it('restores a section whose write was applied even though its response failed', async () => {
    const { state, store } = fakeStore({});
    const lostResponse: ProviderGroupStore = {
      get: store.get,
      put: async (section, groups) => {
        await store.put(section, groups);
        if (section === 'claude-api-key') throw new Error('response lost');
      },
    };
    await expect(applyProviderPresetPlan(planFor('OpenCode Go'), lostResponse)).rejects.toThrow('response lost');
    expect(state['claude-api-key']).toEqual([cleanProviderGroup(existingClaude)]);
    expect(state['openai-compatibility']).toEqual([cleanProviderGroup(existingOpenAi)]);
  });

  it('reports a failed rollback together with the original error', async () => {
    const puts: string[] = [];
    let claudeFailed = false;
    const store: ProviderGroupStore = {
      get: async (section) => (section === 'openai-compatibility' ? [existingOpenAi] : []),
      put: async (section) => {
        puts.push(section);
        if (section === 'claude-api-key' && !claudeFailed) {
          claudeFailed = true;
          throw new Error('claude down');
        }
        // Only restoring the first section fails.
        if (section === 'openai-compatibility' && puts.length > 1) throw new Error('rollback down');
      },
    };
    const attempt = applyProviderPresetPlan(planFor('OpenCode Go'), store);
    await expect(attempt).rejects.toThrow('claude down; rollback failed: Error: rollback down');
  });
});

describe('discovery normalization', () => {
  it('keeps supported_endpoints from discovery payloads and omits them when absent', () => {
    const [claude, chat, silent] = modelsFromDiscoveredPayload({
      data: [
        { id: 'claude-sonnet-5-5', supported_endpoints: ['/messages', 42, '  '] },
        { id: 'deepseek/deepseek-v4-pro' },
        { id: 'no-endpoints', supported_endpoints: [] },
      ],
    });
    expect(claude.supportedEndpoints).toEqual(['/messages']);
    expect(chat.supportedEndpoints).toBeUndefined();
    expect(silent.supportedEndpoints).toEqual([]);
  });
});
