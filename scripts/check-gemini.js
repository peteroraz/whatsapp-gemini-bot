'use strict';
const fs = require('node:fs');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { GoogleGenAI } = require('@google/genai');
const { createSummarizer } = require('../src/summary');
const key = process.env.GEMINI_API_KEY;
if (!key) { console.error('Set GEMINI_API_KEY first.'); process.exit(1); }
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const messages = [{ id: 'synthetic-check', ref: 'm1', author: 'Test user',
    timestamp: new Date().toISOString(), body: 'Test meeting Friday at 4pm. Peter will prepare the agenda by Thursday.', kind: 'text' }];
createSummarizer(new GoogleGenAI({ apiKey: key }), { model, timeoutMs: 30000 })(messages).then(data => {
    if (!data.items.length) throw new Error('EMPTY_EXTRACTION');
    console.log(`Gemini structured extraction and source validation succeeded using ${model} (${data.items.length} items).`);
}).catch(error => { console.error(`Gemini check failed (status ${Number(error.status) || 'unavailable'}). Check key, model access and quota.`); process.exitCode = 1; });
