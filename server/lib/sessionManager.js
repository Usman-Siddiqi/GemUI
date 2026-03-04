import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';

let ptyModule = null;
const NODE_MAJOR = Number(process.versions.node.split('.')[0] || 0);
const FORCE_WINDOWS_PIPE_TERMINAL = process.platform === 'win32' && NODE_MAJOR >= 25;
const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;
const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const SAFE_ATTACHMENT_NAME_PATTERN = /^[^\\/:*?"<>|]+$/;
const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION;
const GEMINI_CLI_JS = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js')
    : '';
const HAS_DIRECT_GEMINI_CLI_JS = process.platform === 'win32' && GEMINI_CLI_JS && fs.existsSync(GEMINI_CLI_JS);
const DEFAULT_WARM_MODEL = 'gemini-2.5-flash';
const TMP_UPLOAD_DIR = path.resolve(path.join(process.env.TEMP || os.tmpdir() || '/tmp', 'gemui-uploads'));
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_TEXT_ATTACHMENT_BYTES = 256 * 1024;
const MAX_INLINE_TEXT_CHARS = 12000;
const MAX_INLINE_ATTACHMENTS = 3;
const NOOP_WS = { readyState: 0, send: () => { } };

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

function sanitizeSessionId(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    const trimmed = sessionId.trim();
    if (!trimmed || !SAFE_SESSION_ID_PATTERN.test(trimmed)) return null;
    return trimmed;
}

function isPathWithin(base, target) {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeAttachmentName(name, fallbackPath) {
    const candidate = typeof name === 'string' ? name.trim() : '';
    if (candidate && SAFE_ATTACHMENT_NAME_PATTERN.test(candidate)) return candidate;
    return path.basename(fallbackPath || 'attachment');
}

function toSafeRelativePath(root, absPath) {
    if (!root || !absPath) return absPath;
    try {
        const rel = path.relative(root, absPath);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
            ? rel.replace(/\\/g, '/')
            : absPath;
    } catch {
        return absPath;
    }
}

function formatContextUsage(usedRaw, sizeRaw, source = 'acp') {
    const used = Number(usedRaw);
    const size = Number(sizeRaw);
    if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
    const clampedUsed = Math.max(0, Math.min(used, size));
    const remaining = Math.max(0, size - clampedUsed);
    const percent = Math.max(0, Math.min((clampedUsed / size) * 100, 100));
    return {
        used: Math.round(clampedUsed),
        size: Math.round(size),
        remaining: Math.round(remaining),
        percent,
        source,
        updatedAt: new Date().toISOString(),
    };
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const num = Number(value);
        if (Number.isFinite(num)) return num;
    }
    return null;
}

function extractContextUsageFromStats(stats, source = 'stream-json') {
    if (!stats || typeof stats !== 'object') return null;

    const nestedContext = stats.context && typeof stats.context === 'object' ? stats.context : null;
    const used = firstFiniteNumber(
        stats.used,
        stats.contextUsed,
        stats.context_used,
        stats.contextWindowUsed,
        stats.context_window_used,
        stats.tokensInContext,
        stats.tokens_in_context,
        nestedContext?.used,
        nestedContext?.contextUsed,
        nestedContext?.context_used,
        nestedContext?.contextWindowUsed,
        nestedContext?.context_window_used,
    );
    const size = firstFiniteNumber(
        stats.size,
        stats.contextSize,
        stats.context_size,
        stats.contextWindowSize,
        stats.context_window_size,
        stats.maxContextTokens,
        stats.max_context_tokens,
        nestedContext?.size,
        nestedContext?.contextSize,
        nestedContext?.context_size,
        nestedContext?.contextWindowSize,
        nestedContext?.context_window_size,
    );
    return formatContextUsage(used, size, source);
}

function pickPermissionOption(options, { yolo, toolTitle }) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const title = String(toolTitle || '').toLowerCase();
    const isLikelyReadOnly = /read|search|find|glob|list|fetch/i.test(title);

    const weight = (option) => {
        const text = `${option?.name || ''} ${option?.kind || ''}`.toLowerCase();

        if (yolo || isLikelyReadOnly) {
            if (/allow.*always|approve.*always/.test(text)) return 130;
            if (/allow.*once|approve.*once/.test(text)) return 120;
            if (/allow|approve|continue|yes/.test(text)) return 100;
            if (/cancel|deny|reject|no/.test(text)) return 10;
            return 40;
        }

        if (/deny.*always|reject.*always/.test(text)) return 130;
        if (/deny.*once|reject.*once|cancel|no/.test(text)) return 120;
        if (/allow.*once|approve.*once/.test(text)) return 60;
        if (/allow|approve|continue|yes/.test(text)) return 30;
        return 20;
    };

    return options.slice().sort((a, b) => weight(b) - weight(a))[0];
}

