'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Bot } = require('../src/bot');
const { BOT_PREFIX } = require('../src/summary');
const A = '111@g.us', B = '222@g.us', operator = '123@lid';
function harness(t, overrides = {}) {
    let clock = Date.now(), sequence = 0;
    const store = new Store(':memory:', { now: () => clock });
    t.after(() => store.close());
    const sent = [], calls = [];
    const config = { groups: new Set([A, B]), senders: new Set([operator]), recordOwnMessages: true,
        allowMemberCommands: false, maxMessages: 200, maxInputChars: 60000, maxMessageChars: 4000, cooldownMs: 1000, maxConcurrent: 2, ...overrides };
    const bot = new Bot({ store, config, now: () => clock,
        summarize: async messages => { calls.push(messages); return { items: [] }; },
        send: async (to, text) => { sent.push({ to, text }); } });
    return { store, config, bot, sent, calls, advance: () => { clock += 11000; },
        message: (from, body, extra = {}) => ({ from, body, author: operator, type: 'chat', timestamp: Math.floor(clock / 1000), id: { _serialized: `msg-${++sequence}` }, ...extra }),
    };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('isolates group prompts and leaves other group messages intact', async t => {
    const h = harness(t);
    await h.bot.handle(h.message(A, 'Secret payment discussion in A'));
    await h.bot.handle(h.message(B, 'Public event in B'));
    await h.bot.handle(h.message(B, '!summarize'));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].map(m => m.body), ['Public event in B']);
    assert(h.sent.every(message => message.to === B));
    assert.equal(h.store.count(A), 1); assert.equal(h.store.count(B), 0);
});
test('new messages survive generation of an earlier snapshot', async t => {
    const h = harness(t); let finish;
    h.bot.summarize = () => new Promise(resolve => { finish = resolve; });
    await h.bot.handle(h.message(A, 'Before'));
    const running = h.bot.handle(h.message(A, '!summarize')); await turn();
    await h.bot.handle(h.message(A, 'During generation'));
    finish({ items: [] }); await running;
    assert.equal(h.store.count(A), 1);
    assert.equal(h.store.beginJob(A, 200, 60000).snapshot.messages[0].body, 'During generation');
});
test('same-group requests cannot overlap and total concurrency is bounded', async t => {
    const h = harness(t, { maxConcurrent: 1 }); let finish, count = 0;
    h.bot.summarize = () => { count++; return new Promise(resolve => { finish = resolve; }); };
    await h.bot.handle(h.message(A, 'Before')); await h.bot.handle(h.message(B, 'Other'));
    const running = h.bot.handle(h.message(A, '!summarize')); await turn();
    await h.bot.handle(h.message(A, '!summarize')); await h.bot.handle(h.message(B, '!summarize'));
    assert.equal(count, 1); finish({ items: [] }); await running;
    assert.equal(h.store.count(B), 1);
});
test('no AI call for an empty queue, private chat, or disabled group', async t => {
    const h = harness(t);
    await h.bot.handle(h.message(A, '!summarize'));
    await h.bot.handle(h.message('123@c.us', '!summarize'));
    await h.bot.handle(h.message('999@g.us', 'Do not capture me'));
    assert.equal(h.calls.length, 0); assert.equal(h.store.count('999@g.us'), 0);
});
test('commands normalize spaces/case, enforce operators, and are not recorded', async t => {
    const h = harness(t);
    await h.bot.handle(h.message(A, 'Record me'));
    await h.bot.handle(h.message(A, '!summarize', { author: '999@lid' }));
    assert.equal(h.calls.length, 0);
    await h.bot.handle(h.message(A, '  !SUMMARIZE  '));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].length, 1);
});
test('linked-account commands work and bot output cannot feed back', async t => {
    const h = harness(t, { recordOwnMessages: false });
    await h.bot.handle(h.message(A, 'Incoming'));
    await h.bot.handle(h.message('self@c.us', BOT_PREFIX + 'ignore', { fromMe: true, to: A }));
    await h.bot.handle(h.message('self@c.us', '!summarize', { fromMe: true, to: A }), 'self@c.us');
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].length, 1);
});
test('deduplicates message replay even after successful summary', async t => {
    const h = harness(t), message = h.message(A, 'Only once');
    await h.bot.handle(message); await h.bot.handle(message);
    assert.equal(h.store.count(A), 1);
    await h.bot.handle(h.message(A, '!summarize'));
    await h.bot.handle(message); assert.equal(h.store.count(A), 0);
});
test('AI failures preserve snapshot and respect cooldown', async t => {
    const h = harness(t);
    h.bot.summarize = async () => { throw new Error('Provider error containing private data'); };
    await h.bot.handle(h.message(A, 'Keep this'));
    await h.bot.handle(h.message(A, '!summarize'));
    assert.equal(h.store.count(A), 1); assert(h.store.getJob(A));
    h.bot.summarize = async () => { h.calls.push('retry'); return { items: [] }; };
    await h.bot.handle(h.message(A, '!summarize')); assert.equal(h.calls.length, 0);
    h.advance(); await h.bot.handle(h.message(A, '!summarize'));
    assert.equal(h.store.count(A), 0); assert.equal(h.calls.length, 1);
    assert(!JSON.stringify(h.sent).includes('private data'));
});
test('failed output resumes from persisted chunk without recharging Gemini', async t => {
    const h = harness(t); let fail = true;
    h.bot.send = async (to, text) => {
        if (text.includes('Scope:') && fail) throw new Error('Transport failure');
        h.sent.push({ to, text });
    };
    await h.bot.handle(h.message(A, 'Keep until delivered'));
    await h.bot.handle(h.message(A, '!summarize'));
    assert.equal(h.calls.length, 1); assert(h.store.getJob(A).chunks);
    assert.equal(h.store.count(A), 1);
    fail = false; h.advance(); await h.bot.handle(h.message(A, '!summarize'));
    assert.equal(h.calls.length, 1); assert.equal(h.store.count(A), 0);
});
test('a batch processes oldest messages and preserves the remaining backlog', async t => {
    const h = harness(t, { maxMessages: 2 });
    for (let i = 0; i < 5; i++) { await h.bot.handle(h.message(A, `Message ${i}`)); h.advance(); }
    await h.bot.handle(h.message(A, '!summarize'));
    assert.deepEqual(h.calls[0].map(m => m.body), ['Message 0', 'Message 1']);
    assert.equal(h.store.count(A), 3);
});
test('restart preserves messages, snapshots and acknowledged multipart progress', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'db.sqlite'); let store = new Store(file);
    store.add({ id: 'one', groupId: A, author: operator, body: 'Persistent', sentAt: Date.now() });
    const job = store.beginJob(A, 200, 60000);
    store.saveChunks(A, ['part1', 'part2']); store.acknowledgeChunk(A, 1); store.close();
    store = new Store(file);
    assert.equal(store.count(A), 1); assert.equal(store.getJob(A).id, job.id); assert.equal(store.getJob(A).next_chunk, 1);
    assert.throws(() => store.complete(A), /incomplete/);
    store.acknowledgeChunk(A, 2); store.complete(A); assert.equal(store.count(A), 0); store.close();
});
test('retention and caps report omissions; active outbox survives pruning', t => {
    let now = Date.now();
    const store = new Store(':memory:', { maxPending: 2, retentionDays: 1, now: () => now }); t.after(() => store.close());
    for (let i = 0; i < 3; i++) { store.add({ id: String(i), groupId: A, author: operator, body: 'Keep', sentAt: now }); now++; }
    assert.equal(store.count(A), 2); assert.equal(store.status()[0].omitted, 1);
    store.beginJob(A, 200, 60000); now += 2 * 86400000; store.prune();
    assert.equal(store.count(A), 0); assert.equal(store.getJob(A).snapshot.messages.length, 2);
});
test('JSON-escaped large messages cannot block the FIFO queue', t => {
    const h = harness(t);
    h.store.add({ id: 'large', groupId: A, author: operator, body: '\u0001'.repeat(4000), sentAt: Date.now() });
    const job = h.store.beginJob(A, 200, 8000);
    assert(job); assert(job.snapshot.messages[0].truncated);
    assert(JSON.stringify(job.snapshot.messages).length <= 8000);
});
test('shutdown refuses new work and lets an active summary finish', async t => {
    const h = harness(t); let finish;
    h.bot.summarize = () => new Promise(resolve => { finish = resolve; });
    await h.bot.handle(h.message(A, 'Before'));
    const task = h.bot.handle(h.message(A, '!summarize')); await turn();
    const stopping = h.bot.stop();
    await h.bot.handle(h.message(A, 'Not accepted during shutdown'));
    finish({ items: [] }); await Promise.all([task, stopping]);
    assert.equal(h.store.count(A), 0);
});
test('FIFO preserves arrival order when timestamps match and IDs sort differently', t => {
    const h = harness(t);
    for (const id of ['z-first', 'a-second']) h.store.add({ id, groupId: A, author: operator, body: id, sentAt: Date.now() });
    assert.deepEqual(h.store.beginJob(A, 200, 60000).snapshot.messages.map(m => m.id), ['z-first', 'a-second']);
});
test('a media-only queue discloses unsupported coverage without an AI request', async t => {
    const h = harness(t);
    await h.bot.handle(h.message(A, '', { type: 'ptt', hasMedia: true }));
    await h.bot.handle(h.message(A, '!summarize'));
    assert.equal(h.calls.length, 0); assert(h.sent.some(m => m.text.includes('not interpreted')));
    assert.equal(h.store.count(A), 0);
});
