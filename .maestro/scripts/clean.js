#!/usr/bin/env node
// Removes Maestro test artifacts (~/.maestro/tests/) and local screenshot/report folders.
// Usage: node .maestro/scripts/clean.js
//        node .maestro/scripts/clean.js --all   (removes ALL past runs, not just the last 5)

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEP_RECENT = process.argv.includes('--all') ? 0 : 5;

const maestroTestsDir = path.join(os.homedir(), '.maestro', 'tests');
const localDirs = [
    path.join(__dirname, '..', 'screenshots'),
    path.join(__dirname, '..', 'reports'),
];

function removeDir(p) {
    if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`  Removed: ${p}`);
    }
}

// Clean local artifact dirs
for (const dir of localDirs) removeDir(dir);

// Clean ~/.maestro/tests — keep N most recent
if (fs.existsSync(maestroTestsDir)) {
    const runs = fs.readdirSync(maestroTestsDir)
        .filter(n => /^\d{4}-\d{2}-\d{2}_/.test(n))
        .sort();

    const toRemove = KEEP_RECENT > 0 ? runs.slice(0, -KEEP_RECENT) : runs;
    if (toRemove.length === 0) {
        console.log(`Nothing to clean (${runs.length} runs kept).`);
    } else {
        for (const run of toRemove) removeDir(path.join(maestroTestsDir, run));
        console.log(`✓ Cleaned ${toRemove.length} run(s), kept ${runs.length - toRemove.length}.`);
    }
} else {
    console.log('No ~/.maestro/tests directory found.');
}
