import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icons } from '../Icons';
import { playNotificationSound } from '../utils/sound';

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function formatFileSize(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokenCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return Math.max(0, Math.round(n)).toLocaleString();
}

function normalizeContextPayload(context) {
    if (!context || typeof context !== 'object') return null;
    const used = Number(context.used);
    const size = Number(context.size);
    if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
    const clampedUsed = Math.max(0, Math.min(used, size));
    const remaining = Math.max(0, size - clampedUsed);
    const percent = Math.max(0, Math.min((clampedUsed / size) * 100, 100));
    return {
        used: Math.round(clampedUsed),
        size: Math.round(size),
        remaining: Math.round(remaining),
        percent,
        source: context.source || 'acp',
        updatedAt: context.updatedAt || null,
    };
}

export default function ChatPanel({ ws, workspace, model, setModel, yolo, modelOptions = [], resumeRequest = null, notificationSound = true }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [sessionId, setSessionId] = useState(null);
    const [runtimeReady, setRuntimeReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [uploadingAttachments, setUploadingAttachments] = useState(false);
    const [pendingAttachments, setPendingAttachments] = useState([]);
    const [contextUsage, setContextUsage] = useState(null);
    const [contextUnavailable, setContextUnavailable] = useState(false);
    const [error, setError] = useState(null);
    const messagesEnd = useRef(null);
    const textareaRef = useRef(null);
    const fileInputRef = useRef(null);
    const currentChunkRef = useRef('');
    const sessionStartedRef = useRef(false);
    const activeSessionRef = useRef(null);
    const pendingPayloadRef = useRef(null);
    const lastSessionConfigRef = useRef(null);
    const handledResumeNonceRef = useRef(null);
    const hasContextUpdateRef = useRef(false);
    const modelLabel = model || 'CLI default';

    const mapHistoryMessages = useCallback((history) => {
        if (!Array.isArray(history)) return [];

        return history
            .map((msg) => {
                const type = String(msg?.type || '').toLowerCase();
                const content = typeof msg?.content === 'string'
                    ? msg.content
                    : (msg?.content ? JSON.stringify(msg.content) : '');
                if (!content.trim()) return null;

                if (type === 'user' || type === 'query') {
                    return { role: 'user', content, time: msg?.timestamp ? new Date(msg.timestamp) : new Date(), streaming: false };
                }
                if (type === 'gemini' || type === 'assistant' || type === 'response' || type === 'model') {
                    return { role: 'assistant', content, time: msg?.timestamp ? new Date(msg.timestamp) : new Date(), streaming: false };
                }
                return { role: 'system', content, time: msg?.timestamp ? new Date(msg.timestamp) : new Date(), streaming: false };
            })
            .filter(Boolean);
    }, []);

    const startSession = useCallback(() => {
        if (sessionStartedRef.current) return;
        const sent = ws.send('chat:start', { cwd: workspace || '.', model, yolo });
        sessionStartedRef.current = sent;
    }, [ws, workspace, model, yolo]);

    const uploadAttachments = useCallback(async (attachments) => {
        if (!Array.isArray(attachments) || attachments.length === 0) return [];

        const uploaded = [];
        for (const attachment of attachments) {
            const fd = new FormData();
            fd.append('file', attachment.file, attachment.name);
            const res = await fetch('/api/file/upload', { method: 'POST', body: fd });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok || !payload?.path) {
                const msg = payload?.error || `Failed uploading ${attachment.name}`;
                throw new Error(msg);
            }
            uploaded.push({
                filename: payload.filename || attachment.name,
                path: payload.path,
                mimetype: payload.mimetype || attachment.type || 'application/octet-stream',
                size: Number.isFinite(Number(payload.size)) ? Number(payload.size) : attachment.size,
            });
        }
        return uploaded;
    }, []);

    useEffect(() => {
        const offs = [];

        offs.push(ws.on('chat:started', (data) => {
            const nextSessionId = data?.sessionId || null;
            const previousSessionId = activeSessionRef.current;
            activeSessionRef.current = data.sessionId;
            setSessionId(data.sessionId);
            if (data?.runtimeState === 'ready') setRuntimeReady(true);
            else if (data?.runtimeState === 'warming') setRuntimeReady(false);
            else setRuntimeReady(false);

            const reusedSameSession = !!data?.reused && previousSessionId && nextSessionId && previousSessionId === nextSessionId;
            if (!reusedSameSession) {
                setContextUsage(null);
                setContextUnavailable(false);
                hasContextUpdateRef.current = false;
            }
            setError(null);

            if (pendingPayloadRef.current) {
                ws.send('chat:send', pendingPayloadRef.current);
                pendingPayloadRef.current = null;
            }
        }));

        offs.push(ws.on('chat:chunk', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            const text = data.text;
            if (!text) return;
            setRuntimeReady(true);

            currentChunkRef.current += text;
            const fullText = currentChunkRef.current;

            setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last?.streaming) {
                    return [...prev.slice(0, -1), { ...last, content: fullText }];
                }
                return [...prev, { role: 'assistant', content: fullText, time: new Date(), streaming: true }];
            });
        }));

        offs.push(ws.on('chat:error', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            const raw = data.text ?? data.message ?? 'Unknown error';
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            setMessages((prev) => [...prev, { role: 'system', content: '⚠️ ' + text.trim(), time: new Date() }]);
        }));

        offs.push(ws.on('chat:meta', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            if (data?.phase === 'ready') setRuntimeReady(true);
            if (data?.phase === 'warming') setRuntimeReady(false);

            const nextContext = normalizeContextPayload(data?.context);
            if (nextContext) {
                hasContextUpdateRef.current = true;
                setContextUnavailable(false);
                setContextUsage(nextContext);
            }
        }));

        offs.push(ws.on('error', (data) => {
            setError(data.message);
        }));

        offs.push(ws.on('chat:done', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            setLoading(false);
            setUploadingAttachments(false);
            const hadAssistantReply = currentChunkRef.current.trim().length > 0;
            if (hadAssistantReply && !hasContextUpdateRef.current) {
                setContextUnavailable(true);
            }
            setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.streaming) {
                    return [...prev.slice(0, -1), { ...last, streaming: false }];
                }
                return prev;
            });
            if (notificationSound && hadAssistantReply) {
                const inBackground = typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
                if (inBackground) {
                    try { playNotificationSound(); } catch { /* noop */ }
                }
            }
        }));

        offs.push(ws.on('chat:exit', () => {
            setLoading(false);
            setUploadingAttachments(false);
            sessionStartedRef.current = false;
            setSessionId(null);
            activeSessionRef.current = null;
        }));

        return () => offs.forEach((off) => off());
    }, [ws.on, ws.send, notificationSound]);

    useEffect(() => {
        messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        if (resumeRequest?.sourceSessionId && resumeRequest?.nonce !== handledResumeNonceRef.current) return;
        if (ws.connected && !sessionId && !sessionStartedRef.current) {
            startSession();
        }
    }, [ws.connected, sessionId, startSession, resumeRequest]);

    useEffect(() => {
        if (!ws.connected) return;
        if (!resumeRequest?.sourceSessionId || !resumeRequest?.nonce) return;
        if (handledResumeNonceRef.current === resumeRequest.nonce) return;

        handledResumeNonceRef.current = resumeRequest.nonce;

        if (sessionId) {
            ws.send('chat:stop', {});
        }

        setSessionId(null);
        setRuntimeReady(false);
        setContextUsage(null);
        setContextUnavailable(false);
        hasContextUpdateRef.current = false;
        activeSessionRef.current = null;
        pendingPayloadRef.current = null;
        sessionStartedRef.current = false;
        lastSessionConfigRef.current = null;
        currentChunkRef.current = '';
        setLoading(false);
        setUploadingAttachments(false);
        setPendingAttachments([]);
        setError(null);
        setMessages(mapHistoryMessages(resumeRequest.history));

        const sent = ws.send('chat:resume', {
            sourceSessionId: resumeRequest.sourceSessionId,
            cwd: resumeRequest.workspace || workspace || '.',
            model: model || undefined,
            yolo,
        });
        sessionStartedRef.current = sent;
    }, [ws, ws.connected, sessionId, resumeRequest, mapHistoryMessages, workspace, model, yolo]);

    useEffect(() => {
        if (!ws.connected || !sessionId) return;
        const next = `${workspace || '.'}|${model || ''}|${yolo ? '1' : '0'}`;
        if (lastSessionConfigRef.current === next) return;
        lastSessionConfigRef.current = next;
        ws.send('chat:update', { cwd: workspace || '.', model, yolo });
    }, [ws.connected, ws.send, sessionId, workspace, model, yolo]);

    const handleAttachmentSelect = async (e) => {
        const selected = Array.from(e.target.files || []);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (selected.length === 0) return;

        const rejected = [];
        const accepted = [];

        for (const file of selected) {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                rejected.push(`${file.name} (>${formatFileSize(MAX_ATTACHMENT_BYTES)})`);
                continue;
            }
            accepted.push({
                id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
                file,
                name: file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
            });
        }

        if (rejected.length > 0) {
            setMessages((prev) => [...prev, {
                role: 'system',
                content: `⚠️ Skipped oversized attachment(s): ${rejected.join(', ')}`,
                time: new Date(),
            }]);
        }

        if (accepted.length === 0) return;

        setPendingAttachments((prev) => {
            const merged = [...prev, ...accepted];
            if (merged.length <= MAX_ATTACHMENTS) return merged;
            const overflow = merged.length - MAX_ATTACHMENTS;
            setMessages((prevMessages) => [...prevMessages, {
                role: 'system',
                content: `⚠️ Attachment limit reached (${MAX_ATTACHMENTS}). Ignored ${overflow} extra file(s).`,
                time: new Date(),
            }]);
            return merged.slice(0, MAX_ATTACHMENTS);
        });
    };

    const removePendingAttachment = (attachmentId) => {
        setPendingAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
    };

    const handleSend = async () => {
        const prompt = input.trim();
        const outgoingAttachments = [...pendingAttachments];

        if ((!prompt && outgoingAttachments.length === 0) || loading || uploadingAttachments) return;

        if (!sessionId && !sessionStartedRef.current) {
            sessionStartedRef.current = false;
            startSession();
        }

        setMessages((prev) => [...prev, {
            role: 'user',
            content: prompt,
            attachments: outgoingAttachments.map((a) => ({
                name: a.name,
                size: a.size,
                mimeType: a.type,
            })),
            time: new Date(),
        }]);

        setInput('');
        setPendingAttachments([]);
        currentChunkRef.current = '';
        setLoading(true);

        if (textareaRef.current) textareaRef.current.style.height = 'auto';

        let uploadedAttachments = [];
        if (outgoingAttachments.length > 0) {
            setUploadingAttachments(true);
            try {
                uploadedAttachments = await uploadAttachments(outgoingAttachments);
            } catch (err) {
                setUploadingAttachments(false);
                setLoading(false);
                setMessages((prev) => [...prev, {
                    role: 'system',
                    content: `⚠️ Attachment upload failed: ${err?.message || 'Unknown error'}`,
                    time: new Date(),
                }]);
                return;
            }
            setUploadingAttachments(false);
        }

        const payload = {
            prompt,
            attachments: uploadedAttachments,
        };

        if (activeSessionRef.current || sessionId) {
            ws.send('chat:send', payload);
        } else {
            pendingPayloadRef.current = payload;
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleInputChange = (e) => {
        setInput(e.target.value);
        const ta = e.target;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    };

    const handleNewSession = () => {
        if (sessionId) {
            ws.send('chat:stop', {});
        }
        setSessionId(null);
        setRuntimeReady(false);
        setContextUsage(null);
        setContextUnavailable(false);
        hasContextUpdateRef.current = false;
        activeSessionRef.current = null;
        pendingPayloadRef.current = null;
        sessionStartedRef.current = false;
        lastSessionConfigRef.current = null;
        setMessages([]);
        currentChunkRef.current = '';
        setLoading(false);
        setUploadingAttachments(false);
        setPendingAttachments([]);
        setError(null);
        setTimeout(() => startSession(), 300);
    };

    return (
        <div className="panel">
            <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2>
                    <Icons.Chat style={{ width: 18, height: 18 }} />
                    Chat
                </h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {contextUsage && (
                        <div
                            className="chat-context-pill"
                            title={`Context: ${formatTokenCount(contextUsage.used)} / ${formatTokenCount(contextUsage.size)} tokens (${contextUsage.percent.toFixed(1)}%)`}
                        >
                            <span className="chat-context-percent">{contextUsage.percent.toFixed(1)}%</span>
                            <div className="chat-context-track">
                                <div className="chat-context-fill" style={{ width: `${Math.min(100, contextUsage.percent)}%` }} />
                            </div>
                            <span className="chat-context-tokens">{formatTokenCount(contextUsage.used)} / {formatTokenCount(contextUsage.size)}</span>
                            <span className="chat-context-remaining">{formatTokenCount(contextUsage.remaining)} left</span>
                        </div>
                    )}
                    {!contextUsage && contextUnavailable && (
                        <div
                            className="chat-context-unavailable"
                            title="Context usage is not currently emitted by this Gemini ACP runtime. In the Terminal panel, use /settings and disable 'Hide Context Window Percentage' to view it in CLI footer."
                        >
                            Context usage unavailable (ACP)
                        </div>
                    )}
                    <select
                        className="settings-select"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        style={{ minWidth: 150, fontSize: 'var(--text-xs)', padding: '4px 8px' }}
                        title="Switch model (applies immediately)"
                    >
                        <option value="">CLI default</option>
                        {modelOptions.map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                    </select>
                    {sessionId && runtimeReady && (
                        <span className="badge badge-success" style={{ fontSize: '0.65rem' }}>Ready</span>
                    )}
                    {sessionId && !runtimeReady && (
                        <span className="badge badge-info" style={{ fontSize: '0.65rem' }}>Warming...</span>
                    )}
                    {uploadingAttachments && (
                        <span className="badge badge-info" style={{ fontSize: '0.65rem' }}>Uploading...</span>
                    )}
                    {loading && (
                        <span className="badge badge-info" style={{ fontSize: '0.65rem' }}>Thinking...</span>
                    )}
                    <button className="btn btn-sm" onClick={handleNewSession} title="New session">+ New</button>
                </div>
            </div>

            <div className="chat-messages">
                {messages.length === 0 && (
                    <div className="empty-state">
                        <Icons.Chat style={{ width: 48, height: 48 }} />
                        <h3>Start a conversation</h3>
                        <p>
                            Chat runs on a persistent Gemini CLI ACP session for low latency.
                            For full interactive TUI, use the <strong>Terminal</strong> panel.
                        </p>
                        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-2)' }}>
                            Supports attachments, <code>@file</code> references, and context usage tracking.
                            Model: {modelLabel}
                        </p>
                        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
                            If context usage is missing, open the Terminal panel and run <code>/settings</code> then disable
                            {' '}
                            <strong>Hide Context Window Percentage</strong>.
                        </p>
                        {error && (
                            <div className="badge badge-error" style={{ marginTop: 'var(--space-3)', padding: '8px 16px' }}>
                                ⚠️ {error}
                            </div>
                        )}
                    </div>
                )}

                {messages.map((msg, i) => (
                    <div key={i} className={`chat-message ${msg.role}`}>
                        <div className="chat-avatar">
                            {msg.role === 'user' ? 'U' : msg.role === 'assistant' ? '✦' : 'ℹ'}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="chat-bubble">
                                {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
                                    <div className="chat-message-attachments">
                                        {msg.attachments.map((att, idx) => (
                                            <span key={`${att.name}-${idx}`} className="chat-message-attachment">
                                                {att.name}
                                                {Number.isFinite(Number(att.size)) ? ` (${formatFileSize(att.size)})` : ''}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {msg.role === 'assistant' ? (
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={{
                                            code({ children, className, ...rest }) {
                                                const isInline = !className;
                                                if (isInline) return <code {...rest}>{children}</code>;
                                                return (
                                                    <pre>
                                                        <code className={className} {...rest}>{children}</code>
                                                    </pre>
                                                );
                                            },
                                        }}
                                    >
                                        {msg.content}
                                    </ReactMarkdown>
                                ) : msg.content?.trim() ? (
                                    <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                                ) : (
                                    <span className="chat-attachment-only-note">
                                        Sent {msg.attachments?.length || 0} attachment{(msg.attachments?.length || 0) === 1 ? '' : 's'}.
                                    </span>
                                )}
                                {msg.streaming && <span className="spinner" style={{ display: 'inline-block', width: 12, height: 12, marginLeft: 8, verticalAlign: 'middle' }} />}
                            </div>
                            <div className="chat-timestamp">
                                {msg.time?.toLocaleTimeString()}
                            </div>
                        </div>
                    </div>
                ))}
                <div ref={messagesEnd} />
            </div>

            <div className="chat-input-container">
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleAttachmentSelect}
                    style={{ display: 'none' }}
                />

                <div className="chat-input-tools">
                    <button
                        className="chat-attach-btn"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={loading || uploadingAttachments || pendingAttachments.length >= MAX_ATTACHMENTS}
                        title={`Attach files/images (max ${MAX_ATTACHMENTS}, ${formatFileSize(MAX_ATTACHMENT_BYTES)} each)`}
                    >
                        <Icons.Paperclip />
                    </button>
                    <span className="chat-attach-hint">
                        Attach files/images ({pendingAttachments.length}/{MAX_ATTACHMENTS})
                    </span>
                </div>

                {pendingAttachments.length > 0 && (
                    <div className="chat-attachment-list">
                        {pendingAttachments.map((attachment) => (
                            <span key={attachment.id} className="chat-attachment-chip">
                                <span>{attachment.name} ({formatFileSize(attachment.size)})</span>
                                <button
                                    type="button"
                                    className="chat-attachment-remove"
                                    onClick={() => removePendingAttachment(attachment.id)}
                                    title="Remove attachment"
                                >
                                    <Icons.X style={{ width: 12, height: 12 }} />
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                <div className="chat-input-wrapper">
                    <textarea
                        ref={textareaRef}
                        className="chat-input"
                        placeholder={uploadingAttachments
                            ? 'Uploading attachments...'
                            : loading
                                ? 'Gemini is thinking...'
                                : (sessionId
                                    ? (runtimeReady ? 'Ask Gemini anything... (Shift+Enter for newline)' : 'Warming Gemini session...')
                                    : 'Connecting...')}
                        value={input}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        disabled={loading || uploadingAttachments}
                        rows={1}
                    />
                    <button
                        className="chat-send-btn"
                        onClick={handleSend}
                        disabled={(!input.trim() && pendingAttachments.length === 0) || loading || uploadingAttachments}
                    >
                        <Icons.Send />
                    </button>
                </div>
            </div>
        </div>
    );
}
