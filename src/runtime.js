'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenAI } = require('@google/genai');
const { Store } = require('./store');
const { Bot } = require('./bot');
const { Session } = require('./session');
const { createSummarizer } = require('./summary');
const { createServer } = require('./server');
const log = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
async function start(config) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const store = new Store(path.join(config.dataDir, 'messages.sqlite'), config);
    store.prune();
    let bot, server, session, closing = false;
    const intervals = [];
    const shutdown = async (exitCode = 0) => {
        if (closing) return; closing = true;
        log('shutdown_started');
        intervals.forEach(clearInterval);
        if (bot) bot.stopping = true;
        const forceExit = setTimeout(() => process.exit(exitCode || 1), 25000);
        forceExit.unref();
        // Interrupt sends/generation safely; unfinished jobs stay on disk for explicit operator retry.
        if (session) await session.stop();
        if (bot) await Promise.race([bot.stop(), new Promise(resolve => setTimeout(resolve, 1000))]);
        if (server) { server.close(); server.closeAllConnections(); }
        // Active promises must not write into a closed database during graceful termination.
        if (!bot?.active.size) store.close();
        process.exit(exitCode);
    };
    const ai = new GoogleGenAI({ apiKey: config.apiKey });
    session = new Session({
        config, log, fatal: () => { void shutdown(1); }, onMessage: (message, ownId) => bot.handle(message, ownId),
        factory: () => new Client({
            authStrategy: new LocalAuth({ dataPath: path.join(config.dataDir, 'auth') }),
            webVersionCache: { type: 'local', path: path.join(config.dataDir, 'webcache') },
            puppeteer: { executablePath: config.executablePath, headless: true,
                args: ['--disable-dev-shm-usage', ...(config.noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])] },
        }),
    });
    bot = new Bot({ store, config, summarize: createSummarizer(ai, config), send: (groupId, text) => session.send(groupId, text), log });
    server = createServer({ config, session, store, bot, log });
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject); server.listen(config.port, config.host, resolve);
        });
    } catch (error) { store.close(); throw error; }
    server.on('error', () => { log('http_server_failed'); void shutdown(1); });
    log('admin_server_started', { port: config.port, enabledGroups: config.groups.size });
    if (!config.groups.size) log('setup_required', { hint: 'Pair in the protected dashboard, then configure ALLOWED_GROUP_IDS. No chats are being recorded.' });
    intervals.push(setInterval(() => { void session.check(); }, 30000));
    intervals.push(setInterval(() => { try { store.prune(); } catch { log('storage_maintenance_failed'); void shutdown(1); } }, 3600000));
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
    process.once('uncaughtException', () => { log('uncaught_exception'); void shutdown(1); });
    process.once('unhandledRejection', () => { log('unhandled_rejection'); void shutdown(1); });
    void session.connect();
    return { bot, store, server, session };
}
module.exports = { start };
