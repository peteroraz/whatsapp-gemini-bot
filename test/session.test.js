'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Session, readGroupDirectory } = require('../src/session');
const vm = require('node:vm');
test('session handles QR, own-account message events, reconnect and shutdown', async () => {
    const clients = [], timers = [], messages = []; let fatal = false;
    const session = new Session({ config: { reconnectMax: 2, terminalQr: false }, log() {}, fatal: () => { fatal = true; },
        onMessage: async message => { messages.push(message); },
        schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel() {},
        factory: () => {
            const client = new EventEmitter(); client.initialize = async () => {};
            client.destroy = async () => { client.destroyed = true; }; client.getState = async () => 'CONNECTED';
            client.sendMessage = async () => 'sent'; clients.push(client); return client;
        } });
    await session.connect(); clients[0].emit('qr', 'private-qr'); assert.equal(session.state.connection, 'awaiting_qr');
    clients[0].emit('authenticated'); assert.equal(session.state.qr, null);
    clients[0].emit('ready'); assert.equal(session.state.connection, 'ready');
    clients[0].emit('message_create', { fromMe: true }); await Promise.resolve(); assert.equal(messages.length, 1);
    assert.equal(await session.send('123@g.us', 'hello'), 'sent'); await session.check();
    clients[0].emit('disconnected', 'reason'); assert.equal(session.state.connection, 'reconnecting'); assert.equal(timers.length, 1);
    clients[0].emit('disconnected', 'duplicate'); assert.equal(timers.length, 1);
    await timers[0].fn(); assert(clients[0].destroyed); assert.equal(clients.length, 2);
    clients[0].emit('qr', 'obsolete'); assert.equal(session.state.qr, null);
    clients[1].emit('ready'); assert.equal(session.attempts, 0);
    await session.stop(); assert(clients[1].destroyed); assert.equal(session.state.connection, 'stopping'); assert(!fatal);
});
test('group directory reads only group IDs/names without serializing chats or loading metadata', () => {
    const group = { id: { _serialized: '123@g.us' }, name: 'Team',
        serialize() { throw new Error('Do not serialize'); }, get groupMetadata() { throw new Error('Do not load metadata'); } };
    const chats = [group, { id: { _serialized: '456@c.us' }, name: 'Private contact' },
        { get id() { throw new Error('Broken chat'); } }, null, { id: { _serialized: '789-10@g.us' }, formattedTitle: 'Older group' }, group];
    const context = vm.createContext({ window: { require(name) {
        assert.equal(name, 'WAWebCollections'); return { Chat: { getModelsArray: () => chats } };
    } } });
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(`(${readGroupDirectory})()`, context))),
        [{ id: '123@g.us', name: 'Team' }, { id: '789-10@g.us', name: 'Older group' }]);
});
test('group lookup rejects results from a disconnected/replaced WhatsApp session', async () => {
    let release;
    const session = new Session({});
    session.state.connection = 'ready';
    session.client = { pupPage: { evaluate: () => new Promise(resolve => { release = resolve; }) } };
    const result = session.groups();
    session.client = {}; release([{ id: '123@g.us', name: 'Team' }]);
    await assert.rejects(result, /WHATSAPP_NOT_READY/);
});
test('initialization failure schedules bounded recovery without leaking error contents', async () => {
    let fn, fatal = false; const logs = [];
    const session = new Session({ config: { reconnectMax: 1 }, onMessage() {}, log: (...args) => logs.push(args), fatal: () => { fatal = true; },
        schedule: callback => { fn = callback; return 1; }, cancel() {}, factory: () => {
            const client = new EventEmitter(); client.initialize = async () => { throw new Error('secret credentials'); }; client.destroy = async () => {}; return client;
        } });
    await session.connect(); assert(fn); await fn(); assert(fatal);
    assert(!JSON.stringify(logs).includes('secret credentials')); await session.stop();
});
