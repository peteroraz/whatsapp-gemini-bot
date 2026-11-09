'use strict';
// Browser + operator UI integration check. Uses local stubs; no WhatsApp/Gemini requests.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Store } = require('../src/store');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');
async function main() {
    const puppeteer = createRequire(require.resolve('whatsapp-web.js'))('puppeteer');
    const store = new Store(':memory:');
    const config = loadConfig({ GEMINI_API_KEY: 'mock-key', ADMIN_TOKEN: 'mock-admin-token-'.repeat(3) });
    const session = { state: { connection: 'awaiting_qr', qr: 'mock-pairing-code', qrAt: Date.now() },
        groups: async () => [{ id: '123@g.us', name: '<img src=x onerror="window.injected=true">' }] };
    const server = createServer({ config, store, session, bot: { active: new Map(), stopping: false } });
    let browser;
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, headless: true,
            args: process.env.CHROMIUM_NO_SANDBOX === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [] });
        const page = await browser.newPage();
        const failures = []; page.on('pageerror', error => failures.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.type('#token', config.adminToken); await page.click('#auth button');
        await page.waitForSelector('#dashboard:not([hidden])');
        await page.waitForFunction(() => document.querySelector('#qr').naturalWidth > 0);
        assert((await page.$eval('#connection', element => element.textContent)).includes('awaiting qr'));
        session.state.connection = 'ready';
        await page.click('#groups'); await page.waitForSelector('#group-list li');
        assert((await page.$eval('#group-list', element => element.textContent)).includes('<img'));
        assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
        for (const width of [1280, 390]) {
            await page.setViewport({ width, height: 900 });
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        }
        await page.click('#logout');
        assert(await page.$eval('#dashboard', element => element.hidden));
        assert.equal(await page.$eval('#group-list', element => element.textContent), '');
        assert.deepEqual(failures, []);
        console.log('Browser launch, authenticated dashboard, QR rendering, group-name escaping, mobile layout and page locking passed.');
    } finally {
        if (browser) await browser.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
