import React, { useState } from 'react';
import { api } from '../hooks';
import { Icons } from '../Icons';

export default function SearchPanel({ workspace }) {
    const [mode, setMode] = useState('grep'); // 'grep' | 'glob'
    const [query, setQuery] = useState('');
    const [pattern, setPattern] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    // Replace state
    const [showReplace, setShowReplace] = useState(false);
    const [replaceWith, setReplaceWith] = useState('');
    const [selectedFile, setSelectedFile] = useState(null);
    const [replaceResult, setReplaceResult] = useState(null);

    const doGrep = async () => {
        if (!query) return;
        setLoading(true);
        setError(null);
        try {
            const data = await api('/grep', { method: 'POST', body: { query, workspace } });
            setResults({ type: 'grep', items: data.results, total: data.total });
        } catch (e) {
            setError(e.message);
        }
        setLoading(false);
    };

    const doGlob = async () => {
        if (!pattern) return;
        setLoading(true);
        setError(null);
        try {
            const data = await api('/glob', { method: 'POST', body: { pattern, workspace } });
            setResults({ type: 'glob', items: data.matches, total: data.total, capped: data.capped });
        } catch (e) {
            setError(e.message);
        }
        setLoading(false);
    };

    const doReplace = async (filePath, preview = true) => {
        if (!query || !filePath) return;
        try {
            const data = await api('/replace', {
                method: 'POST',
                params: { workspace },
                body: { path: filePath, oldString: query, newString: replaceWith, preview }
            });
            setReplaceResult(data);
            if (!preview) {
                setReplaceResult({ ...data, applied: true });
            }
        } catch (e) {
            setError(e.message);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            mode === 'grep' ? doGrep() : doGlob();
        }
    };

    return (
        <div className="panel">
            <div className="panel-header">
                <h2>
                    <Icons.Search style={{ width: 18, height: 18 }} />
                    Search
                </h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <button className={`btn btn-sm ${mode === 'grep' ? 'btn-primary' : ''}`} onClick={() => setMode('grep')}>
                        Text Search
                    </button>
                    <button className={`btn btn-sm ${mode === 'glob' ? 'btn-primary' : ''}`} onClick={() => setMode('glob')}>
                        File Search
                    </button>
                </div>
            </div>

            <div className="search-input-group">
                {mode === 'grep' ? (
                    <>
                        <input
                            className="search-field"
                            placeholder="Search text in files (regex supported)..."
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                        />
                        <button className="btn" onClick={() => setShowReplace(!showReplace)} title="Toggle replace">
                            ↔
                        </button>
                    </>
                ) : (
                    <input
                        className="search-field"
                        placeholder="Glob pattern (e.g. **/*.js, src/**/*.tsx)..."
                        value={pattern}
                        onChange={(e) => setPattern(e.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                )}
                <button className="btn btn-primary" onClick={mode === 'grep' ? doGrep : doGlob} disabled={loading}>
                    {loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icons.Search style={{ width: 14, height: 14 }} />}
                </button>
            </div>

            {showReplace && mode === 'grep' && (
                <div className="search-input-group" style={{ paddingTop: 0 }}>
                    <input
                        className="search-field"
                        placeholder="Replace with..."
                        value={replaceWith}
                        onChange={(e) => setReplaceWith(e.target.value)}
                    />
                </div>
            )}

            {error && (
                <div style={{ padding: 'var(--space-2) var(--space-4)' }}>
                    <span className="badge badge-error">{error}</span>
                </div>
            )}

            <div className="panel-body search-results">
                {results && (
                    <div style={{ padding: 'var(--space-2) 0', marginBottom: 'var(--space-2)', color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
                        {results.total} result{results.total !== 1 ? 's' : ''} found
                        {results.capped && ' (capped at 200)'}
                    </div>
                )}

                {results?.type === 'grep' && results.items.map((r, i) => (
                    <div key={i} className="search-result-item" onClick={() => setSelectedFile(r.file)}>
                        <div className="search-result-file">{r.file}</div>
                        <div className="search-result-line">Line {r.line}</div>
                        <div className="search-result-content">{r.content}</div>
                        {showReplace && selectedFile === r.file && (
                            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                                <button className="btn btn-sm" onClick={() => doReplace(r.file, true)}>Preview</button>
                                <button className="btn btn-sm btn-primary" onClick={() => doReplace(r.file, false)}>Apply</button>
                            </div>
                        )}
                    </div>
                ))}

                {results?.type === 'glob' && results.items.map((path, i) => (
                    <div key={i} className="search-result-item">
                        <div className="search-result-file">{path}</div>
                    </div>
                ))}

                {replaceResult && (
                    <div style={{ padding: 'var(--space-3)', marginTop: 'var(--space-2)', background: 'var(--surface-1)', borderRadius: 'var(--radius-sm)' }}>
                        <p style={{ fontSize: 'var(--text-sm)', color: replaceResult.applied ? 'var(--success)' : 'var(--warning)' }}>
                            {replaceResult.applied
                                ? `✓ Replaced ${replaceResult.occurrences} occurrence(s)`
                                : `Found ${replaceResult.occurrences} occurrence(s) — click Apply to replace`}
                        </p>
                    </div>
                )}

                {!results && !loading && (
                    <div className="empty-state">
                        <Icons.Search style={{ width: 48, height: 48 }} />
                        <h3>{mode === 'grep' ? 'Search your codebase' : 'Find files'}</h3>
                        <p>{mode === 'grep' ? 'Search for text patterns across all files in your workspace' : 'Use glob patterns to find files (e.g. **/*.js)'}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
