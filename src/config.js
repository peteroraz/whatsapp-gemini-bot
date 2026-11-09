'use strict';
const path = require('node:path');
function integer(env, name, fallback, min, max) {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
}
function boolean(env, name, fallback) {
    if (env[name] === undefined || env[name] === '') return fallback;
    if (!['true', 'false'].includes(env[name])) throw new Error(`Invalid ${name}`);
    return env[name] === 'true';
}
function list(value) { return new Set((value || '').split(',').map(s => s.trim()).filter(Boolean)); }
function loadConfig(env = process.env) {
    if (!env.GEMINI_API_KEY?.trim()) throw new Error('GEMINI_API_KEY is required');
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters');
    const groups = list(env.ALLOWED_GROUP_IDS);
    if (groups.size > 100 || [...groups].some(id => !/^\d+(?:-\d+)?@g\.us$/.test(id))) throw new Error('Use at most 100 exact group IDs in ALLOWED_GROUP_IDS');
    const senders = list(env.ALLOWED_SENDER_IDS);
    if ([...senders].some(id => !/^\d+@(c\.us|lid)$/.test(id))) throw new Error('Use exact WhatsApp IDs in ALLOWED_SENDER_IDS');
    return {
        apiKey: env.GEMINI_API_KEY.trim(), adminToken: env.ADMIN_TOKEN,
        model: env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
        dataDir: path.resolve(env.DATA_DIR || './data'),
        port: integer(env, 'PORT', 3000, 1, 65535), host: env.HOST || '0.0.0.0', groups, senders,
        allowMemberCommands: boolean(env, 'ALLOW_MEMBER_COMMANDS', false),
        recordOwnMessages: boolean(env, 'RECORD_OWN_MESSAGES', true),
        terminalQr: boolean(env, 'QR_IN_TERMINAL', false),
        noSandbox: boolean(env, 'CHROMIUM_NO_SANDBOX', false),
        executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
        maxMessages: integer(env, 'MAX_SUMMARY_MESSAGES', 200, 1, 500),
        maxInputChars: integer(env, 'MAX_INPUT_CHARS', 60000, 8000, 200000),
        maxMessageChars: integer(env, 'MAX_MESSAGE_CHARS', 4000, 100, 6000),
        maxPending: integer(env, 'MAX_PENDING_PER_GROUP', 5000, 500, 20000),
        retentionDays: integer(env, 'RETENTION_DAYS', 7, 1, 90),
        cooldownMs: integer(env, 'SUMMARY_COOLDOWN_SECONDS', 60, 1, 3600) * 1000,
        timeoutMs: integer(env, 'AI_TIMEOUT_SECONDS', 90, 5, 180) * 1000,
        maxConcurrent: integer(env, 'MAX_CONCURRENT_SUMMARIES', 2, 1, 5),
        reconnectMax: integer(env, 'MAX_RECONNECT_ATTEMPTS', 10, 1, 50),
    };
}
module.exports = { loadConfig };
