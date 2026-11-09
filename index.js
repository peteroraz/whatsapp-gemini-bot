'use strict';
const fs = require('node:fs');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
process.umask(0o077);
const { loadConfig } = require('./src/config');
const { start } = require('./src/runtime');
start(loadConfig()).catch(() => {
    // Provider errors may contain prompts or secrets; never print them verbatim.
    console.error(JSON.stringify({ event: 'startup_failed', hint: 'Check configuration, data permissions and browser installation.' }));
    process.exitCode = 1;
});
