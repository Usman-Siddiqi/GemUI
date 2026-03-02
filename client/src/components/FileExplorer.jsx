import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../hooks';
import { Icons } from '../Icons';
import Editor from '@monaco-editor/react';

export default function FileExplorer({ workspace }) {
    const [tree, setTree] = useState([]);
    const [expanded, setExpanded] = useState(new Set());
    const [children, setChildren] = useState({});
    const [openFiles, setOpenFiles] = useState([]);       // {path, name, content, modified}
    const [activeFile, setActiveFile] = useState(null);
    const [error, setError] = useState(null);
    const [contextMenu, setContextMenu] = useState(null);

    const loadDir = useCallback(async (dirPath = '.') => {
        try {
            const data = await api('/files', { params: { path: dirPath, workspace } });
            if (dirPath === '.') setTree(data.items);
            else setChildren(prev => ({ ...prev, [dirPath]: data.items }));
        } catch (e) {
            setError(e.message);
        }
    }, [workspace]);

    useEffect(() => {
        loadDir('.');
    }, [loadDir]);

    const toggleExpand = async (item) => {
        const key = item.path;
        if (expanded.has(key)) {
            expanded.delete(key);
            setExpanded(new Set(expanded));
        } else {
            expanded.add(key);
            setExpanded(new Set(expanded));
            await loadDir(key);
        }
    };

    const openFile = async (item) => {
        if (item.isDirectory) return toggleExpand(item);
        // check if already open
        const existing = openFiles.find(f => f.path === item.path);
        if (existing) { setActiveFile(item.path); return; }

        try {
            const data = await api('/file', { params: { path: item.path, workspace } });
            setOpenFiles(prev => [...prev, { path: item.path, name: item.name, content: data.content, modified: false }]);
            setActiveFile(item.path);
        } catch (e) {
            setError(e.message);
        }
    };

    const closeFile = (path, e) => {
        e?.stopPropagation();
        setOpenFiles(prev => prev.filter(f => f.path !== path));
        if (activeFile === path) {
            setActiveFile(openFiles.find(f => f.path !== path)?.path || null);
        }
    };

    const saveFile = async (path) => {
        const file = openFiles.find(f => f.path === path);
        if (!file) return;
        try {
            await api('/file', { method: 'PUT', body: { path, content: file.content } });
            setOpenFiles(prev => prev.map(f => f.path === path ? { ...f, modified: false } : f));
        } catch (e) {
            setError(e.message);
        }
    };

    const handleEditorChange = (value) => {
        setOpenFiles(prev => prev.map(f =>
            f.path === activeFile ? { ...f, content: value, modified: true } : f
        ));
    };

    const handleCreate = async (parentPath, isDirectory) => {
        const name = prompt(`New ${isDirectory ? 'folder' : 'file'} name:`);
        if (!name) return;
        const newPath = parentPath === '.' ? name : `${parentPath}/${name}`;
        try {
            await api('/file/create', { method: 'POST', body: { path: newPath, isDirectory } });
            loadDir(parentPath);
        } catch (e) {
            setError(e.message);
        }
        setContextMenu(null);
    };

    const handleDelete = async (path) => {
        if (!confirm(`Delete "${path}"?`)) return;
        try {
            await api('/file', { method: 'DELETE', params: { path, workspace } });
            closeFile(path);
            loadDir('.');
        } catch (e) {
            setError(e.message);
        }
        setContextMenu(null);
    };

    const handleRename = async (oldPath) => {
        const newName = prompt('New name:', oldPath.split('/').pop());
        if (!newName) return;
        const parts = oldPath.split('/');
        parts[parts.length - 1] = newName;
        const newPath = parts.join('/');
        try {
            await api('/file/move', { method: 'POST', body: { from: oldPath, to: newPath } });
            loadDir('.');
        } catch (e) {
            setError(e.message);
        }
        setContextMenu(null);
    };

    const getLanguage = (filename) => {
        const ext = filename.split('.').pop();
        const map = {
            js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
            py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
            html: 'html', css: 'css', scss: 'scss', json: 'json',
            md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'toml',
            sh: 'shell', bash: 'shell', sql: 'sql', xml: 'xml',
            java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
        };
        return map[ext] || 'plaintext';
    };

    const activeFileData = openFiles.find(f => f.path === activeFile);

    const renderItem = (item, depth = 0) => (
        <div key={item.path}>
            <div
                className={`file-tree-item ${activeFile === item.path ? 'active' : ''} ${item.isDirectory ? 'directory' : ''}`}
                style={{ paddingLeft: 12 + depth * 16 }}
                onClick={() => openFile(item)}
                onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
            >
                {item.isDirectory ? (
                    expanded.has(item.path) ? <Icons.ChevronDown className="file-tree-icon" /> : <Icons.ChevronRight className="file-tree-icon" />
                ) : <Icons.File className="file-tree-icon" />}
                <span>{item.name}</span>
            </div>
            {item.isDirectory && expanded.has(item.path) && children[item.path]?.map(child => renderItem(child, depth + 1))}
        </div>
    );

    return (
        <div className="file-explorer">
            <div className="file-tree-pane">
                <div className="panel-header" style={{ padding: 'var(--space-2) var(--space-3)' }}>
                    <h2 style={{ fontSize: 'var(--text-sm)' }}>
                        <Icons.Folder style={{ width: 14, height: 14 }} /> Explorer
                    </h2>
                    <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm" onClick={() => handleCreate('.', false)} title="New File">
                            <Icons.File style={{ width: 12, height: 12 }} />
                        </button>
                        <button className="btn btn-sm" onClick={() => handleCreate('.', true)} title="New Folder">
                            <Icons.FolderOpen style={{ width: 12, height: 12 }} />
                        </button>
                        <button className="btn btn-sm" onClick={() => loadDir('.')} title="Refresh">↻</button>
                    </div>
                </div>
                <div style={{ overflow: 'auto', flex: 1 }}>
                    {tree.map(item => renderItem(item))}
                </div>
            </div>

            <div className="file-editor-pane">
                {openFiles.length > 0 && (
                    <div className="editor-tabs">
                        {openFiles.map(f => (
                            <div
                                key={f.path}
                                className={`editor-tab ${activeFile === f.path ? 'active' : ''}`}
                                onClick={() => setActiveFile(f.path)}
                            >
                                <span>{f.name}{f.modified ? ' •' : ''}</span>
                                <span className="editor-tab-close" onClick={(e) => closeFile(f.path, e)}>
                                    <Icons.X style={{ width: 12, height: 12 }} />
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {activeFileData ? (
                    <div style={{ flex: 1, position: 'relative' }}>
                        {activeFileData.modified && (
                            <button
                                className="btn btn-primary btn-sm"
                                style={{ position: 'absolute', top: 8, right: 16, zIndex: 10 }}
                                onClick={() => saveFile(activeFile)}
                            >
                                <Icons.Save style={{ width: 12, height: 12 }} /> Save
                            </button>
                        )}
                        <Editor
                            height="100%"
                            language={getLanguage(activeFileData.name)}
                            value={activeFileData.content}
                            onChange={handleEditorChange}
                            theme="vs-dark"
                            options={{
                                minimap: { enabled: false },
                                fontSize: 14,
                                fontFamily: "'JetBrains Mono', Consolas, monospace",
                                lineNumbers: 'on',
                                renderWhitespace: 'selection',
                                scrollBeyondLastLine: false,
                                wordWrap: 'on',
                                padding: { top: 8 },
                            }}
                        />
                    </div>
                ) : (
                    <div className="empty-state">
                        <Icons.File style={{ width: 48, height: 48 }} />
                        <h3>No file open</h3>
                        <p>Select a file from the explorer to start editing</p>
                    </div>
                )}
            </div>

            {/* Context menu */}
            {contextMenu && (
                <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setContextMenu(null)} />
                    <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
                        <div className="context-menu-item" onClick={() => handleCreate(contextMenu.item.isDirectory ? contextMenu.item.path : '.', false)}>
                            <Icons.File style={{ width: 14, height: 14 }} /> New File
                        </div>
                        <div className="context-menu-item" onClick={() => handleCreate(contextMenu.item.isDirectory ? contextMenu.item.path : '.', true)}>
                            <Icons.FolderOpen style={{ width: 14, height: 14 }} /> New Folder
                        </div>
                        <div className="context-menu-item" onClick={() => handleRename(contextMenu.item.path)}>
                            ✏️ Rename
                        </div>
                        <div className="context-menu-item danger" onClick={() => handleDelete(contextMenu.item.path)}>
                            <Icons.Trash style={{ width: 14, height: 14 }} /> Delete
                        </div>
                    </div>
                </>
            )}

            {error && (
                <div className="badge badge-error" style={{ position: 'fixed', bottom: 16, right: 16, padding: '8px 16px', fontSize: 'var(--text-sm)', cursor: 'pointer' }} onClick={() => setError(null)}>
                    {error}
                </div>
            )}
        </div>
    );
}
