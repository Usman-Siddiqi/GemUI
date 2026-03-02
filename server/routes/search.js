import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { validatePath, getDefaultWorkspace } from '../lib/workspace.js';
import { glob } from 'glob';

export const searchApi = Router();

function ws(req) {
    return req.query.workspace || req.body?.workspace || getDefaultWorkspace();
}

const MAX_RESULTS = 200;
const DEFAULT_IGNORE = ['node_modules/**', '.git/**', 'dist/**', 'build/**', '*.min.js', '*.min.css'];
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function parseGrepResults(stdout) {
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const results = [];

    for (const line of lines) {
        const firstColon = line.indexOf(':');
        if (firstColon < 0) continue;
        const secondColon = line.indexOf(':', firstColon + 1);
        if (secondColon < 0) continue;

        const file = line.slice(0, firstColon).replace(/\\/g, '/');
        const lineRaw = line.slice(firstColon + 1, secondColon);
        const content = line.slice(secondColon + 1).trim();
        const lineNum = parseInt(lineRaw, 10);
        if (!Number.isFinite(lineNum)) continue;

        results.push({ file, line: lineNum, content });
        if (results.length >= MAX_RESULTS) break;
    }

    return results;
}

function runProcess(command, args, { cwd, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            cwd,
            shell: false,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let totalBytes = 0;

        const timer = setTimeout(() => {
            try { proc.kill(); } catch { /* noop */ }
            const err = new Error(`${command} timed out`);
            err.code = 'ETIMEDOUT';
            reject(err);
        }, timeoutMs);

        const append = (chunk, target) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_OUTPUT_BYTES) {
                try { proc.kill(); } catch { /* noop */ }
                clearTimeout(timer);
                const err = new Error('Search output too large');
                err.code = 'ETOOBIG';
                reject(err);
                return false;
            }
            if (target === 'stdout') stdout += chunk.toString();
            else stderr += chunk.toString();
            return true;
        };

        proc.stdout.on('data', (chunk) => { append(chunk, 'stdout'); });
        proc.stderr.on('data', (chunk) => { append(chunk, 'stderr'); });
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

// ── Glob (find files by pattern) ──────────────────────────────

searchApi.post('/glob', async (req, res) => {
    const { pattern, searchPath } = req.body;
    if (!pattern) return res.status(400).json({ error: 'pattern required' });
    const root = ws(req);
    const base = searchPath ? path.resolve(root, searchPath) : root;
    const v = validatePath(base, root);
    if (!v.safe) return res.status(403).json({ error: v.error });

    try {
        const matches = await glob(pattern, {
            cwd: v.resolved,
            ignore: DEFAULT_IGNORE,
            nodir: false,
            maxDepth: 10,
        });

        const capped = matches.slice(0, MAX_RESULTS);
        res.json({
            matches: capped.map(m => m.replace(/\\/g, '/')),
            total: matches.length,
            capped: matches.length > MAX_RESULTS,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Grep (search text in files) ───────────────────────────────

searchApi.post('/grep', async (req, res) => {
    const { query, searchPath, include, caseSensitive } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    const root = ws(req);
    const base = searchPath ? path.resolve(root, searchPath) : root;
    const v = validatePath(base, root);
    if (!v.safe) return res.status(403).json({ error: v.error });

    // Try git grep first. Use argv arrays (no shell) to prevent command injection.
    try {
        const gitArgs = ['grep', '-n', '--max-count=5'];
        if (!caseSensitive) gitArgs.push('-i');
        gitArgs.push('-e', query);
        if (include) gitArgs.push('--', include);

        const git = await runProcess('git', gitArgs, { cwd: v.resolved });
        if (git.code === 0) {
            const results = parseGrepResults(git.stdout);
            return res.json({ results, total: results.length });
        }
        if (git.code === 1) {
            return res.json({ results: [], total: 0 });
        }
        // Non-1 error (eg not a git repo) falls through to rg fallback.
    } catch {
        // Fall through to fallback.
    }

    // Fallback to ripgrep if available.
    try {
        const rgArgs = ['-n', '--max-count', '5'];
        if (!caseSensitive) rgArgs.push('-i');
        for (const ignore of DEFAULT_IGNORE) {
            rgArgs.push('--glob', `!${ignore}`);
        }
        if (include) rgArgs.push('--glob', include);
        rgArgs.push(query, '.');

        const rg = await runProcess('rg', rgArgs, { cwd: v.resolved });
        if (rg.code === 0) {
            const results = parseGrepResults(rg.stdout);
            return res.json({ results, total: results.length });
        }
        if (rg.code === 1) {
            return res.json({ results: [], total: 0 });
        }
        return res.status(500).json({ error: rg.stderr?.trim() || 'Search failed' });
    } catch {
        return res.json({ results: [], total: 0 });
    }
});
