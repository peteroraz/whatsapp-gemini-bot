'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function missing(error) { return error.code === 'ENOENT' || error.code === 'ESRCH'; }
function fail(code) { throw Object.assign(new Error(code), { code }); }
function stat(file) {
    try { return fs.lstatSync(file); } catch (error) { if (!missing(error)) throw error; }
}
// Called by entrypoint.sh while it holds the volume's exclusive instance.lock.
// Chromium embeds a container hostname in SingletonLock; a replacement container
// cannot recognize the old owner and refuses to open an otherwise valid login.
function prepareProfile(dataDir, { hostname = os.hostname(), procRoot = '/proc', alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
} } = {}) {
    const profile = path.resolve(dataDir, 'auth/session');
    const lock = path.join(profile, 'SingletonLock');
    const lockStat = stat(lock);
    if (!lockStat) return null;
    if (!lockStat.isSymbolicLink()) fail('UNEXPECTED_BROWSER_LOCK');
    const owner = /^(.*)-([1-9]\d*)$/.exec(fs.readlinkSync(lock));
    if (!owner || !Number.isSafeInteger(Number(owner[2]))) fail('UNEXPECTED_BROWSER_LOCK');
    if (owner[1] === hostname && alive(Number(owner[2]))) fail('BROWSER_PROFILE_IN_USE');
    // Also refuse recovery if a live local browser actually uses this profile,
    // even if its lock happens to name a different hostname.
    for (const pid of fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
        try {
            const comm = fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim();
            if (!/^(?:chromium|chrome)(?:-|$)/.test(comm)) continue;
            const args = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0');
            const index = args.indexOf('--user-data-dir');
            const dir = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--user-data-dir='))?.slice(16);
            if (dir && path.resolve(dir) === profile) fail('BROWSER_PROFILE_IN_USE');
        } catch (error) { if (!missing(error)) throw error; }
    }
    const files = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].filter(name => {
        const info = stat(path.join(profile, name));
        if (info && !info.isSymbolicLink()) fail('UNEXPECTED_BROWSER_LOCK');
        return Boolean(info);
    });
    // Preserve the links for diagnosis. Never touch Default/, credentials or DBs.
    const backup = fs.mkdtempSync(path.join(path.dirname(profile), 'stale-browser-locks-'));
    for (const name of files) fs.renameSync(path.join(profile, name), path.join(backup, name));
    return { backup, files: files.length };
}
if (require.main === module) {
    try {
        if (!process.env.DATA_DIR) fail('DATA_DIR_REQUIRED');
        const result = prepareProfile(process.env.DATA_DIR);
        if (result) console.log(JSON.stringify({ event: 'stale_browser_locks_recovered', files: result.files }));
    } catch (error) {
        console.error(JSON.stringify({ event: 'browser_profile_recovery_failed', code: error.code || 'RECOVERY_FAILED' }));
        process.exitCode = 1;
    }
}
module.exports = { prepareProfile };
