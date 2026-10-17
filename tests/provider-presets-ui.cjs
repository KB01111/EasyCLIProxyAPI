const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const screenshotDir = process.env.PROVIDER_PRESET_SCREENSHOTS || '';
const labels = { en: /Quick setup/, 'zh-CN': /快速设置/ };
const widths = [1280, 640];

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({
    configFile: false,
    root: path.resolve(__dirname, '..'),
    plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/provider-presets.html'] },
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null },
  });
  let browser;
  const errors = [];
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;
    browser = await chromium.launch({ channel, headless: true, args: ['--no-proxy-server'] });

    const open = async (locale, width) => {
      const page = await browser.newPage({ viewport: { width, height: 820 } });
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(`${locale} ${width}: ${error}`));
      await page.route('**/*', (route) => (route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort()));
      await page.goto(`${base}/tests/fixtures/provider-presets.html?locale=${locale}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForSelector('.provider-workbench', { timeout: 90000 });
      return page;
    };
    const fixtureState = (page) => page.evaluate(() => structuredClone({
      writes: window.presetFixture.writes,
      probes: window.presetFixture.probes,
    }));
    const submit = (page) => page.locator('.provider-preset-form button[type="submit"]').click();

    // Layout: every locale and width shows the chooser inside the viewport without horizontal scroll.
    for (const locale of Object.keys(labels)) for (const width of widths) {
      const page = await open(locale, width);
      await page.getByRole('button', { name: labels[locale] }).click();
      await page.waitForSelector('.provider-preset-card');
      assert.equal(await page.locator('.provider-preset-card').count(), 11, `${locale} ${width}: card count`);
      const fits = await page.locator('.provider-preset-dialog').evaluate((dialog) => {
        const box = dialog.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
      });
      assert.ok(fits, `${locale} ${width}: dialog fits the viewport without horizontal scroll`);
      if (screenshotDir && locale === 'en') {
        await page.screenshot({ path: path.join(screenshotDir, `presets-chooser-${width}.png`) });
      }
      await page.close();
    }

    // OpenCode Go: discovery routes models by protocol, then three routes share one session header.
    {
      const page = await open('en', 1280);
      await page.getByRole('button', { name: labels.en }).click();
      await page.locator('.provider-preset-card', { hasText: 'OpenCode Go' }).click();
      await page.locator('.provider-dialog-secret input').fill('go-test-key');
      await submit(page);
      await page.waitForSelector('.provider-preset-routing');
      const routes = await page.locator('.provider-preset-routing li').evaluateAll((items) => items.map((item) => ({
        label: item.querySelector('span').textContent,
        count: Number(item.querySelector('b').textContent),
      })));
      assert.deepEqual(routes, [
        { label: 'OpenAI chat', count: 1 },
        { label: 'Anthropic messages', count: 2 },
        { label: 'Responses', count: 1 },
      ]);
      assert.match(await page.locator('.provider-preset-routing').textContent(), /Left out \(no supported route, or free tier only\): 1/);
      if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'presets-routing-en.png') });
      await submit(page);
      await page.waitForSelector('.provider-preset-dialog', { state: 'detached' });

      const { writes, probes } = await fixtureState(page);
      assert.deepEqual(writes.map((write) => write.section), ['openai-compatibility', 'claude-api-key', 'codex-api-key']);
      const [openai, claude, codex] = writes.map((write) => write.body.at(-1));
      const session = openai.headers['x-opencode-session'];
      assert.match(session, /^[0-9a-f-]{36}$/);
      assert.equal(openai['base-url'], 'https://opencode.ai/zen/go/v1');
      assert.deepEqual(openai.models, [{ name: 'glm-5.3' }]);
      assert.equal(claude.name, 'OpenCode Go');
      assert.equal(claude['base-url'], 'https://opencode.ai/zen/go');
      assert.equal(claude.keys[0].headers['x-opencode-session'], session);
      assert.deepEqual(claude.keys[0].models, [{ name: 'claude-haiku-5-5' }, { name: 'minimax-m3' }]);
      assert.equal(codex['base-url'], 'https://opencode.ai/zen/go/v1');
      assert.equal(codex.keys[0].headers['x-opencode-session'], session);
      assert.deepEqual(codex.keys[0].models, [{ name: 'gpt-5.6-luna' }]);
      assert.equal(probes[0].url, 'https://opencode.ai/zen/go/v1/models');
      assert.match(await page.locator('.provider-category-panel button[aria-pressed="true"]').textContent(), /OpenAI/);
      await page.getByText('OpenCode Go added. Models: 4.').waitFor();
      await page.close();
    }

    // Modal: a pasted full token is split into both fields and sent as one bearer key.
    {
      const page = await open('en', 1280);
      await page.getByRole('button', { name: labels.en }).click();
      await page.locator('.provider-preset-card', { hasText: 'Modal shared endpoint' }).click();
      await page.getByLabel('Token ID').fill('wk-abc123.ws-def456');
      assert.equal(await page.getByLabel('Token ID').inputValue(), 'wk-abc123');
      assert.equal(await page.getByLabel('Token secret').inputValue(), 'ws-def456');
      await submit(page);
      await page.waitForSelector('.provider-preset-routing');
      await submit(page);
      await page.waitForSelector('.provider-preset-dialog', { state: 'detached' });

      const { writes, probes } = await fixtureState(page);
      const modal = writes.at(-1);
      assert.equal(modal.section, 'openai-compatibility');
      const group = modal.body.at(-1);
      assert.equal(group.name, 'Modal shared endpoint');
      assert.equal(group['base-url'], 'https://inference.us-west.modal.direct/v1');
      assert.deepEqual(group.keys, [{ 'api-key': 'wk-abc123.ws-def456' }]);
      assert.deepEqual(group.models, [{ name: 'my-endpoint.us-west.modal.direct' }, { name: 'other.us-west.modal.direct' }]);
      assert.equal(probes.at(-1).header.Authorization, 'Bearer wk-abc123.ws-def456');

      // The same service cannot be created twice; the dialog stays open and explains why.
      await page.getByRole('button', { name: labels.en }).click();
      await page.locator('.provider-preset-card', { hasText: 'Modal shared endpoint' }).click();
      await page.getByLabel('Token ID').fill('wk-abc123');
      await page.getByLabel('Token secret').fill('ws-def456');
      await submit(page);
      await page.waitForSelector('.provider-preset-routing');
      const writesBefore = (await fixtureState(page)).writes.length;
      await submit(page);
      await page.getByRole('alert').filter({ hasText: 'already exists' }).waitFor();
      assert.equal((await fixtureState(page)).writes.length, writesBefore, 'duplicate must not write');
      assert.equal(await page.locator('.provider-preset-dialog').count(), 1);
      await page.getByRole('button', { name: 'Back' }).click();
      assert.equal(await page.locator('.provider-preset-card').count(), 11, 'Back returns to the chooser');
      await page.close();
    }

    // While a create is in flight, every field is disabled, so the values cannot change or be re-submitted.
    {
      const page = await open('en', 1280);
      await page.getByRole('button', { name: labels.en }).click();
      await page.locator('.provider-preset-card', { hasText: 'OpenRouter' }).click();
      await page.getByLabel('API Key').fill('or-test-key');
      await submit(page);
      await page.waitForSelector('.provider-preset-routing');
      await page.evaluate(() => { window.presetFixture.hold = true; });
      await submit(page);
      await page.waitForFunction(() => typeof window.presetFixture.release === 'function');
      assert.equal(await page.locator('.provider-preset-fields').evaluate((fields) => fields.disabled), true, 'fields disabled while creating');
      assert.equal(await page.getByLabel('Service Name').isDisabled(), true);
      assert.equal(await page.getByLabel('API Key').isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Back' }).isDisabled(), true);
      assert.equal((await fixtureState(page)).writes.length, 0, 'nothing is written until the held write is released');
      await page.evaluate(() => window.presetFixture.release());
      await page.waitForSelector('.provider-preset-dialog', { state: 'detached' });
      assert.equal((await fixtureState(page)).writes.at(-1).body.at(-1).name, 'OpenRouter');
      await page.close();
    }

    // Chinese UI uses the translated chooser and form labels.
    {
      const page = await open('zh-CN', 1280);
      await page.getByRole('button', { name: labels['zh-CN'] }).click();
      await page.locator('.provider-preset-card', { hasText: 'OpenRouter' }).click();
      assert.equal(await page.locator('#provider-preset-title').textContent(), '接入 OpenRouter');
      assert.equal(await page.locator('.provider-dialog-secret input').count(), 1);
      await page.close();
    }

    assert.deepEqual(errors, [], 'no page errors');
    console.log('provider preset UI checks passed');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
