import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../hooks';
import { Icons } from '../Icons';

export default function GitPanel({ workspace }) {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [actionBusy, setActionBusy] = useState(false);
    const [commitMessage, setCommitMessage] = useState('');
    const [branchTarget, setBranchTarget] = useState('');
    const [newBranch, setNewBranch] = useState('');

    const refreshStatus = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api('/git/status', { params: { workspace } });
            setStatus(data);
            if (data?.branch) setBranchTarget(data.branch);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [workspace]);

    useEffect(() => {
        refreshStatus().catch(() => { /* handled above */ });
    }, [refreshStatus]);

    const runAction = useCallback(async (endpoint, body = {}, { refresh = true } = {}) => {
        setActionBusy(true);
        setError(null);
        try {
            const data = await api(endpoint, { method: 'POST', body: { workspace, ...body } });
            if (data?.status) {
                setStatus(data.status);
                if (data.status?.branch) setBranchTarget(data.status.branch);
            } else if (refresh) {
                await refreshStatus();
            }
            return data;
        } catch (e) {
            setError(e.message);
            return null;
        } finally {
            setActionBusy(false);
        }
    }, [workspace, refreshStatus]);

    const summary = useMemo(() => {
        const s = status?.summary || { staged: 0, unstaged: 0, untracked: 0 };
        return `${s.staged} staged • ${s.unstaged} unstaged • ${s.untracked} untracked`;
    }, [status]);

    const hasStaged = (status?.summary?.staged || 0) > 0;
    const canCommit = hasStaged && commitMessage.trim().length > 0 && !actionBusy;

    const handleCommit = async () => {
        if (!canCommit) return;
        const result = await runAction('/git/commit', { message: commitMessage.trim() });
        if (result?.ok) setCommitMessage('');
    };

    const handleCheckout = async () => {
        const branch = branchTarget.trim();
        if (!branch || branch === status?.branch) return;
        await runAction('/git/checkout', { branch });
    };

    const handleCreateBranch = async () => {
        const branch = newBranch.trim();
        if (!branch) return;
        const result = await runAction('/git/branch', { branch, checkout: true });
        if (result?.ok) setNewBranch('');
    };

    return (
        <div className="panel">
            <div className="panel-header">
                <h2>
                    <Icons.GitBranch style={{ width: 18, height: 18 }} />
                    Git
                </h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <span className="badge badge-info">{status?.branch || 'No branch'}</span>
                    <button className="btn btn-sm" onClick={refreshStatus} disabled={loading || actionBusy}>
                        Refresh
                    </button>
                </div>
            </div>

            {error && (
                <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
                    <span className="badge badge-error">{error}</span>
                </div>
            )}

            <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
                {!workspace && (
                    <div className="empty-state" style={{ height: 'auto', padding: 'var(--space-6)' }}>
                        <Icons.Folder style={{ width: 40, height: 40 }} />
                        <h3>Set a workspace first</h3>
                        <p>Choose your project path in the sidebar to enable Git tools.</p>
                    </div>
                )}

                {workspace && loading && (
                    <div className="empty-state" style={{ height: 'auto', padding: 'var(--space-6)' }}>
                        <div className="spinner" />
                        <p>Loading git status...</p>
                    </div>
                )}

                {workspace && !loading && status && !status.isRepo && (
                    <div className="empty-state" style={{ height: 'auto', padding: 'var(--space-6)' }}>
                        <Icons.GitBranch style={{ width: 40, height: 40 }} />
                        <h3>No Git Repository</h3>
                        <p>This workspace is not initialized as a git repository.</p>
                        <button className="btn btn-primary" disabled={actionBusy} onClick={() => runAction('/git/init')}>
                            Initialize Git
                        </button>
                    </div>
                )}

                {workspace && !loading && status?.isRepo && (
                    <>
                        <div className="git-toolbar">
                            <div className="git-toolbar-row">
                                <span className="setting-label">Status</span>
                                <span className="setting-description">{summary}</span>
                            </div>
                            <div className="git-toolbar-row">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                    <span className="setting-label">Branch</span>
                                    <select className="settings-select" style={{ minWidth: 180 }} value={branchTarget} onChange={(e) => setBranchTarget(e.target.value)}>
                                        {(status.branches || []).map((b) => (
                                            <option key={b} value={b}>{b}</option>
                                        ))}
                                    </select>
                                    <button className="btn btn-sm" disabled={actionBusy || !branchTarget || branchTarget === status.branch} onClick={handleCheckout}>
                                        Switch
                                    </button>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                    <input
                                        className="search-field"
                                        style={{ width: 180 }}
                                        placeholder="new branch name"
                                        value={newBranch}
                                        onChange={(e) => setNewBranch(e.target.value)}
                                    />
                                    <button className="btn btn-sm" disabled={actionBusy || !newBranch.trim()} onClick={handleCreateBranch}>
                                        Create
                                    </button>
                                </div>
                            </div>
                            <div className="git-toolbar-row">
                                <button className="btn btn-sm" disabled={actionBusy || status.clean} onClick={() => runAction('/git/stage-all')}>
                                    Stage All
                                </button>
                                <span className="setting-description">
                                    {status.upstream ? `${status.upstream} • ahead ${status.ahead} / behind ${status.behind}` : 'No upstream tracking branch'}
                                </span>
                            </div>
                        </div>

                        <div className="git-list">
                            {status.changes.map((change) => (
                                <div key={`${change.path}-${change.stagedStatus}-${change.unstagedStatus}`} className="git-item">
                                    <div className="git-item-main">
                                        <div className="git-path">{change.path}</div>
                                        <div className="git-meta">
                                            {change.untracked && <span className="badge badge-info">untracked</span>}
                                            {change.staged && <span className="badge badge-success">staged</span>}
                                            {change.unstaged && !change.untracked && <span className="badge badge-warning">unstaged</span>}
                                            <span className="badge">{change.statusLabel}</span>
                                        </div>
                                    </div>
                                    <div className="git-actions">
                                        {(change.untracked || change.unstaged) && (
                                            <button className="btn btn-sm" disabled={actionBusy} onClick={() => runAction('/git/stage', { path: change.path })}>
                                                Stage
                                            </button>
                                        )}
                                        {change.staged && (
                                            <button className="btn btn-sm" disabled={actionBusy} onClick={() => runAction('/git/unstage', { path: change.path })}>
                                                Unstage
                                            </button>
                                        )}
                                        {change.unstaged && !change.untracked && (
                                            <button
                                                className="btn btn-sm btn-danger"
                                                disabled={actionBusy}
                                                onClick={() => {
                                                    if (window.confirm(`Discard local changes in ${change.path}?`)) {
                                                        runAction('/git/discard', { path: change.path });
                                                    }
                                                }}
                                            >
                                                Discard
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {status.clean && (
                            <div className="empty-state" style={{ height: 'auto', padding: 'var(--space-6)' }}>
                                <Icons.GitBranch style={{ width: 36, height: 36 }} />
                                <h3>Working tree clean</h3>
                                <p>No local changes detected.</p>
                            </div>
                        )}

                        <div className="git-commit-box">
                            <div className="setting-label">Commit Message</div>
                            <textarea
                                className="git-commit-input"
                                value={commitMessage}
                                onChange={(e) => setCommitMessage(e.target.value)}
                                placeholder={hasStaged ? 'Describe your changes...' : 'Stage files first to commit'}
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-2)' }}>
                                <span className="setting-description">
                                    {hasStaged ? 'Only staged files will be committed.' : 'No staged changes.'}
                                </span>
                                <button className="btn btn-primary" disabled={!canCommit} onClick={handleCommit}>
                                    Commit
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
