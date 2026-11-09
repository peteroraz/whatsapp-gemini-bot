'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
class Store {
    constructor(filename, options = {}) {
        this.now = options.now || Date.now;
        this.retentionMs = (options.retentionDays || 7) * 86400000;
        this.maxPending = options.maxPending || 5000;
        this.db = new DatabaseSync(filename);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, group_id TEXT NOT NULL, author TEXT NOT NULL,
                body TEXT NOT NULL, sent_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
                kind TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id, created_at, id);
            CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS seen_group ON seen(group_id, created_at);
            CREATE TABLE IF NOT EXISTS jobs (
                group_id TEXT PRIMARY KEY, id TEXT NOT NULL, snapshot TEXT NOT NULL,
                chunks TEXT, next_chunk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS group_state (
                group_id TEXT PRIMARY KEY, last_attempt INTEGER NOT NULL DEFAULT 0,
                omitted INTEGER NOT NULL DEFAULT 0);
            PRAGMA user_version=1;`);
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = fn(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    markSeen(id, groupId) {
        return Number(this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?, ?, ?)').run(id, groupId, this.now()).changes) > 0;
    }
    omitted(groupId, amount) {
        if (amount) this.db.prepare(`INSERT INTO group_state(group_id, omitted) VALUES (?, ?)
            ON CONFLICT(group_id) DO UPDATE SET omitted=omitted+excluded.omitted`).run(groupId, amount);
    }
    add(message) {
        return this.transaction(() => {
            if (!this.markSeen(message.id, message.groupId)) return false;
            this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
                message.id, message.groupId, message.author, message.body, message.sentAt,
                this.now(), message.kind || 'text', message.truncated ? 1 : 0);
            const count = this.count(message.groupId);
            if (count > this.maxPending) {
                const evicted = this.db.prepare('SELECT id FROM messages WHERE group_id=? ORDER BY rowid LIMIT ?').all(message.groupId, count - this.maxPending);
                this.db.prepare(`DELETE FROM messages WHERE id IN (
                    SELECT id FROM messages WHERE group_id=? ORDER BY rowid LIMIT ?)`)
                    .run(message.groupId, count - this.maxPending);
                this.recordOmissions(message.groupId, evicted);
            }
            return true;
        });
    }
    recordOmissions(groupId, rows) {
        const protectedIds = new Set(this.getJob(groupId)?.snapshot.messages.map(m => m.id) || []);
        this.omitted(groupId, rows.filter(row => !protectedIds.has(row.id)).length);
    }
    prune() {
        return this.transaction(() => {
            const cutoff = this.now() - this.retentionMs;
            for (const row of this.db.prepare('SELECT group_id, COUNT(*) AS n FROM messages WHERE created_at < ? GROUP BY group_id').all(cutoff)) {
                this.recordOmissions(row.group_id, this.db.prepare('SELECT id FROM messages WHERE group_id=? AND created_at < ?').all(row.group_id, cutoff));
            }
            this.db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
            this.db.prepare('DELETE FROM seen WHERE created_at < ?').run(cutoff);
            // Unfinished outboxes outlive retention, preserving interrupted summaries.
        });
    }
    count(groupId) { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id=?').get(groupId).n); }
    lastAttempt(groupId) { return this.db.prepare('SELECT last_attempt FROM group_state WHERE group_id=?').get(groupId)?.last_attempt || 0; }
    recordAttempt(groupId) {
        this.db.prepare(`INSERT INTO group_state(group_id, last_attempt) VALUES (?, ?)
            ON CONFLICT(group_id) DO UPDATE SET last_attempt=excluded.last_attempt`).run(groupId, this.now());
    }
    getJob(groupId) {
        const row = this.db.prepare('SELECT * FROM jobs WHERE group_id=?').get(groupId);
        return row ? { ...row, snapshot: JSON.parse(row.snapshot), chunks: row.chunks ? JSON.parse(row.chunks) : null } : null;
    }
    beginJob(groupId, maxMessages, maxChars) {
        return this.transaction(() => {
            const existing = this.getJob(groupId);
            if (existing) return existing;
            const rows = this.db.prepare('SELECT * FROM messages WHERE group_id=? ORDER BY rowid LIMIT ?').all(groupId, maxMessages);
            let size = 2;
            const messages = [];
            for (const row of rows) {
                const entry = { id: row.id, ref: `m${messages.length + 1}`, author: row.author,
                    timestamp: new Date(row.sent_at).toISOString(), body: row.body, kind: row.kind, truncated: Boolean(row.truncated) };
                // A heavily escaped first message must fit instead of wedging the queue.
                if (!messages.length) {
                    while (JSON.stringify(entry).length + 3 > maxChars && entry.body.length > 1) {
                        entry.body = Array.from(entry.body).slice(0, Math.floor(Array.from(entry.body).length / 2)).join('');
                        entry.truncated = true;
                    }
                }
                const length = JSON.stringify(entry).length + 1;
                if (size + length > maxChars) break;
                messages.push(entry); size += length;
            }
            if (!messages.length) return null;
            const snapshot = { messages, omitted: this.db.prepare('SELECT omitted FROM group_state WHERE group_id=?').get(groupId)?.omitted || 0 };
            this.db.prepare('INSERT INTO jobs(group_id, id, snapshot, created_at) VALUES (?, ?, ?, ?)')
                .run(groupId, randomUUID(), JSON.stringify(snapshot), this.now());
            return this.getJob(groupId);
        });
    }
    saveChunks(groupId, chunks) { this.db.prepare('UPDATE jobs SET chunks=?, next_chunk=0 WHERE group_id=?').run(JSON.stringify(chunks), groupId); }
    acknowledgeChunk(groupId, next) { this.db.prepare('UPDATE jobs SET next_chunk=? WHERE group_id=?').run(next, groupId); }
    complete(groupId) {
        this.transaction(() => {
            const job = this.getJob(groupId);
            if (!job || !job.chunks || job.next_chunk !== job.chunks.length) throw new Error('Delivery incomplete');
            const remove = this.db.prepare('DELETE FROM messages WHERE id=? AND group_id=?');
            for (const message of job.snapshot.messages) remove.run(message.id, groupId);
            this.db.prepare('DELETE FROM jobs WHERE group_id=?').run(groupId);
            this.db.prepare('UPDATE group_state SET omitted=MAX(0, omitted-?) WHERE group_id=?').run(job.snapshot.omitted, groupId);
        });
    }
    status() {
        return this.db.prepare(`SELECT group_id FROM messages UNION SELECT group_id FROM jobs UNION SELECT group_id FROM group_state WHERE omitted>0`).all().map(row => ({
            groupId: row.group_id, pending: this.count(row.group_id), unfinishedSummary: Boolean(this.getJob(row.group_id)),
            omitted: this.db.prepare('SELECT omitted FROM group_state WHERE group_id=?').get(row.group_id)?.omitted || 0,
        }));
    }
    ping() { this.db.prepare('SELECT 1').get(); }
    close() { this.db.close(); }
}
module.exports = { Store };
