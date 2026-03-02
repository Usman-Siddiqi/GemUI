import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { validatePath, getDefaultWorkspace } from '../lib/workspace.js';
import { glob } from 'glob';

const execAsync = promisify(exec);
export const searchApi = Router();

function ws(req) {
    return req.query.workspace || req.body?.workspace || getDefaultWorkspace();
}

const MAX_RESULTS = 200;
const DEFAULT_IGNORE = ['node_modules/**', '.git/**', 'dist/**', 'build/**', '*.min.js', '*.min.css'];

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

    try {
        // Try git grep first (faster), fall back to grep/findstr
        const flags = caseSensitive ? '' : '-i';
        const includeFlag = include ? `-- '${include}'` : '';
        let cmd;

        if (process.platform === 'win32') {
            // Use findstr on Windows as fallback; try git grep first
            cmd = `git grep -n ${flags} --max-count=5 "${query}" ${includeFlag}`;
        } else {
            cmd = `git grep -n ${flags} --max-count=5 "${query}" ${includeFlag}`;
        }

        const { stdout } = await execAsync(cmd, {
            cwd: v.resolved,
            maxBuffer: 1024 * 1024,
            timeout: 10000,
        });

        const lines = stdout.trim().split('\n').filter(Boolean).slice(0, MAX_RESULTS);
        const results = lines.map(line => {
            const [file, lineNum, ...rest] = line.split(':');
            return { file: file.replace(/\\/g, '/'), line: parseInt(lineNum, 10), content: rest.join(':').trim() };
        });

        res.json({ results, total: results.length });
    } catch (e) {
        // git grep returns exit code 1 when no matches found
        if (e.code === 1) return res.json({ results: [], total: 0 });
        // If git grep fails, try a simpler approach
        try {
            const { stdout } = await execAsync(
                process.platform === 'win32'
                    ? `findstr /S /N ${caseSensitive ? '' : '/I'} "${query}" *`
                    : `grep -rn ${caseSensitive ? '' : '-i'} --include='*' "${query}" .`,
                { cwd: v.resolved, maxBuffer: 1024 * 1024, timeout: 10000 }
            );
            const lines = stdout.trim().split('\n').filter(Boolean).slice(0, MAX_RESULTS);
            const results = lines.map(line => {
                const [file, lineNum, ...rest] = line.split(':');
                return { file: file.replace(/\\/g, '/'), line: parseInt(lineNum, 10), content: rest.join(':').trim() };
            });
            res.json({ results, total: results.length });
        } catch {
            res.json({ results: [], total: 0 });
        }
    }
});
