import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

const VIDEO_EXTS = new Set(['.mp4', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a']);
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]{1,96}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 18 * 1024 * 1024;
const MAX_AUDIO_BYTES = 18 * 1024 * 1024;

const DEFAULT_CONFIG = {
  mode: 'default',   // default | image | video
  mediaFile: '',
  dim: 0.45,         // 0 .. 0.9
  blur: 6,           // 0 .. 20 (px)
  glassOpacity: 0.84,// 0.45 .. 1
  bgmEnabled: false,
  bgmFile: '',
  bgmVolume: 0.35,   // 0 .. 1
};

function kindOf(ext) {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'image';
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitizeConfig(raw) {
  const mode = raw?.mode === 'image' || raw?.mode === 'video' ? raw.mode : 'default';
  const mediaFile = typeof raw?.mediaFile === 'string' && SAFE_NAME_RE.test(raw.mediaFile) ? raw.mediaFile : '';
  const bgmFile = typeof raw?.bgmFile === 'string' && SAFE_NAME_RE.test(raw.bgmFile) ? raw.bgmFile : '';
  return {
    mode: mode !== 'default' && !mediaFile ? 'default' : mode,
    mediaFile,
    dim: Math.round(clamp(raw?.dim, 0, 0.9, DEFAULT_CONFIG.dim) * 100) / 100,
    blur: Math.round(clamp(raw?.blur, 0, 20, DEFAULT_CONFIG.blur)),
    glassOpacity: Math.round(clamp(raw?.glassOpacity, 0.45, 1, DEFAULT_CONFIG.glassOpacity) * 100) / 100,
    bgmEnabled: Boolean(raw?.bgmEnabled) && Boolean(bgmFile),
    bgmFile,
    bgmVolume: Math.round(clamp(raw?.bgmVolume, 0, 1, DEFAULT_CONFIG.bgmVolume) * 100) / 100,
  };
}

export function createMediaStore(dataDir) {
  const mediaDir = join(dataDir, 'media');
  const configPath = join(dataDir, 'theme_config.json');

  function ensureDirs() {
    mkdirSync(mediaDir, { recursive: true });
  }

  function getConfig() {
    if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
    try {
      return sanitizeConfig(JSON.parse(readFileSync(configPath, 'utf-8')));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(input) {
    ensureDirs();
    const next = sanitizeConfig({ ...getConfig(), ...(input || {}) });
    writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  }

  function listMedia() {
    if (!existsSync(mediaDir)) return [];
    const out = [];
    for (const name of readdirSync(mediaDir)) {
      if (!SAFE_NAME_RE.test(name)) continue;
      const ext = extname(name).toLowerCase();
      if (!MIME_BY_EXT[ext]) continue;
      try {
        const st = statSync(join(mediaDir, name));
        if (!st.isFile()) continue;
        out.push({
          name,
          kind: kindOf(ext),
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch {}
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  function uploadMedia(originalName, dataBase64) {
    ensureDirs();
    const ext = extname(String(originalName || '')).toLowerCase();
    if (!MIME_BY_EXT[ext]) throw new Error(`Unsupported media type: ${ext || 'none'}`);
    const kind = kindOf(ext);
    const cleanB64 = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(cleanB64, 'base64');
    if (!buf.length) throw new Error('Empty media payload');
    const limit = kind === 'video' ? MAX_VIDEO_BYTES : kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
    if (buf.length > limit) {
      throw new Error(`File exceeds ${Math.round(limit / (1024 * 1024))}MB limit`);
    }

    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
    // Deduplicate identical uploads by content hash prefix
    const existing = listMedia().find((f) => f.name.startsWith(`${hash}_`) && extname(f.name).toLowerCase() === ext);
    if (existing) return existing;

    const stem = String(originalName || 'media')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 32) || 'bg';
    const fileName = `${hash}_${stem}${ext}`;
    writeFileSync(join(mediaDir, fileName), buf);
    return { name: fileName, kind, size: buf.length, mtime: Date.now() };
  }

  function deleteMedia(name) {
    if (!SAFE_NAME_RE.test(String(name || ''))) return false;
    const full = join(mediaDir, name);
    if (!existsSync(full)) return false;
    unlinkSync(full);
    const cfg = getConfig();
    const patch = {};
    if (cfg.mediaFile === name) {
      patch.mode = 'default';
      patch.mediaFile = '';
    }
    if (cfg.bgmFile === name) {
      patch.bgmEnabled = false;
      patch.bgmFile = '';
    }
    if (Object.keys(patch).length) saveConfig(patch);
    return true;
  }

  function readMediaRange(name, rangeHeader = '') {
    if (!SAFE_NAME_RE.test(String(name || ''))) return null;
    const ext = extname(name).toLowerCase();
    const contentType = MIME_BY_EXT[ext];
    if (!contentType) return null;
    const full = join(mediaDir, name);
    if (!existsSync(full)) return null;
    const st = statSync(full);
    if (!st.isFile()) return null;

    const total = st.size;
    const m = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || '').trim());
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : Math.min(start + 1024 * 1024 - 1, total - 1);
      if (start >= total || start > end) {
        return { status: 416, contentType: 'text/plain', body: 'Range Not Satisfiable', headers: { 'Content-Range': `bytes */${total}` } };
      }
      const len = end - start + 1;
      const buf = Buffer.allocUnsafe(len);
      const fd = openSync(full, 'r');
      try {
        readSync(fd, buf, 0, len, start);
      } finally {
        closeSync(fd);
      }
      return {
        status: 206,
        contentType,
        body: buf,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(len),
          'Cache-Control': 'private, max-age=3600',
        },
      };
    }

    return {
      status: 200,
      contentType,
      body: readFileSync(full),
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(total),
        'Cache-Control': 'private, max-age=3600',
      },
    };
  }

  return { getConfig, saveConfig, listMedia, uploadMedia, deleteMedia, readMediaRange };
}
