import React, { useEffect } from 'react';
import { Icons } from '../Icons';

const FALLBACK_MODELS = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'Fallback' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'Fallback' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'Fallback' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', tier: 'Preview' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', tier: 'Preview' },
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview (Legacy)', tier: 'Preview' },
];

export default function SettingsPanel({
    model,
    setModel,
    yolo,
    setYolo,
    health,
    modelCatalog,
    refreshingModels,
    onRefreshModels,
}) {
    const validated = modelCatalog?.available || [];
    const unavailable = modelCatalog?.unavailable || [];
    const uncertain = validated.filter(m => m.verified === false);
    const selectableModels = validated.length > 0 ? validated : FALLBACK_MODELS;
    const modelOptions = [
        { id: '', label: 'CLI Default (Safe Fallback)', tier: 'Recommended' },
        ...selectableModels.map((m) => ({
            ...m,
            label: m.verified === false ? `${m.label} (Unverified)` : m.label,
        })),
    ];
    const tiers = [...new Set(modelOptions.map(m => m.tier))];
    const checkedAt = modelCatalog?.checkedAt ? new Date(modelCatalog.checkedAt).toLocaleTimeString() : null;

    useEffect(() => {
        if (!modelCatalog?.checkedAt && !refreshingModels) {
            onRefreshModels();
        }
    }, [modelCatalog?.checkedAt, refreshingModels, onRefreshModels]);

    return (
        <div className="panel">
            <div className="panel-header">
                <h2>
                    <Icons.Settings style={{ width: 18, height: 18 }} />
                    Settings
                </h2>
            </div>
            <div className="panel-body">
                {/* CLI Status */}
                <div className="settings-group">
                    <h3>Gemini CLI Status</h3>
                    <div className="setting-row">
                        <div>
                            <div className="setting-label">Installation</div>
                            <div className="setting-description">Whether Gemini CLI is installed and accessible</div>
                        </div>
                        <span className={`badge ${health?.geminiCli?.installed ? 'badge-success' : 'badge-error'}`}>
                            {health?.geminiCli?.installed ? '✓ Installed' : '✗ Not Found'}
                        </span>
                    </div>
                    {health?.geminiCli?.path && (
                        <div className="setting-row">
                            <div>
                                <div className="setting-label">Path</div>
                            </div>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                                {health.geminiCli.path}
                            </span>
                        </div>
                    )}
                    <div className="setting-row">
                        <div>
                            <div className="setting-label">Session Directory</div>
                        </div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                            {health?.sessionDir || 'Not found'}
                        </span>
                    </div>
                    <div className="setting-row">
                        <div>
                            <div className="setting-label">Memory File</div>
                        </div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                            {health?.memoryFile || 'Not found'}
                        </span>
                    </div>
                </div>

                {/* Model Selection */}
                <div className="settings-group">
                    <h3>Model</h3>
                    <div className="setting-row">
                        <div>
                            <div className="setting-label">Validation</div>
                            <div className="setting-description">
                                {modelCatalog?.loading
                                    ? 'Checking model availability in your Gemini CLI account...'
                                    : `${validated.length} selectable • ${unavailable.length} unavailable`}
                                {checkedAt ? ` • Last check: ${checkedAt}` : ''}
                            </div>
                        </div>
                        <button className="btn btn-sm" onClick={onRefreshModels} disabled={refreshingModels}>
                            {refreshingModels ? 'Checking...' : 'Refresh'}
                        </button>
                    </div>
                    <div className="setting-row">
                        <div>
                            <div className="setting-label">Active Model</div>
                            <div className="setting-description">Applied immediately to upcoming chat requests.</div>
                        </div>
                        <select className="settings-select" value={model} onChange={(e) => setModel(e.target.value)}>
                            {tiers.map(tier => (
                                <optgroup key={tier} label={tier}>
                                    {modelOptions.filter(m => m.tier === tier).map(m => (
                                        <option key={m.id} value={m.id}>{m.label}</option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                    </div>
                    <div className="setting-description" style={{ marginTop: 'var(--space-2)', color: 'var(--text-tertiary)' }}>
                        Stable + Preview models are shown. Preview models can be slower, quota-limited, or temporarily unavailable.
                    </div>
                    {modelCatalog?.error && (
                        <div className="setting-description" style={{ marginTop: 'var(--space-2)', color: 'var(--error)' }}>
                            Model check failed: {modelCatalog.error}
                        </div>
                    )}
                    {unavailable.length > 0 && (
                        <div className="setting-description" style={{ marginTop: 'var(--space-2)', color: 'var(--text-secondary)' }}>
                            Unavailable: {unavailable.slice(0, 4).map(m => m.id).join(', ')}
                            {unavailable.length > 4 ? ` +${unavailable.length - 4} more` : ''}
                        </div>
                    )}
                    {uncertain.length > 0 && (
                        <div className="setting-description" style={{ marginTop: 'var(--space-2)', color: 'var(--warning)' }}>
                            Unverified this check: {uncertain.map(m => m.id).join(', ')} (kept selectable)
                        </div>
                    )}
                    <div className="setting-description" style={{ marginTop: 'var(--space-2)', color: 'var(--text-tertiary)' }}>
                        Gemini 3.1 Pro Preview may require paid-tier access and can return temporary capacity errors (429).
                    </div>
                </div>

                {/* Behavior */}
                <div className="settings-group">
                    <h3>Behavior</h3>
                    <div className="setting-row">
                        <div>
                            <div className="setting-label">YOLO Mode</div>
                            <div className="setting-description">
                                Skip all confirmation prompts. Equivalent to <code>gemini --yolo</code>.
                                <br />
                                <span style={{ color: 'var(--warning)' }}>⚠️ Use with caution — tool actions will execute automatically</span>
                            </div>
                        </div>
                        <div className={`toggle ${yolo ? 'active' : ''}`} onClick={() => setYolo(!yolo)} />
                    </div>
                </div>

                {/* Slash Commands Reference */}
                <div className="settings-group">
                    <h3>Available Slash Commands</h3>
                    <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
                        {[
                            ['/help', 'Show help information'],
                            ['/model', 'Select or change the model'],
                            ['/chat', 'Manage chat sessions (save, list)'],
                            ['/resume', 'Resume a saved conversation'],
                            ['/memory', 'Manage saved memories'],
                            ['/compress', 'Compress context to save tokens'],
                            ['/clear', 'Clear screen and context'],
                            ['/copy', 'Copy last response to clipboard'],
                            ['/stats', 'Show token usage stats'],
                            ['/plan', 'Enter plan mode (read-only)'],
                            ['/restore', 'Restore a checkpoint'],
                            ['/rewind', 'Rewind and replay session'],
                            ['/tools', 'List available tools'],
                            ['/mcp', 'List MCP servers and tools'],
                            ['/extensions', 'Manage extensions'],
                            ['/settings', 'Access settings'],
                            ['/theme', 'Change UI theme'],
                            ['/about', 'About Gemini CLI'],
                            ['/quit', 'Exit the CLI'],
                            ['!command', 'Run a shell command'],
                            ['@file.txt', 'Include file in context'],
                        ].map(([cmd, desc]) => (
                            <div key={cmd} className="setting-row">
                                <code style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 'var(--text-xs)',
                                    background: 'var(--surface-2)',
                                    padding: '2px 8px',
                                    borderRadius: 'var(--radius-sm)',
                                    color: 'var(--accent)',
                                    minWidth: 110,
                                }}>
                                    {cmd}
                                </code>
                                <span className="setting-label" style={{ marginLeft: 'var(--space-3)' }}>{desc}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Keyboard Shortcuts */}
                <div className="settings-group">
                    <h3>Keyboard Shortcuts</h3>
                    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                        {[
                            ['Enter', 'Send message'],
                            ['Shift + Enter', 'New line in chat'],
                        ].map(([key, desc]) => (
                            <div key={key} className="setting-row">
                                <span className="setting-label">{desc}</span>
                                <code style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 'var(--text-xs)',
                                    background: 'var(--surface-2)',
                                    padding: '2px 8px',
                                    borderRadius: 'var(--radius-sm)',
                                    color: 'var(--text-secondary)',
                                }}>
                                    {key}
                                </code>
                            </div>
                        ))}
                    </div>
                </div>

                {/* About */}
                <div className="settings-group">
                    <h3>About</h3>
                    <div className="setting-row">
                        <div>
                            <div className="setting-label">GemUI</div>
                            <div className="setting-description">
                                A premium web GUI for Gemini CLI. Built with React + Express + WebSocket + node-pty.
                                <br />
                                All Gemini CLI tools supported: file ops, shell, web fetch/search, memory, checkpoints, and all slash commands.
                            </div>
                        </div>
                        <span className="badge badge-info">v1.0.0</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
