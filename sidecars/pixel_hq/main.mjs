import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import {
  ID_RE,
  buildSessionState,
  findAppDataDirs,
  resolveSessionForConversation,
  scanSessions,
} from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = {
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/pixel-scene.js': ['pixel-scene.js', 'application/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC_FILES)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET',
  );
}

app.api('/api/sessions', (data) => {
  const dirs = findAppDataDirs();
  const currentConv = typeof data.conversationId === 'string' && ID_RE.test(data.conversationId)
    ? data.conversationId
    : app.config.conversationId || '';
  const sessions = scanSessions(dirs, { includeConv: currentConv });
  const matched = currentConv ? resolveSessionForConversation(dirs, currentConv) : null;
  return {
    currentConv: currentConv || null,
    matchedSessionId: matched?.id || null,
    sessions: sessions.map(({ id, kind, title, memberCount, updatedAt }) => ({
      id,
      kind,
      title,
      memberCount,
      updatedAt,
    })),
  };
}, 'GET');

app.api('/api/state', (data) => {
  const dirs = findAppDataDirs();
  const currentConv = typeof data.conversationId === 'string' && ID_RE.test(data.conversationId)
    ? data.conversationId
    : app.config.conversationId || '';
  const requestedId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';

  let targetId = '';
  if (requestedId) {
    if (!ID_RE.test(requestedId)) return { session: null, error: 'invalid_session_id' };
    targetId = requestedId;
  } else if (currentConv && ID_RE.test(currentConv)) {
    targetId = resolveSessionForConversation(dirs, currentConv)?.id || '';
  }

  if (!targetId) {
    const sessions = scanSessions(dirs, { includeConv: currentConv });
    return {
      currentConv: currentConv || null,
      session: null,
      sessions: sessions.slice(0, 12).map(({ id, kind, title, memberCount, updatedAt }) => ({
        id,
        kind,
        title,
        memberCount,
        updatedAt,
      })),
    };
  }

  const state = buildSessionState(dirs, targetId, Date.now());
  if (!state) return { currentConv: currentConv || null, session: null };
  if (data.etag && data.etag === state.etag) {
    return { currentConv: currentConv || null, unchanged: true, etag: state.etag };
  }
  return { currentConv: currentConv || null, session: state };
}, 'GET');

app.run();
