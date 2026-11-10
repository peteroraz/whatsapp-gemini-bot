'use strict';
const { BOT_PREFIX, format } = require('./summary');
const { createHash } = require('node:crypto');
const groupPattern = /^\d+(?:-\d+)?@g\.us$/;
function wid(value) {
    if (typeof value === 'string') return value;
    if (typeof value?._serialized === 'string' && value._serialized) return value._serialized;
    if (/^\d+(?:-\d+)?$/.test(String(value?.user)) && ['g.us', 'c.us', 'lid'].includes(value?.server)) return `${value.user}@${value.server}`;
}
// Adapt the actual WhatsApp Message/MsgKey contract at the ingestion boundary.
// Recent MsgKey objects have id/remote/participant but no _serialized property.
function normalizeMessage(raw, ownId = 'self') {
    raw = raw || {};
    const fromMe = raw.fromMe === true || raw.id?.fromMe === true;
    const direct = wid(fromMe ? raw.to : raw.from);
    const remote = wid(raw.id?.remote);
    const groupId = groupPattern.test(direct || '') ? direct : groupPattern.test(remote || '') ? remote : null;
    if (!groupId) return { reason: 'not_a_group' };
    if (groupPattern.test(direct || '') && groupPattern.test(remote || '') && direct !== remote) return { groupId, reason: 'ambiguous_group' };
    const participant = wid(raw.id?.participant);
    const author = fromMe ? wid(ownId) || 'self' : wid(raw.author) || wid(raw._data?.author) || participant;
    if (typeof author !== 'string' || !author || author.length > 100) return { groupId, reason: 'missing_author' };
    let id = raw.id?._serialized;
    if (typeof id !== 'string' || !id || id.length > 300) {
        const wireId = raw.id?.id;
        if (typeof wireId !== 'string' || !wireId || wireId.length > 200) return { groupId, reason: 'missing_message_id' };
        // A bounded, deterministic identity keeps duplicate events/replays out of
        // SQLite without depending on a private SDK serialization convenience.
        id = 'wa:' + createHash('sha256').update(JSON.stringify([groupId, fromMe, wireId, participant || author])).digest('hex');
    }
    return { groupId, id, author, fromMe, body: typeof raw.body === 'string' ? raw.body : '',
        type: raw.type, hasMedia: raw.hasMedia, timestamp: raw.timestamp };
}
class Bot {
    constructor({ store, config, summarize, send, log = () => {}, now = Date.now }) {
        Object.assign(this, { store, config, summarize, send, log, now });
        this.active = new Map(); this.stopping = false; this.lastNotice = new Map();
        this.processing = new Map([...config.groups].map(groupId => [groupId, { groupId, received: 0, stored: 0,
            commands: 0, rejected: 0, duplicates: 0, lastMessageAt: null, lastCommandAt: null,
            lastCommand: null, lastSummaryAt: null, stage: 'waiting_for_messages', lastError: null }]));
    }
    diagnostics() { return [...this.processing.values()].map(row => ({ ...row })); }
    progress(groupId, stage, fields = {}) { Object.assign(this.processing.get(groupId) || {}, { stage, ...fields }); }
    async notice(groupId, message) { await this.send(groupId, BOT_PREFIX + message); }
    async throttledNotice(groupId, message) {
        if (this.now() - (this.lastNotice.get(groupId) || 0) < 10000) return;
        this.lastNotice.set(groupId, this.now());
        await this.notice(groupId, message);
    }
    async handle(msg, ownId = 'self') {
        if (this.stopping) return;
        const message = normalizeMessage(msg, ownId);
        const { groupId } = message;
        if (!this.config.groups.has(groupId)) return;
        const metrics = this.processing.get(groupId);
        metrics.received++; metrics.lastMessageAt = new Date(this.now()).toISOString();
        if (message.reason) {
            metrics.rejected++;
            if (metrics.lastError !== message.reason) this.log('message_rejected', { groupId, reason: message.reason });
            this.progress(groupId, 'message_rejected', { lastError: message.reason }); return;
        }
        const { fromMe, body, id, author } = message;
        if (fromMe && body.startsWith(BOT_PREFIX)) return;
        const command = body.trim().toLowerCase();
        if (command === '!summarize' || command === '!help') {
            if (!this.store.markSeen(id, groupId)) { metrics.duplicates++; return; }
            metrics.commands++;
            this.progress(groupId, 'command_received', { lastCommand: command, lastCommandAt: metrics.lastMessageAt, lastError: null });
            this.log('command_received', { groupId, command });
            if (!fromMe && !this.config.allowMemberCommands && !this.config.senders.has(author)) {
                this.progress(groupId, 'operator_required', { lastError: 'operator_required' });
                await this.throttledNotice(groupId, 'Only configured operators or the linked account can request summaries.'); return;
            }
            if (command === '!help') {
                await this.throttledNotice(groupId, 'Send !summarize to extract the oldest pending text batch. Media contents are not read. Repeating after a failed delivery resumes it.'); return;
            }
            return this.request(groupId);
        }
        if (fromMe && !this.config.recordOwnMessages) return;
        const isText = (!message.type || message.type === 'chat') && !message.hasMedia;
        if (!body.trim() && isText) return;
        const original = body || `[Non-text message: ${String(message.type || 'media').slice(0, 40)}]`;
        const chars = Array.from(original);
        const timestamp = Number(message.timestamp) * 1000;
        const added = this.store.add({ id, groupId, author, body: chars.slice(0, this.config.maxMessageChars).join(''),
            kind: isText ? 'text' : 'media', truncated: chars.length > this.config.maxMessageChars,
            sentAt: Number.isFinite(timestamp) && timestamp > 0 && timestamp <= this.now() + 86400000 ? timestamp : this.now() });
        if (added) {
            metrics.stored++;
            if (!this.active.has(groupId)) this.progress(groupId, 'collecting', { lastError: null });
        } else metrics.duplicates++;
    }
    request(groupId) {
        if (this.stopping) return Promise.resolve();
        if (this.active.has(groupId)) return this.throttledNotice(groupId, 'A summary is already in progress for this group.');
        if (this.active.size >= this.config.maxConcurrent) return this.throttledNotice(groupId, 'The bot is busy. Please try again shortly.');
        if (this.now() - this.store.lastAttempt(groupId) < this.config.cooldownMs) return this.throttledNotice(groupId, 'Please wait for the summary cooldown before trying again.');
        this.store.prune();
        const job = this.store.beginJob(groupId, this.config.maxMessages, this.config.maxInputChars);
        if (!job) {
            this.progress(groupId, 'empty_queue');
            return this.throttledNotice(groupId, 'There are no pending messages to summarize.');
        }
        this.store.recordAttempt(groupId);
        const task = Promise.resolve().then(() => this.run(groupId, job)).finally(() => this.active.delete(groupId));
        this.active.set(groupId, task);
        return task;
    }
    async run(groupId, job) {
        let phase = 'delivery';
        try {
            this.progress(groupId, 'preparing', { lastError: null });
            await this.notice(groupId, job.chunks ? `Resuming summary ${job.id.slice(0, 8)}.` : 'Preparing a summary of the pending messages…');
            if (!job.chunks) {
                phase = 'generation';
                this.progress(groupId, 'generating');
                const data = job.snapshot.messages.some(message => message.kind === 'text')
                    ? await this.summarize(job.snapshot.messages) : { items: [] };
                this.store.saveChunks(groupId, format(data, job));
                job = this.store.getJob(groupId);
            }
            phase = 'delivery';
            this.progress(groupId, 'delivering');
            for (let i = job.next_chunk; i < job.chunks.length; i++) {
                await this.send(groupId, job.chunks[i]);
                this.store.acknowledgeChunk(groupId, i + 1);
            }
            this.store.complete(groupId);
            this.progress(groupId, 'complete', { lastSummaryAt: new Date(this.now()).toISOString(), lastError: null });
            this.log('summary_complete', { groupId, summaryId: job.id, messages: job.snapshot.messages.length });
        } catch (error) {
            this.progress(groupId, `${phase}_failed`, { lastError: `${phase}_failed` });
            this.log('summary_failed', { groupId, phase, status: Number(error.status) || undefined });
            try { await this.notice(groupId, phase === 'generation'
                ? 'AI extraction failed or returned unverifiable output. Messages are saved; an operator can retry after the cooldown.'
                : 'WhatsApp delivery failed. The saved summary can be resumed after the cooldown.'); } catch { /* Saved outbox remains. */ }
        }
    }
    async stop() { this.stopping = true; await Promise.allSettled([...this.active.values()]); }
}
module.exports = { Bot, normalizeMessage };
