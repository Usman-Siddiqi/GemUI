import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Icons } from '../Icons';

export default function TerminalPanel({ ws, workspace }) {
    const containerRef = useRef(null);
    const termRef = useRef(null);
    const fitAddonRef = useRef(null);
    const [sessionId, setSessionId] = useState(null);
    const cleanupRef = useRef([]);
    const mountedRef = useRef(true);
    const activeSessionRef = useRef(null);
    const workspaceRef = useRef(workspace);

    // If workspace changes while terminal panel is open, restart in the new cwd.
    const handleRestart = useCallback(() => {
        ws.send('terminal:stop', {});
        activeSessionRef.current = null;
        setSessionId(null);
        if (termRef.current) {
            termRef.current.clear();
        }
        setTimeout(() => {
            ws.send('terminal:start', { cwd: workspace || '.' });
        }, 200);
    }, [ws, workspace]);

    useEffect(() => {
        if (workspaceRef.current === workspace) return;
        workspaceRef.current = workspace;
        if (termRef.current) handleRestart();
    }, [workspace, handleRestart]);

    // Setup terminal UI once
    useEffect(() => {
        mountedRef.current = true;
        let terminal, fitAddon;

        (async () => {
            const { Terminal } = await import('@xterm/xterm');
            const { FitAddon } = await import('@xterm/addon-fit');
            const { WebLinksAddon } = await import('@xterm/addon-web-links');
            await import('@xterm/xterm/css/xterm.css');

            if (!mountedRef.current) return;

            terminal = new Terminal({
                theme: {
                    background: '#0a0e17',
                    foreground: '#e2e8f0',
                    cursor: '#38bdf8',
                    cursorAccent: '#0a0e17',
                    selectionBackground: 'rgba(56, 189, 248, 0.3)',
                    black: '#1e293b',
                    red: '#f87171',
                    green: '#34d399',
                    yellow: '#fbbf24',
                    blue: '#60a5fa',
                    magenta: '#c084fc',
                    cyan: '#22d3ee',
                    white: '#e2e8f0',
                    brightBlack: '#475569',
                    brightRed: '#fca5a5',
                    brightGreen: '#6ee7b7',
                    brightYellow: '#fde68a',
                    brightBlue: '#93c5fd',
                    brightMagenta: '#d8b4fe',
                    brightCyan: '#67e8f9',
                    brightWhite: '#f8fafc',
                },
                fontFamily: "'JetBrains Mono', 'Consolas', monospace",
                fontSize: 14,
                lineHeight: 1.3,
                cursorBlink: true,
                cursorStyle: 'bar',
                allowProposedApi: true,
            });

            fitAddon = new FitAddon();
            terminal.loadAddon(fitAddon);
            terminal.loadAddon(new WebLinksAddon());

            termRef.current = terminal;
            fitAddonRef.current = fitAddon;

            if (containerRef.current) {
                terminal.open(containerRef.current);
                // Small delay to ensure container has dimensions
                requestAnimationFrame(() => {
                    if (fitAddonRef.current) {
                        try { fitAddonRef.current.fit(); } catch { }
                    }
                });
            }

            // Handle WS events
            const offOutput = ws.on('terminal:output', (data) => {
                if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
                if (termRef.current) terminal.write(data.output);
            });
            cleanupRef.current.push(offOutput);

            const offStarted = ws.on('terminal:started', (data) => {
                activeSessionRef.current = data.sessionId;
                if (mountedRef.current) setSessionId(data.sessionId);
                // Resize to fit now that session is active
                requestAnimationFrame(() => {
                    if (fitAddonRef.current && termRef.current) {
                        try {
                            fitAddonRef.current.fit();
                            ws.send('terminal:resize', { cols: termRef.current.cols, rows: termRef.current.rows });
                        } catch { }
                    }
                });
            });
            cleanupRef.current.push(offStarted);

            const offExit = ws.on('terminal:exit', (data) => {
                if (data?.sessionId && activeSessionRef.current && data.sessionId !== activeSessionRef.current) return;
                if (termRef.current) terminal.writeln('\r\n\x1b[33m[Session ended]\x1b[0m');
                if (mountedRef.current) setSessionId(null);
                activeSessionRef.current = null;
            });
            cleanupRef.current.push(offExit);

            // User input -> backend
            const inputDisposable = terminal.onData((data) => {
                ws.send('terminal:input', { text: data });
            });
            cleanupRef.current.push(() => inputDisposable.dispose());

            // Resize observer
            const ro = new ResizeObserver(() => {
                try {
                    if (fitAddonRef.current) fitAddonRef.current.fit();
                    if (termRef.current?.cols && termRef.current?.rows) {
                        ws.send('terminal:resize', { cols: termRef.current.cols, rows: termRef.current.rows });
                    }
                } catch { }
            });
            if (containerRef.current) ro.observe(containerRef.current);
            cleanupRef.current.push(() => ro.disconnect());

            // Start the terminal session
            ws.send('terminal:start', { cwd: workspace || '.' });
        })();

        return () => {
            mountedRef.current = false;
            cleanupRef.current.forEach(fn => typeof fn === 'function' && fn());
            cleanupRef.current = [];
            activeSessionRef.current = null;
            if (termRef.current) {
                termRef.current.dispose();
                termRef.current = null;
            }
            ws.send('terminal:stop', {});
        };
    }, []); // Run once on mount only

    return (
        <div className="panel">
            <div className="panel-header">
                <h2>
                    <Icons.Terminal style={{ width: 18, height: 18 }} />
                    Terminal
                </h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    {sessionId && <span className="badge badge-success">Live</span>}
                    <button className="btn btn-sm" onClick={handleRestart} title="Restart terminal">↻ Restart</button>
                </div>
            </div>
            <div className="terminal-container" ref={containerRef} />
        </div>
    );
}
