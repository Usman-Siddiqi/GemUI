import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileApi } from './routes/files.js';
import { searchApi } from './routes/search.js';
import { sessionsApi } from './routes/sessions.js';
import { healthApi } from './routes/health.js';
import { modelsApi } from './routes/models.js';
import { gitApi } from './routes/git.js';
import { SessionManager } from './lib/sessionManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4008;
const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '5mb' }));

// Serve built client in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

// ---------------------------------------------------------------------------
// REST APIs
// ---------------------------------------------------------------------------
app.use('/api', healthApi);
app.use('/api', modelsApi);
app.use('/api', fileApi);
app.use('/api', searchApi);
app.use('/api', gitApi);
app.use('/api', sessionsApi);

// SPA fallback
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server — bind to 127.0.0.1 only
// ---------------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const sessionManager = new SessionManager();

wss.on('connection', (ws) => {
  // Each WS connection can have multiple sessions (one terminal, one chat)
  let terminalSessionId = null;
  let chatSessionId = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { event, data } = msg;

    try {
      switch (event) {
        // ── Terminal mode: raw PTY ──────────────────────────────────
        case 'terminal:start': {
          // Cleanup existing terminal session first
          if (terminalSessionId) {
            sessionManager.destroySession(terminalSessionId);
          }
          const cwd = data?.cwd || process.env.USERPROFILE || process.env.HOME || '.';
          const s = await sessionManager.createTerminalSession(cwd, ws);
          terminalSessionId = s.id;
          ws.send(JSON.stringify({ event: 'terminal:started', data: { sessionId: s.id } }));
          break;
        }
        case 'terminal:input': {
          if (!terminalSessionId) return;
          sessionManager.writeToSession(terminalSessionId, data?.text ?? '');
          break;
        }
        case 'terminal:resize': {
          if (!terminalSessionId) return;
          sessionManager.resizeSession(terminalSessionId, data?.cols ?? 80, data?.rows ?? 24);
          break;
        }
        case 'terminal:stop': {
          if (terminalSessionId) sessionManager.destroySession(terminalSessionId);
          terminalSessionId = null;
          break;
        }

        // ── Chat mode: persistent Gemini ACP session ───────────────────
        case 'chat:start': {
          const cwd = data?.cwd || process.env.USERPROFILE || process.env.HOME || '.';
          const model = data?.model;
          const yolo = data?.yolo ?? false;
          const existingRuntimeState = chatSessionId ? sessionManager.getChatRuntimeState(chatSessionId) : null;

          if (chatSessionId && existingRuntimeState) {
            sessionManager.updateChatSession(chatSessionId, { cwd, model, yolo });
            const runtimeState = sessionManager.getChatRuntimeState(chatSessionId);
            ws.send(JSON.stringify({
              event: 'chat:started',
              data: { sessionId: chatSessionId, reused: true, runtimeState },
            }));
            if (runtimeState === 'ready') {
              ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: chatSessionId, phase: 'ready' } }));
              const context = sessionManager.getChatContextUsage(chatSessionId);
              if (context) {
                ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: chatSessionId, context } }));
              }
            } else if (runtimeState === 'warming') {
              ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: chatSessionId, phase: 'warming' } }));
            }
            break;
          }

          if (chatSessionId) {
            sessionManager.destroySession(chatSessionId);
          }
          const s = sessionManager.createChatSession(cwd, ws, { model, yolo });
          chatSessionId = s.id;
          const runtimeState = sessionManager.getChatRuntimeState(s.id);
          ws.send(JSON.stringify({
            event: 'chat:started',
            data: { sessionId: s.id, reused: false, runtimeState },
          }));
          if (runtimeState === 'ready') {
            ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: s.id, phase: 'ready' } }));
            const context = sessionManager.getChatContextUsage(s.id);
            if (context) {
              ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: s.id, context } }));
            }
          } else if (runtimeState === 'warming') {
            ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: s.id, phase: 'warming' } }));
          }
          break;
        }
        case 'chat:resume': {
          if (chatSessionId) {
            sessionManager.destroySession(chatSessionId);
          }
          const cwd = data?.cwd || process.env.USERPROFILE || process.env.HOME || '.';
          const model = data?.model;
          const yolo = data?.yolo ?? false;
          const sourceSessionId = data?.sourceSessionId || data?.sessionId;
          const s = sessionManager.resumeChatSession(cwd, ws, { sessionId: sourceSessionId, model, yolo });
          chatSessionId = s.id;
          const runtimeState = sessionManager.getChatRuntimeState(s.id);
          ws.send(JSON.stringify({
            event: 'chat:started',
            data: { sessionId: s.id, resumedFrom: sourceSessionId || null, reused: false, runtimeState },
          }));
          if (runtimeState === 'ready') {
            ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: s.id, phase: 'ready' } }));
            const context = sessionManager.getChatContextUsage(s.id);
            if (context) {
              ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: s.id, context } }));
            }
          } else if (runtimeState === 'warming') {
            ws.send(JSON.stringify({ event: 'chat:meta', data: { sessionId: s.id, phase: 'warming' } }));
          }
          break;
        }
        case 'chat:send': {
          if (!chatSessionId) return;
          sessionManager.sendChatMessage(chatSessionId, data?.prompt ?? '', {
            attachments: data?.attachments,
          });
          break;
        }
        case 'chat:update': {
          if (!chatSessionId) return;
          sessionManager.updateChatSession(chatSessionId, {
            cwd: data?.cwd,
            model: data?.model,
            yolo: data?.yolo,
          });
          ws.send(JSON.stringify({ event: 'chat:updated', data: { sessionId: chatSessionId } }));
          break;
        }
        case 'chat:stop': {
          if (chatSessionId) sessionManager.destroySession(chatSessionId);
          chatSessionId = null;
          break;
        }
      }
    } catch (err) {
      console.error(`[WS] Error handling ${event}:`, err.message);
      ws.send(JSON.stringify({ event: 'error', data: { message: err.message } }));
    }
  });

  ws.on('close', () => {
    if (terminalSessionId) sessionManager.destroySession(terminalSessionId);
    if (chatSessionId) sessionManager.destroySession(chatSessionId);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🚀 GemUI server running at http://127.0.0.1:${PORT}\n`);
});
