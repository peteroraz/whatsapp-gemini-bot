'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSummarizer, validate, format, splitText, BOT_PREFIX } = require('../src/summary');
const messages = [{ id: 'real', ref: 'm1', author: '123@lid', timestamp: '2026-11-09T12:00:00.000Z', body: 'Please send the report by Friday.', kind: 'text' }];
const good = { items: [{ category: 'action', text: 'Send the report by Friday.', sources: [{ ref: 'm1', quote: 'send the report by Friday' }] }] };
test('accepts supported source quotes and rejects fabricated evidence', () => {
    assert.deepEqual(validate(JSON.stringify(good), messages), good);
    assert.throws(() => validate(JSON.stringify({ items: [{ ...good.items[0], sources: [{ ref: 'm2', quote: 'invented' }] }] }), messages));
    assert.throws(() => validate(JSON.stringify({ items: [{ ...good.items[0], sources: [{ ref: 'm1', quote: 'Pay someone today' }] }] }), messages));
    for (const value of ['', 'undefined', 'null', '{}', '{"items":null}']) assert.throws(() => validate(value, messages));
});
test('media captions cannot be used as approval evidence', () => {
    assert.throws(() => validate(JSON.stringify(good), [{ ...messages[0], kind: 'media' }]));
});
test('digest hides technical identifiers, uses local dates and discloses coverage limits', () => {
    const job = { id: 'abcdefgh1234', snapshot: { messages: [...messages, { ...messages[0], ref: 'm2', kind: 'media', truncated: true }], omitted: 3 } };
    const text = format(good, job).join('\n');
    for (const expected of ['9 Nov 2026', '1:00 pm WAT', '*Action items*', '3 older messages', 'not interpreted', 'shortened']) assert(text.includes(expected));
    for (const hidden of ['123@lid', 'abcdefgh', '[m1]', 'T12:00:00', 'Scope:', 'Source:']) assert(!text.includes(hidden));
    assert(text.startsWith(BOT_PREFIX));
});
test('optional source quotes stay readable without sender addresses or internal refs', () => {
    const data = { items: [{ category: 'approval', text: '123@lid approved the budget.', sources: [{ ref: 'm1', quote: '123@lid approved the budget.' }] }] };
    const text = format(data, { id: 'internal-job-id', snapshot: { messages, omitted: 0 } }, { includeSources: true }).join('\n');
    assert(text.includes('Source: “a group member approved the budget.”'));
    assert(text.includes('*Approvals mentioned*')); assert(text.includes('Confirm approval mentions'));
    for (const hidden of ['123@lid', 'internal-job-id', '[m1]']) assert(!text.includes(hidden));
});
test('digest dates honor the configured timezone including midnight and multi-day ranges', () => {
    const job = { id: 'hidden', snapshot: { messages: [{ ...messages[0], timestamp: '2026-11-10T23:30:00Z' }], omitted: 0 } };
    const local = format({ items: [] }, job).join('\n');
    assert(local.includes('11 Nov 2026')); assert(local.includes('12:30 am WAT'));
    const utc = format({ items: [] }, job, { timeZone: 'UTC' }).join('\n');
    assert(utc.includes('10 Nov 2026')); assert(utc.includes('11:30 pm'));
    job.snapshot.messages.push({ ...messages[0], timestamp: '2026-11-12T00:00:00Z' });
    const range = format({ items: [] }, job).join('\n');
    assert(range.includes('11 Nov 2026')); assert(range.includes('12 Nov 2026'));
});
test('long digests have readable part numbers and no job IDs', () => {
    const job = { id: 'private-job-123', snapshot: { messages, omitted: 0 } };
    const parts = format({ items: Array.from({ length: 12 }, () => ({ ...good.items[0], text: 'Meeting details '.repeat(50) })) }, job);
    assert(parts.length > 1);
    assert(parts[0].includes(`_Part 1 of ${parts.length}_`));
    assert(parts.at(-1).includes(`_Part ${parts.length} of ${parts.length}_`));
    assert(parts.every(part => !part.includes(job.id) && Array.from(part).length <= 2900));
});
test('splits long unicode output without destroying surrogate pairs', () => {
    const source = ('😀 hello\n').repeat(2000);
    const parts = splitText(source);
    assert.equal(parts.join(''), source); assert(parts.length > 1);
    assert(parts.every(part => Array.from(part).length <= 3000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part)));
});
test('SDK receives isolated structured input, timeout and disabled automatic retries', async () => {
    let request;
    const summarize = createSummarizer({ models: { generateContent: async args => { request = args; return { text: JSON.stringify(good), candidates: [{ finishReason: 'STOP' }] }; } } }, { model: 'configured-model', timeoutMs: 5000 });
    assert.deepEqual(await summarize(messages), good);
    assert.equal(request.model, 'configured-model'); assert.equal(request.contents, JSON.stringify(messages));
    assert.equal(request.config.httpOptions.retryOptions.attempts, 1); assert(request.config.abortSignal);
    assert(request.config.systemInstruction.includes('untrusted'));
});
test('only transient provider status codes receive one bounded retry', async () => {
    let calls = 0, waits = 0;
    const summarize = createSummarizer({ models: { generateContent: async () => { calls++; if (calls === 1) throw { status: 429 }; return { text: '{"items":[]}' }; } } }, { model: 'test', timeoutMs: 5000 }, { wait: async () => { waits++; } });
    await summarize(messages); assert.equal(calls, 2); assert.equal(waits, 1);
    for (const status of [400, 401, 403, 404]) {
        let attempts = 0;
        const fail = createSummarizer({ models: { generateContent: async () => { attempts++; throw { status }; } } }, { model: 'test', timeoutMs: 5000 });
        await assert.rejects(fail(messages)); assert.equal(attempts, 1);
    }
});
test('truncated, blocked or empty AI responses cannot consume messages', async () => {
    for (const response of [{ text: '' }, { text: JSON.stringify(good), candidates: [{ finishReason: 'MAX_TOKENS' }] }, { text: undefined, promptFeedback: { blockReason: 'SAFETY' } }]) {
        const summarize = createSummarizer({ models: { generateContent: async () => response } }, { model: 'test', timeoutMs: 5000 });
        await assert.rejects(summarize(messages));
    }
});
test('installed Gemini SDK serializes the schema and honors the custom HTTP transport', async () => {
    const { GoogleGenAI } = require('@google/genai');
    let captured;
    const ai = new GoogleGenAI({ apiKey: 'mock', httpOptions: { fetch: async (url, options) => {
        captured = { url: String(url), body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(good) }] }, finishReason: 'STOP' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } });
    } } });
    const summarize = createSummarizer(ai, { model: 'mock-model', timeoutMs: 5000 });
    assert.deepEqual(await summarize(messages), good);
    assert(captured.url.includes('mock-model:generateContent'));
    assert(captured.body.generationConfig.responseJsonSchema);
    const schemaText = JSON.stringify(captured.body.generationConfig.responseJsonSchema);
    assert(!schemaText.includes('minItems')); assert(!schemaText.includes('maxItems'));
    for (const option of ['temperature', 'topP', 'topK']) assert.equal(captured.body.generationConfig[option], undefined);
    assert(captured.body.systemInstruction.parts[0].text.includes('untrusted'));
});
test('application validation enforces array bounds outside the provider schema', () => {
    assert.throws(() => validate(JSON.stringify({ items: Array(31).fill(good.items[0]) }), messages));
    for (const sources of [[], Array(4).fill(good.items[0].sources[0])]) {
        assert.throws(() => validate(JSON.stringify({ items: [{ ...good.items[0], sources }] }), messages));
    }
});
