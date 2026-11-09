'use strict';
let token = '', timer, qrUrl, epoch = 0;
const el = id => document.getElementById(id);
async function api(route, expectedEpoch = epoch) {
    const result = await fetch(route, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (expectedEpoch !== epoch) throw new Error('Session changed.');
    if (result.status === 401) { lock(); throw new Error('The admin token was not accepted.'); }
    if (!result.ok) throw new Error('This information is not available yet. Check the connection and try again.');
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
}
async function refresh() {
    const current = epoch;
    try {
        const status = await (await api('/api/status', current)).json();
        if (current !== epoch) return;
        el('error').textContent = ''; el('login').hidden = true; el('dashboard').hidden = false;
        el('connection').textContent = status.connection.replaceAll('_', ' ');
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
el('groups').addEventListener('click', async () => {
    const current = epoch;
    try {
        const { groups } = await (await api('/api/groups', current)).json();
        if (current !== epoch) return;
        el('group-list').replaceChildren(...groups.map(group => {
            const li = document.createElement('li');
            const name = document.createElement('strong'); name.textContent = group.name;
            const id = document.createElement('code'); id.textContent = group.id;
            li.append(name, document.createElement('br'), id); return li;
        }));
    } catch (error) { if (current === epoch) el('error').textContent = error.message; }
});
window.addEventListener('pagehide', lock);
