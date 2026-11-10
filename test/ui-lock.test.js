'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('locking the admin page cannot be undone by a delayed authenticated response', async () => {
    const nodes = new Map();
    const document = { getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { value: '', hidden: id === 'dashboard', textContent: '', listeners: {},
            addEventListener(event, fn) { this.listeners[event] = fn; }, removeAttribute() {}, replaceChildren() {} });
        return nodes.get(id);
    } };
    let release;
    const context = vm.createContext({ document, window: { addEventListener() {} },
        fetch: () => new Promise(resolve => { release = resolve; }),
        URL: { revokeObjectURL() {}, createObjectURL() { return 'blob:mock'; } },
        AbortSignal, setTimeout() { return 1; }, clearTimeout() {} });
    vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
    document.getElementById('token').value = 'operator-token';
    nodes.get('auth').listeners.submit({ preventDefault() {} });
    assert(release);
    nodes.get('logout').listeners.click();
    release({ status: 200, ok: true, json: async () => ({ connection: 'ready', allowedGroups: [], pending: [], activeSummaries: 0 }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.get('dashboard').hidden, true);
    assert.equal(nodes.get('queues').textContent, '');
    assert.equal(vm.runInContext('token', context), '');
});
