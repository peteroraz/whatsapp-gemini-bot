'use strict';
let token = '', timer, qrUrl, epoch = 0;
const el = id => document.getElementById(id);
async function api(route, expectedEpoch = epoch, method = 'GET') {
    const result = await fetch(route, { method, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (expectedEpoch !== epoch) throw new Error('Session changed.');
    if (result.status === 401) { lock(); throw new Error('The admin token was not accepted.'); }
    if (!result.ok) {
        const body = await result.json().catch(() => ({}));
        const messages = {
            whatsapp_not_ready: 'WhatsApp is still connecting. Wait until Connection says ready, then try again.',
            group_list_timeout: 'Loading groups took too long. Keep WhatsApp online, then try again.',
            group_list_failed: 'WhatsApp could not provide the group list. Try again; if it persists, check the server logs.',
            summary_in_progress: 'A summary is running. Wait for it to finish before reconnecting.',
            reconnect_cooldown: 'A reconnect was just requested. Wait 30 seconds before trying again.',
            reconnect_failed: 'The browser could not restart. Check the server logs or restart the bot in Coolify.',
        };
        throw new Error(messages[body.error] || 'This information is not available yet. Check the connection and try again.');
    }
    return result;
}
function clearQr() {
    if (qrUrl) URL.revokeObjectURL(qrUrl);
    qrUrl = null; el('qr').hidden = true; el('qr').removeAttribute('src');
}
function lock() {
    epoch++; token = ''; clearTimeout(timer); clearQr(); el('token').value = '';
    el('dashboard').hidden = true; el('login').hidden = false;
    el('group-list').replaceChildren(); el('queues').textContent = ''; el('connection').textContent = ''; el('scope').textContent = '';
    el('group-status').textContent = ''; el('groups').disabled = false; el('groups').textContent = 'List WhatsApp groups';
    el('pairing-help').textContent = ''; el('recovery-status').textContent = ''; el('reconnect').disabled = false;
}
async function refresh() {
    const current = epoch;
    try {
        const status = await (await api('/api/status', current)).json();
        if (current !== epoch) return;
        el('error').textContent = ''; el('login').hidden = true; el('dashboard').hidden = false;
        el('connection').textContent = status.connection.replaceAll('_', ' ');
        const help = {
            ready: 'WhatsApp is connected. No QR is needed while the saved pairing is valid.',
            authenticated: 'Pairing was accepted. WhatsApp is synchronizing before groups become available.',
            awaiting_qr: 'Scan the QR in WhatsApp → Linked devices → Link a device. QR codes rotate automatically. Use Refresh pairing QR if a fresh code is needed.',
            reconnecting: 'The bot is trying to restore its saved session. Groups are unavailable until it says ready. Reconnect WhatsApp restarts the browser without deleting the pairing.',
            starting: 'The WhatsApp browser is starting. A QR will appear if this instance is not already paired.',
        };
        el('pairing-help').textContent = help[status.connection] || 'Wait for WhatsApp to connect before listing groups.';
        el('reconnect').textContent = status.connection === 'awaiting_qr' ? 'Refresh pairing QR' : 'Reconnect WhatsApp';
        if (!el('groups').textContent.includes('Loading')) el('groups').disabled = status.connection !== 'ready';
        el('scope').textContent = `${status.allowedGroups.length} enabled groups · Model: ${status.model} · ${status.activeSummaries} summaries running`;
        el('queues').textContent = status.pending.length ? status.pending.map(g => `${g.groupId}\n${g.pending} pending${g.unfinishedSummary ? ' · saved summary awaiting completion' : ''}${g.omitted ? ` · ${g.omitted} omitted by limits` : ''}`).join('\n\n') : 'No pending recorded messages.';
        if (status.qrAvailable) {
            const blob = await (await api('/api/qr', current)).blob();
            if (current !== epoch) return;
            clearQr(); qrUrl = URL.createObjectURL(blob);
            el('qr').src = qrUrl; el('qr').hidden = false;
        } else clearQr();
    } catch (error) { if (current === epoch) { el('error').textContent = error.message; clearQr(); } }
    if (token && current === epoch) timer = setTimeout(refresh, 5000);
}
el('auth').addEventListener('submit', event => { event.preventDefault(); epoch++; clearTimeout(timer); token = el('token').value; el('token').value = ''; void refresh(); });
el('logout').addEventListener('click', lock);
el('reconnect').addEventListener('click', async () => {
    if (el('reconnect').disabled) return;
    const current = epoch;
    el('reconnect').disabled = true; el('recovery-status').textContent = 'Restarting the WhatsApp browser. Your saved pairing is retained…';
    try {
        await api('/api/reconnect', current, 'POST');
        if (current === epoch) el('recovery-status').textContent = 'Reconnect requested. Connection status will update automatically; an unpaired account will show a fresh QR.';
    } catch (error) {
        if (current === epoch) el('recovery-status').textContent = ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'The request timed out. Check Connection status before retrying.' : error.message;
    } finally { if (current === epoch) el('reconnect').disabled = false; }
});
el('groups').addEventListener('click', async () => {
    if (el('groups').disabled) return;
    const current = epoch;
    el('groups').disabled = true; el('groups').textContent = 'Loading groups…';
    el('group-status').textContent = 'Loading your WhatsApp groups…';
    try {
        const { groups } = await (await api('/api/groups', current)).json();
        if (current !== epoch) return;
        el('group-list').replaceChildren(...groups.map(group => {
            const li = document.createElement('li');
            const name = document.createElement('strong'); name.textContent = group.name;
            const id = document.createElement('code'); id.textContent = group.id;
            const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary copy-id'; copy.textContent = 'Copy ID';
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(group.id);
                    if (current === epoch) el('group-status').textContent = `Copied ID for ${group.name}.`;
                } catch { if (current === epoch) el('group-status').textContent = 'Copy was blocked. Select and copy the ID shown beneath the group name.'; }
            });
            li.append(name, document.createElement('br'), id, document.createElement('br'), copy); return li;
        }));
        el('group-status').textContent = groups.length ? `${groups.length} groups found. Copy an ID below.`
            : 'No groups are available yet. Open WhatsApp on your phone, let it sync, and try again.';
    } catch (error) {
        if (current === epoch) el('group-status').textContent = ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'The request timed out. Check your connection and try again.' : error.message;
    } finally {
        if (current === epoch) { el('groups').disabled = false; el('groups').textContent = 'List WhatsApp groups'; }
    }
});
window.addEventListener('pagehide', lock);
