import React, { useState, useEffect } from 'react';
import { api } from '../hooks';
import { Icons } from '../Icons';

export default function MemoryPanel() {
    const [content, setContent] = useState('');
    const [memoryPath, setMemoryPath] = useState('');
    const [modified, setModified] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState(null);

    useEffect(() => {
        api('/memory').then(data => {
            setContent(data.content);
            setMemoryPath(data.path);
        }).catch(() => { });
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            await api('/memory', { method: 'PUT', body: { content } });
            setModified(false);
            setStatus({ type: 'success', text: 'Memory saved successfully' });
            setTimeout(() => setStatus(null), 3000);
        } catch (e) {
            setStatus({ type: 'error', text: e.message });
        }
        setSaving(false);
    };

    const handleChange = (e) => {
        setContent(e.target.value);
        setModified(true);
    };

    return (
        <div className="panel">
            <div className="panel-header">
                <h2>
                    <Icons.Memory style={{ width: 18, height: 18 }} />
                    Memory (GEMINI.md)
                </h2>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                    {memoryPath}
                </span>
            </div>
            <div className="memory-editor">
                <textarea
                    className="memory-textarea"
                    value={content}
                    onChange={handleChange}
                    placeholder="# GEMINI.md&#10;&#10;Add project context, preferences, and instructions for Gemini CLI here...&#10;&#10;## Gemini Added Memories&#10;- Your saved memories will appear here"
                    spellCheck={false}
                />
                <div className="memory-actions">
                    {status && (
                        <span className={`badge ${status.type === 'success' ? 'badge-success' : 'badge-error'}`}>
                            {status.text}
                        </span>
                    )}
                    <button className="btn btn-primary" onClick={handleSave} disabled={!modified || saving}>
                        <Icons.Save style={{ width: 14, height: 14 }} />
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
