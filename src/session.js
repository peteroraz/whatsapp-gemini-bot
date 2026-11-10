'use strict';
function deadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), ms); })])
        .finally(() => clearTimeout(timer));
}
// Run inside the linked WhatsApp browser. getChats() serializes every chat and
// refreshes group metadata/last messages; listing names and IDs needs none of it.
function readGroupDirectory() {
    const collection = window.require('WAWebCollections').Chat;
    if (typeof collection?.getModelsArray !== 'function') throw new Error('GROUP_DIRECTORY_UNAVAILABLE');
    const groups = new Map();
    for (const chat of collection.getModelsArray()) {
        try {
            const id = chat?.id?._serialized;
            if (typeof id !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(id)) continue;
            const name = chat.name || chat.formattedTitle;
            groups.set(id, { id, name: typeof name === 'string' && name.trim() ? name : 'Unnamed group' });
        } catch { /* A malformed chat must not hide all other groups. */ }
    }
    return [...groups.values()];
}
class Session {
    constructor({ factory, config, onMessage, log, fatal, schedule = setTimeout, cancel = clearTimeout }) {
        Object.assign(this, { factory, config, onMessage, log, fatal, schedule, cancel });
        this.state = { connection: 'starting', qr: null, qrAt: 0, readyAt: null };
        this.client = null; this.connecting = false; this.stopping = false; this.retryTimer = null; this.attempts = 0;
    }
    async connect() {
        if (this.stopping || this.connecting) return;
        this.connecting = true;
        try {
            const client = this.factory(); this.client = client;
            const current = () => this.client === client && !this.stopping;
            client.on('qr', qr => {
                if (!current()) return;
                Object.assign(this.state, { connection: 'awaiting_qr', qr, qrAt: Date.now() });
                this.log('qr_available');
                if (this.config.terminalQr) require('qrcode-terminal').generate(qr, { small: true });
            });
            client.on('authenticated', () => {
                if (current()) Object.assign(this.state, { connection: 'authenticated', qr: null, qrAt: 0 });
            });
            client.on('ready', () => {
                if (!current()) return;
                this.attempts = 0;
                Object.assign(this.state, { connection: 'ready', qr: null, qrAt: 0, readyAt: new Date().toISOString() });
                this.log('whatsapp_ready');
            });
            client.on('auth_failure', () => { if (current()) this.retry('authentication_failed'); });
            client.on('disconnected', () => { if (current()) this.retry('disconnected'); });
            client.on('message_create', message => {
                if (!current() || this.state.connection !== 'ready') return;
                Promise.resolve(this.onMessage(message, client.info?.wid?._serialized || 'self'))
                    .catch(() => this.log('message_handler_failed'));
            });
            // First pairing can take time. QR waiting is healthy; browser launch hangs are bounded.
            await deadline(client.initialize(), 300000);
        } catch {
            this.retry('initialization_failed');
        } finally { this.connecting = false; }
    }
    retry(reason) {
        if (this.stopping || this.retryTimer) return;
        Object.assign(this.state, { connection: 'reconnecting', qr: null, qrAt: 0 });
        this.attempts++;
        this.log(reason, { attempt: this.attempts });
        if (this.attempts > this.config.reconnectMax) { this.fatal(); return; }
        const wait = Math.min(60000, 2000 * 2 ** Math.min(this.attempts - 1, 5));
        this.retryTimer = this.schedule(async () => {
            this.retryTimer = null;
            if (this.connecting) { this.retry('initialization_still_pending'); return; }
            try {
                const old = this.client; this.client = null;
                if (old) await deadline(old.destroy(), 15000);
                if (!this.stopping) await this.connect();
            } catch { this.fatal(); }
        }, wait);
    }
    async check() {
        if (this.stopping || this.connecting || this.state.connection !== 'ready') return;
        try {
            const state = await deadline(this.client.getState(), 10000);
            if (state !== 'CONNECTED') this.retry('connection_check_failed');
        } catch { this.retry('connection_check_failed'); }
    }
    async send(groupId, text) {
        if (this.state.connection !== 'ready' || !this.client) throw new Error('WHATSAPP_NOT_READY');
        const client = this.client;
        try {
            return await deadline(client.sendMessage(groupId, text, { linkPreview: false, sendSeen: false }), 30000);
        } catch (error) {
            // A timed-out send may still finish. Reset the browser before another operator retry.
            this.retry('send_failed'); throw error;
        }
    }
    async groups() {
        if (this.state.connection !== 'ready' || !this.client) throw new Error('WHATSAPP_NOT_READY');
        const client = this.client;
        const groups = await deadline(client.pupPage.evaluate(readGroupDirectory), 15000);
        if (this.client !== client || this.state.connection !== 'ready') throw new Error('WHATSAPP_NOT_READY');
        return groups.sort((a, b) => a.name.localeCompare(b.name));
    }
    async stop() {
        this.stopping = true;
        if (this.retryTimer) this.cancel(this.retryTimer);
        this.retryTimer = null;
        Object.assign(this.state, { connection: 'stopping', qr: null, qrAt: 0 });
        const client = this.client; this.client = null;
        if (client) await deadline(client.destroy(), 15000).catch(() => {});
    }
}
module.exports = { Session, deadline, readGroupDirectory };
