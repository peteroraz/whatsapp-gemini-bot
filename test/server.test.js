'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { Store } = require('../src/store');
const { createServer } = require('../src/server');
test('configuration fails closed and validates secret, group and numeric settings', () => {
    const env = { GEMINI_API_KEY: 'test', ADMIN_TOKEN: 'x'.repeat(32) };
    assert.equal(loadConfig(env).groups.size, 0);
    for (const override of [{ ADMIN_TOKEN: 'short' }, { GEMINI_API_KEY: '' }, { ALLOWED_GROUP_IDS: '*' }, { RETENTION_DAYS: 'abc' }, { ALLOW_MEMBER_COMMANDS: 'yes' }]) assert.throws(() => loadConfig({ ...env, ...override }));
    assert.equal(loadConfig({ ...env, ALLOWED_GROUP_IDS: '123-456@g.us,789@g.us' }).groups.size, 2);
});
test('HTTP admin requires bearer token, hides QR and secrets, separates liveness and readiness', async t => {
    const config = loadConfig({ GEMINI_API_KEY: 'private-api-key', ADMIN_TOKEN: 'secret-admin-token'.repeat(3) });
    const store = new Store(':memory:');
    const session = { state: { connection: 'awaiting_qr', qr: 'sensitive-whatsapp-pairing-code', qrAt: Date.now() }, groups: async () => [{ id: '123@g.us', name: '<img src=x onerror=alert(1)>' }] };
    const bot = { active: new Map(), stopping: false };
    const server = createServer({ config, session, store, bot });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${config.adminToken}` };
    for (const route of ['/api/status', '/api/qr', '/api/groups']) {
        const response = await fetch(base + route); assert.equal(response.status, 401);
        assert(!JSON.stringify(await response.json()).includes(session.state.qr));
    }
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/readyz')).status, 503);
    const status = await fetch(base + '/api/status', { headers }); const text = await status.text();
    assert(!text.includes(config.apiKey)); assert(!text.includes(config.adminToken)); assert(!text.includes(session.state.qr));
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert(status.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    const qr = await fetch(base + '/api/qr', { headers }); assert.equal(qr.status, 200); assert((await qr.text()).includes('<svg'));
    session.state.qrAt -= 60001; assert.equal((await fetch(base + '/api/qr', { headers })).status, 404);
    session.state.connection = 'ready'; assert.equal((await fetch(base + '/readyz')).status, 200);
    assert.equal((await fetch(base + '/api/groups', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/status?token=' + config.adminToken)).status, 401);
    assert.equal((await fetch(base + '/api/status', { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(base + '/missing')).status, 404);
    bot.stopping = true; assert.equal((await fetch(base + '/healthz')).status, 503);
});
