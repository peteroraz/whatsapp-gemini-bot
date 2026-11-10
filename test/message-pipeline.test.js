'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Message } = require('whatsapp-web.js');
const { Bot, normalizeMessage } = require('../src/bot');
const { Session } = require('../src/session');
const { Store } = require('../src/store');
const { createSummarizer } = require('../src/summary');
const group = '111@g.us', other = '222@g.us', own = '456@c.us';
const sender = { user: '123', server: 'lid' };
function wireMessage(body, id, { fromMe = false, chat = group, participant = sender } = {}) {
    // Shape observed on the deployed WhatsApp Web: MsgKey has no _serialized.
    // Use the real library's Message adapter rather than a hand-made bot object.
    return new Message(null, { id: { fromMe, remote: chat, id, participant },
        from: fromMe ? { user: '456', server: 'c.us' } : { _serialized: chat },
        to: fromMe ? { user: chat.split('@')[0], server: 'g.us' } : { user: '456', server: 'c.us' },
        author: participant, body, type: 'chat', t: Math.floor(Date.now() / 1000) });
}
test('real Message objects without serialized MsgKeys normalize to stable, isolated identities', () => {
    const message = wireMessage('Text', 'A'.repeat(32));
    assert.equal(message.id._serialized, undefined);
    assert.equal(message.author, undefined); // The raw Wid also needs normalization.
    const first = normalizeMessage(message, own);
    assert.equal(first.groupId, group); assert.equal(first.author, '123@lid');
    assert.match(first.id, /^wa:[a-f0-9]{64}$/);
    assert.equal(normalizeMessage(wireMessage('Text', 'A'.repeat(32)), own).id, first.id);
    assert.notEqual(normalizeMessage(wireMessage('Text', 'A'.repeat(32), { chat: other }), own).id, first.id);
    assert.notEqual(normalizeMessage(wireMessage('Text', 'A'.repeat(32), { participant: { user: '789', server: 'lid' } }), own).id, first.id);
    const legacy = normalizeMessage({ ...message, id: { _serialized: 'legacy-message' } }, own);
    assert.equal(legacy.id, 'legacy-message');
});
test('real message shape flows through session events, SQLite, structured Gemini and acknowledged delivery', async t => {
    const store = new Store(':memory:'); t.after(() => store.close());
    const calls = [], sent = [], pending = [], logs = [];
    const config = { groups: new Set([group]), senders: new Set(), recordOwnMessages: true,
        allowMemberCommands: false, maxMessages: 200, maxInputChars: 60000, maxMessageChars: 4000,
        cooldownMs: 1000, maxConcurrent: 2, timeoutMs: 5000, model: 'test-model', reconnectMax: 2 };
    const ai = { models: { generateContent: async request => {
        calls.push(request); const rows = JSON.parse(request.contents);
        return { candidates: [{ finishReason: 'STOP' }], text: JSON.stringify({ items: [
            { category: 'event', text: 'Test meeting on Friday at 4pm.', sources: [{ ref: rows[0].ref, quote: rows[0].body }] },
        ] }) };
    } } };
    let bot;
    const client = new EventEmitter();
    client.pupPage = { evaluate: async () => {} };
    client.info = { wid: { _serialized: own } }; client.initialize = async () => {};
    client.destroy = async () => {}; client.getState = async () => 'CONNECTED';
    client.sendMessage = async (to, text, options) => {
        assert.equal(options.waitUntilMsgSent, true);
        sent.push({ to, text }); return wireMessage(text, `out-${sent.length}`, { fromMe: true });
    };
    const session = new Session({ config, log: (event, fields) => logs.push({ event, ...fields }), fatal() {},
        factory: () => client, onMessage: (message, ownId) => {
            const task = bot.handle(message, ownId); pending.push(task); return task;
        } });
    t.after(() => session.stop());
    bot = new Bot({ config, store, summarize: createSummarizer(ai, config),
        send: (to, text) => session.send(to, text), log: (event, fields) => logs.push({ event, ...fields }) });
    await session.connect(); client.emit('ready');
    client.emit('message_create', wireMessage('Test meeting on Friday at 4pm.', 'A'.repeat(32)));
    client.emit('message_create', wireMessage('Private excluded group text', 'B'.repeat(32), { chat: other }));
    await Promise.all(pending.splice(0)); assert.equal(store.count(group), 1); assert.equal(store.count(other), 0);
    const command = wireMessage('!summarize', 'C'.repeat(32), { fromMe: true });
    client.emit('message_create', command); await Promise.all(pending.splice(0));
    assert.equal(calls.length, 1); assert.equal(sent.length, 2);
    assert(sent.every(row => row.to === group)); assert.match(sent[1].text, /Test meeting on Friday/);
    assert.equal(store.count(group), 0); assert.equal(store.getJob(group), null);
    client.emit('message_create', command); await Promise.all(pending.splice(0));
    assert.equal(calls.length, 1); assert.equal(sent.length, 2);
    const metrics = bot.diagnostics()[0];
    assert.equal(metrics.stored, 1); assert.equal(metrics.commands, 1); assert.equal(metrics.duplicates, 1);
    assert.equal(metrics.stage, 'complete'); assert(metrics.lastSummaryAt);
    assert(logs.some(row => row.event === 'command_received'));
    assert(logs.some(row => row.event === 'summary_complete'));
    assert(!JSON.stringify(logs).includes('Private excluded group text'));
});
test('malformed allowed-group messages are visible in diagnostics without logging their content', async t => {
    const store = new Store(':memory:'); t.after(() => store.close()); const logs = [];
    const bot = new Bot({ store, config: { groups: new Set([group]), senders: new Set() },
        log: (event, fields) => logs.push({ event, ...fields }) });
    await bot.handle({ from: group, author: '123@lid', body: 'PRIVATE CONTENT', id: {} });
    assert.equal(store.count(group), 0);
    assert.equal(bot.diagnostics()[0].rejected, 1);
    assert.equal(bot.diagnostics()[0].lastError, 'missing_message_id');
    assert(!JSON.stringify(logs).includes('PRIVATE CONTENT'));
});
