import React from 'react';
import { Icons } from '../Icons';

const MODELS = [
    { value: '', label: 'CLI Default (Recommended)', tier: 'Recommended' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', tier: 'Latest' },
    { value: 'gemini-3.1-flash-preview', label: 'Gemini 3.1 Flash (Preview)', tier: 'Latest' },
    { value: 'gemini-3.0-pro', label: 'Gemini 3 Pro', tier: 'Current' },
    { value: 'gemini-3.0-flash', label: 'Gemini 3 Flash', tier: 'Current' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'Stable' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'Stable' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'Stable' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tier: 'Legacy' },
    { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', tier: 'Legacy' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', tier: 'Legacy' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', tier: 'Legacy' },
];

export default function SettingsPanel({ model, setModel, yolo, setYolo, health }) {
    const tiers = [...new Set(MODELS.map(m => m.tier))];

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
                            <div className="setting-label">Active Model</div>
                            <div className="setting-description">The Gemini model used for new chat sessions. Changes apply to new sessions only.</div>
                        </div>
                        <select className="settings-select" value={model} onChange={(e) => setModel(e.target.value)}>
                            {tiers.map(tier => (
                                <optgroup key={tier} label={tier}>
                                    {MODELS.filter(m => m.tier === tier).map(m => (
                                        <option key={m.value} value={m.value}>{m.label}</option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                    </div>
                    <div className="setting-description" style={{ marginTop: 'var(--space-2)', color: 'var(--text-tertiary)' }}>
                        Model availability depends on your Gemini account/project. Use CLI Default for maximum compatibility.
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
