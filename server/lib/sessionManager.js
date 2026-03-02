import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

let ptyModule = null;
const NODE_MAJOR = Number(process.versions.node.split('.')[0] || 0);
const FORCE_WINDOWS_PIPE_TERMINAL = process.platform === 'win32' && NODE_MAJOR >= 25;
const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;

async function getPty() {
    if (ptyModule) return ptyModule;
    try {
        ptyModule = await import('node-pty');
        if (ptyModule.default) ptyModule = ptyModule.default;
    } catch (e) {
        console.error('Failed to load node-pty:', e.message);
        throw new Error('node-pty not available — terminal mode disabled');
    }
    return ptyModule;
}

function sanitizeModelName(model) {
    if (!model || typeof model !== 'string') return null;
    const trimmed = model.trim();
    if (!trimmed || !SAFE_MODEL_PATTERN.test(trimmed)) return null;
    return trimmed;
}

/**
 * Manages Gemini CLI sessions:
 * - Terminal mode: raw PTY shell (interactive xterm.js)
 * - Chat mode: headless `gemini` per message, prompt piped via stdin
 */
export class SessionManager {
    constructor() {
        /** @type {Map<string, object>} */
        this.sessions = new Map();
    }

    // ── Terminal Mode: raw PTY shell ─────────────────────────────────

    async createTerminalSession(cwd, ws) {
        const id = randomUUID();
        const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');

        if (FORCE_WINDOWS_PIPE_TERMINAL) {
            return this._createPipeTerminalSession({ id, cwd, ws, shell });
        }

        try {
            const pty = await getPty();
            const proc = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd,
                env: { ...process.env, TERM: 'xterm-256color' },
            });