function getErrorText(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.message || String(err);
    if (typeof err === 'object') {
        if (typeof err.message === 'string') return err.message;
        if (typeof err.error?.message === 'string') return err.error.message;
    }
    return String(err);
}

function buildGeminiSpawn(args, cwd) {
    if (process.platform === 'win32') {
        // Avoid cmd wrapper overhead and shell escaping when possible.
        if (HAS_DIRECT_GEMINI_CLI_JS) {
            return {
                command: process.execPath,
                spawnArgs: ['--no-warnings=DEP0040', GEMINI_CLI_JS, ...args],
                options: {
                    cwd,
                    env: { ...process.env, NO_COLOR: '1' },
                    shell: false,
                    windowsHide: true,
                },
            };
        }
        return {
            command: 'cmd.exe',
            spawnArgs: ['/d', '/s', '/c', 'gemini', ...args],
            options: {
                cwd,
                env: { ...process.env, NO_COLOR: '1' },
                shell: false,
                windowsHide: true,
            },
        };
    }

    return {
        command: 'gemini',
        spawnArgs: args,
        options: {
            cwd,
            env: { ...process.env, NO_COLOR: '1' },
            shell: false,
            windowsHide: true,
        },
    };
}

/**
 * Manages Gemini CLI sessions:
 * - Terminal mode: raw PTY shell (interactive xterm.js)
 * - Chat mode: headless `gemini` per message (`stream-json`)
 */
export class SessionManager {
    constructor() {
        /** @type {Map<string, object>} */
        this.sessions = new Map();
        this.bootstrapChatSessionId = null;
        // Pre-start default Gemini runtime at server boot so the app feels ready immediately.
        this._warmBootstrapChatSession();
    }

    _buildChatSession(id, cwd, ws, model, yolo, { bootstrap = false, resumeSessionId = null } = {}) {
        return {
            id,
            mode: 'chat',
            cwd,
            model: sanitizeModelName(model),
            resumeSessionId: sanitizeSessionId(resumeSessionId),
            contextUsage: null,
            yolo: !!yolo,
            ws,
            proc: null,
            acp: null,
            acpInitPromise: null,
            activePromptToken: null,
            bootstrap,
            startTime: Date.now(),
            lastActivity: Date.now(),
        };
    }

    _warmBootstrapChatSession() {
        if (this.bootstrapChatSessionId) return;
        const id = randomUUID();
        const session = this._buildChatSession(id, '.', NOOP_WS, DEFAULT_WARM_MODEL, false, { bootstrap: true });
        this.sessions.set(id, session);
        this.bootstrapChatSessionId = id;

        this._ensureAcpRuntime(id, session).catch(() => {
            if (this.sessions.get(id) === session) this.sessions.delete(id);
            if (this.bootstrapChatSessionId === id) this.bootstrapChatSessionId = null;
            setTimeout(() => {
                if (!this.bootstrapChatSessionId) this._warmBootstrapChatSession();
            }, 15000);
        });
    }

