'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const groupId = process.argv[2];
if (!/^\d+(?:-\d+)?@g\.us$/.test(groupId || '')) {
    console.error('Usage: node scripts/purge-group.js EXACT_GROUP_ID@g.us (stop the bot first)'); process.exit(1);
}
const filename = path.join(path.resolve(process.env.DATA_DIR || './data'), 'messages.sqlite');
if (!fs.existsSync(filename)) { console.error('No database found in DATA_DIR.'); process.exit(1); }
const store = new Store(filename);
try {
    store.transaction(() => {
        store.db.prepare('DELETE FROM jobs WHERE group_id=?').run(groupId);
        store.db.prepare('DELETE FROM messages WHERE group_id=?').run(groupId);
        store.db.prepare('DELETE FROM group_state WHERE group_id=?').run(groupId);
        store.db.prepare('DELETE FROM seen WHERE group_id=?').run(groupId);
    });
    console.log('Stored group queue and unfinished summary removed. Remove it from ALLOWED_GROUP_IDS to stop collection.');
} finally { store.close(); }
