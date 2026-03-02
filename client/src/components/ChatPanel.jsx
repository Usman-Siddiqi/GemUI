import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icons } from '../Icons';

export default function ChatPanel({ ws, workspace, model, setModel, yolo, modelOptions = [], resumeRequest = null }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [sessionId, setSessionId] = useState(null);
    const [runtimeReady, setRuntimeReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const messagesEnd = useRef(null);
    const textareaRef = useRef(null);
    const currentChunkRef = useRef('');
    const sessionStartedRef = useRef(false);
    const activeSessionRef = useRef(null);
    const pendingPromptRef = useRef(null);
    const lastSessionConfigRef = useRef(null);
    const handledResumeNonceRef = useRef(null);
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

    // Start a chat session (this just registers the session, no process spawned yet)
    const startSession = useCallback(() => {
        if (sessionStartedRef.current) return;
        const sent = ws.send('chat:start', { cwd: workspace || '.', model, yolo });
        sessionStartedRef.current = sent;
    }, [ws, workspace, model, yolo]);

    useEffect(() => {
        const offs = [];

        offs.push(ws.on('chat:started', (data) => {
            activeSessionRef.current = data.sessionId;
            setSessionId(data.sessionId);
            setRuntimeReady(false);
            setError(null);

            if (pendingPromptRef.current) {
                ws.send('chat:send', { prompt: pendingPromptRef.current });
                pendingPromptRef.current = null;
            }
        }));

        // Chunks from headless Gemini stdout — clean text, no ANSI
        offs.push(ws.on('chat:chunk', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            const text = data.text;
            if (!text) return;
            setRuntimeReady(true);

            currentChunkRef.current += text;
            const fullText = currentChunkRef.current;

            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last?.streaming) {
                    return [...prev.slice(0, -1), { ...last, content: fullText }];
                }
                return [...prev, { role: 'assistant', content: fullText, time: new Date(), streaming: true }];
            });
        }));

        // Errors from stderr
        offs.push(ws.on('chat:error', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            const raw = data.text ?? data.message ?? 'Unknown error';
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            setMessages(prev => [...prev, { role: 'system', content: '⚠️ ' + text.trim(), time: new Date() }]);
        }));

        offs.push(ws.on('chat:meta', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            if (data?.phase === 'ready') setRuntimeReady(true);
            if (data?.phase === 'warming') setRuntimeReady(false);
        }));

        // WS-level error
        offs.push(ws.on('error', (data) => {
            setError(data.message);
        }));

        // Process completed for this message
        offs.push(ws.on('chat:done', (data) => {
            if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
            setLoading(false);
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.streaming) {
                    return [...prev.slice(0, -1), { ...last, streaming: false }];
                }
                return prev;
            });
        }));

        // Session destroyed
        offs.push(ws.on('chat:exit', () => {
            setLoading(false);
            sessionStartedRef.current = false;
            setSessionId(null);
            activeSessionRef.current = null;
        }));

        return () => offs.forEach(off => off());
    }, [ws.on, ws.send]);

    useEffect(() => {
        messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Auto-start session when WS connects
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
        activeSessionRef.current = null;
        pendingPromptRef.current = null;
        sessionStartedRef.current = false;
        lastSessionConfigRef.current = null;
        currentChunkRef.current = '';
        setLoading(false);
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

    // Apply model/workspace/yolo changes immediately to the active chat session.
    useEffect(() => {
        if (!ws.connected || !sessionId) return;
        const next = `${workspace || '.'}|${model || ''}|${yolo ? '1' : '0'}`;
        if (lastSessionConfigRef.current === next) return;
        lastSessionConfigRef.current = next;
        ws.send('chat:update', { cwd: workspace || '.', model, yolo });
    }, [ws.connected, ws.send, sessionId, workspace, model, yolo]);

    const handleSend = () => {
        const prompt = input.trim();
        if (!prompt || loading) return;

        if (!sessionId) {
            sessionStartedRef.current = false;
            startSession();
            pendingPromptRef.current = prompt;
        }

        setMessages(prev => [...prev, { role: 'user', content: prompt, time: new Date() }]);
        currentChunkRef.current = '';
        setLoading(true);

        if (sessionId) {
            ws.send('chat:send', { prompt });
        }
        setInput('');

        if (textareaRef.current) textareaRef.current.style.height = 'auto';
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
        activeSessionRef.current = null;
        pendingPromptRef.current = null;
        sessionStartedRef.current = false;
        lastSessionConfigRef.current = null;
        setMessages([]);
        currentChunkRef.current = '';
        setLoading(false);
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
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
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
                            Supports <code>@file</code> references • Model: {modelLabel}
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
                                            }
                                        }}
                                    >
                                        {msg.content}
                                    </ReactMarkdown>
                                ) : (
                                    <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
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
                <div className="chat-input-wrapper">
                    <textarea
                        ref={textareaRef}
                        className="chat-input"
                        placeholder={loading
                            ? 'Gemini is thinking...'
                            : (sessionId
                                ? (runtimeReady ? 'Ask Gemini anything... (Shift+Enter for newline)' : 'Warming Gemini session...')
                                : 'Connecting...')}
                        value={input}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        disabled={loading}
                        rows={1}
                    />
                    <button className="chat-send-btn" onClick={handleSend} disabled={!input.trim() || loading}>
                        <Icons.Send />
                    </button>
                </div>
            </div>
        </div>
    );
}