    _takeBootstrapChatSession(cwd, ws, model, yolo) {
        if (!this.bootstrapChatSessionId) return null;
        const id = this.bootstrapChatSessionId;
        const session = this.sessions.get(id);
        if (!session || session.mode !== 'chat' || !session.bootstrap) {
            this.bootstrapChatSessionId = null;
            return null;
        }

        if (session.cwd !== cwd || session.model !== model || session.yolo !== yolo) {
            return null;
        }

        session.ws = ws;
        session.bootstrap = false;
        session.lastActivity = Date.now();
        this.bootstrapChatSessionId = null;
        // Keep a warm spare ready for future chat sessions.
        this._warmBootstrapChatSession();
        return session;
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

    // ── Chat Mode: persistent ACP session (with one-shot fallback) ──

    createChatSession(cwd, ws, { model, yolo } = {}) {
        const normalizedModel = sanitizeModelName(model);
        const normalizedYolo = !!yolo;
        const adopted = this._takeBootstrapChatSession(cwd, ws, normalizedModel, normalizedYolo);
        if (adopted) return adopted;

        const id = randomUUID();
        const session = this._buildChatSession(id, cwd, ws, normalizedModel, normalizedYolo);
        this.sessions.set(id, session);
        // Warm an ACP session in the background so first prompt is fast.
        this._ensureAcpRuntime(id, session).catch(() => { /* fallback path handles this */ });
        return session;
    }

    resumeChatSession(cwd, ws, { sessionId, model, yolo } = {}) {
        const resumeSessionId = sanitizeSessionId(sessionId);
        if (!resumeSessionId) {
            throw new Error('Invalid Gemini session ID for resume.');
        }

        const normalizedModel = sanitizeModelName(model);
        const normalizedYolo = !!yolo;
        const id = randomUUID();
        const session = this._buildChatSession(id, cwd, ws, normalizedModel, normalizedYolo, { resumeSessionId });
        this.sessions.set(id, session);
        this._ensureAcpRuntime(id, session).catch(() => { /* fallback path handles this */ });
        return session;
    }

    sendChatMessage(sessionId, prompt, { attachments } = {}) {
        const s = this.sessions.get(sessionId);
        if (!s || s.mode !== 'chat') return;
        this._updateActivity(sessionId);

        // Kill any one-shot fallback process if one is running.
        if (s.proc) {
            try { s.proc.kill('SIGTERM'); } catch { /* ok */ }
        }

        this._normalizeAttachments(attachments, s.cwd)
            .then((normalizedAttachments) => {
                // Prompts run async to keep WS event loop responsive.
                this._runChatAcpPrompt(sessionId, s, prompt, {
                    allowModelFallback: true,
                    attachments: normalizedAttachments,
                }).catch((err) => {
                    if (this.sessions.get(sessionId) !== s) return;
                    if (s.ws.readyState === 1) {
                        s.ws.send(JSON.stringify({
                            event: 'chat:error',
                            data: { sessionId, text: `Chat request failed: ${getErrorText(err) || 'Unknown error'}` },
                        }));
                        s.ws.send(JSON.stringify({ event: 'chat:done', data: { sessionId, code: -1 } }));
                    }
                }).finally(() => {
                    this._cleanupUploadedAttachments(normalizedAttachments).catch(() => { /* noop */ });
                });
            })
            .catch((err) => {
                if (this.sessions.get(sessionId) !== s) return;
                if (s.ws.readyState === 1) {
                    s.ws.send(JSON.stringify({
                        event: 'chat:error',
                        data: { sessionId, text: `Attachment error: ${getErrorText(err) || 'Failed to process attachments'}` },
                    }));
                    s.ws.send(JSON.stringify({ event: 'chat:done', data: { sessionId, code: -1 } }));
                }
            });
    }

    async _normalizeAttachments(rawAttachments, cwd) {
        if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];

        const workspaceRoot = path.resolve(cwd || '.');
        const normalized = [];

        for (const item of rawAttachments.slice(0, MAX_ATTACHMENTS)) {
            const candidatePath = typeof item?.path === 'string' ? item.path.trim() : '';
            if (!candidatePath) continue;

            const resolvedPath = path.resolve(candidatePath);
            const inUploads = isPathWithin(TMP_UPLOAD_DIR, resolvedPath);
            const inWorkspace = isPathWithin(workspaceRoot, resolvedPath);
            if (!inUploads && !inWorkspace) continue;

            let stat;
            try {
                stat = await fsp.stat(resolvedPath);
            } catch {
                continue;
            }
            if (!stat.isFile()) continue;
            if (stat.size > MAX_ATTACHMENT_BYTES) continue;

            const mimeType = typeof item?.mimetype === 'string' && item.mimetype.trim()
                ? item.mimetype.trim().toLowerCase()
                : (typeof item?.mimeType === 'string' && item.mimeType.trim()
                    ? item.mimeType.trim().toLowerCase()
                    : 'application/octet-stream');

            const attachment = {
                name: normalizeAttachmentName(item?.filename || item?.name, resolvedPath),
                path: resolvedPath,
                displayPath: toSafeRelativePath(workspaceRoot, resolvedPath),
                mimeType,
                size: Number.isFinite(Number(item?.size)) ? Number(item.size) : stat.size,
                uploaded: inUploads,
            };

            normalized.push(attachment);
        }

        return normalized;
    }

