#!/usr/bin/env node

const { execSync } = require('child_process');

const ports = process.argv
    .slice(2)
    .map(v => Number(v))
    .filter(v => Number.isInteger(v) && v > 0 && v <= 65535);

if (ports.length === 0) {
    console.log('[dev:stop] No ports provided.');
    process.exit(0);
}

function unique(arr) {
    return [...new Set(arr)];
}

function getGemUiNodePidsWindows() {
    const cwdNorm = process.cwd().toLowerCase().replace(/\//g, '\\');
    try {
        const cmd = 'powershell -NoLogo -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \\"node.exe\\" } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"';
        const out = execSync(cmd, { encoding: 'utf8' }).trim();
        if (!out) return [];
        const parsed = JSON.parse(out);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return unique(
            rows
                .filter(row => row && row.ProcessId && typeof row.CommandLine === 'string')
                .filter(row => row.CommandLine.toLowerCase().includes(cwdNorm))
                .map(row => Number(row.ProcessId))
                .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
        );
    } catch {
        return [];
    }
}

function getPidsOnWindows(port) {
    const cmd = 'netstat -ano -p tcp';
    const out = execSync(cmd, { encoding: 'utf8' });
    const lines = out.split(/\r?\n/);
    const pids = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('TCP')) continue;
        if (!trimmed.includes('LISTENING')) continue;
        if (!trimmed.includes(`:${port} `) && !trimmed.includes(`:${port}\t`)) continue;
        const parts = trimmed.split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
            pids.push(pid);
        }
    }
    return unique(pids);
}

function getPidsOnUnix(port) {
    try {
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
        return unique(
            out
                .split(/\r?\n/)
                .map(v => Number(v.trim()))
                .filter(v => Number.isInteger(v) && v > 0 && v !== process.pid),
        );
    } catch {
        return [];
    }
}

function killPid(pid) {
    if (process.platform === 'win32') {
        try {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }
    try {
        process.kill(pid, 'SIGTERM');
        return true;
    } catch {
        return false;
    }
}

function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // busy wait; small duration and avoids async complexity in npm script.
    }
}

const finder = process.platform === 'win32' ? getPidsOnWindows : getPidsOnUnix;
const killed = new Set();
let attempts = 0;

if (process.platform === 'win32') {
    for (const pid of getGemUiNodePidsWindows()) {
        if (killPid(pid)) killed.add(pid);
    }
}

while (attempts < 12) {
    const toKill = unique(ports.flatMap(port => finder(port)));
    if (toKill.length === 0) break;
    for (const pid of toKill) {
        if (killPid(pid)) killed.add(pid);
    }
    attempts += 1;
    sleep(250);
}

const stillListening = unique(ports.flatMap(port => finder(port)));

if (killed.size === 0 && stillListening.length === 0) {
    console.log(`[dev:stop] No listeners found on ports: ${ports.join(', ')}`);
} else if (stillListening.length === 0) {
    console.log(`[dev:stop] Stopped process IDs: ${[...killed].join(', ')}`);
} else {
    console.log(`[dev:stop] Attempted to stop: ${[...killed].join(', ') || 'none'}`);
    console.log(`[dev:stop] Still listening on target ports with PIDs: ${stillListening.join(', ')}`);
}
