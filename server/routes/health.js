import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);
export const healthApi = Router();
const HEALTH_TTL_MS = 15000;
let cachedHealth = null;
let cachedAt = 0;

healthApi.get('/health', async (_req, res) => {
    if (cachedHealth && (Date.now() - cachedAt) < HEALTH_TTL_MS) {
        return res.json(cachedHealth);
    }

    const info = {
        status: 'ok',
        platform: process.platform,
        geminiCli: { installed: false, version: null },
        sessionDir: null,
        memoryFile: null,
    };

    // Check Gemini CLI path first.
    const pathCmd = process.platform === 'win32' ? 'where.exe gemini 2>NUL' : 'which gemini 2>/dev/null';
    try {
        const { stdout } = await execAsync(pathCmd, { timeout: 3000, shell: true });
        const firstLine = stdout.trim().split('\n')[0]?.trim();
        if (firstLine) {
            info.geminiCli.installed = true;
            info.geminiCli.path = firstLine;
        }
    } catch {
        // keep installed=false
    }

    // Keep /health fast and non-blocking. We only require install detection here.
    if (info.geminiCli.installed) info.geminiCli.version = 'detected';

    // Check session directory — Gemini CLI stores sessions in ~/.gemini/tmp/<hash>/chats/
    const geminiDir = path.join(os.homedir(), '.gemini');
    const tmpDir = path.join(geminiDir, 'tmp');
    try {
        await fs.access(tmpDir);
        info.sessionDir = tmpDir;
    } catch { /* no tmp dir */ }

    // Check memory file
    try {
        await fs.access(path.join(geminiDir, 'GEMINI.md'));
        info.memoryFile = path.join(geminiDir, 'GEMINI.md');
    } catch { /* no memory file */ }

    cachedHealth = info;
    cachedAt = Date.now();
    res.json(info);
});
