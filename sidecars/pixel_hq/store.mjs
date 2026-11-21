import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ID_RE = /^[0-9a-f-]{8,64}$/i;
const STUCK_MS = 10 * 60 * 1000;
const STEP_ERROR_SETTLE_MS = 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const SUBAGENT_SCAN_TAIL_BYTES = 2 * 1024 * 1024; // shortcut: tail-capped at 2MB for giant transcripts, upgrade to streaming reader if needed
const MAX_RECENT_SUBAGENT_CANDIDATES = 25;
const SCAN_TTL_MS = 4000;
const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;
const NAME_RUNE = /[\p{L}\p{Nd}_-]/u;

const transcriptCache = new Map();
const subagentIndexCache = new Map();
const scanCache = new Map();

export function findAppDataDirs() {
  if (process.env.PIXEL_AGENTS_DATA_DIR) {
    return existsSync(join(process.env.PIXEL_AGENTS_DATA_DIR, 'brain'))
      ? [process.env.PIXEL_AGENTS_DATA_DIR]
      : [];
  }
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .map((n) => join(root, n))
    .filter((d) => existsSync(join(d, 'brain')));
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statOf(path) {
  try {
    const s = statSync(path);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

function readTail(path, maxBytes) {
  const s = statOf(path);
  if (s.size < 0) return { text: null, mtime: 0, size: -1, truncated: false };
  if (s.size <= maxBytes) {
    try {
      return { text: readFileSync(path, 'utf-8'), ...s, truncated: false };
    } catch {
      return { text: null, mtime: 0, size: -1, truncated: false };
    }
  }
  const start = s.size - maxBytes;
  const buf = Buffer.allocUnsafe(maxBytes);
  let fd;
  try {
    fd = openSync(path, 'r');
    const bytesRead = readSync(fd, buf, 0, maxBytes, start);
    let text = buf.subarray(0, bytesRead).toString('utf-8');
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
    return { text, ...s, truncated: true };
  } catch {
    return { text: null, mtime: 0, size: -1, truncated: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function readHeadTitle(transcriptFile) {
  const s = statOf(transcriptFile);
  if (s.size <= 0) return '';
  const len = Math.min(s.size, 8192);
  const buf = Buffer.allocUnsafe(len);
  let fd;
  try {
    fd = openSync(transcriptFile, 'r');
    const n = readSync(fd, buf, 0, len, 0);
    const text = buf.subarray(0, n).toString('utf-8');
    const firstLine = text.split('\n')[0];
    if (!firstLine) return '';
    const obj = JSON.parse(firstLine);
    const raw = String(obj?.content || '');
    const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
    return oneLine(m ? m[1] : raw, 72);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function formatModelName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const clean = s.replace(/^models\//i, '');
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)(?:-(.+))?$/i.exec(clean);
  if (claude) {
    const family = cap(claude[1]);
    const extra = claude[4] ? ` (${cap(claude[4])})` : '';
    return `Claude ${family} ${claude[2]}.${claude[3]}${extra}`;
  }
  const gpt = /^gpt-oss-(\d+b)(?:-(.+))?$/i.exec(clean);
  if (gpt) {
    return `GPT OSS ${gpt[1].toUpperCase()}${gpt[2] ? ` (${cap(gpt[2])})` : ''}`;
  }
  const parts = clean.split(/[-_]+/).filter(Boolean);
  const out = parts.map((p) => {
    const low = p.toLowerCase();
    if (low === 'xhigh') return 'XHigh';
    if (low === 'gpt') return 'GPT';
    if (low === 'oss') return 'OSS';
    if (/^\d+b$/i.test(p)) return p.toUpperCase();
    return cap(p);
  });
  return out.join(' ');
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
}

function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return String(JSON.parse(s)); } catch { return s.slice(1, -1); }
  }
  return s;
}

function oneLine(s, maxLen = 88) {
  const out = String(s || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

function classifyToolKind(name) {
  if (!name) return 'tool';
  if (/^(read_file|list_resources|read_resource|view_|inspect_|list_)/.test(name)) return 'read';
  if (/^(edit_file|write_file|replace_file|multi_replace)/.test(name)) return 'edit';
  if (/^(run_command|manage_task|run_workflow|schedule)/.test(name)) return 'cmd';
  if (/^(search_|code_search|grep_|find_by_name)/.test(name)) return 'search';
  if (/^(swarm|post_message|read_board|swarm_wait|invoke_subagent|send_message)/.test(name)) return 'board';
  return 'tool';
}

function toFileUri(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const clean = filePath.trim();
  if (!clean || /[\0]/.test(clean)) return '';
  if (!isAbsolute(clean) && !/^[a-zA-Z]:[\\/]/.test(clean)) return '';
  try {
    return pathToFileURL(clean).href;
  } catch {
    return '';
  }
}

function extractToolFilePath(tc) {
  const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  return unquote(args.Path || args.AbsolutePath || args.TargetFile || args.FilePath || '');
}

function isWriteTool(name) {
  return /^(edit_file|write_file|replace_file|multi_replace)/.test(String(name || ''));
}

function describeToolCall(tc) {
  const name = tc?.name || '';
  if (!name) return { label: '', kind: 'tool', filePath: '' };
  const boardLabels = {
    swarm_wait: 'Chờ tin nhắn Board',
    read_board: 'Đọc Board',
    post_message: 'Gửi tin lên Board',
  };
  if (boardLabels[name]) return { label: boardLabels[name], kind: 'board', filePath: '' };
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const kind = classifyToolKind(name);
  const filePath = extractToolFilePath(tc);
  const summary = unquote(args.toolSummary) || unquote(args.toolAction);
  if (summary) return { label: oneLine(summary, 72), kind, filePath };
  if (filePath) {
    const verb = { read_file: 'Read', write_file: 'Write', edit_file: 'Edit' }[name];
    if (verb) return { label: `${verb} ${basename(filePath)}`, kind, filePath };
  }
  if (name === 'code_search' && args.Query) return { label: oneLine(`Search ${unquote(args.Query)}`, 72), kind, filePath: '' };
  if (name === 'swarm' && args.action) return { label: oneLine(`swarm ${unquote(args.action)} ${unquote(args.name)}`, 72), kind, filePath: '' };
  if (name === 'invoke_subagent') return { label: oneLine(`Spawn ${unquote(args.Role) || unquote(args.TypeName)}`, 72), kind: 'board', filePath: '' };
  if (name === 'send_message') return { label: 'Gửi tin cho agent', kind: 'board', filePath: '' };
  return { label: name, kind, filePath };
}

function thinkingHeading(thinking) {
  if (typeof thinking !== 'string') return '';
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)];
  return hs.length ? oneLine(hs[hs.length - 1][1], 72) : '';
}

function replyQuestion(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, (_, s) => s.replace(/\?/g, ''))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
    .replace(/\*\*|__/g, '');
  const qs = plain
    .split(/\n+|(?<=[.!?])\s+/)
    .map((x) => x.replace(/^[\s>*-]+/, '').trim())
    .filter((x) => /\?$/.test(x) && x.length > 3);
  return qs.length ? oneLine(qs[qs.length - 1], 180) : '';
}

function parseJsonLines(text) {
  const out = [];
  let tornTail = false;
  const rawLines = (text || '').split('\n').filter((l) => l.trim());
  for (let i = 0; i < rawLines.length; i++) {
    try {
      const obj = JSON.parse(rawLines[i]);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      if (i === rawLines.length - 1) tornTail = true;
    }
  }
  return { items: out, tornTail };
}

function turnEnded(steps, tornTail) {
  if (tornTail || !steps.length) return false;
  const results = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'GENERIC') {
      results.unshift(step);
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE') return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const waitIdx = calls.findIndex((c) => c?.name === 'swarm_wait');
    return waitIdx >= 0 && results.length >= calls.length && results[waitIdx]?.status === 'DONE';
  }
  return false;
}

function stepFailure(last, mtime, now) {
  if (!last) return null;
  const modelError = last.type === 'ERROR_MESSAGE';
  const settledToolError = last.status === 'ERROR' && now - (mtime || 0) >= STEP_ERROR_SETTLE_MS;
  if (!modelError && !settledToolError) return null;
  const text = last.error || (modelError ? 'Model error' : 'Tool step failed');
  return { kind: QUOTA_RE.test(text) ? 'quota' : 'error', text };
}

export function summarizeTranscript(filePath, now = Date.now()) {
  const s = statOf(filePath);
  if (s.size < 0) return null;
  const key = `${s.mtime}:${s.size}`;
  let base = transcriptCache.get(filePath);
  if (!base || base.key !== key) {
    const tail = readTail(filePath, TAIL_BYTES);
    if (tail.text == null) return null;
    const { items: steps, tornTail } = parseJsonLines(tail.text);

    let totalSteps = steps.length;
    let model = '';
    const tokens = { input: 0, output: 0, cache: 0 };
    const recentActions = [];
    const editedMap = new Map();
    let lastReply = '';
    let replied = false;

    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (Number.isFinite(st.step_index)) totalSteps = Math.max(totalSteps, st.step_index + 1);
      if (st.type === 'PLANNER_RESPONSE') {
        if (typeof st.model === 'string' && st.model) model = st.model;
        if (Number.isFinite(st.input_tokens)) tokens.input += st.input_tokens;
        if (Number.isFinite(st.output_tokens)) tokens.output += st.output_tokens;
        if (Number.isFinite(st.cache_read_tokens)) tokens.cache += st.cache_read_tokens;

        const calls = Array.isArray(st.tool_calls) ? st.tool_calls : [];
        if (calls.length > 0) {
          for (let c = 0; c < calls.length; c++) {
            const desc = describeToolCall(calls[c]);
            if (!desc.label) continue;
            const resStep = steps[i + 1 + c];
            const resStatus = resStep?.type === 'GENERIC' ? String(resStep.status || 'DONE') : 'DONE';
            const resErr = resStep?.type === 'GENERIC' && resStep.error ? oneLine(resStep.error, 140) : '';
            const fileUri = desc.filePath ? toFileUri(desc.filePath) : '';
            if (isWriteTool(calls[c]?.name) && desc.filePath) {
              const prev = editedMap.get(desc.filePath);
              editedMap.delete(desc.filePath);
              editedMap.set(desc.filePath, {
                path: desc.filePath,
                name: basename(desc.filePath),
                fileUri,
                action: calls[c].name === 'write_file' ? 'write' : 'edit',
                count: (prev?.count || 0) + 1,
                lastAt: st.created_at || '',
              });
            }
            recentActions.push({
              step: Number.isFinite(st.step_index) ? st.step_index : i,
              time: st.created_at || '',
              label: desc.label,
              kind: desc.kind,
              status: resStatus,
              error: resErr,
              ...(desc.filePath ? { filePath: desc.filePath, fileUri } : {}),
            });
          }
        } else {
          const heading = thinkingHeading(st.thinking);
          if (heading) {
            recentActions.push({
              step: Number.isFinite(st.step_index) ? st.step_index : i,
              time: st.created_at || '',
              label: heading,
              kind: 'think',
              status: String(st.status || 'DONE'),
              error: '',
            });
          }
        }
      } else if (st.type === 'ERROR_MESSAGE') {
        recentActions.push({
          step: Number.isFinite(st.step_index) ? st.step_index : i,
          time: st.created_at || '',
          label: oneLine(st.error || 'Model error', 72),
          kind: 'error',
          status: 'ERROR',
          error: oneLine(st.error || 'Model error', 180),
        });
      }
    }

    const lastStep = steps.length ? steps[steps.length - 1] : null;
    const last = lastStep
      ? {
          type: String(lastStep.type || ''),
          status: String(lastStep.status || ''),
          error: typeof lastStep.error === 'string' ? oneLine(lastStep.error, 240) : '',
          createdAt: lastStep.created_at || '',
        }
      : null;

    if (lastStep?.type === 'PLANNER_RESPONSE' && (!Array.isArray(lastStep.tool_calls) || lastStep.tool_calls.length === 0)) {
      replied = true;
      lastReply = String(lastStep.content || '');
    }

    let activity = '';
    let activityKind = '';
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      if (st.type === 'USER_INPUT') break;
      if (st.type !== 'PLANNER_RESPONSE') continue;
      const calls = Array.isArray(st.tool_calls) ? st.tool_calls : [];
      if (calls.some((tc) => tc?.name === 'swarm_wait')) break;
      const lastCall = calls.length ? describeToolCall(calls[calls.length - 1]) : null;
      const heading = thinkingHeading(st.thinking);
      if (lastCall?.label) {
        activity = lastCall.label;
        activityKind = lastCall.kind;
        break;
      }
      if (heading) {
        activity = heading;
        activityKind = 'think';
        break;
      }
    }

    const idle = turnEnded(steps, tornTail);
    const replyAsk = replied ? replyQuestion(lastReply) : '';

    base = {
      key,
      data: {
        steps: totalSteps,
        model,
        tokens,
        activity,
        activityKind,
        idle,
        replied,
        replyAsk,
        lastReplyPreview: oneLine(lastReply, 180),
        last,
        mtime: s.mtime,
        recentActions: recentActions.slice(-12).reverse(),
        editedFiles: [...editedMap.values()].slice(-16).reverse(),
      },
    };
    if (transcriptCache.size > 400) transcriptCache.clear();
    transcriptCache.set(filePath, base);
  }

  const failure = stepFailure(base.data.last, base.data.mtime, now);
  return { ...base.data, failure };
}