    async _buildPromptBundle(prompt, attachments, cwd) {
        const promptText = String(prompt || '').trim();
        const safeAttachments = Array.isArray(attachments) ? attachments : [];
        const textSections = [];
        const imageParts = [];
        const referenceLines = [];
        let inlineTextCount = 0;

        for (const attachment of safeAttachments) {
            referenceLines.push(`- ${attachment.name} (${attachment.displayPath})`);

            if (attachment.mimeType.startsWith('image/')) {
                try {
                    const buf = await fsp.readFile(attachment.path);
                    imageParts.push({
                        type: 'image',
                        mimeType: attachment.mimeType,
                        data: buf.toString('base64'),
                        uri: `file://${attachment.path.replace(/\\/g, '/')}`,
                    });
                } catch {
                    textSections.push(`Attachment "${attachment.name}" could not be read as an image.`);
                }
                continue;
            }

            if (inlineTextCount >= MAX_INLINE_ATTACHMENTS) continue;
            if (attachment.size > MAX_INLINE_TEXT_ATTACHMENT_BYTES) continue;
            if (!/^text\/|application\/(json|xml|javascript|x-javascript|x-sh|x-shellscript)/.test(attachment.mimeType)) {
                continue;
            }

            try {
                const raw = await fsp.readFile(attachment.path, 'utf8');
                const clipped = raw.length > MAX_INLINE_TEXT_CHARS
                    ? `${raw.slice(0, MAX_INLINE_TEXT_CHARS)}\n\n[...truncated...]`
                    : raw;
                const ext = path.extname(attachment.name).replace('.', '');
                textSections.push(`Attached file: ${attachment.name}\n\`\`\`${ext || 'text'}\n${clipped}\n\`\`\``);
                inlineTextCount += 1;
            } catch {
                textSections.push(`Attachment "${attachment.name}" could not be read as text.`);
            }
        }

        let combinedText = promptText;
        if (referenceLines.length > 0) {
            combinedText += `${combinedText ? '\n\n' : ''}Attached files:\n${referenceLines.join('\n')}`;
        }
        if (textSections.length > 0) {
            combinedText += `${combinedText ? '\n\n' : ''}${textSections.join('\n\n')}`;
        }
        if (!combinedText) combinedText = 'Please analyze the attached files.';

        const acpPrompt = [{ type: 'text', text: combinedText }, ...imageParts];
        const cliPrompt = imageParts.length > 0
            ? `${combinedText}\n\nImage references:\n${safeAttachments.filter((a) => a.mimeType.startsWith('image/')).map((a) => `@${a.path}`).join('\n')}`
            : combinedText;

        return { acpPrompt, cliPrompt };
    }

    async _cleanupUploadedAttachments(attachments) {
        if (!Array.isArray(attachments) || attachments.length === 0) return;
        const deletions = attachments
            .filter((a) => a?.uploaded && typeof a?.path === 'string')
            .map((a) => fsp.unlink(a.path).catch(() => { /* noop */ }));
        await Promise.all(deletions);
    }

    _emitContextUsage(sessionId, s, context, source = 'acp') {
        if (!context) return;
        const payload = { ...context, source };
        s.contextUsage = payload;
        if (s.ws.readyState === 1) {
            s.ws.send(JSON.stringify({
                event: 'chat:meta',
                data: { sessionId, context: payload },
            }));
        }
    }

    async _ensureAcpRuntime(sessionId, s) {
        if (s.acp) return s.acp;
        if (s.acpInitPromise) return s.acpInitPromise;

        if (s.ws.readyState === 1) {
            s.ws.send(JSON.stringify({
                event: 'chat:meta',
                data: { sessionId, phase: 'warming' },
            }));
        }

        s.acpInitPromise = this._createAcpRuntime(sessionId, s)
            .then((runtime) => {
                if (this.sessions.get(sessionId) !== s) {
                    runtime.closedByManager = true;
                    try { runtime.proc.kill('SIGTERM'); } catch { /* noop */ }
                    throw new Error('Chat session was replaced while initializing');
                }
                s.acp = runtime;
                if (s.ws.readyState === 1) {
                    s.ws.send(JSON.stringify({
                        event: 'chat:meta',
                        data: { sessionId, phase: 'ready' },
                    }));
                    if (s.contextUsage) {
                        s.ws.send(JSON.stringify({
                            event: 'chat:meta',
                            data: { sessionId, context: s.contextUsage },
                        }));
                    }
                }
                return runtime;
            })
            .finally(() => {
                if (this.sessions.get(sessionId) === s) {
                    s.acpInitPromise = null;
                }
            });

        return s.acpInitPromise;
    }

