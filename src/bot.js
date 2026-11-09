'use strict';
const { BOT_PREFIX, format } = require('./summary');
class Bot {
    constructor({ store, config, summarize, send, log = () => {}, now = Date.now }) {
        Object.assign(this, { store, config, summarize, send, log, now });
        this.active = new Map(); this.stopping = false; this.lastNotice = new Map();
    }
    async notice(groupId, message) { await this.send(groupId, BOT_PREFIX + message); }
    async throttledNotice(groupId, message) {
        if (this.now() - (this.lastNotice.get(groupId) || 0) < 10000) return;
        this.lastNotice.set(groupId, this.now());
        await this.notice(groupId, message);
    }
    async handle(msg, ownId = 'self') {
        if (this.stopping) return;
        const fromMe = Boolean(msg.fromMe);
        const groupId = fromMe ? msg.to : msg.from;
        if (typeof groupId !== 'string' || !this.config.groups.has(groupId)) return;
        const body = typeof msg.body === 'string' ? msg.body : '';
        if (fromMe && body.startsWith(BOT_PREFIX)) return;
        const id = msg.id?._serialized;
        if (typeof id !== 'string' || !id || id.length > 300) return;
        const author = fromMe ? ownId : msg.author;
        if (typeof author !== 'string' || !author || author.length > 100) return;
        const command = body.trim().toLowerCase();
        if (command === '!summarize' || command === '!help') {
            if (!this.store.markSeen(id, groupId)) return;
            if (!fromMe && !this.config.allowMemberCommands && !this.config.senders.has(author)) {
                await this.throttledNotice(groupId, 'Only configured operators or the linked account can request summaries.'); return;
            }
            if (command === '!help') {
                await this.throttledNotice(groupId, 'Send !summarize to extract the oldest pending text batch. Media contents are not read. Repeating after a failed delivery resumes it.'); return;
            }
            return this.request(groupId);
        }
        if (fromMe && !this.config.recordOwnMessages) return;
        const isText = (!msg.type || msg.type === 'chat') && !msg.hasMedia;
        if (!body.trim() && isText) return;
        const original = body || `[Non-text message: ${String(msg.type || 'media').slice(0, 40)}]`;
        const chars = Array.from(original);
        const timestamp = Number(msg.timestamp) * 1000;
        this.store.add({ id, groupId, author, body: chars.slice(0, this.config.maxMessageChars).join(''),
            kind: isText ? 'text' : 'media', truncated: chars.length > this.config.maxMessageChars,
            sentAt: Number.isFinite(timestamp) && timestamp > 0 && timestamp <= this.now() + 86400000 ? timestamp : this.now() });
    }
    request(groupId) {
        if (this.stopping) return Promise.resolve();
        if (this.active.has(groupId)) return this.throttledNotice(groupId, 'A summary is already in progress for this group.');
        if (this.active.size >= this.config.maxConcurrent) return this.throttledNotice(groupId, 'The bot is busy. Please try again shortly.');
        if (this.now() - this.store.lastAttempt(groupId) < this.config.cooldownMs) return this.throttledNotice(groupId, 'Please wait for the summary cooldown before trying again.');
        this.store.prune();
        const job = this.store.beginJob(groupId, this.config.maxMessages, this.config.maxInputChars);
        if (!job) return this.throttledNotice(groupId, 'There are no pending messages to summarize.');
        this.store.recordAttempt(groupId);
        const task = Promise.resolve().then(() => this.run(groupId, job)).finally(() => this.active.delete(groupId));
        this.active.set(groupId, task);
        return task;
    }
    async run(groupId, job) {
        let phase = 'delivery';
        try {
            await this.notice(groupId, job.chunks ? `Resuming summary ${job.id.slice(0, 8)}.` : 'Preparing a summary of the pending messages…');
            if (!job.chunks) {
                phase = 'generation';
                const data = job.snapshot.messages.some(message => message.kind === 'text')
                    ? await this.summarize(job.snapshot.messages) : { items: [] };
                this.store.saveChunks(groupId, format(data, job));
                job = this.store.getJob(groupId);
            }
            phase = 'delivery';
            for (let i = job.next_chunk; i < job.chunks.length; i++) {
                await this.send(groupId, job.chunks[i]);
                this.store.acknowledgeChunk(groupId, i + 1);
            }
            this.store.complete(groupId);
            this.log('summary_complete', { groupId, summaryId: job.id, messages: job.snapshot.messages.length });
        } catch (error) {
            this.log('summary_failed', { groupId, phase, status: Number(error.status) || undefined });
            try { await this.notice(groupId, phase === 'generation'
                ? 'AI extraction failed or returned unverifiable output. Messages are saved; an operator can retry after the cooldown.'
                : 'WhatsApp delivery failed. The saved summary can be resumed after the cooldown.'); } catch { /* Saved outbox remains. */ }
        }
    }
    async stop() { this.stopping = true; await Promise.allSettled([...this.active.values()]); }
}
module.exports = { Bot };
