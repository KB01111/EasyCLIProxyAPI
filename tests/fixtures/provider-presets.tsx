import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { ApiAccessPage } from '../../src/pages/ApiAccessPage';
import '../../src/styles/index.css';

// Fictional upstream catalogues. Hosts map to the shapes the real endpoints return.
const modelsByHost: [string, { id: string; supported_endpoints?: string[] }[]][] = [
  ['inference.us-west.modal.direct', [{ id: 'my-endpoint.us-west.modal.direct' }, { id: 'other.us-west.modal.direct' }]],
  ['opencode.ai/zen/go', [
    { id: 'claude-haiku-5-5' }, { id: 'minimax-m3' }, { id: 'gpt-5.6-luna' }, { id: 'glm-5.3' }, { id: 'gemini-4-argon-contributor' },
  ]],
  ['api.commandcode.ai', [
    { id: 'claude-sonnet-5-5', supported_endpoints: ['/messages'] },
    { id: 'deepseek/deepseek-v4-pro', supported_endpoints: ['/chat/completions', '/responses'] },
  ]],
];

const fixture = window as typeof window & {
  presetFixture: {
    sections: Record<string, Record<string, unknown>[]>;
    writes: { section: string; body: Record<string, unknown>[] }[];
    probes: { url: string; header: Record<string, string> | undefined }[];
    hold?: boolean;
    release?: () => void;
  };
};
fixture.presetFixture = { sections: {}, writes: [], probes: [] };

const query = new URLSearchParams(location.search);
localStorage.setItem('easy-cli-proxy-api.locale', query.get('locale') ?? 'en');

const sectionFromPath = (path: string) => {
  const key = path.replace('/config/api-keys/', '');
  return key === 'openai-compatibility' ? key : `${key}-api-key`;
};

mockIPC((cmd, args: any) => {
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'resolve_api_access_remarks') return args.queries.map(() => '');
  if (cmd === 'save_api_access_remark') return null;
  if (cmd !== 'management_request') throw new Error(`Unexpected ${cmd}`);
  const request = args.request;
  if (request.path === '/requests/api-call') {
    // Discovery is the outer POST that carries an inner GET, as fetchModels sends it.
    if (request.method !== 'POST' || request.body.method !== 'GET') {
      throw new Error(`Unexpected discovery call ${request.method} ${request.body.method}`);
    }
    const url: string = request.body.url;
    fixture.presetFixture.probes.push({ url, header: request.body.header });
    const host = modelsByHost.find(([fragment]) => url.includes(fragment));
    return { status_code: 200, body: { data: host ? host[1] : [{ id: 'fallback-model' }] } };
  }
  if (request.method === 'GET') {
    const section = sectionFromPath(request.path);
    return structuredClone(fixture.presetFixture.sections[section] ?? []);
  }
  if (request.method !== 'PUT') throw new Error(`Unexpected ${request.method} ${request.path}`);
  const section = sectionFromPath(request.path);
  const commit = () => {
    fixture.presetFixture.sections[section] = structuredClone(request.body);
    fixture.presetFixture.writes.push({ section, body: structuredClone(request.body) });
    return { status: 'ok' };
  };
  // A held write stays pending until the test releases it, so the in-flight state can be inspected.
  if (fixture.presetFixture.hold) {
    return new Promise((resolve) => {
      fixture.presetFixture.release = () => resolve(commit());
    });
  }
  return commit();
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <div className="app-shell">
      <aside className="sidebar" />
      <div className="workspace"><main className="content"><ApiAccessPage /></main></div>
    </div>
  </I18nProvider>,
);