            proc.onData((data) => {
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ event: 'terminal:output', data: { sessionId: id, output: data } }));
                }
            });

            proc.onExit(({ exitCode }) => {
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ event: 'terminal:exit', data: { sessionId: id, code: exitCode } }));
                }
                this.sessions.delete(id);
            });

            const session = { id, mode: 'terminal', cwd, proc, ws, startTime: Date.now(), lastActivity: Date.now() };
            this.sessions.set(id, session);
            return session;
        } catch (err) {
            console.warn('[Terminal] Falling back to pipe mode:', err.message);
            return this._createPipeTerminalSession({ id, cwd, ws, shell });
        }
    }

    // ── Chat Mode: headless gemini per message ──────────────────────
    // Prompt is piped via stdin to avoid Windows shell escaping issues.
    // shell:true is needed for .cmd files on Windows.

    createChatSession(cwd, ws, { model, yolo } = {}) {
        const id = randomUUID();
        const session = {
            id, mode: 'chat', cwd, model: sanitizeModelName(model), yolo: !!yolo, ws,
            proc: null,
            startTime: Date.now(),
            lastActivity: Date.now(),
        };
        this.sessions.set(id, session);
        return session;
    }

    sendChatMessage(sessionId, prompt) {
        const s = this.sessions.get(sessionId);
        if (!s || s.mode !== 'chat') return;
        this._updateActivity(sessionId);

        // Kill any existing running process
        if (s.proc) {
            try { s.proc.kill('SIGTERM'); } catch { /* ok */ }
        }

        // Build args — NO user content in args to avoid shell escaping issues.
        // Prompt is piped via stdin below.
        const args = ['-o', 'text'];
        if (s.model) args.push('-m', s.model);
        if (s.yolo) args.push('--yolo');

        const command = process.platform === 'win32' ? 'cmd.exe' : 'gemini';
        const spawnArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'gemini', ...args] : args;
        const proc = spawn(command, spawnArgs, {
            cwd: s.cwd,
            env: { ...process.env, NO_COLOR: '1' },
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        // Pipe prompt via stdin — this bypasses all shell escaping issues
        try {
            proc.stdin.write(prompt);
            proc.stdin.end();
        } catch (err) {
            console.error('[Chat] stdin write failed:', err.message);
        }

        s.proc = proc;
        let buffer = '';
        let flushTimer = null;

        const flushBuffer = () => {
            if (buffer.length > 0 && s.ws.readyState === 1) {
                s.ws.send(JSON.stringify({ event: 'chat:chunk', data: { sessionId, text: buffer } }));
                buffer = '';
            }
        };

        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            if (!flushTimer) {
                flushTimer = setTimeout(() => { flushTimer = null; flushBuffer(); }, 50);
            }
        });

        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            // Filter out common info/noise from stderr
            if (text.includes('Loaded cached credentials') ||
                text.includes('DeprecationWarning') ||
                text.includes('ExperimentalWarning')) return;
            if (s.ws.readyState === 1) {
                s.ws.send(JSON.stringify({ event: 'chat:error', data: { sessionId, text } }));
            }
        });

        proc.on('close', (code) => {
            clearTimeout(flushTimer);
            flushBuffer();
            if (s.ws.readyState === 1) {
                s.ws.send(JSON.stringify({ event: 'chat:done', data: { sessionId, code } }));
            }
            s.proc = null;
        });

        proc.on('error', (err) => {
            console.error('[Chat] Process error:', err.message);
            if (s.ws.readyState === 1) {
                s.ws.send(JSON.stringify({ event: 'chat:error', data: { sessionId, text: 'Failed to run gemini: ' + err.message } }));
                s.ws.send(JSON.stringify({ event: 'chat:done', data: { sessionId, code: -1 } }));
            }
            s.proc = null;
        });
    }

    // ── Session Operations ─────────────────────────────────────────

    writeToSession(sessionId, text) {
        const s = this.sessions.get(sessionId);
        if (!s || (s.mode !== 'terminal' && s.mode !== 'terminal-pipe')) return;
        this._updateActivity(sessionId);
        if (s.mode === 'terminal') {
            s.proc.write(text);
        } else {
            try { s.proc.stdin.write(text); } catch { /* process already gone */ }
        }
    }

    resizeSession(sessionId, cols, rows) {
        const s = this.sessions.get(sessionId);
        if (!s || s.mode !== 'terminal') return;
        try { s.proc.resize(cols, rows); } catch { /* already exited */ }
    }

    destroySession(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        try {
            if (s.mode === 'terminal') {
                // node-pty can crash on kill under some Windows/Node versions.
                // Graceful shell exit keeps the server alive.
                if (process.platform === 'win32') {
                    try { s.proc.write('\x03'); } catch { /* noop */ }
                    try { s.proc.write('exit\r'); } catch { /* noop */ }
                } else {
                    s.proc.kill();
                }
            } else if (s.mode === 'terminal-pipe') {
                try { s.proc.stdin.write('exit\r\n'); } catch { /* noop */ }
                setTimeout(() => {
                    try { s.proc.kill('SIGTERM'); } catch { /* noop */ }
                }, 300);
            } else if (s.proc) {
                s.proc.kill('SIGTERM');
            }
        } catch { /* already exited */ }
        this.sessions.delete(sessionId);
    }

    listSessions() {
        return [...this.sessions.values()].map(s => ({
            id: s.id, mode: s.mode, cwd: s.cwd, model: s.model,
            startTime: s.startTime, lastActivity: s.lastActivity,
        }));
    }

    _updateActivity(sessionId) {
        const s = this.sessions.get(sessionId);
        if (s) s.lastActivity = Date.now();
    }

    _createPipeTerminalSession({ id, cwd, ws, shell }) {
        const args = process.platform === 'win32' ? ['-NoLogo'] : ['-i'];
        const proc = spawn(shell, args, {
            cwd,
            env: { ...process.env, TERM: 'xterm-256color' },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        const emitOutput = (chunk) => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                    event: 'terminal:output',
                    data: { sessionId: id, output: chunk.toString() },
                }));
            }
        };

        proc.stdout.on('data', emitOutput);
        proc.stderr.on('data', emitOutput);

        proc.on('close', (code) => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ event: 'terminal:exit', data: { sessionId: id, code } }));
            }
            this.sessions.delete(id);
        });

        proc.on('error', (err) => {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                    event: 'terminal:output',
                    data: { sessionId: id, output: `\r\n[terminal error] ${err.message}\r\n` },
                }));
                ws.send(JSON.stringify({ event: 'terminal:exit', data: { sessionId: id, code: -1 } }));
            }
            this.sessions.delete(id);
        });

        const session = { id, mode: 'terminal-pipe', cwd, proc, ws, startTime: Date.now(), lastActivity: Date.now() };
        this.sessions.set(id, session);
        return session;
    }
}
