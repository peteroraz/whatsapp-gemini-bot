'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
function authorized(header, token) {
    const supplied = Buffer.from(typeof header === 'string' ? header.replace(/^Bearer /, '') : '');
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) && header.startsWith('Bearer ');
}
function createServer({ config, session, store, bot, log = () => {} }) {
    let attempts = 0, windowStart = Date.now(), groupCache = null, groupCacheAt = 0, groupRequest = null, groupSession = null;
    let lastReconnectAt = 0;
    const assets = new Map([
        ['/', ['index.html', 'text/html; charset=utf-8']],
        ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
        ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ].map(([route, [file, type]]) => [route, { body: fs.readFileSync(path.join(__dirname, '../public', file)), type }]));
    return http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        const respond = (status, body, type = 'application/json; charset=utf-8') => {
            res.writeHead(status, { 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
        };
        try {
            const url = new URL(req.url, 'http://localhost');
            const reconnect = req.method === 'POST' && url.pathname === '/api/reconnect';
            if (req.method !== 'GET' && !reconnect) return respond(405, { error: 'method_not_allowed' });
            if (url.pathname === '/healthz') {
                store.ping(); return respond(bot.stopping ? 503 : 200, { alive: !bot.stopping });
            }
            if (url.pathname === '/readyz') {
                const ready = !bot.stopping && session.state.connection === 'ready';
                return respond(ready ? 200 : 503, { ready });
            }
            if (assets.has(url.pathname)) {
                const asset = assets.get(url.pathname); return respond(200, asset.body, asset.type);
            }
            if (!url.pathname.startsWith('/api/')) return respond(404, { error: 'not_found' });
            if (Date.now() - windowStart > 60000) { windowStart = Date.now(); attempts = 0; }
            if (!authorized(req.headers.authorization, config.adminToken)) {
                attempts++;
                return respond(attempts > 30 ? 429 : 401, { error: attempts > 30 ? 'too_many_attempts' : 'unauthorized' });
            }
            if (reconnect) {
                req.resume();
                if (bot.active.size) return respond(409, { error: 'summary_in_progress' });
                if (Date.now() - lastReconnectAt < 30000) return respond(429, { error: 'reconnect_cooldown' });
                lastReconnectAt = Date.now(); groupCache = null; groupRequest = null;
                try { await session.reconnect(); return respond(202, { reconnecting: true }); }
                catch { log('operator_reconnect_failed'); return respond(503, { error: 'reconnect_failed' }); }
            }
            if (url.pathname === '/api/status') return respond(200, {
                connection: session.state.connection, readyAt: session.state.readyAt, lastReason: session.state.lastReason,
                qrAvailable: Boolean(session.state.qr) && Date.now() - session.state.qrAt < 60000,
                model: config.model, allowedGroups: [...config.groups], commandSenders: [...config.senders],
                memberCommands: config.allowMemberCommands, pending: store.status(), activeSummaries: bot.active.size,
            });
            if (url.pathname === '/api/qr') {
                if (!session.state.qr || Date.now() - session.state.qrAt >= 60000) return respond(404, { error: 'no_current_qr' });
                const svg = await require('qrcode').toString(session.state.qr, { type: 'svg', margin: 4, width: 300 });
                return respond(200, svg, 'image/svg+xml');
            }
            if (url.pathname === '/api/groups') {
                if (session.state.connection !== 'ready') return respond(503, { error: 'whatsapp_not_ready' });
                if (groupSession !== session.state.readyAt) {
                    groupCache = null; groupRequest = null; groupSession = session.state.readyAt;
                }
                try {
                    if (!groupCache || Date.now() - groupCacheAt > 30000) {
                        if (!groupRequest) {
                            const request = Promise.resolve().then(() => session.groups());
                            groupRequest = request;
                            request.finally(() => { if (groupRequest === request) groupRequest = null; }).catch(() => {});
                        }
                        const request = groupRequest, readyAt = session.state.readyAt;
                        const groups = await request;
                        if (session.state.connection !== 'ready' || session.state.readyAt !== readyAt) return respond(503, { error: 'whatsapp_not_ready' });
                        groupCache = groups; groupCacheAt = Date.now();
                    }
                    return respond(200, { groups: groupCache });
                } catch (error) {
                    const code = error.message === 'TIMEOUT' ? 'group_list_timeout'
                        : error.message === 'WHATSAPP_NOT_READY' ? 'whatsapp_not_ready' : 'group_list_failed';
                    log('group_list_failed', { code });
                    return respond(503, { error: code });
                }
            }
            return respond(404, { error: 'not_found' });
        } catch { log('admin_request_failed'); if (!res.headersSent) respond(503, { error: 'temporarily_unavailable' }); else res.end(); }
    });
}
module.exports = { createServer, authorized };
