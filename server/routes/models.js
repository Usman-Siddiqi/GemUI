import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import stripAnsi from 'strip-ansi';

export const modelsApi = Router();

const MODEL_CANDIDATES = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'Stable' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'Stable' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'Stable' },
    // Gemini 3.x preview line (official model codes).
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', tier: 'Preview' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', tier: 'Preview' },
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview (Legacy)', tier: 'Preview' },
];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 40000;
const GEMINI_CLI_JS = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js')
    : '';
const HAS_DIRECT_GEMINI_CLI_JS = process.platform === 'win32' && GEMINI_CLI_JS && fs.existsSync(GEMINI_CLI_JS);

function buildBaselineCatalog() {
    return {
        checkedAt: null,
        totalChecked: 0,
        recommendedModel: 'gemini-2.5-flash',
        available: MODEL_CANDIDATES.map((m) => ({
            ...m,
            available: true,
            verified: false,
            reason: 'Pending validation',
        })),
        unavailable: [],
        stale: true,
    };
}

let cached = buildBaselineCatalog();
let cachedAt = 0;
let lastError = null;
let inFlight = null;

function summarizeFailure(stderr, code) {
    const text = stripAnsi(stderr || '');
    if (/ModelNotFoundError|Requested entity was not found/i.test(text)) {
        return 'Model not found for this account/project';
    }
    if (/No capacity available for model/i.test(text)) {
        return 'Model is valid but no serving capacity is currently available (try later or switch model)';
    }
    if (/requires a paid tier|Gemini Ultra|permission denied/i.test(text)) {
        return 'Model exists but this account/project does not currently have access';
    }
    if (/include_thoughts is only enabled when thinking is enabled/i.test(text)) {
        return 'Model is incompatible with current CLI request config';
    }
    if (/status 429|RESOURCE_EXHAUSTED|quota/i.test(text)) {
        return 'Rate limited/quota exceeded while validating';
    }
    const cleanLine = text
        .split(/\r?\n/)
        .map(s => s.trim())
        .find(s => s && !s.startsWith('at ') && !s.includes('file:///'));
    return cleanLine || `Probe failed with exit code ${code ?? 'unknown'}`;
}

function probeModel(modelId) {
    return new Promise((resolve) => {
        let command = process.platform === 'win32' ? 'cmd.exe' : 'gemini';
        let args = process.platform === 'win32'
            ? ['/d', '/s', '/c', 'gemini', '-o', 'text', '-m', modelId]
            : ['-o', 'text', '-m', modelId];

        if (HAS_DIRECT_GEMINI_CLI_JS) {
            command = process.execPath;
            args = ['--no-warnings=DEP0040', GEMINI_CLI_JS, '-o', 'text', '-m', modelId];
        }

        const proc = spawn(command, args, {
            cwd: process.cwd(),
            env: { ...process.env, NO_COLOR: '1' },
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            try { proc.kill('SIGTERM'); } catch { /* noop */ }
        }, PROBE_TIMEOUT_MS);

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({
                id: modelId,
                result: 'transient_error',
                reason: err.message || 'Failed to start gemini process',
            });
        });

        proc.on('close', (code) => {
            clearTimeout(timer);

            if (timedOut) {
                const timedOutReason = summarizeFailure(stderr, code);
                return resolve({
                    id: modelId,
                    result: 'transient_error',
                    reason: timedOutReason.startsWith('Probe failed')
                        ? 'Validation timed out'
                        : timedOutReason,
                });
            }

            if (code === 0) {
                return resolve({
                    id: modelId,
                    result: 'available',
                    reason: null,
                    sample: stripAnsi(stdout).trim().slice(0, 120) || null,
                });
            }

            const cleanErr = stripAnsi(stderr || '');
            if (/ModelNotFoundError|Requested entity was not found/i.test(cleanErr)) {
                return resolve({
                    id: modelId,
                    result: 'not_found',
                    reason: summarizeFailure(stderr, code),
                });
            }
            if (/include_thoughts is only enabled when thinking is enabled/i.test(cleanErr)) {
                return resolve({
                    id: modelId,
                    result: 'incompatible',
                    reason: summarizeFailure(stderr, code),
                });
            }

            return resolve({
                id: modelId,
                result: 'transient_error',
                reason: summarizeFailure(stderr, code),
            });
        });

        try {
            proc.stdin.write('ping');
            proc.stdin.end();
        } catch {
            // ignore
        }
    });
}

async function buildModelCatalog() {
    const probes = [];
    for (const candidate of MODEL_CANDIDATES) {
        // Sequential probing avoids tripping CLI/API rate limits during validation.
        // eslint-disable-next-line no-await-in-loop
        const status = await probeModel(candidate.id);
        const hardUnavailable = status.result === 'not_found' || status.result === 'incompatible';
        const selectable = !hardUnavailable;
        probes.push({
            ...candidate,
            available: selectable,
            verified: status.result === 'available',
            reason: status.reason || null,
        });
    }

    const available = probes.filter(m => m.available);
    const unavailable = probes.filter(m => !m.available);
    const recommended = available.find(m => m.id.includes('flash') && !m.id.includes('lite'))
        || available.find(m => m.id.includes('flash'))
        || available.find(m => m.id.includes('pro'))
        || null;

    return {
        checkedAt: new Date().toISOString(),
        totalChecked: probes.length,
        recommendedModel: recommended?.id || null,
        available,
        unavailable,
        stale: false,
    };
}

function startRefresh() {
    if (inFlight) return inFlight;
    inFlight = buildModelCatalog()
        .then((catalog) => {
            cached = catalog;
            cachedAt = Date.now();
            lastError = null;
            return catalog;
        })
        .catch((err) => {
            lastError = err?.message || 'Model refresh failed';
            return cached;
        })
        .finally(() => { inFlight = null; });
    return inFlight;
}

modelsApi.get('/models', async (req, res) => {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const isFresh = cachedAt > 0 && (Date.now() - cachedAt) < CACHE_TTL_MS;

    if (force || !isFresh) {
        startRefresh();
    }

    res.json({
        ...cached,
        stale: !isFresh,
        refreshing: !!inFlight,
        error: lastError,
    });
});
