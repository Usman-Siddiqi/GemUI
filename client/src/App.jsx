import React, { useState, useEffect } from 'react';
import { useWebSocket, api } from './hooks';
import { Icons } from './Icons';
import ChatPanel from './components/ChatPanel';
import TerminalPanel from './components/TerminalPanel';
import FileExplorer from './components/FileExplorer';
import SearchPanel from './components/SearchPanel';
import MemoryPanel from './components/MemoryPanel';
import SessionPanel from './components/SessionPanel';
import SettingsPanel from './components/SettingsPanel';

const NAV_ITEMS = [
    { id: 'chat', label: 'Chat', icon: Icons.Chat, section: 'main' },
    { id: 'terminal', label: 'Terminal', icon: Icons.Terminal, section: 'main' },
    { id: 'files', label: 'Files', icon: Icons.Folder, section: 'main' },
    { id: 'search', label: 'Search', icon: Icons.Search, section: 'main' },
    { id: 'memory', label: 'Memory', icon: Icons.Memory, section: 'tools' },
    { id: 'sessions', label: 'Sessions', icon: Icons.Sessions, section: 'tools' },
    { id: 'settings', label: 'Settings', icon: Icons.Settings, section: 'tools' },
];

export default function App() {
    const [activePanel, setActivePanel] = useState('welcome');
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [workspace, setWorkspace] = useState('');
    const [editingWorkspace, setEditingWorkspace] = useState(false);
    const [workspaceInput, setWorkspaceInput] = useState('');
    const [health, setHealth] = useState(null);
    const [model, setModel] = useState('gemini-2.5-flash');
    const [yolo, setYolo] = useState(false);
    const ws = useWebSocket();

    useEffect(() => {
        api('/health').then(setHealth).catch(() => { });
    }, []);

    const handleNavClick = (id) => {
        setActivePanel(id);
        setSidebarOpen(false);
    };

    const handleWorkspaceSet = () => {
        const trimmed = workspaceInput.trim();
        if (trimmed) {
            setWorkspace(trimmed);
        }
        setEditingWorkspace(false);
    };

    const renderPanel = () => {
        switch (activePanel) {
            case 'chat':
                return <ChatPanel ws={ws} workspace={workspace} model={model} yolo={yolo} />;
            case 'terminal':
                return <TerminalPanel ws={ws} workspace={workspace} />;
            case 'files':
                return <FileExplorer workspace={workspace} />;
            case 'search':
                return <SearchPanel workspace={workspace} />;
            case 'memory':
                return <MemoryPanel />;
            case 'sessions':
                return <SessionPanel />;
            case 'settings':
                return <SettingsPanel model={model} setModel={setModel} yolo={yolo} setYolo={setYolo} health={health} />;
            default:
                return <WelcomePanel onNavigate={handleNavClick} health={health} />;
        }
    };

    return (
        <div className="app-layout">
            {/* Mobile overlay */}
            <div className={`overlay ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />

            {/* Sidebar */}
            <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
                <div className="sidebar-brand">
                    <Icons.Gemini />
                    <h1>GemUI</h1>
                </div>

                <nav className="sidebar-nav">
                    <div className="sidebar-section-label">Workspace</div>
                    {NAV_ITEMS.filter(n => n.section === 'main').map(item => (
                        <div
                            key={item.id}
                            className={`nav-item ${activePanel === item.id ? 'active' : ''}`}
                            onClick={() => handleNavClick(item.id)}
                        >
                            <item.icon />
                            <span>{item.label}</span>
                        </div>
                    ))}

                    <div className="sidebar-section-label">Tools</div>
                    {NAV_ITEMS.filter(n => n.section === 'tools').map(item => (
                        <div
                            key={item.id}
                            className={`nav-item ${activePanel === item.id ? 'active' : ''}`}
                            onClick={() => handleNavClick(item.id)}
                        >
                            <item.icon />
                            <span>{item.label}</span>
                        </div>
                    ))}
                </nav>

                <div className="sidebar-workspace">
                    {editingWorkspace ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                            <input
                                type="text"
                                className="chat-input"
                                autoFocus
                                value={workspaceInput}
                                onChange={(e) => setWorkspaceInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleWorkspaceSet();
                                    if (e.key === 'Escape') setEditingWorkspace(false);
                                }}
                                onBlur={handleWorkspaceSet}
                                placeholder="C:\path\to\project"
                                style={{ fontSize: 'var(--text-xs)', padding: '6px 8px', flex: 1 }}
                            />
                        </div>
                    ) : (
                        <button
                            className="workspace-btn"
                            onClick={() => {
                                setWorkspaceInput(workspace);
                                setEditingWorkspace(true);
                            }}
                            title="Change workspace directory"
                        >
                            <Icons.FolderOpen style={{ width: 14, height: 14, flexShrink: 0 }} />
                            <span>{workspace || 'Set workspace...'}</span>
                        </button>
                    )}
                </div>
            </aside>

            {/* Main Content */}
            <main className="app-main">
                <header className="header">
                    <div className="header-left">
                        <button className="btn btn-sm" onClick={() => setSidebarOpen(!sidebarOpen)} style={{ display: 'none' }} id="menu-toggle">
                            <Icons.Menu style={{ width: 16, height: 16 }} />
                        </button>
                        <style>{`@media (max-width: 768px) { #menu-toggle { display: flex !important; } }`}</style>
                        {activePanel !== 'welcome' && (
                            <span style={{ fontWeight: 600, fontSize: 'var(--text-lg)' }}>
                                {NAV_ITEMS.find(n => n.id === activePanel)?.label || 'GemUI'}
                            </span>
                        )}
                    </div>
                    <div className="header-right">
                        <div className="header-model">
                            <Icons.Gemini style={{ width: 12, height: 12 }} />
                            <span>{model}</span>
                        </div>
                        <div className={`connection-dot ${ws.connected ? '' : 'disconnected'}`} title={ws.connected ? 'Connected' : 'Disconnected'} />
                    </div>
                </header>

                <div className="app-content">
                    {renderPanel()}
                </div>
            </main>
        </div>
    );
}

function WelcomePanel({ onNavigate, health }) {
    return (
        <div className="welcome-container">
            <div className="welcome-logo">GemUI</div>
            <p className="welcome-subtitle">
                A premium web interface for Gemini CLI.
                Chat, edit files, search code, and run commands — all from your browser.
            </p>

            {health && !health.geminiCli?.installed && (
                <div className="badge badge-warning" style={{ padding: '8px 16px', fontSize: 'var(--text-sm)' }}>
                    ⚠️ Gemini CLI not detected — please install it first
                </div>
            )}

            {health?.geminiCli?.installed && (
                <div className="badge badge-success" style={{ padding: '8px 16px', fontSize: 'var(--text-sm)' }}>
                    ✓ Gemini CLI {health.geminiCli.version}
                </div>
            )}

            <div className="welcome-grid">
                <div className="welcome-card" onClick={() => onNavigate('chat')}>
                    <Icons.Chat />
                    <span>Chat</span>
                </div>
                <div className="welcome-card" onClick={() => onNavigate('terminal')}>
                    <Icons.Terminal />
                    <span>Terminal</span>
                </div>
                <div className="welcome-card" onClick={() => onNavigate('files')}>
                    <Icons.Folder />
                    <span>Files</span>
                </div>
                <div className="welcome-card" onClick={() => onNavigate('search')}>
                    <Icons.Search />
                    <span>Search</span>
                </div>
                <div className="welcome-card" onClick={() => onNavigate('memory')}>
                    <Icons.Memory />
                    <span>Memory</span>
                </div>
                <div className="welcome-card" onClick={() => onNavigate('settings')}>
                    <Icons.Settings />
                    <span>Settings</span>
                </div>
            </div>
        </div>
    );
}
