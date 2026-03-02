import { Router } from 'express';
import { spawn } from 'child_process';
import stripAnsi from 'strip-ansi';

export const modelsApi = Router();

const MODEL_CANDIDATES = [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'Stable' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'Stable' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'Stable' },
];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30000;

let cached = null;
let cachedAt = 0;
let inFlight = null;

function summarizeFailure(stderr, code) {
    const text = stripAnsi(stderr || '');
    if (/ModelNotFoundError|Requested entity was not found/i.test(text)) {
        return 'Model not found for this account/project';
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
        const command = process.platform === 'win32' ? 'cmd.exe' : 'gemini';
        const args = process.platform === 'win32'
            ? ['/d', '/s', '/c', 'gemini', '-o', 'text', '-m', modelId]
            : ['-o', 'text', '-m', modelId];

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
                return resolve({
                    id: modelId,
                    result: 'transient_error',
                    reason: 'Validation timed out',
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
    };
}

modelsApi.get('/models', async (req, res) => {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const isFresh = cached && (Date.now() - cachedAt) < CACHE_TTL_MS;
    if (!force && isFresh) return res.json(cached);

    if (!inFlight) {
        inFlight = buildModelCatalog()
            .then((catalog) => {
                cached = catalog;
                cachedAt = Date.now();
                return catalog;
            })
            .finally(() => { inFlight = null; });
    }

    const result = await inFlight;
    res.json(result);
});
