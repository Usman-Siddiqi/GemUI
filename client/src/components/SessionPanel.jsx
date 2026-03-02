import React, { useState, useEffect } from 'react';
import { api } from '../hooks';
import { Icons } from '../Icons';
import ReactMarkdown from 'react-markdown';

export default function SessionPanel({ onResumeSession }) {
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeSession, setActiveSession] = useState(null);
    const [sessionDetail, setSessionDetail] = useState(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [deletingKey, setDeletingKey] = useState(null);

    useEffect(() => {
        setLoading(true);
        api('/sessions')
            .then(data => setSessions(data.sessions || []))
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    const openSession = async (session) => {
        setActiveSession(session.id);
        setLoadingDetail(true);
        try {
            const data = await api(`/sessions/${encodeURIComponent(session.projectHash)}/${encodeURIComponent(session.filename)}`);
            setSessionDetail(data);
        } catch (e) {
            setError(e.message);
        }
        setLoadingDetail(false);
    };

    const handleContinue = (session, detail = null) => {
        if (typeof onResumeSession !== 'function') return;

        const sourceSessionId = detail?.sessionId || session?.id;
        if (!sourceSessionId) return;

        onResumeSession({
            sourceSessionId,
            workspace: detail?.projectRoot || session?.projectRoot || '',
            model: detail?.model || session?.model || '',
            history: Array.isArray(detail?.messages) ? detail.messages : null,
            title: session?.projectName || 'Session',
        });
    };

    const continueFromList = async (session) => {
        if (!session) return;
        try {
            const detail = await api(`/sessions/${encodeURIComponent(session.projectHash)}/${encodeURIComponent(session.filename)}`);
            handleContinue(session, detail);
        } catch {
            handleContinue(session);
        }
    };

    const deleteSession = async (session) => {
        if (!session) return;
        if (!window.confirm(`Delete session "${session.preview || session.id}"? This cannot be undone.`)) return;

        const key = `${session.projectHash}/${session.filename}`;
        setDeletingKey(key);
        try {
            await api(`/sessions/${encodeURIComponent(session.projectHash)}/${encodeURIComponent(session.filename)}`, {
                method: 'DELETE',
            });

            setSessions((prev) => prev.filter((s) => !(s.projectHash === session.projectHash && s.filename === session.filename)));

            if (sessionDetail?.sessionId === session.id || activeSession === session.id) {
                setSessionDetail(null);
                setActiveSession(null);
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setDeletingKey(null);
        }
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
        return d.toLocaleDateString();
    };

    const formatFullDate = (dateStr) => {
        if (!dateStr) return '';
        return new Date(dateStr).toLocaleString();
    };

    if (loading) {
        return (
            <div className="panel">
                <div className="panel-header">
                    <h2><Icons.Sessions style={{ width: 18, height: 18 }} /> Sessions</h2>
                </div>
                <div className="empty-state"><div className="spinner" /><p>Loading sessions...</p></div>
            </div>
        );
    }

    // Session detail view
    if (sessionDetail) {
        return (
            <div className="panel">
                <div className="panel-header">
                    <h2 style={{ cursor: 'pointer' }} onClick={() => { setSessionDetail(null); setActiveSession(null); }}>
                        ← Back to Sessions
                    </h2>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                            {sessionDetail.messages?.length || 0} messages
                        </span>
                        <button
                            className="btn btn-sm"
                            onClick={() => {
                                const selected = sessions.find((s) => s.id === activeSession) || null;
                                handleContinue(selected, sessionDetail);
                            }}
                        >
                            Continue
                        </button>
                        <button
                            className="btn btn-sm btn-danger"
                            onClick={() => {
                                const selected = sessions.find((s) => s.id === activeSession) || null;
                                deleteSession(selected);
                            }}
                            disabled={!sessions.find((s) => s.id === activeSession)}
                        >
                            Delete
                        </button>
                    </div>
                </div>
                <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                        Session: {sessionDetail.sessionId?.slice(0, 8)}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                        {formatFullDate(sessionDetail.startTime)} — {formatFullDate(sessionDetail.lastUpdated)}
                    </div>
                </div>
                <div className="panel-body" style={{ padding: 'var(--space-4)' }}>
                    {loadingDetail ? (
                        <div className="empty-state"><div className="spinner" /></div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                            {sessionDetail.messages?.map((msg, i) => {
                                const isUser = msg.type === 'user' || msg.type === 'query';
                                const isInfo = msg.type === 'info';
                                const isAssistant = msg.type === 'assistant' || msg.type === 'response' || msg.type === 'model';
                                const isTool = msg.type === 'tool_call' || msg.type === 'tool_result' || msg.type === 'function_call';

                                return (
                                    <div key={msg.id || i} className={`chat-message ${isUser ? 'user' : 'assistant'}`}>
                                        <div className="chat-avatar">
                                            {isUser ? 'U' : isInfo ? 'ℹ' : isTool ? '⚙' : '✦'}
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div className="chat-bubble" style={isTool ? { fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', background: 'var(--accent-dim)' } : {}}>
                                                {isAssistant ? (
                                                    <ReactMarkdown>{msg.content || ''}</ReactMarkdown>
                                                ) : (
                                                    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content || JSON.stringify(msg.data || msg, null, 2)}</span>
                                                )}
                                            </div>
                                            <div className="chat-timestamp">
                                                {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ''}
                                                {isTool && <span className="badge badge-info" style={{ marginLeft: 8 }}>{msg.type}</span>}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            {(!sessionDetail.messages || sessionDetail.messages.length === 0) && (
                                <div className="empty-state"><p>No messages in this session</p></div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // Session list view
    return (
        <div className="panel">
            <div className="panel-header">
                <h2><Icons.Sessions style={{ width: 18, height: 18 }} /> Sessions</h2>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                    {sessions.length} session{sessions.length !== 1 ? 's' : ''}
                </span>
            </div>
            <div className="panel-body">
                {error && (
                    <div style={{ padding: 'var(--space-4)' }}>
                        <span className="badge badge-error">{error}</span>
                    </div>
                )}

                {sessions.length === 0 ? (
                    <div className="empty-state">
                        <Icons.Sessions style={{ width: 48, height: 48 }} />
                        <h3>No saved sessions</h3>
                        <p>Sessions from Gemini CLI will appear here. Start a conversation to create a session.</p>
                    </div>
                ) : (
                    sessions.map(session => (
                        <div key={`${session.projectHash}-${session.id}`} className="session-item" onClick={() => openSession(session)}>
                            <div className="session-icon">
                                <Icons.Chat style={{ width: 18, height: 18 }} />
                            </div>
                            <div className="session-info">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                    <span className="session-id">{session.projectName}</span>
                                    <span className="badge badge-info" style={{ fontSize: '0.65rem' }}>
                                        {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
                                    </span>
                                </div>
                                <div className="session-preview">{session.preview || 'No preview available'}</div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                <div className="session-date">{formatDate(session.lastUpdated || session.startTime)}</div>
                                <button
                                    className="btn btn-sm"
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        await continueFromList(session);
                                    }}
                                    title="Continue this session in Chat"
                                >
                                    Continue
                                </button>
                                <button
                                    className="btn btn-sm btn-danger"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        deleteSession(session);
                                    }}
                                    disabled={deletingKey === `${session.projectHash}/${session.filename}`}
                                    title="Delete this session"
                                >
                                    {deletingKey === `${session.projectHash}/${session.filename}` ? '...' : 'Delete'}
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
