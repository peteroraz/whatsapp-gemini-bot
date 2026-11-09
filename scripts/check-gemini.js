'use strict';
const fs = require('node:fs');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { GoogleGenAI } = require('@google/genai');
const key = process.env.GEMINI_API_KEY;
if (!key) { console.error('Set GEMINI_API_KEY first.'); process.exit(1); }
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
new GoogleGenAI({ apiKey: key }).models.generateContent({ model, contents: 'Reply with OK.', config: {
    maxOutputTokens: 256, abortSignal: AbortSignal.timeout(30000), httpOptions: { timeout: 30000, retryOptions: { attempts: 1 } },
} }).then(response => {
    if (!response.text?.trim()) throw new Error('EMPTY_RESPONSE');
    console.log(`Gemini generation succeeded using ${model}.`);
}).catch(error => { console.error(`Gemini check failed (status ${Number(error.status) || 'unavailable'}). Check key, model access and quota.`); process.exitCode = 1; });
