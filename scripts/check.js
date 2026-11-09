'use strict';
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    }
}
execFileSync(process.execPath, ['--check', 'index.js'], { stdio: 'inherit' });
for (const directory of ['src', 'scripts', 'test', 'public']) scan(directory);
console.log('JavaScript syntax checks passed.');
