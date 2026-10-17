// Browser-mock UI test for the Codex Account Center page. Run: bun run test:ui:codex-accounts
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ configFile: false, root: path.resolve(__dirname, '..'), plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null } });
  let browser;
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, args: ['--no-proxy-server'] });
    const errors = [], externalRequests = [];

    const open = async (flags = '', viewport = { width: 1400, height: 1100 }, locale = 'en') => {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => {
        if (route.request().url().startsWith(`${base}/`)) return route.continue();
        externalRequests.push(route.request().url());
        return route.abort();
      });
      await page.addInitScript(value => localStorage.setItem('easy-cli-proxy-api.locale', value), locale);
      await page.goto(`${base}/?mock=running&mockDelay=5${flags ? `&mockCodex=${flags}` : ''}`);
      await page.locator('.app-shell').waitFor();
      await page.locator('.nav-section button').filter({ hasText: locale === 'en' ? 'Codex Accounts' : 'Codex' }).first().click();
      await page.locator('[data-testid=codex-account]').first().waitFor();
      return page;
    };
    const card = (page, alias) => page.locator('[data-testid=codex-account]').filter({ has: page.locator('.cxa-alias-text', { hasText: alias }) });
    const featured = (page, slot) => page.locator(`[data-testid=featured-card][data-slot=${slot}]`);

    // 1. Rendering, five separate states, secrets, quota arrival.
    {
      const page = await open();
      assert.equal(await page.locator('[data-testid=codex-account]').count(), 3, 'three accounts are listed');
      assert.equal(await page.locator('[data-testid=featured-card]:not([data-empty])').count(), 2, 'two featured quick-switch cards');
      assert.equal(await page.locator('[data-testid=duplicate-email]').count(), 2, 'same email with different identity is flagged on both accounts');
      assert.equal(await card(page, 'Work').locator('.cxa-hint').count(), 1, 'masked account id hint is always visible');
      await featured(page, 'primary').locator('[data-window=short] [role=progressbar][aria-valuenow]').waitFor();
      assert.equal(await featured(page, 'primary').locator('[data-window=short] [role=progressbar]').getAttribute('aria-valuenow'), '72');
      assert.equal(await featured(page, 'secondary').locator('[data-window=short] [role=progressbar]').getAttribute('aria-valuenow'), '9');
      assert.match(await featured(page, 'primary').locator('[data-window=long]').innerText(), /58%/);
      assert.match(await featured(page, 'primary').innerText(), /resets in/i);
      // Expired credentials never get a quota request and say why.
      assert.match(await card(page, 'Reserve').locator('.cxa-account-quota').innerText(), /expired/i);
      assert.match(await card(page, 'Reserve').innerText(), /older than the native copy/i);
      // Proxy-connected, native-active and pinned are distinct facts.
      assert.equal(await card(page, 'Work').locator('[data-native=active]').count(), 1);
      assert.equal(await card(page, 'Home').locator('[data-native=inactive]').count(), 1);
      assert.equal(await card(page, 'Home').locator('[data-slot=secondary]').count(), 1);
      assert.match(await page.locator('[data-testid=fact-health]').innerText(), /1 valid · 1 refreshable · 1 needs re-login/);
      // Recommendation is advisory text only.
      assert.match(await page.locator('[data-testid=banner-recommendation]').innerText(), /Recommended: Work/);
      assert.match(await page.locator('[data-testid=activity-scope]').innerText(), /proxy only/i);
      const body = await page.locator('body').innerText();
      assert.ok(!/access_token|refresh_token|id_token|Bearer /i.test(body), 'no token names or values in page text');
      const html = await page.content();
      assert.ok(!/access_token|refresh_token/i.test(html), 'no token names in the DOM');
      assert.equal(await page.locator('[data-testid=protection-note]').getAttribute('data-protection'), 'windows-dpapi');

      // 2. Switch flow: the active indicator only moves after the backend answered and state was re-read.
      await featured(page, 'secondary').getByRole('button', { name: 'Switch to Home' }).click();
      const result = page.locator('[data-testid=switch-result][data-status=switched]');
      await result.waitFor();
      assert.match(await result.innerText(), /Switched to Home/);
      assert.match(await result.locator('[data-testid=restart-note]').innerText(), /Restart required/i);
      assert.match(await result.locator('[data-testid=desktop-unverified]').innerText(), /Unverified/);
      assert.match(await result.locator('[data-testid=desktop-note]').innerText(), /could not be verified/);
      assert.equal(await page.locator('[data-testid=desktop-unverified]').count(), 1, 'Desktop is never shown as switched');
      assert.match(await page.locator('[data-testid=switch-live]').innerText(), /Switched to Home/, 'result is announced in a live region');
      assert.equal(await page.locator('[data-testid=switch-live]').getAttribute('aria-live'), 'polite');
      assert.equal(await card(page, 'Home').locator('[data-native=active]').count(), 1, 'active indicator moved after re-fetch');
      assert.equal(await card(page, 'Work').locator('[data-native=inactive]').count(), 1);
      await result.locator('summary').click();
      assert.match(await result.locator('[data-testid=perf-details]').innerText(), /Validate[\s\S]*1 ms[\s\S]*Backend total[\s\S]*8 ms/);
      await page.waitForFunction(() => /\d+ ms/.test(document.querySelector('[data-testid=perf-ui]')?.textContent || ''));
      // Toggle goes back to the primary.
      await page.getByRole('button', { name: /Toggle A/ }).click();
      await page.locator('[data-testid=switch-result] [data-testid=switch-result-title]', { hasText: 'Switched to Work' }).waitFor();
      assert.equal(await card(page, 'Work').locator('[data-native=active]').count(), 1);
      // Restart Desktop needs a confirmation naming the consequence.
      await page.getByRole('button', { name: 'Restart Codex Desktop' }).click();
      const dialog = page.getByRole('alertdialog');
      assert.match(await dialog.innerText(), /closes and reopens Codex Desktop/);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.close();
    }

    // 3. Blocked: Codex is running. Actionable, and never offers to kill anything.
    {
      const page = await open('running');
      await featured(page, 'secondary').getByRole('button', { name: 'Switch to Home' }).click();
      const blocked = page.locator('[data-testid=switch-result][data-code=codex_running]');
      await blocked.waitFor();
      const text = await blocked.innerText();
      assert.match(text, /Close Codex/);
      assert.match(text, /Codex\.exe/);
      assert.match(text, /never closes Codex for you/);
      assert.equal(await blocked.getByRole('button', { name: /kill|terminate|end task|force|stop process/i }).count(), 0);
      assert.equal(await card(page, 'Work').locator('[data-native=active]').count(), 1, 'a blocked switch changes nothing');
      await page.close();
    }

    // 4. Unmanaged native login: banner and the add-account flow.
    {
      const page = await open('unmanaged');
      await page.locator('[data-testid=banner-unmanaged]').waitFor();
      await featured(page, 'secondary').getByRole('button', { name: 'Switch to Home' }).click();
      await page.locator('[data-testid=switch-result][data-code=unknown_live_identity]').waitFor();
      await page.locator('[data-testid=switch-result]').getByRole('button', { name: /Add this login as account/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Add account' }).isDisabled();
      assert.equal(await dialog.getByRole('button', { name: 'Add account' }).isDisabled(), true, 'alias is required');
      await dialog.getByLabel('Account name').fill('Found');
      await dialog.getByRole('button', { name: 'Add account' }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.locator('[data-testid=banner-unmanaged]').waitFor({ state: 'detached' });
      assert.equal(await page.locator('[data-testid=codex-account]').count(), 4);
      await page.close();
    }

    // 5. API-key mode, unsupported store, external change, vault failure.
    {
      let page = await open('api_key');
      assert.equal(await featured(page, 'secondary').getByRole('button', { name: 'Switch to Home' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: /Toggle A/ }).isDisabled(), true);
      await page.locator('[data-testid=banner-api-key]').waitFor();
      await page.close();
      page = await open('keyring,external,recovery,file_permissions');
      assert.equal(await featured(page, 'secondary').getByRole('button', { name: 'Switch to Home' }).isDisabled(), true);
      assert.match(await page.locator('[data-testid=banner-store]').innerText(), /keyring/);
      assert.match(await page.locator('[data-testid=banner-external]').innerText(), /changed from "Work" to "None"/);
      await page.locator('[data-testid=banner-external]').getByRole('button', { name: 'OK' }).click();
      await page.locator('[data-testid=banner-external]').waitFor({ state: 'detached' });
      await page.locator('[data-testid=banner-recovery]').waitFor();
      assert.equal(await page.locator('[data-testid=protection-note]').getAttribute('data-protection'), 'file-permissions');
      assert.match(await page.locator('[data-testid=protection-note]').innerText(), /file permissions only/);
      await page.close();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`${base}/?mock=running&mockCodex=vault_error`);
      await page.locator('.nav-section button').filter({ hasText: 'Codex Accounts' }).click();
      await page.locator('[data-testid=reset-vault]').click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Reset' }).click();
      await page.locator('[data-testid=codex-account]').first().waitFor();
      await page.close();
    }

    // 6. Row actions: rename, pin/unpin, details, remove (confirmation wording).
    {
      const page = await open();
      await card(page, 'Reserve').getByRole('button', { name: /Rename Reserve/ }).click();
      const input = page.locator('[data-account-key=cx_mock_reserve]').getByLabel('Account name');
      await input.fill('Spare');
      await input.press('Enter');
      await card(page, 'Spare').waitFor();
      await card(page, 'Spare').getByRole('button', { name: 'Pin as Primary' }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid=featured-card][data-slot=primary]')?.getAttribute('data-account-key') === 'cx_mock_reserve');
      // Pinning the secondary as primary swaps the pair; the pins stay distinct.
      assert.equal(await featured(page, 'secondary').getAttribute('data-account-key'), 'cx_mock_home');
      await card(page, 'Home').getByRole('button', { name: 'Pin as Primary' }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid=featured-card][data-slot=secondary]')?.getAttribute('data-account-key') === 'cx_mock_reserve');
      await card(page, 'Home').getByRole('button', { name: 'Unpin' }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid=featured-card][data-slot=primary]')?.hasAttribute('data-empty'));
      assert.match(await page.locator('[data-testid=pair-hint]').innerText(), /Pin two accounts/);
      await card(page, 'Work').getByRole('button', { name: 'Details' }).click();
      const details = page.getByTestId('details-dialog');
      assert.match(await details.innerText(), /acct…0001/);
      assert.ok(!/access_token|refresh_token|id_token|eyJ/i.test(await details.innerText()));
      await page.keyboard.press('Escape');
      await details.waitFor({ state: 'detached' });
      await card(page, 'Spare').getByRole('button', { name: 'Remove' }).click();
      const dialog = page.getByRole('alertdialog');
      const wording = await dialog.innerText();
      assert.match(wording, /only removes this app's saved copy/);
      assert.match(wording, /does not delete the CLIProxyAPI credential file or any Codex data/i);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      assert.equal(await page.locator('[data-testid=codex-account]').count(), 3, 'cancel keeps the account');
      await card(page, 'Spare').getByRole('button', { name: 'Remove' }).click();
      await dialog.getByRole('button', { name: 'Remove' }).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=codex-account]').length === 2);
      await page.close();
    }

    // 7. Settings: validation errors keep the stored value; hotkey recording.
    {
      const page = await open();
      await page.getByTestId('settings-toggle').click();
      const hotkey = page.getByTestId('setting-hotkey');
      await hotkey.fill('Ctrl+F9');
      await page.getByTestId('settings-save').click();
      assert.match(await page.getByTestId('settings-error').innerText(), /at least two modifier keys/);
      assert.equal(await hotkey.inputValue(), '', 'previous (disabled) value is kept after a rejected save');
      await page.getByRole('button', { name: 'Record' }).click();
      await page.keyboard.press('Control+Alt+F9');
      assert.equal(await hotkey.inputValue(), 'Ctrl+Alt+F9');
      await page.getByTestId('settings-save').click();
      await page.waitForFunction(() => !document.querySelector('[data-testid=settings-error]'));
      await page.getByTestId('setting-minutes').fill('0');
      await page.getByTestId('settings-save').click();
      assert.match(await page.getByTestId('settings-error').innerText(), /1 to 1440/);
      assert.match(await page.getByTestId('compat-readout').innerText(), /file · supported/);
      assert.match(await page.getByTestId('compat-readout').innerText(), /Unverified/);
      await page.close();
    }

    // 8. Proxy routing pool: global warning, confirmation, exact restore.
    {
      const page = await open();
      await page.getByTestId('pool-toggle').click();
      assert.match(await page.getByTestId('pool-global-banner').innerText(), /Affects every client using the local CLIProxyAPI proxy/);
      const rows = () => page.getByTestId('pool-table').locator('tbody tr');
      const stateOf = async name => (await rows().filter({ hasText: name }).innerText()).replace(/\s+/g, ' ');
      assert.match(await stateOf('codex-unknown-quota.json'), /Enabled/);
      await page.getByTestId('pool-mode-only-ab').check();
      await page.getByTestId('pool-apply').click();
      const dialog = page.getByRole('alertdialog');
      assert.match(await dialog.innerText(), /Affects every client/);
      assert.match(await dialog.innerText(), /codex-unknown-quota\.json/);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      assert.match(await stateOf('codex-unknown-quota.json'), /Enabled/, 'cancel changes nothing');
      await page.getByTestId('pool-apply').click();
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await page.waitForFunction(() => /Disabled/.test([...document.querySelectorAll('[data-testid=pool-table] tbody tr')].find(row => row.textContent.includes('codex-unknown-quota.json'))?.textContent || ''));
      assert.match(await stateOf('codex-unknown-quota.json'), /Disabled.*Changed by this feature/);
      assert.match(await stateOf('codex-personal.json'), /Enabled/);
      assert.doesNotMatch(await stateOf('codex-disabled.json'), /Changed by this feature/, 'credentials already disabled by the user are not touched');
      const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('easy-cli-proxy-api.codex-routing-pool.v1')));
      assert.equal(stored.mode, 'only-ab');
      assert.ok(!('codex-disabled.json' in stored.changes) && 'codex-unknown-quota.json' in stored.changes);
      await page.getByTestId('pool-mode-all').check();
      await page.getByTestId('pool-apply').click();
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await page.waitForFunction(() => /Enabled/.test([...document.querySelectorAll('[data-testid=pool-table] tbody tr')].find(row => row.textContent.includes('codex-unknown-quota.json'))?.textContent || ''));
      assert.match(await stateOf('codex-disabled.json'), /Disabled/, 'still disabled: it was never changed by this feature');
      assert.equal(await page.evaluate(() => localStorage.getItem('easy-cli-proxy-api.codex-routing-pool.v1')), null);
      // Prefer B raises only B's priority.
      await page.getByTestId('pool-mode-prefer-b').check();
      await page.getByTestId('pool-apply').click();
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await page.waitForFunction(() => /\b2\b/.test([...document.querySelectorAll('[data-testid=pool-table] tbody tr')].find(row => row.textContent.includes('codex-idle.json'))?.textContent || ''));
      await page.close();
    }

    // 9. Keyboard order and accessible names.
    {
      const page = await open();
      await page.getByTestId('refresh-all').focus();
      const order = [];
      for (let step = 0; step < 6; step++) {
        await page.keyboard.press('Tab');
        order.push(await page.evaluate(() => {
          const el = document.activeElement;
          return { text: (el.getAttribute('aria-label') || el.textContent || '').trim(), top: el.getBoundingClientRect().top + window.scrollY };
        }));
      }
      assert.match(order[0].text, /Toggle A/, 'Tab moves from Refresh to the quick-switch controls');
      assert.match(order.map(item => item.text).join('|'), /Switch to Work\|Switch to Home/, 'featured switch buttons are reachable in order');
      const unnamed = await page.evaluate(() => [...document.querySelectorAll('[data-testid=codex-accounts-page] button, [data-testid=codex-accounts-page] input')]
        .filter(el => !(el.getAttribute('aria-label') || el.textContent.trim() || el.labels?.length || el.getAttribute('aria-labelledby'))).length);
      assert.equal(unnamed, 0, 'every control has an accessible name');
      const bars = await page.locator('[role=progressbar]').evaluateAll(list => list.every(bar => bar.hasAttribute('aria-valuemin') && bar.hasAttribute('aria-valuemax') && bar.getAttribute('aria-label')));
      assert.ok(bars, 'progress bars expose their range and a label');
      // A dialog traps focus.
      await card(page, 'Work').getByRole('button', { name: 'Details' }).click();
      for (let step = 0; step < 6; step++) await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[data-testid=details-dialog]'))), true);
      await page.keyboard.press('Escape');
      await page.close();
    }

    // 10. Narrow viewports never scroll horizontally.
    for (const width of [640, 520]) {
      const page = await open('running,external,keyring', { width, height: 900 });
      await page.getByTestId('settings-toggle').click();
      await page.getByTestId('pool-toggle').click();
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - window.innerWidth,
        body: document.body.scrollWidth - window.innerWidth,
        content: (document.querySelector('.content')?.scrollWidth ?? 0) - (document.querySelector('.content')?.clientWidth ?? 0),
        page2: (document.querySelector('[data-testid=codex-accounts-page]')?.scrollWidth ?? 0) - (document.querySelector('[data-testid=codex-accounts-page]')?.clientWidth ?? 0),
      }));
      assert.ok(overflow.page <= 0 && overflow.body <= 0 && overflow.content <= 1 && overflow.page2 <= 1, `no horizontal scroll at ${width}px: ${JSON.stringify(overflow)}`);
      await page.close();
    }

    // 11. Localised in every language.
    for (const [locale, title] of [['zh-CN', 'Codex 账号'], ['zh-TW', 'Codex 帳號'], ['ja', 'Codex アカウント']]) {
      const page = await open('', { width: 1200, height: 900 }, locale);
      assert.equal(await page.locator('.cxa-title h1').innerText(), title);
      await page.close();
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: Codex Accounts page - states, quick switch, switch results, blocked flows, row actions, settings, routing pool, keyboard, narrow layout and localisation.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
