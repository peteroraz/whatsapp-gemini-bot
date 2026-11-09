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
test('format includes scope, source, caution and all coverage limitations', () => {
    const job = { id: 'abcdefgh1234', snapshot: { messages: [...messages, { ...messages[0], ref: 'm2', kind: 'media', truncated: true }], omitted: 3 } };
    const text = format(good, job).join('\n');
    for (const expected of ['123@lid', '2026-11-09', 'not payment authorisation', '3 older messages', 'not interpreted', 'shortened']) assert(text.includes(expected));
    assert(text.startsWith(BOT_PREFIX));
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
    assert(captured.body.systemInstruction.parts[0].text.includes('untrusted'));
});
