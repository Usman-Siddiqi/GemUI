import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { getDefaultWorkspace } from '../lib/workspace.js';

export const gitApi = Router();

const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SAFE_PATH_PATTERN = /^[^\0]+$/;

function ws(req) {
    return req.query.workspace || req.body?.workspace || getDefaultWorkspace();
}

async function resolveWorkspace(workspace) {
    const root = path.resolve(workspace || '.');
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
        throw new Error('Workspace must be a directory');
    }
    return root;
}

function cleanError(stderr, fallback = 'Git command failed') {
    const text = (stderr || '').trim();
    if (!text) return fallback;
    const line = text
        .split(/\r?\n/)
        .map((v) => v.trim())
        .find((v) => v && !v.startsWith('hint:'));
    return line || fallback;
}

function runGit(args, { cwd, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn('git', args, {
            cwd,
            shell: false,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            try { proc.kill('SIGTERM'); } catch { /* noop */ }
        }, timeoutMs);

        proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
                const err = new Error('Git command timed out');
                err.code = 'ETIMEDOUT';
                return reject(err);
            }
            resolve({ code, stdout, stderr });
        });
    });
}

async function isGitRepo(cwd) {
    try {
        const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 5000 });
        return result.code === 0 && result.stdout.trim().toLowerCase() === 'true';
    } catch {
        return false;
    }
}

function describeStatus(stagedStatus, unstagedStatus) {
    if (stagedStatus === '?' && unstagedStatus === '?') return 'Untracked';
    const chars = `${stagedStatus}${unstagedStatus}`;
    if (chars.includes('U')) return 'Unmerged';
    if (chars.includes('R')) return 'Renamed';
    if (chars.includes('A')) return 'Added';
    if (chars.includes('D')) return 'Deleted';
    if (chars.includes('M')) return 'Modified';
    if (chars.includes('C')) return 'Copied';
    return 'Changed';
}

function parseStatusOutput(statusOutput) {
    const lines = statusOutput.split(/\r?\n/).filter(Boolean);
    let branch = null;
    let upstream = null;
    let ahead = 0;
    let behind = 0;
    const changes = [];

    for (const line of lines) {
        if (line.startsWith('## ')) {
            const head = line.slice(3).trim();
            const statsMatch = head.match(/^(.*?)(?: \[(.*)\])?$/);
            const headPart = statsMatch?.[1] || head;
            const statsPart = statsMatch?.[2] || '';
            const branchParts = headPart.split('...');
            branch = branchParts[0] || null;
            upstream = branchParts.length > 1 ? branchParts[1] : null;
            const aheadMatch = statsPart.match(/ahead (\d+)/);
            const behindMatch = statsPart.match(/behind (\d+)/);
            ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
            behind = behindMatch ? Number(behindMatch[1]) : 0;
            continue;
        }

        if (line.length < 4) continue;

        const stagedStatus = line[0];
        const unstagedStatus = line[1];
        let rawPath = line.slice(3);
        let originalPath = null;
        if (rawPath.includes(' -> ')) {
            const [from, to] = rawPath.split(' -> ');
            originalPath = from?.replace(/\\/g, '/') || null;
            rawPath = to || rawPath;
        }

        const normalizedPath = rawPath
            .trim()
            .replace(/^"|"$/g, '')
            .replace(/\\/g, '/');

        const untracked = stagedStatus === '?' && unstagedStatus === '?';
        const staged = stagedStatus !== ' ' && stagedStatus !== '?';
        const unstaged = unstagedStatus !== ' ';

        changes.push({
            path: normalizedPath,
            originalPath,
            stagedStatus,
            unstagedStatus,
            staged,
            unstaged,
            untracked,
            statusLabel: describeStatus(stagedStatus, unstagedStatus),
        });
    }

    const summary = {
        staged: changes.filter((c) => c.staged).length,
        unstaged: changes.filter((c) => c.unstaged && !c.untracked).length,
        untracked: changes.filter((c) => c.untracked).length,
    };

    return { branch, upstream, ahead, behind, changes, summary };
}

