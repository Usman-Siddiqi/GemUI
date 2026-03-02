import { Router } from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import multer from 'multer';
import { validatePath, isBlockedFile, isBinaryFile, MAX_FILE_SIZE, getDefaultWorkspace } from '../lib/workspace.js';

export const fileApi = Router();

// Multer for image uploads → temp directory
const upload = multer({ dest: path.join(process.env.TEMP || '/tmp', 'gemui-uploads'), limits: { fileSize: 10 * 1024 * 1024 } });

// Helper: get workspace root from query or default
function ws(req) {
    return req.query.workspace || req.body?.workspace || getDefaultWorkspace();
}

// ── List directory ────────────────────────────────────────────

fileApi.get('/files', async (req, res) => {
    const dirPath = req.query.path || '.';
    const root = ws(req);
    const v = validatePath(dirPath, root);
    if (!v.safe) return res.status(403).json({ error: v.error });

    try {
        const entries = await fs.readdir(v.resolved, { withFileTypes: true });
        const items = [];
        for (const entry of entries) {
            // Skip hidden dirs like .git in listing (but allow .gemini, .gitignore etc)
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const fullPath = path.join(v.resolved, entry.name);
            const relPath = path.relative(root, fullPath);
            let size = 0;
            try {
                const st = await fs.stat(fullPath);
                size = st.size;
            } catch { /* skip */ }
            items.push({
                name: entry.name,
                path: relPath.replace(/\\/g, '/'),
                isDirectory: entry.isDirectory(),
                size,
            });
        }
        // Sort: directories first, then alphabetically
        items.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        res.json({ items, root });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Read file ─────────────────────────────────────────────────

fileApi.get('/file', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const root = ws(req);
    const v = validatePath(filePath, root);
    if (!v.safe) return res.status(403).json({ error: v.error });
    if (isBlockedFile(v.resolved)) return res.status(403).json({ error: 'Access to this file is blocked' });
    if (isBinaryFile(v.resolved)) return res.status(400).json({ error: 'Binary file — cannot display' });

    try {
        const stat = await fs.stat(v.resolved);
        if (stat.size > MAX_FILE_SIZE) return res.status(400).json({ error: 'File too large (>2MB)' });
        const content = await fs.readFile(v.resolved, 'utf-8');
        res.json({ content, path: filePath, size: stat.size });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

// ── Write / save file ─────────────────────────────────────────

fileApi.put('/file', async (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const root = ws(req);
    const v = validatePath(filePath, root);
    if (!v.safe) return res.status(403).json({ error: v.error });
    if (isBlockedFile(v.resolved)) return res.status(403).json({ error: 'Cannot write to this file' });

    try {
        await fs.writeFile(v.resolved, content, 'utf-8');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Create file or directory ──────────────────────────────────

fileApi.post('/file/create', async (req, res) => {
    const { path: filePath, isDirectory } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const root = ws(req);
    const v = validatePath(filePath, root);
    if (!v.safe) return res.status(403).json({ error: v.error });

    try {
        if (isDirectory) {
            await fs.mkdir(v.resolved, { recursive: true });
        } else {
            await fs.mkdir(path.dirname(v.resolved), { recursive: true });
            await fs.writeFile(v.resolved, '', 'utf-8');
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Rename / move ─────────────────────────────────────────────

fileApi.post('/file/move', async (req, res) => {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const root = ws(req);
    const vFrom = validatePath(from, root);
    const vTo = validatePath(to, root);
    if (!vFrom.safe) return res.status(403).json({ error: vFrom.error });
    if (!vTo.safe) return res.status(403).json({ error: vTo.error });

    try {
        await fs.rename(vFrom.resolved, vTo.resolved);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Delete ────────────────────────────────────────────────────

fileApi.delete('/file', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const root = ws(req);
    const v = validatePath(filePath, root);
    if (!v.safe) return res.status(403).json({ error: v.error });

    try {
        const stat = await fs.stat(v.resolved);
        if (stat.isDirectory()) {
            await fs.rm(v.resolved, { recursive: true });
        } else {
            await fs.unlink(v.resolved);
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Upload (images for multimodal) ────────────────────────────

fileApi.post('/file/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
        ok: true,
        filename: req.file.originalname,
        path: req.file.path,
        mimetype: req.file.mimetype,
        size: req.file.size,
    });
});

// ── Replace (find-and-replace with diff preview) ──────────────

fileApi.post('/replace', async (req, res) => {
    const { path: filePath, oldString, newString, preview } = req.body;
    if (!filePath || oldString === undefined) return res.status(400).json({ error: 'path and oldString required' });
    const root = ws(req);
    const v = validatePath(filePath, root);
    if (!v.safe) return res.status(403).json({ error: v.error });

    try {
        const content = await fs.readFile(v.resolved, 'utf-8');
        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) return res.status(404).json({ error: 'String not found' });

        const newContent = content.replaceAll(oldString, newString ?? '');

        if (preview) {
            // Return diff preview without applying
            return res.json({ preview: true, occurrences, oldString, newString });
        }

        await fs.writeFile(v.resolved, newContent, 'utf-8');
        res.json({ ok: true, occurrences });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
