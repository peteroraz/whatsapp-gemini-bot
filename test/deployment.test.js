'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareProfile } = require('../scripts/prepare-profile');
function profileFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-profile-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const profile = path.join(dir, 'auth/session');
    const procRoot = path.join(dir, 'proc');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.mkdirSync(procRoot);
    fs.writeFileSync(path.join(profile, 'Default', 'saved-login'), 'preserve-login');
    fs.symlinkSync('old-container-282', path.join(profile, 'SingletonLock'));
    fs.symlinkSync('cookie', path.join(profile, 'SingletonCookie'));
    fs.symlinkSync('/tmp/old-browser/SingletonSocket', path.join(profile, 'SingletonSocket'));
    return { dir, profile, procRoot };
}
test('replacement container recovers stale browser links and preserves the saved login', t => {
    const { dir, profile, procRoot } = profileFixture(t);
    const result = prepareProfile(dir, { hostname: 'new-container', procRoot });
    assert.equal(result.files, 3);
    assert.equal(fs.readlinkSync(path.join(result.backup, 'SingletonLock')), 'old-container-282');
    assert.equal(fs.readFileSync(path.join(profile, 'Default/saved-login'), 'utf8'), 'preserve-login');
    assert.throws(() => fs.lstatSync(path.join(profile, 'SingletonLock')), { code: 'ENOENT' });
    assert.equal(prepareProfile(dir, { hostname: 'new-container', procRoot }), null);
});
test('profile recovery refuses a live owner on the same host', t => {
    const { dir, profile, procRoot } = profileFixture(t);
    assert.throws(() => prepareProfile(dir, { hostname: 'old-container', procRoot, alive: () => true }), { code: 'BROWSER_PROFILE_IN_USE' });
    assert.equal(fs.readlinkSync(path.join(profile, 'SingletonLock')), 'old-container-282');
});
test('profile recovery refuses an active browser despite a foreign hostname in its lock', t => {
    const { dir, profile, procRoot } = profileFixture(t);
    fs.mkdirSync(path.join(procRoot, '31'));
    fs.writeFileSync(path.join(procRoot, '31/comm'), 'chromium\n');
    fs.writeFileSync(path.join(procRoot, '31/cmdline'), `chromium\0--user-data-dir=${profile}\0`);
    assert.throws(() => prepareProfile(dir, { hostname: 'new-container', procRoot }), { code: 'BROWSER_PROFILE_IN_USE' });
    assert.equal(fs.readlinkSync(path.join(profile, 'SingletonLock')), 'old-container-282');
});
test('profile recovery preserves unexpected files instead of moving them', t => {
    const { dir, profile, procRoot } = profileFixture(t);
    fs.unlinkSync(path.join(profile, 'SingletonCookie'));
    fs.writeFileSync(path.join(profile, 'SingletonCookie'), 'unexpected');
    assert.throws(() => prepareProfile(dir, { hostname: 'new-container', procRoot }), { code: 'UNEXPECTED_BROWSER_LOCK' });
    assert.equal(fs.readFileSync(path.join(profile, 'SingletonCookie'), 'utf8'), 'unexpected');
    assert.equal(fs.readlinkSync(path.join(profile, 'SingletonLock')), 'old-container-282');
});
test('container entrypoint excludes another process on the same volume and releases on exit', { skip: process.platform !== 'linux' }, async t => {
    const { dir, profile } = profileFixture(t);
    const script = path.resolve('scripts/entrypoint.sh');
    const env = { ...process.env, DATA_DIR: dir };
    const first = spawn('sh', [script, process.execPath, '-e', 'console.log("locked"); setInterval(()=>{},1000)'], { env });
    t.after(() => { first.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
    let output = '';
    while (!output.includes('locked\n')) output += (await once(first.stdout, 'data'))[0];
    assert.match(output, /stale_browser_locks_recovered/);
    assert.equal(fs.readFileSync(path.join(profile, 'Default/saved-login'), 'utf8'), 'preserve-login');
    fs.symlinkSync('later-container-99999', path.join(profile, 'SingletonLock'));
    const second = spawnSync('sh', [script, process.execPath, '-e', 'process.exit(0)'], { env });
    assert.equal(second.status, 75);
    assert.equal(fs.readlinkSync(path.join(profile, 'SingletonLock')), 'later-container-99999');
    const exit = once(first, 'exit'); first.kill(); await exit;
    const third = spawnSync('sh', [script, process.execPath, '-e', 'process.exit(0)'], { env });
    assert.equal(third.status, 0);
});