function namedToken(lowerText, lowerName) {
  if (!lowerName) return false;
  for (let i = lowerText.indexOf('@'); i >= 0; i = lowerText.indexOf('@', i + 1)) {
    if (i > 0) {
      const before = [...lowerText.slice(Math.max(0, i - 2), i)].pop();
      if (NAME_RUNE.test(before)) continue;
    }
    if (!lowerText.startsWith(lowerName, i + 1)) continue;
    const j = i + 1 + lowerName.length;
    if (j >= lowerText.length) return true;
    if (!NAME_RUNE.test(String.fromCodePoint(lowerText.codePointAt(j)))) return true;
  }
  return false;
}

function mentionsOf(text, names) {
  const lower = String(text || '').toLowerCase();
  const mentions = names.filter((n) => {
    const ln = String(n).toLowerCase();
    if (namedToken(lower, ln)) return true;
    const pref = ln.match(/^(.+)-\d+$/);
    return pref ? namedToken(lower, pref[1]) : false;
  });
  return { mentions, all: namedToken(lower, 'all') };
}

function boardTimeMs(t) {
  if (!t) return null;
  const ms = Date.parse(String(t).includes('T') ? String(t) : String(t).replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

function classifyFeedTag(msg, role) {
  const text = String(msg.text || '');
  if (role === 'monitor' || /\[STUCK|ERROR|FAILED|429|quota/i.test(text)) return 'Cảnh báo';
  if (msg.kind === 'brief' || role === 'coordinator') return 'Giao việc';
  return 'Báo cáo';
}

function scanSubagentsInTranscript(filePath) {
  const s = statOf(filePath);
  if (s.size < 0) return null;
  const key = `${s.mtime}:${s.size}`;
  const hit = subagentIndexCache.get(filePath);
  if (hit && hit.key === key) return hit.data;

  const tail = readTail(filePath, SUBAGENT_SCAN_TAIL_BYTES);
  if (!tail.text || !tail.text.includes('"invoke_subagent"')) {
    const empty = { subagents: [], feed: [] };
    if (subagentIndexCache.size > 200) subagentIndexCache.clear();
    subagentIndexCache.set(filePath, { key, data: empty });
    return empty;
  }

  const { items: steps } = parseJsonLines(tail.text);
  const subagents = new Map(); // convId -> { conversation_id, name, typeName, prompt, modelHint, createdAt }
  const feed = [];
  let seq = 0;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.type === 'PLANNER_RESPONSE' && Array.isArray(st.tool_calls)) {
      for (let c = 0; c < st.tool_calls.length; c++) {
        const tc = st.tool_calls[c];
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        if (tc?.name === 'invoke_subagent') {
          const resStep = steps[i + 1 + c];
          const resContent = String(resStep?.content || '');
          const m = /"conversationId"\s*:\s*"([0-9a-f-]{8,64})"/i.exec(resContent);
          if (m) {
            const convId = m[1];
            const roleName = unquote(args.Role) || unquote(args.TypeName) || `subagent-${subagents.size + 1}`;
            const prompt = unquote(args.Prompt);
            if (!subagents.has(convId)) {
              subagents.set(convId, {
                conversation_id: convId,
                name: roleName,
                typeName: unquote(args.TypeName) || 'subagent',
                modelHint: unquote(args.Model) || '',
                createdAt: st.created_at || '',
                reported: false,
              });
            }
            feed.push({
              seq: ++seq,
              from: 'lead',
              to: [roleName],
              all: false,
              tag: 'Giao việc',
              text: oneLine(prompt || `Giao nhiệm vụ cho ${roleName}`, 320),
              time: st.created_at || '',
              ts: boardTimeMs(st.created_at),
            });
          }
        } else if (tc?.name === 'send_message') {
          const rec = unquote(args.Recipient);
          const msg = unquote(args.Message);
          const target = subagents.get(rec)?.name || rec;
          if (target && msg) {
            feed.push({
              seq: ++seq,
              from: 'lead',
              to: [target],
              all: false,
              tag: 'Giao việc',
              text: oneLine(msg, 320),
              time: st.created_at || '',
              ts: boardTimeMs(st.created_at),
            });
          }
        }
      }
    } else if (st.type === 'SYSTEM_MESSAGE' && typeof st.content === 'string') {
      const m = /sender=([0-9a-f-]{8,64})\s+priority=\S+\s+content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i.exec(st.content);
      if (m && subagents.has(m[1])) {
        const sub = subagents.get(m[1]);
        sub.reported = true;
        feed.push({
          seq: ++seq,
          from: sub.name,
          to: ['lead'],
          all: false,
          tag: 'Báo cáo',
          text: oneLine(m[2], 320),
          time: st.created_at || '',
          ts: boardTimeMs(st.created_at),
        });
      }
    }
  }

  const data = { subagents: [...subagents.values()], feed };
  if (subagentIndexCache.size > 200) subagentIndexCache.clear();
  subagentIndexCache.set(filePath, { key, data });
  return data;
}

export function scanSessions(appDataDirs, { force = false, includeConv = '' } = {}) {
  const cacheKey = `${appDataDirs.join('|')}::${includeConv}`;
  const now = Date.now();
  const cached = scanCache.get(cacheKey);
  if (!force && cached && now - cached.at < SCAN_TTL_MS) return cached.list;

  const sessions = [];
  const seen = new Set();
  const nonSwarmCandidates = [];

  for (const appData of appDataDirs) {
    const brainDir = join(appData, 'brain');
    for (const id of safeReaddir(brainDir)) {
      if (!ID_RE.test(id) || seen.has(id)) continue;
      const membersFile = join(brainDir, id, '.system_generated', 'swarm', 'members.json');
      const trFile = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const mStat = statOf(membersFile);
      if (mStat.size >= 0) {
        seen.add(id);
        let title = '';
        let memberCount = 0;
        try {
          const parsed = JSON.parse(readFileSync(membersFile, 'utf-8'));
          title = parsed?.title || '';
          memberCount = parsed?.members ? Object.keys(parsed.members).length : 0;
        } catch {}
        const bStat = statOf(join(brainDir, id, '.system_generated', 'swarm', 'board.jsonl'));
        const updatedAt = Math.max(mStat.mtime, bStat.mtime);
        sessions.push({
          id,
          appData,
          kind: 'swarm',
          title: title || readHeadTitle(trFile) || `Swarm ${id.slice(0, 8)}`,
          memberCount,
          updatedAt,
        });
      } else {
        const tStat = statOf(trFile);
        if (tStat.size > 0) {
          nonSwarmCandidates.push({ id, appData, trFile, mtime: tStat.mtime });
        }
      }
    }
  }

  nonSwarmCandidates.sort((a, b) => b.mtime - a.mtime);
  const top = nonSwarmCandidates.slice(0, MAX_RECENT_SUBAGENT_CANDIDATES);
  if (includeConv && ID_RE.test(includeConv) && !seen.has(includeConv) && !top.some((c) => c.id === includeConv)) {
    const extra = nonSwarmCandidates.find((c) => c.id === includeConv);
    if (extra) top.push(extra);
  }

  for (const cand of top) {
    const idx = scanSubagentsInTranscript(cand.trFile);
    if (idx && idx.subagents.length > 0) {
      seen.add(cand.id);
      sessions.push({
        id: cand.id,
        appData: cand.appData,
        kind: 'subagent',
        title: readHeadTitle(cand.trFile) || `Team ${cand.id.slice(0, 8)}`,
        memberCount: idx.subagents.length + 1,
        updatedAt: cand.mtime,
      });
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  scanCache.set(cacheKey, { at: now, list: sessions });
  return sessions;
}

export function resolveSessionForConversation(appDataDirs, convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  const sessions = scanSessions(appDataDirs, { includeConv: convId });
  const direct = sessions.find((s) => s.id === convId);
  if (direct) return direct;

  // Check if convId is a worker inside any Swarm or a child inside any Subagent session
  for (const s of sessions) {
    if (s.kind === 'swarm') {
      try {
        const m = JSON.parse(readFileSync(join(s.appData, 'brain', s.id, '.system_generated', 'swarm', 'members.json'), 'utf-8'));
        const hit = Object.values(m?.members || {}).some((entry) => entry?.conversation_id === convId);
        if (hit) return s;
      } catch {}
    } else if (s.kind === 'subagent') {
      const idx = scanSubagentsInTranscript(join(s.appData, 'brain', s.id, '.system_generated', 'logs', 'transcript.jsonl'));
      if (idx?.subagents.some((sub) => sub.conversation_id === convId)) return s;
    }
  }
  return null;
}

function buildPeers(feed) {
  const sets = new Map();
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    if (!sets.has(a)) sets.set(a, new Set());
    if (!sets.has(b)) sets.set(b, new Set());
    sets.get(a).add(b);
    sets.get(b).add(a);
  };
  for (const m of feed) {
    for (const target of m.to || []) link(m.from, target);
  }
  const out = {};
  for (const [k, v] of sets.entries()) out[k] = [...v];
  return out;
}

function buildSwarmState(appData, sessionId, now) {
  const swDir = join(appData, 'brain', sessionId, '.system_generated', 'swarm');
  const membersPath = join(swDir, 'members.json');
  const boardPath = join(swDir, 'board.jsonl');
  const planPath = join(swDir, 'plan.json');
  const mStat = statOf(membersPath);
  if (mStat.size < 0) return null;

  let roster = { title: '', members: {} };
  try {
    const parsed = JSON.parse(readFileSync(membersPath, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      roster = { title: parsed.title || '', members: parsed.members || {} };
    }
  } catch {
    return null;
  }

  const pStat = statOf(planPath);
  let plan = null;
  if (pStat.size >= 0) {
    try { plan = JSON.parse(readFileSync(planPath, 'utf-8')); } catch {}
  }

  const bStat = statOf(boardPath);
  const boardText = bStat.size >= 0 ? readFileSync(boardPath, 'utf-8') : '';
  const { items: rawMsgs } = parseJsonLines(boardText);
  const head = rawMsgs.length ? Number(rawMsgs[rawMsgs.length - 1].seq) || rawMsgs.length : 0;

  const names = Object.keys(roster.members).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');
  const postStats = new Map();
  const feed = [];

  for (const msg of rawMsgs) {
    if (msg.control && typeof msg.control === 'object') continue;
    const seq = Number(msg.seq) || feed.length + 1;
    const from = String(msg.agent || '');
    const text = String(msg.text || '');
    const { mentions, all } = mentionsOf(text, names);
    const role = String(roster.members[from]?.role || '');
    const ps = postStats.get(from) || { posts: 0, lastPostSeq: 0 };
    postStats.set(from, { posts: ps.posts + 1, lastPostSeq: seq });
    feed.push({
      seq,
      from,
      to: all ? ['all'] : mentions,
      all,
      tag: classifyFeedTag(msg, role),
      text: oneLine(text, 360),
      time: msg.time || '',
      ts: boardTimeMs(msg.time),
    });
  }

  const members = names.map((name) => {
    const m = roster.members[name];
    const convId = String(m.conversation_id || '');
    const tr = convId && ID_RE.test(convId)
      ? summarizeTranscript(join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'), now)
      : null;
    const role = String(m.role || (name === 'coordinator' ? 'coordinator' : 'worker'));
    const posts = postStats.get(name)?.posts || 0;
    const steps = tr?.steps || 0;
    const killed = Boolean(m.killed);
    const lastRead = Number(m.last_read_seq) || 0;
    const unread = killed ? 0 : Math.max(0, head - lastRead);

    let status;
    if (killed) {
      status = steps > 0 || posts > 0 ? 'done' : 'killed';
    } else if (tr?.failure) {
      status = 'error';
    } else if (tr && typeof tr.idle === 'boolean') {
      if (tr.idle) {
        status = 'waiting';
      } else if (tr.mtime && now - tr.mtime > STUCK_MS) {
        status = 'stuck';
      } else {
        status = 'working';
      }
    } else {
      status = m.wake_mode === 'mentions' || m.wake_mode === 'anything' ? 'waiting' : 'working';
    }

    const modelRaw = m.model || tr?.model || '';
    const activity =
      status === 'error'
        ? tr?.failure?.text || 'Lỗi thực thi'
        : status === 'stuck'
          ? 'Không có tiến triển >10 phút'
          : status === 'done'
            ? 'Đã kết thúc'
            : status === 'killed'
              ? 'Đã dừng'
              : status === 'waiting'
                ? tr?.replyAsk
                  ? `Chờ bạn trả lời: ${tr.replyAsk}`
                  : 'Đang chờ tin nhắn Board'
                : tr?.activity || 'Đang xử lý...';

    return {
      name,
      conversationId: convId,
      role,
      model: formatModelName(modelRaw),
      modelRaw,
      status,
      killed,
      steps,
      unread,
      posts,
      activity,
      activityKind: status === 'working' ? tr?.activityKind || 'tool' : status,
      failure: tr?.failure || null,
      replyAsk: !killed && tr?.replyAsk ? tr.replyAsk : '',
      lastReplyPreview: tr?.lastReplyPreview || '',
      lastActiveAt: tr?.mtime || 0,
      tokens: tr?.tokens || { input: 0, output: 0, cache: 0 },
      recentActions: tr?.recentActions || [],
      editedFiles: tr?.editedFiles || [],
      workspaceMode: m.workspace_mode || '',
      task: plan?.tasks?.[name] || '',
    };
  });

  members.sort(
    (a, b) =>
      (a.role === 'coordinator' ? 0 : 1) - (b.role === 'coordinator' ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );

  const attention = buildAttention(members);
  const totals = summarizeTotals(members);
  const departments = buildDepartments(members, plan);
  const etag = `sw:${sessionId}:${mStat.mtime}:${bStat.mtime}:${pStat.mtime}:${members.map((x) => `${x.name}:${x.status}:${x.steps}:${x.lastActiveAt}`).join(',')}`;

  return {
    id: sessionId,
    kind: 'swarm',
    title: roster.title || plan?.goal?.title || `Swarm ${sessionId.slice(0, 8)}`,
    goal: plan?.goal?.line || '',
    etag,
    head,
    totals,
    attention,
    departments,
    members,
    feed: feed.slice(-120).reverse(),
    peers: buildPeers(feed),
  };
}

function buildSubagentState(appData, sessionId, now) {
  const trFile = join(appData, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  const tStat = statOf(trFile);
  if (tStat.size < 0) return null;

  const idx = scanSubagentsInTranscript(trFile);
  if (!idx || idx.subagents.length === 0) return null;

  const leadTr = summarizeTranscript(trFile, now);
  const leadStatus = leadTr?.failure
    ? 'error'
    : leadTr?.idle
      ? 'waiting'
      : leadTr?.mtime && now - leadTr.mtime > STUCK_MS
        ? 'stuck'
        : 'working';

  const members = [
    {
      name: 'lead',
      conversationId: sessionId,
      role: 'coordinator',
      model: formatModelName(leadTr?.model || ''),
      modelRaw: leadTr?.model || '',
      status: leadStatus,
      killed: false,
      steps: leadTr?.steps || 0,
      unread: 0,
      posts: idx.feed.filter((f) => f.from === 'lead').length,
      activity:
        leadStatus === 'error'
          ? leadTr?.failure?.text || 'Lỗi thực thi'
          : leadStatus === 'waiting'
            ? leadTr?.replyAsk
              ? `Chờ bạn trả lời: ${leadTr.replyAsk}`
              : 'Đang chờ subagent / bạn'
            : leadTr?.activity || 'Đang điều phối...',
      activityKind: leadStatus === 'working' ? leadTr?.activityKind || 'tool' : leadStatus,
      failure: leadTr?.failure || null,
      replyAsk: leadTr?.replyAsk || '',
      lastReplyPreview: leadTr?.lastReplyPreview || '',
      lastActiveAt: leadTr?.mtime || 0,
      tokens: leadTr?.tokens || { input: 0, output: 0, cache: 0 },
      recentActions: leadTr?.recentActions || [],
      editedFiles: leadTr?.editedFiles || [],
      workspaceMode: 'inherit',
      task: '',
    },
  ];

  for (const sub of idx.subagents) {
    const subFile = join(appData, 'brain', sub.conversation_id, '.system_generated', 'logs', 'transcript.jsonl');
    const tr = summarizeTranscript(subFile, now);
    let status;
    if (tr?.failure) {
      status = 'error';
    } else if (sub.reported || (tr?.idle && tr?.replied)) {
      status = 'done';
    } else if (tr?.idle) {
      status = 'waiting';
    } else if (tr?.mtime && now - tr.mtime > STUCK_MS) {
      status = 'stuck';
    } else {
      status = 'working';
    }

    const modelRaw = tr?.model || sub.modelHint || '';
    members.push({
      name: sub.name,
      conversationId: sub.conversation_id,
      role: 'subagent',
      model: formatModelName(modelRaw),
      modelRaw,
      status,
      killed: false,
      steps: tr?.steps || 0,
      unread: 0,
      posts: idx.feed.filter((f) => f.from === sub.name).length,
      activity:
        status === 'error'
          ? tr?.failure?.text || 'Lỗi thực thi'
          : status === 'done'
            ? 'Đã hoàn thành'
            : status === 'stuck'
              ? 'Không có tiến triển >10 phút'
              : tr?.activity || 'Đang thực thi...',
      activityKind: status === 'working' ? tr?.activityKind || 'tool' : status,
      failure: tr?.failure || null,
      replyAsk: '',
      lastReplyPreview: tr?.lastReplyPreview || '',
      lastActiveAt: tr?.mtime || 0,
      tokens: tr?.tokens || { input: 0, output: 0, cache: 0 },
      recentActions: tr?.recentActions || [],
      editedFiles: tr?.editedFiles || [],
      workspaceMode: sub.typeName,
      task: '',
    });
  }

  const attention = buildAttention(members);
  const totals = summarizeTotals(members);
  const departments = buildDepartments(members, null);
  const etag = `sub:${sessionId}:${tStat.mtime}:${members.map((x) => `${x.name}:${x.status}:${x.steps}:${x.lastActiveAt}`).join(',')}`;

  return {
    id: sessionId,
    kind: 'subagent',
    title: readHeadTitle(trFile) || `Team ${sessionId.slice(0, 8)}`,
    goal: '',
    etag,
    head: idx.feed.length,
    totals,
    attention,
    departments,
    members,
    feed: idx.feed.slice(-120).reverse(),
    peers: buildPeers(idx.feed),
  };
}

function deptThemeFor(text) {
  const s = String(text || '').toLowerCase();
  if (/(^be[-_]|backend|api|db|server|patcher|^rs[-_]|core|infra|system|hệ thống)/.test(s)) return 'server';
  if (/(^fe[-_]|frontend|ui|ux|gfx|css|design|đồ họa|giao diện|pixel|style)/.test(s)) return 'design';
  if (/(audit|review|verif|test|qa|spec|research|^re[-_]|critic|security|kiểm định|nghiên cứu)/.test(s)) return 'lab';
  return 'studio';
}

function fallbackDeptInfo(member) {
  const s = `${member.name} ${member.workspaceMode || ''}`.toLowerCase();
  if (/(^be[-_]|backend|api|db|server|patcher|^rs[-_]|infra|core)/.test(s)) {
    return { id: 'dept-server', title: 'Ban Hệ Thống & Backend', theme: 'server' };
  }
  if (/(^fe[-_]|frontend|ui|ux|gfx|css|design|visual)/.test(s)) {
    return { id: 'dept-design', title: 'Ban Giao Diện & Đồ Họa', theme: 'design' };
  }
  if (/(audit|review|verif|test|qa|spec|research|^re[-_]|critic|security)/.test(s)) {
    return { id: 'dept-lab', title: 'Ban Kiểm Định & Nghiên Cứu', theme: 'lab' };
  }
  if (/(doc|sync|voice|content|writer|note)/.test(s)) {
    return { id: 'dept-docs', title: 'Ban Tài Liệu & Nội Dung', theme: 'studio' };
  }
  return { id: 'dept-exec', title: 'Ban Thực Thi', theme: 'studio' };
}

function deptStats(list) {
  const st = { total: list.length, working: 0, waiting: 0, done: 0, alert: 0 };
  for (const m of list) {
    if (m.status === 'working') st.working++;
    else if (m.status === 'waiting') st.waiting++;
    else if (m.status === 'done' || m.status === 'killed') st.done++;
    else if (m.status === 'error' || m.status === 'stuck') st.alert++;
  }
  return st;
}

function buildDepartments(members, plan) {
  const byName = new Map(members.map((m) => [m.name, m]));
  const commandMembers = members.filter(
    (m) => m.role === 'coordinator' || m.role === 'monitor' || m.role === 'narrator',
  );
  const workers = members.filter((m) => !commandMembers.includes(m));
  const out = [];

  if (commandMembers.length) {
    out.push({
      id: 'command',
      title: 'Phòng Chỉ Huy',
      goal: plan?.goal?.line || 'Điều phối kế hoạch & giám sát toàn đội',
      theme: 'command',
      tier: 'command',
      members: commandMembers.map((m) => m.name),
      stats: deptStats(commandMembers),
    });
  }

  const threads = Array.isArray(plan?.threads) ? plan.threads : [];
  if (threads.length) {
    const assigned = new Set();
    for (let i = 0; i < threads.length; i++) {
      const th = threads[i];
      if (!th || typeof th !== 'object') continue;
      const names = (Array.isArray(th.tasks) ? th.tasks : []).filter((n) => byName.has(n) && !assigned.has(n));
      if (!names.length) continue;
      for (const n of names) assigned.add(n);
      const list = names.map((n) => byName.get(n));
      out.push({
        id: String(th.id || `thread-${i + 1}`),
        title: String(th.title || `Phòng ${i + 1}`),
        goal: String(th.goal || ''),
        theme: deptThemeFor(`${th.title || ''} ${names.join(' ')}`),
        tier: 'department',
        members: names,
        stats: deptStats(list),
      });
    }
    const rest = workers.filter((m) => !assigned.has(m.name));
    if (rest.length) {
      out.push({
        id: 'dept-other',
        title: 'Ban Hỗ Trợ',
        goal: '',
        theme: 'studio',
        tier: 'department',
        members: rest.map((m) => m.name),
        stats: deptStats(rest),
      });
    }
    return out;
  }

  // Fallback smart department grouping when plan.json has no threads
  const groups = new Map();
  for (const w of workers) {
    const info = fallbackDeptInfo(w);
    if (!groups.has(info.id)) groups.set(info.id, { ...info, list: [] });
    groups.get(info.id).list.push(w);
  }
  for (const g of groups.values()) {
    out.push({
      id: g.id,
      title: g.title,
      goal: '',
      theme: g.theme,
      tier: 'department',
      members: g.list.map((m) => m.name),
      stats: deptStats(g.list),
    });
  }
  return out;
}

function buildAttention(members) {
  const out = [];
  for (const m of members) {
    if (m.killed) continue;
    if (m.failure) {
      out.push({
        kind: m.failure.kind,
        member: m.name,
        conversationId: m.conversationId,
        text: `${m.name}: ${m.failure.kind === 'quota' ? 'Hết quota / 429' : 'Lỗi'} — ${m.failure.text}`,
      });
    } else if (m.status === 'stuck') {
      out.push({
        kind: 'stuck',
        member: m.name,
        conversationId: m.conversationId,
        text: `${m.name}: không có bước mới hơn 10 phút`,
      });
    } else if (m.role === 'coordinator' && m.replyAsk) {
      out.push({
        kind: 'question',
        member: m.name,
        conversationId: m.conversationId,
        text: `${m.name} đang hỏi: ${m.replyAsk}`,
      });
    }
  }
  return out;
}

function summarizeTotals(members) {
  const t = { total: members.length, working: 0, waiting: 0, done: 0, alert: 0, steps: 0, tokens: 0 };
  for (const m of members) {
    t.steps += m.steps || 0;
    t.tokens += (m.tokens?.input || 0) + (m.tokens?.output || 0);
    if (m.status === 'working') t.working++;
    else if (m.status === 'waiting') t.waiting++;
    else if (m.status === 'done' || m.status === 'killed') t.done++;
    else if (m.status === 'error' || m.status === 'stuck') t.alert++;
  }
  return t;
}

export function buildSessionState(appDataDirs, sessionId, now = Date.now()) {
  if (!sessionId || !ID_RE.test(sessionId)) return null;
  for (const appData of appDataDirs) {
    const sw = buildSwarmState(appData, sessionId, now);
    if (sw) return sw;
    const sub = buildSubagentState(appData, sessionId, now);
    if (sub) return sub;
  }
  return null;
}