    async _createAcpRuntime(sessionId, s) {
        const args = ['--experimental-acp'];
        if (s.model) args.push('-m', s.model);
        if (s.yolo) args.push('--approval-mode', 'yolo');

        const { command, spawnArgs, options } = buildGeminiSpawn(args, s.cwd);
        const proc = spawn(command, spawnArgs, {
            ...options,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderrBuffer = '';
        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            if (text.includes('Loaded cached credentials') ||
                text.includes('DeprecationWarning') ||
                text.includes('ExperimentalWarning')) return;
            stderrBuffer += text;
        });

        const runtime = {
            proc,
            connection: null,
            sessionId: null,
            closedByManager: false,
            onAssistantText: null,
            onMeta: null,
        };

        const client = {
            requestPermission: async (params) => {
                const selected = pickPermissionOption(params?.options || [], {
                    yolo: s.yolo,
                    toolTitle: params?.toolCall?.title || params?.toolCall?.kind || '',
                });
                if (!selected) {
                    return { outcome: { outcome: 'cancelled' } };
                }
                return { outcome: { outcome: 'selected', optionId: selected.optionId } };
            },
            sessionUpdate: async (params) => {
                if (this.sessions.get(sessionId) !== s) return;
                const update = params?.update;
                if (!update) return;

                if (update.sessionUpdate === 'agent_message_chunk' &&
                    update.content?.type === 'text' &&
                    typeof update.content.text === 'string') {
                    if (typeof runtime.onAssistantText === 'function') {
                        runtime.onAssistantText(update.content.text);
                    }
                    return;
                }

                if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
                    typeof runtime.onMeta === 'function') {
                    runtime.onMeta(update);
                    return;
                }

                if (update.sessionUpdate === 'usage_update') {
                    const context = formatContextUsage(update.used, update.size, 'acp');
                    this._emitContextUsage(sessionId, s, context, 'acp');
                    if (typeof runtime.onMeta === 'function') {
                        runtime.onMeta(update);
                    }
                }
            },
            writeTextFile: async () => ({}),
            readTextFile: async () => ({ content: '' }),
        };

        proc.on('close', (code) => {
            if (this.sessions.get(sessionId) !== s) return;
            if (s.acp?.proc === proc) s.acp = null;
            if (!runtime.closedByManager && s.ws.readyState === 1) {
                const line = stderrBuffer
                    .split(/\r?\n/)
                    .map((x) => x.trim())
                    .find((x) => x && !x.startsWith('at ') && !x.includes('file:///'));
                s.ws.send(JSON.stringify({
                    event: 'chat:error',
                    data: { sessionId, text: line || `Gemini ACP session exited (code ${code ?? 'unknown'})` },
                }));
            }
        });

        proc.on('error', (err) => {
            if (this.sessions.get(sessionId) !== s) return;
            if (s.ws.readyState === 1) {
                s.ws.send(JSON.stringify({
                    event: 'chat:error',
                    data: { sessionId, text: `Failed to start Gemini ACP session: ${err.message}` },
                }));
            }
        });

        try {
            const input = Writable.toWeb(proc.stdin);
            const output = Readable.toWeb(proc.stdout);
            const stream = acp.ndJsonStream(input, output);
            const connection = new acp.ClientSideConnection(() => client, stream);

            await connection.initialize({
                protocolVersion: ACP_PROTOCOL_VERSION,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                },
            });

            let activeSessionId = null;
            if (s.resumeSessionId) {
                try {
                    const loaded = await connection.loadSession({
                        sessionId: s.resumeSessionId,
                        cwd: s.cwd || process.cwd(),
                        mcpServers: [],
                    });
                    activeSessionId = s.resumeSessionId;
                    const loadedModel = sanitizeModelName(loaded?.models?.currentModelId);
                    if (!s.model && loadedModel) s.model = loadedModel;
                } catch (resumeErr) {
                    if (s.ws.readyState === 1) {
                        s.ws.send(JSON.stringify({
                            event: 'chat:error',
                            data: {
                                sessionId,
                                text: `Could not resume session ${s.resumeSessionId}: ${getErrorText(resumeErr) || 'Unknown error'}. Starting a new session instead.`,
                            },
                        }));
                    }
                    s.resumeSessionId = null;
                }
            }

            if (!activeSessionId) {
                const created = await connection.newSession({
                    cwd: s.cwd || process.cwd(),
                    mcpServers: [],
                });
                activeSessionId = created.sessionId;
            }

            if (s.model && typeof connection.unstable_setSessionModel === 'function') {
                try {
                    await connection.unstable_setSessionModel({
                        sessionId: activeSessionId,
                        modelId: s.model,
                    });
                } catch {
                    // Keep going; model set can fail for unavailable previews.
                }
            }

