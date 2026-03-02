import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

/**
 * WebSocket hook with auto-reconnect and event-based message handling
 */
export function useWebSocket() {
    const wsRef = useRef(null);
    const listenersRef = useRef(new Map());
    const [connected, setConnected] = useState(false);
    const reconnectTimer = useRef(null);
    const shouldReconnectRef = useRef(true);

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;
        if (!shouldReconnectRef.current) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

        ws.onopen = () => {
            setConnected(true);
            clearTimeout(reconnectTimer.current);
        };

        ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                const handlers = listenersRef.current.get(msg.event);
                if (handlers) handlers.forEach(fn => fn(msg.data));
            } catch { /* ignore bad messages */ }
        };

        ws.onclose = () => {
            setConnected(false);
            if (shouldReconnectRef.current) {
                reconnectTimer.current = setTimeout(connect, 2000);
            }
        };

        ws.onerror = () => ws.close();

        wsRef.current = ws;
    }, []);

    const send = useCallback((event, data = {}) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ event, data }));
            return true;
        }
        return false;
    }, []);

    const on = useCallback((event, handler) => {
        if (!listenersRef.current.has(event)) {
            listenersRef.current.set(event, new Set());
        }
        listenersRef.current.get(event).add(handler);
        return () => listenersRef.current.get(event)?.delete(handler);
    }, []);

    useEffect(() => {
        shouldReconnectRef.current = true;
        connect();
        return () => {
            shouldReconnectRef.current = false;
            clearTimeout(reconnectTimer.current);
            wsRef.current?.close();
        };
    }, [connect]);

    return useMemo(() => ({ connected, send, on }), [connected, send, on]);
}

/**
 * Simple API fetch wrapper
 */
export async function api(endpoint, options = {}) {
    const { method = 'GET', body, params } = options;
    let url = `/api${endpoint}`;
    if (params) {
        const q = new URLSearchParams(params);
        url += `?${q}`;
    }
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Request failed');
    }
    return res.json();
}
