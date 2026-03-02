import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const sessionsApi = Router();

const geminiDir = path.join(os.homedir(), '.gemini');
const tmpDir = path.join(geminiDir, 'tmp');

// Helper: extract text from a message content field (can be string, array of parts, or object)
function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // parts array — find text parts, skip inline_data / inlineData
        return content
            .filter(p => p.text || typeof p === 'string')
            .map(p => p.text || p)
            .join(' ');
    }
    if (content && typeof content === 'object') {
        if (content.text) return content.text;
        if (content.parts) return extractText(content.parts);
        return '';
    }
    return '';
}

// Helper: strip heavy binary data from messages before sending to frontend
function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(msg => {
        const clean = { ...msg };
        // Handle content that is an array of parts with inlineData
        if (Array.isArray(clean.content)) {
            clean.content = clean.content.map(part => {
                if (part.inlineData || part.inline_data) {
                    return { text: `[${part.inlineData?.mimeType || part.inline_data?.mimeType || 'binary'} attachment]` };
                }
                return part;
            });
            clean.content = extractText(clean.content);
        } else if (clean.content && typeof clean.content === 'object') {
            clean.content = extractText(clean.content);
        }
        // Remove any data/inlineData fields directly on the message
        delete clean.inlineData;
        delete clean.inline_data;
        delete clean.data;
        // Cap content to prevent huge payloads
        if (typeof clean.content === 'string' && clean.content.length > 50000) {
            clean.content = clean.content.slice(0, 50000) + '\n\n[Content truncated — too large to display]';
        }
        return clean;
    });
}

function extractLastModel(messages) {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const model = messages[i]?.model;
        if (typeof model === 'string' && model.trim()) return model.trim();
    }
    return null;
}

// ── List saved sessions ───────────────────────────────────────
// Gemini CLI stores sessions at: ~/.gemini/tmp/<project_hash>/chats/session-<timestamp>-<id>.json
// Each session JSON has: { sessionId, projectHash, startTime, lastUpdated, messages: [...] }

sessionsApi.get('/sessions', async (_req, res) => {
    try {
        const sessions = [];

        // Check if tmp dir exists
        try {
            await fs.access(tmpDir);
        } catch {
            return res.json({ sessions: [] });
        }

        // Enumerate project hash directories
        const projectDirs = await fs.readdir(tmpDir, { withFileTypes: true });

        for (const projDir of projectDirs) {
            if (!projDir.isDirectory()) continue;

            const chatsDir = path.join(tmpDir, projDir.name, 'chats');
            try {
                await fs.access(chatsDir);
            } catch {
                continue; // no chats dir
            }

            // Read .project_root if it exists for a human-readable project name
            let projectName = projDir.name.slice(0, 12) + '...';
            let projectRoot = null;
            try {
                const rootContent = await fs.readFile(path.join(tmpDir, projDir.name, '.project_root'), 'utf-8');
                const trimmed = rootContent.trim();
                if (trimmed) {
                    projectRoot = trimmed;
                    // Extract last directory name from path for a clean label
                    projectName = path.basename(trimmed) || trimmed;
                }
            } catch { /* no .project_root file */ }

            // Read session JSON files
            const chatFiles = await fs.readdir(chatsDir);
            for (const chatFile of chatFiles) {
                if (!chatFile.endsWith('.json')) continue;
                const chatPath = path.join(chatsDir, chatFile);

                try {
                    const raw = await fs.readFile(chatPath, 'utf-8');
                    const data = JSON.parse(raw);

                    // Extract preview from first user message
                    let preview = '';
                    let messageCount = 0;
                    let model = null;
                    if (data.messages && Array.isArray(data.messages)) {
                        messageCount = data.messages.length;
                        model = extractLastModel(data.messages);
                        const firstUser = data.messages.find(m => m.type === 'user' || m.type === 'query');
                        if (firstUser) {
                            preview = extractText(firstUser.content).slice(0, 120);
                        } else if (data.messages.length > 0) {
                            preview = extractText(data.messages[0].content).slice(0, 120);
                        }
                    }

                    sessions.push({
                        id: data.sessionId || chatFile.replace('.json', ''),
                        projectHash: projDir.name,
                        projectName,
                        projectRoot,
                        filename: chatFile,
                        startTime: data.startTime,
                        lastUpdated: data.lastUpdated,
                        messageCount,
                        model,
                        preview,
                    });
                } catch {
                    // skip corrupt session files
                }
            }
        }

        // Sort by most recent first
        sessions.sort((a, b) => {
            const da = new Date(b.lastUpdated || b.startTime || 0);
            const db = new Date(a.lastUpdated || a.startTime || 0);
            return da - db;
        });

        res.json({ sessions });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Get single session detail ─────────────────────────────────

sessionsApi.get('/sessions/:projectHash/:filename', async (req, res) => {
    const { projectHash, filename } = req.params;
    // Validate no traversal
    if (projectHash.includes('..') || filename.includes('..')) {
        return res.status(403).json({ error: 'Invalid path' });
    }
    const sessionPath = path.join(tmpDir, projectHash, 'chats', filename);
    try {
        const raw = await fs.readFile(sessionPath, 'utf-8');
        const data = JSON.parse(raw);

        let projectRoot = null;
        try {
            const rootContent = await fs.readFile(path.join(tmpDir, projectHash, '.project_root'), 'utf-8');
            const trimmed = rootContent.trim();
            if (trimmed) projectRoot = trimmed;
        } catch { /* no .project_root */ }

        // Sanitize messages to strip binary data before sending to frontend
        const originalMessages = Array.isArray(data.messages) ? data.messages : [];
        data.messages = sanitizeMessages(originalMessages);
        data.projectRoot = projectRoot;
        data.model = extractLastModel(originalMessages);
        res.json(data);
    } catch (e) {
        res.status(404).json({ error: 'Session not found' });
    }
});

// ── Delete a session file ────────────────────────────────────

sessionsApi.delete('/sessions/:projectHash/:filename', async (req, res) => {
    const { projectHash, filename } = req.params;
    if (projectHash.includes('..') || filename.includes('..') || !filename.endsWith('.json')) {
        return res.status(403).json({ error: 'Invalid path' });
    }

    const sessionPath = path.join(tmpDir, projectHash, 'chats', filename);
    try {
        await fs.unlink(sessionPath);
        res.json({ ok: true });
    } catch (e) {
        res.status(404).json({ error: 'Session not found' });
    }
});

// ── Read GEMINI.md memory ─────────────────────────────────────

sessionsApi.get('/memory', async (_req, res) => {
    try {
        const memoryPath = path.join(geminiDir, 'GEMINI.md');
        try {
            const content = await fs.readFile(memoryPath, 'utf-8');
            res.json({ content, path: memoryPath });
        } catch {
            res.json({ content: '', path: memoryPath });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Update GEMINI.md memory ───────────────────────────────────

sessionsApi.put('/memory', async (req, res) => {
    try {
        const { content } = req.body;
        const memoryPath = path.join(geminiDir, 'GEMINI.md');
        await fs.mkdir(geminiDir, { recursive: true });
        await fs.writeFile(memoryPath, content, 'utf-8');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
