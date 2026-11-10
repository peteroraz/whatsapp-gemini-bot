'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness(fetcher) {
    const node = () => ({ value: '', hidden: false, disabled: false, textContent: '', children: [], listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; }, removeAttribute() {},
        replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } });
    const nodes = new Map();
    const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
    const copied = [];
    const context = vm.createContext({ document, window: { addEventListener() {} }, AbortSignal,
        navigator: { clipboard: { writeText: async text => { copied.push(text); } } }, fetch: fetcher,
        URL: { revokeObjectURL() {} }, setTimeout() {}, clearTimeout() {} });
    vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
    return { nodes, copied, context };
}
test('group loading shows progress, blocks duplicate clicks, renders groups and copies IDs', async () => {
    let release, calls = 0;
    const h = harness(() => { calls++; return new Promise(resolve => { release = resolve; }); });
    const pending = h.nodes.get('groups').listeners.click();
    assert.equal(h.nodes.get('groups').disabled, true);
    assert.match(h.nodes.get('group-status').textContent, /Loading/);
    await h.nodes.get('groups').listeners.click(); assert.equal(calls, 1);
    release({ ok: true, status: 200, json: async () => ({ groups: [{ id: '123@g.us', name: 'Test <group>' }] }) });
    await pending;
    assert.equal(h.nodes.get('groups').disabled, false);
    const li = h.nodes.get('group-list').children[0];
    assert.equal(li.children[0].textContent, 'Test <group>');
    await li.children[4].listeners.click(); assert.deepEqual(h.copied, ['123@g.us']);
});
test('group errors survive successful status polling; empty and timed-out requests explain recovery', async () => {
    let response = { ok: false, status: 503, json: async () => ({ error: 'group_list_timeout' }) };
    const h = harness(async () => response);
    await h.nodes.get('groups').listeners.click();
    assert.match(h.nodes.get('group-status').textContent, /took too long/);
    response = { ok: true, status: 200, json: async () => ({ connection: 'ready', allowedGroups: [], pending: [], activeSummaries: 0 }) };
    await vm.runInContext('refresh()', h.context);
    assert.match(h.nodes.get('group-status').textContent, /took too long/);
    response = { ok: true, status: 200, json: async () => ({ groups: [] }) };
    await h.nodes.get('groups').listeners.click();
    assert.match(h.nodes.get('group-status').textContent, /No groups/);
    const timed = harness(async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); });
    await timed.nodes.get('groups').listeners.click();
    assert.match(timed.nodes.get('group-status').textContent, /timed out/);
    assert.equal(timed.nodes.get('groups').disabled, false);
});
test('locking during group lookup prevents late group names from being displayed', async () => {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const request = h.nodes.get('groups').listeners.click();
    h.nodes.get('logout').listeners.click();
    release({ ok: true, status: 200, json: async () => ({ groups: [{ id: '123@g.us', name: 'Private group' }] }) });
    await request;
    assert.equal(h.nodes.get('group-list').children.length, 0);
    assert.equal(h.nodes.get('group-status').textContent, '');
});
test('connection instructions explain QR availability and block group lookup until ready', async () => {
    let connection = 'reconnecting';
    const h = harness(async () => ({ ok: true, status: 200, json: async () => ({ connection, allowedGroups: [], pending: [], activeSummaries: 0 }) }));
    await vm.runInContext('refresh()', h.context);
    assert(h.nodes.get('groups').disabled); assert.match(h.nodes.get('pairing-help').textContent, /restore/);
    connection = 'awaiting_qr'; await vm.runInContext('refresh()', h.context);
    assert.equal(h.nodes.get('reconnect').textContent, 'Refresh pairing QR');
    connection = 'ready'; await vm.runInContext('refresh()', h.context);
    assert.equal(h.nodes.get('groups').disabled, false); assert.match(h.nodes.get('pairing-help').textContent, /No QR is needed/);
});
