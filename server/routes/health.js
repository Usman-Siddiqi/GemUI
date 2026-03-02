import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);
export const healthApi = Router();

healthApi.get('/health', async (_req, res) => {
    const info = {
        status: 'ok',
        platform: process.platform,
        geminiCli: { installed: false, version: null },
        sessionDir: null,
        memoryFile: null,
    };

    // Check Gemini CLI — try multiple approaches since --version isn't always valid
    const detectCommands = [
        process.platform === 'win32' ? 'where.exe gemini 2>NUL' : 'which gemini 2>/dev/null',
        'gemini -h',
    ];

    for (const cmd of detectCommands) {
        try {
            const { stdout } = await execAsync(cmd, { timeout: 10000, shell: true });
            info.geminiCli.installed = true;
            // Try to extract version from help output
            const versionMatch = stdout.match(/(?:version|v)\s*([\d.]+)/i);
            if (versionMatch) info.geminiCli.version = versionMatch[1];
            // If from 'where'/'which', the path tells us it exists
            if (cmd.includes('where') || cmd.includes('which')) {
                info.geminiCli.path = stdout.trim().split('\n')[0].trim();
            }
            break;
        } catch {
            // try next command
        }
    }

    // If still no version, try 'gemini -h' output directly
    if (info.geminiCli.installed && !info.geminiCli.version) {
        try {
            const { stdout } = await execAsync('gemini -h', { timeout: 10000, shell: true });
            const m = stdout.match(/Gemini CLI/i);
            if (m) info.geminiCli.version = 'detected';
        } catch { /* ignore */ }
    }

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

    res.json(info);
});