            runtime.connection = connection;
            runtime.sessionId = activeSessionId;
            return runtime;
        } catch (err) {
            runtime.closedByManager = true;
            try { proc.kill('SIGTERM'); } catch { /* noop */ }
            throw err;
        }
    }

    _disposeAcpRuntime(sessionId, s) {
        if (!s?.acp) return;
        const runtime = s.acp;
        runtime.closedByManager = true;
        try { runtime.proc.kill('SIGTERM'); } catch { /* noop */ }
        if (this.sessions.get(sessionId) === s && s.acp === runtime) {
            s.acp = null;
        }
    }

    _restartAcpRuntime(sessionId, s) {
        this._disposeAcpRuntime(sessionId, s);
        return this._ensureAcpRuntime(sessionId, s);
    }

    async _trySetAcpSessionModel(sessionId, s, modelId) {
        if (!modelId) return false;

        let runtime = null;
        try {
            runtime = await this._ensureAcpRuntime(sessionId, s);
        } catch {
            return false;
        }

        if (this.sessions.get(sessionId) !== s) return false;
        if (!runtime?.connection || !runtime.sessionId) return false;
        if (typeof runtime.connection.unstable_setSessionModel !== 'function') return false;

        try {
            await runtime.connection.unstable_setSessionModel({
                sessionId: runtime.sessionId,
                modelId,
            });
            return true;
        } catch {
            return false;
        }
    }

    async _runChatAcpPrompt(sessionId, s, prompt, { allowModelFallback, attachments = [], promptBundle = null } = {}) {
        if (this.sessions.get(sessionId) !== s) return;

        const bundle = promptBundle || await this._buildPromptBundle(prompt, attachments, s.cwd);
        const cliPromptText = String(bundle?.cliPrompt || '');
        const acpPrompt = Array.isArray(bundle?.acpPrompt) && bundle.acpPrompt.length > 0
            ? bundle.acpPrompt
            : [{ type: 'text', text: cliPromptText }];

        let runtime = null;
        try {
            runtime = await this._ensureAcpRuntime(sessionId, s);
        } catch {
            // ACP unavailable: fallback to one-shot mode for this prompt.
            await this._runChatProcess(sessionId, s, cliPromptText, { modelOverride: s.model, allowModelFallback });
            return;
        }

        if (!runtime?.connection || !runtime.sessionId) {
            await this._runChatProcess(sessionId, s, cliPromptText, { modelOverride: s.model, allowModelFallback });
            return;
        }

        const token = randomUUID();
        s.activePromptToken = token;

        let buffer = '';
        let flushTimer = null;
        const flushBuffer = () => {
            if (buffer.length > 0 && s.ws.readyState === 1 && s.activePromptToken === token) {
                s.ws.send(JSON.stringify({ event: 'chat:chunk', data: { sessionId, text: buffer } }));
                buffer = '';
            }
        };
        const queueChunk = (text) => {
            if (!text || s.activePromptToken !== token) return;
            buffer += text;
            if (!flushTimer) {
                flushTimer = setTimeout(() => { flushTimer = null; flushBuffer(); }, 20);
            }
        };

        runtime.onAssistantText = queueChunk;
        runtime.onMeta = (update) => {
            if (s.ws.readyState !== 1 || s.activePromptToken !== token) return;
            s.ws.send(JSON.stringify({
                event: 'chat:meta',
                data: { sessionId, update },
            }));
        };

        try {
            const result = await runtime.connection.prompt({
                sessionId: runtime.sessionId,
                prompt: acpPrompt,
            });

            clearTimeout(flushTimer);
            flushBuffer();

            if (this.sessions.get(sessionId) !== s || s.activePromptToken !== token) return;
            if (s.ws.readyState === 1) {
                s.ws.send(JSON.stringify({
                    event: 'chat:done',
                    data: { sessionId, code: result?.stopReason === 'cancelled' ? 130 : 0, stopReason: result?.stopReason || null },
                }));
            }
        } catch (err) {
            clearTimeout(flushTimer);
            flushBuffer();
            if (this.sessions.get(sessionId) !== s || s.activePromptToken !== token) return;

            const message = getErrorText(err);
            const modelNotFound = /ModelNotFoundError|Requested entity was not found|model.*not found/i.test(message);
            if (modelNotFound && allowModelFallback && s.model) {
                if (s.ws.readyState === 1) {
                    s.ws.send(JSON.stringify({
                        event: 'chat:error',
                        data: {
                            sessionId,
                            text: `Model "${s.model}" is unavailable for this Gemini account. Retrying with CLI default model...`,
                        },
                    }));
                }
                s.model = null;
                await this._restartAcpRuntime(sessionId, s).catch(() => { /* fallback below */ });
                return this._runChatAcpPrompt(sessionId, s, prompt, {
                    allowModelFallback: false,
                    attachments,
                    promptBundle: bundle,
                });
            }

            if (s.ws.readyState === 1) {
                s.ws.send(JSON.stringify({
                    event: 'chat:error',
                    data: { sessionId, text: message || 'Gemini ACP prompt failed.' },
                }));
                s.ws.send(JSON.stringify({ event: 'chat:done', data: { sessionId, code: -1 } }));
            }
        } finally {
            if (this.sessions.get(sessionId) === s && s.activePromptToken === token) {
                s.activePromptToken = null;
            }
            if (runtime) {
                runtime.onAssistantText = null;
                runtime.onMeta = null;
            }
        }
    }

    _runChatProcess(sessionId, s, prompt, { modelOverride, allowModelFallback }) {
        if (this.sessions.get(sessionId) !== s) return Promise.resolve();

        return new Promise((resolve) => {
            // Headless chat request via stream-json for faster incremental output.
            const args = ['-o', 'stream-json'];
            if (modelOverride) args.push('-m', modelOverride);
            if (s.yolo) args.push('--yolo');
            args.push('-p', prompt || '');

            const { command, spawnArgs, options } = buildGeminiSpawn(args, s.cwd);
            const proc = spawn(command, spawnArgs, {
                ...options,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            s.proc = proc;
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                resolve();
            };

            let buffer = '';
            let flushTimer = null;
            let stderrBuffer = '';
            let stdoutRaw = '';
            let stdoutLineBuffer = '';
            let sawJsonStream = false;

            const flushBuffer = () => {
                if (buffer.length > 0 && s.ws.readyState === 1) {
                    s.ws.send(JSON.stringify({ event: 'chat:chunk', data: { sessionId, text: buffer } }));
                    buffer = '';
                }
            };

            const queueChunk = (text) => {
                if (!text) return;
                buffer += text;
                if (!flushTimer) {
                    flushTimer = setTimeout(() => { flushTimer = null; flushBuffer(); }, 20);
                }
            };

            const handleJsonLine = (line) => {
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch {
                    return false;
                }

                sawJsonStream = true;

                if (msg?.type === 'message' && msg?.role === 'assistant' && typeof msg?.content === 'string') {
                    if (msg.delta) {
                        queueChunk(msg.content);
                    } else {
                        queueChunk(msg.content);
                    }
                    return true;
                }

                if (msg?.type === 'result' && s.ws.readyState === 1 && msg?.stats) {
                    const context = extractContextUsageFromStats(msg.stats, 'stream-json');
                    if (context) this._emitContextUsage(sessionId, s, context, 'stream-json');
                    s.ws.send(JSON.stringify({
                        event: 'chat:meta',
                        data: { sessionId, stats: msg.stats },
                    }));
                    return true;
                }

                return true;
            };

            proc.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                stdoutRaw += text;
                stdoutLineBuffer += text;

                let newlineIndex;
                while ((newlineIndex = stdoutLineBuffer.indexOf('\n')) !== -1) {
                    const line = stdoutLineBuffer.slice(0, newlineIndex).trim();
                    stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
                    if (!line) continue;
                    const handledAsJson = handleJsonLine(line);
                    if (!handledAsJson) queueChunk(line + '\n');
                }
            });

            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                // Filter out common info/noise from stderr
                if (text.includes('Loaded cached credentials') ||
                    text.includes('DeprecationWarning') ||
                    text.includes('ExperimentalWarning')) return;
                stderrBuffer += text;
            });

            proc.on('close', (code) => {
                clearTimeout(flushTimer);
                if (stdoutLineBuffer.trim().length > 0 && !sawJsonStream) {
                    queueChunk(stdoutLineBuffer);
                }
                flushBuffer();
                if (this.sessions.get(sessionId) !== s) {
                    s.proc = null;
                    done();
                    return;
                }

                const combinedErrorText = `${stderrBuffer}\n${stdoutRaw}`;
                const modelNotFound = /ModelNotFoundError|Requested entity was not found/i.test(combinedErrorText);

                if (code !== 0 && allowModelFallback && modelOverride && modelNotFound) {
                    if (s.ws.readyState === 1) {
                        s.ws.send(JSON.stringify({
                            event: 'chat:error',
                            data: {
                                sessionId,
                                text: `Model "${modelOverride}" is unavailable for this Gemini account. Retrying with CLI default model...`,
                            },
                        }));
                    }
                    s.proc = null;
                    this._runChatProcess(sessionId, s, prompt, { modelOverride: null, allowModelFallback: false })
                        .finally(done);
                    return;
                }

                if (code !== 0 && s.ws.readyState === 1) {
                    s.ws.send(JSON.stringify({
                        event: 'chat:error',
                        data: { sessionId, text: this._summarizeChatError(combinedErrorText, code) },
                    }));
                }

                if (s.ws.readyState === 1) {
                    s.ws.send(JSON.stringify({ event: 'chat:done', data: { sessionId, code } }));
                }
                s.proc = null;
                done();
            });

            proc.on('error', (err) => {
                console.error('[Chat] Process error:', err.message);
                if (s.ws.readyState === 1) {
                    s.ws.send(JSON.stringify({ event: 'chat:error', data: { sessionId, text: 'Failed to run gemini: ' + err.message } }));
                    s.ws.send(JSON.stringify({ event: 'chat:done', data: { sessionId, code: -1 } }));
                }
                s.proc = null;
                done();
            });
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
        const wasBootstrap = !!s.bootstrap;
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
            } else {
                this._disposeAcpRuntime(sessionId, s);
                if (s.proc) s.proc.kill('SIGTERM');
            }
        } catch { /* already exited */ }
        this.sessions.delete(sessionId);
        if (wasBootstrap && this.bootstrapChatSessionId === sessionId) {
            this.bootstrapChatSessionId = null;
            this._warmBootstrapChatSession();
        }
    }

    listSessions() {
        return [...this.sessions.values()]
            .filter(s => !s.bootstrap)
            .map(s => ({
            id: s.id, mode: s.mode, cwd: s.cwd, model: s.model,
            startTime: s.startTime, lastActivity: s.lastActivity,
        }));
    }

    getChatRuntimeState(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.mode !== 'chat') return null;
        if (s.acp) return 'ready';
        if (s.acpInitPromise) return 'warming';
        return 'cold';
    }

    getChatContextUsage(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.mode !== 'chat') return null;
        return s.contextUsage || null;
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

    updateChatSession(sessionId, { cwd, model, yolo } = {}) {
        const s = this.sessions.get(sessionId);
        if (!s || s.mode !== 'chat') return;
        const prevCwd = s.cwd;
        const prevModel = s.model;
        const prevYolo = s.yolo;

        const nextCwd = (cwd && typeof cwd === 'string') ? cwd : s.cwd;
        const nextModel = model !== undefined ? sanitizeModelName(model) : s.model;
        const nextYolo = yolo !== undefined ? !!yolo : s.yolo;

        const cwdChanged = nextCwd !== prevCwd;
        const modelChanged = nextModel !== prevModel;
        const yoloChanged = nextYolo !== prevYolo;
        const changed = cwdChanged || modelChanged || yoloChanged;
        s.cwd = nextCwd;
        s.model = nextModel;
        s.yolo = nextYolo;
        this._updateActivity(sessionId);

        if (!changed) return;

        // Match CLI /model behavior: switch models in-place without full warm restart.
        if (!cwdChanged && !yoloChanged && modelChanged && nextModel) {
            this._trySetAcpSessionModel(sessionId, s, nextModel)
                .then((switched) => {
                    if (!switched && this.sessions.get(sessionId) === s) {
                        this._restartAcpRuntime(sessionId, s).catch(() => { /* one-shot fallback remains available */ });
                    }
                })
                .catch(() => {
                    if (this.sessions.get(sessionId) === s) {
                        this._restartAcpRuntime(sessionId, s).catch(() => { /* one-shot fallback remains available */ });
                    }
                });
            return;
        }

        this._restartAcpRuntime(sessionId, s).catch(() => { /* one-shot fallback remains available */ });
    }

    _summarizeChatError(stderrText, code) {
        const text = (stderrText || '').trim();
        if (!text) return code ? `Gemini exited with code ${code}.` : 'Gemini request failed.';
        if (/ModelNotFoundError|Requested entity was not found/i.test(text)) {
            return 'Selected model is not available for this Gemini account/project.';
        }

        const line = text
            .split(/\r?\n/)
            .map(s => s.trim())
            .find(s => s && !s.startsWith('at ') && !s.includes('file:///'));
        return line || `Gemini request failed (code ${code}).`;
    }
}