function validateBranch(branch) {
    if (!branch || typeof branch !== 'string') return false;
    const b = branch.trim();
    if (!b) return false;
    return SAFE_BRANCH_PATTERN.test(b);
}

function validateGitPath(p) {
    if (!p || typeof p !== 'string') return false;
    const v = p.trim();
    if (!v || v.startsWith('-')) return false;
    return SAFE_PATH_PATTERN.test(v);
}

async function getStatusPayload(root) {
    const statusRes = await runGit(['status', '--porcelain=v1', '-b'], { cwd: root });
    if (statusRes.code !== 0) {
        throw new Error(cleanError(statusRes.stderr, 'Failed to read git status'));
    }

    const branchRes = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root });
    const branches = branchRes.code === 0
        ? branchRes.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
        : [];

    const parsed = parseStatusOutput(statusRes.stdout);
    return {
        isRepo: true,
        workspace: root,
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        clean: parsed.changes.length === 0,
        summary: parsed.summary,
        changes: parsed.changes,
        branches,
    };
}

gitApi.get('/git/status', async (req, res) => {
    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!(await isGitRepo(root))) {
        return res.json({
            isRepo: false,
            workspace: root,
            error: 'Workspace is not a git repository',
            clean: true,
            summary: { staged: 0, unstaged: 0, untracked: 0 },
            changes: [],
            branches: [],
            branch: null,
            upstream: null,
            ahead: 0,
            behind: 0,
        });
    }

    try {
        const payload = await getStatusPayload(root);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/init', async (req, res) => {
    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const result = await runGit(['init'], { cwd: root });
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, 'Failed to initialize git repository') });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, message: result.stdout.trim() || 'Repository initialized', status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/stage', async (req, res) => {
    const filePath = req.body?.path;
    if (!validateGitPath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
    }

    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const result = await runGit(['add', '--', filePath.trim()], { cwd: root });
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, 'Failed to stage file') });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/stage-all', async (req, res) => {
    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const result = await runGit(['add', '-A'], { cwd: root });
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, 'Failed to stage all changes') });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/unstage', async (req, res) => {
    const filePath = req.body?.path;
    if (!validateGitPath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
    }

    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        let result = await runGit(['restore', '--staged', '--', filePath.trim()], { cwd: root });
        if (result.code !== 0) {
            result = await runGit(['reset', 'HEAD', '--', filePath.trim()], { cwd: root });
        }
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, 'Failed to unstage file') });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/discard', async (req, res) => {
    const filePath = req.body?.path;
    if (!validateGitPath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
    }

    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const result = await runGit(['restore', '--worktree', '--', filePath.trim()], { cwd: root });
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, 'Failed to discard changes') });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/commit', async (req, res) => {
    const message = (req.body?.message || '').trim();
    if (!message) {
        return res.status(400).json({ error: 'Commit message is required' });
    }

    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const result = await runGit(['commit', '-m', message], { cwd: root, timeoutMs: 30000 });
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, 'Failed to create commit') });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, message: result.stdout.trim(), status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/checkout', async (req, res) => {
    const branch = (req.body?.branch || '').trim();
    if (!validateBranch(branch)) {
        return res.status(400).json({ error: 'Invalid branch name' });
    }

    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const result = await runGit(['checkout', branch], { cwd: root });
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, `Failed to checkout ${branch}`) });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, message: result.stdout.trim() || result.stderr.trim(), status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

gitApi.post('/git/branch', async (req, res) => {
    const branch = (req.body?.branch || '').trim();
    const checkout = !!req.body?.checkout;
    if (!validateBranch(branch)) {
        return res.status(400).json({ error: 'Invalid branch name' });
    }

    let root;
    try {
        root = await resolveWorkspace(ws(req));
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const args = checkout ? ['checkout', '-b', branch] : ['branch', branch];
        const result = await runGit(args, { cwd: root });
        if (result.code !== 0) {
            return res.status(400).json({ error: cleanError(result.stderr, `Failed to create branch ${branch}`) });
        }
        const status = await getStatusPayload(root);
        res.json({ ok: true, message: result.stdout.trim() || result.stderr.trim(), status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
