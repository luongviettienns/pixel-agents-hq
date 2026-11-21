import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatModelName,
  summarizeTranscript,
  scanSessions,
  resolveSessionForConversation,
  buildSessionState,
} from './store.mjs';
import { createMediaStore } from './media.mjs';

function makeTempAppData() {
  const root = mkdtempSync(join(tmpdir(), 'pixel-hq-test-'));
  mkdirSync(join(root, 'brain'), { recursive: true });
  return root;
}

function writeTranscript(appData, convId, steps, mtimeMs = null) {
  const dir = join(appData, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript.jsonl');
  const content = steps.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n') + '\n';
  writeFileSync(file, content, 'utf-8');
  if (mtimeMs != null) {
    const d = new Date(mtimeMs);
    utimesSync(file, d, d);
  }
  return file;
}

describe('formatModelName', () => {
  it('formats known model slugs cleanly', () => {
    assert.equal(formatModelName('gemini-4-neon-xhigh'), 'Gemini 4 Neon XHigh');
    assert.equal(formatModelName('claude-sonnet-4-6'), 'Claude Sonnet 4.6');
    assert.equal(formatModelName('gpt-oss-120b-medium'), 'GPT OSS 120B (Medium)');
    assert.equal(formatModelName(''), '');
  });
});

describe('summarizeTranscript', () => {
  it('extracts activity, recentActions, tokens, model, and idle state', () => {
    const root = makeTempAppData();
    try {
      const file = writeTranscript(root, '11111111-1111-1111-1111-111111111111', [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T00:00:00Z', content: '<USER_REQUEST>\nFix API\n</USER_REQUEST>' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T00:00:02Z',
          model: 'gemini-4-neon-high',
          input_tokens: 1000,
          cache_read_tokens: 500,
          output_tokens: 200,
          thinking: '**Inspecting server routes**\nChecking main.mjs',
          tool_calls: [{ name: 'read_file', args: { Path: '"C:/app/main.mjs"' } }],
        },
        { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-22T00:00:03Z', content: 'ok' },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T00:00:10Z',
          model: 'gemini-4-neon-high',
          input_tokens: 1200,
          cache_read_tokens: 800,
          output_tokens: 300,
          tool_calls: [{ name: 'edit_file', args: { Path: '"C:/app/main.mjs"' } }],
        },
        { step_index: 4, type: 'GENERIC', status: 'RUNNING', created_at: '2026-11-22T00:00:11Z', content: 'running' },
      ]);

      const res = summarizeTranscript(file, Date.now());
      assert.equal(res.steps, 5);
      assert.equal(res.model, 'gemini-4-neon-high');
      assert.equal(res.idle, false);
      assert.equal(res.activity, 'Edit main.mjs');
      assert.equal(res.activityKind, 'edit');
      assert.equal(res.tokens.input, 2200);
      assert.equal(res.tokens.output, 500);
      assert.equal(res.tokens.cache, 1300);
      assert.equal(res.recentActions.length, 2);
      assert.equal(res.recentActions[0].label, 'Edit main.mjs');
      assert.equal(res.recentActions[0].status, 'RUNNING');
      assert.equal(res.recentActions[0].filePath, 'C:/app/main.mjs');
      assert.match(res.recentActions[0].fileUri, /^file:\/\/\//);
      assert.equal(res.recentActions[1].label, 'Read main.mjs');
      assert.equal(res.recentActions[1].status, 'DONE');
      assert.equal(res.editedFiles.length, 1);
      assert.equal(res.editedFiles[0].name, 'main.mjs');
      assert.equal(res.editedFiles[0].count, 1);
      assert.match(res.editedFiles[0].fileUri, /^file:\/\/\/C:\/app\/main\.mjs$/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tolerates torn final JSON line and detects quota ERROR_MESSAGE', () => {
    const root = makeTempAppData();
    try {
      const file = writeTranscript(root, '22222222-2222-2222-2222-222222222222', [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T00:00:00Z', content: 'hi' },
        { step_index: 1, type: 'ERROR_MESSAGE', status: 'ERROR', error: '429 RESOURCE_EXHAUSTED quota exceeded', created_at: '2026-11-22T00:00:05Z' },
        '{"step_index":2,"type":"PLANNER_RESPO',
      ]);

      const res = summarizeTranscript(file, Date.now());
      assert.equal(res.failure?.kind, 'quota');
      assert.match(res.failure?.text || '', /429/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects swarm_wait DONE as idle and coordinator question replyAsk', () => {
    const root = makeTempAppData();
    try {
      const waitFile = writeTranscript(root, '33333333-3333-3333-3333-333333333333', [
        {
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'swarm_wait', args: {} }],
        },
        { step_index: 1, type: 'GENERIC', status: 'DONE', content: 'parked' },
      ]);
      assert.equal(summarizeTranscript(waitFile, Date.now()).idle, true);

      const askFile = writeTranscript(root, '44444444-4444-4444-4444-444444444444', [
        {
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Đã xong bước 1. Anh muốn tiếp tục bước 2 không?',
        },
      ]);
      const ask = summarizeTranscript(askFile, Date.now());
      assert.equal(ask.idle, true);
      assert.equal(ask.replied, true);
      assert.match(ask.replyAsk, /bước 2 không\?/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for missing transcript file', () => {
    assert.equal(summarizeTranscript('C:/nonexistent/path/transcript.jsonl', Date.now()), null);
  });
});

describe('Swarm & Subagent session engine', () => {
  it('parses Swarm session, resolves worker conv, computes statuses, feed, peers & attention', () => {
    const root = makeTempAppData();
    try {
      const now = Date.now();
      const coordId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const w1Id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const w2Id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const w3Id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

      const swDir = join(root, 'brain', coordId, '.system_generated', 'swarm');
      mkdirSync(swDir, { recursive: true });
      writeFileSync(
        join(swDir, 'members.json'),
        JSON.stringify({
          title: 'Upgrade Graphics & Voice',
          members: {
            coordinator: { conversation_id: coordId, role: 'coordinator', model: 'gemini-4-neon-xhigh', wake_mode: 'mentions', last_read_seq: 2, killed: false },
            'gfx-worker': { conversation_id: w1Id, role: 'worker', model: 'claude-sonnet-4-6', wake_mode: 'working', last_read_seq: 1, killed: false },
            'voice-done': { conversation_id: w2Id, role: 'worker', model: 'gemini-4-hydrogen-high', wake_mode: 'working', last_read_seq: 2, killed: true },
            'stuck-worker': { conversation_id: w3Id, role: 'worker', model: 'claude-sonnet-4-6', wake_mode: 'working', last_read_seq: 1, killed: false },
          },
        }),
      );
      writeFileSync(
        join(swDir, 'board.jsonl'),
        [
          { seq: 1, agent: 'coordinator', text: '@gfx-worker @voice-done Bắt đầu nâng cấp đồ họa', time: '2026-11-22 00:01:00', kind: 'brief' },
          { seq: 2, agent: 'voice-done', text: '@coordinator [done] Đã xong phần voice.', time: '2026-11-22 00:05:00' },
        ].map((x) => JSON.stringify(x)).join('\n') + '\n',
      );

      writeTranscript(root, coordId, [
        { step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Đang chờ các worker. Bạn có muốn đổi ưu tiên không?' },
      ], now - 5000);
      writeTranscript(root, w1Id, [
        { step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { toolSummary: '"Build shader pipeline"' } }] },
        { step_index: 1, type: 'GENERIC', status: 'RUNNING', content: 'building' },
      ], now - 3000);
      writeTranscript(root, w2Id, [
        { step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Done' },
      ], now - 60000);
      writeTranscript(root, w3Id, [
        { step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '"a.ts"' } }] },
        { step_index: 1, type: 'GENERIC', status: 'RUNNING', content: 'reading' },
      ], now - 15 * 60 * 1000); // 15m old -> stuck!

      const sessions = scanSessions([root], { force: true });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].kind, 'swarm');
      assert.equal(sessions[0].id, coordId);

      // Worker conversation resolves back to coordinator swarm
      assert.equal(resolveSessionForConversation([root], w1Id)?.id, coordId);

      const state = buildSessionState([root], coordId, now);
      assert.ok(state);
      assert.equal(state.kind, 'swarm');
      assert.equal(state.title, 'Upgrade Graphics & Voice');
      assert.equal(state.feed.length, 2);
      assert.equal(state.feed[0].tag, 'Báo cáo');
      assert.equal(state.feed[1].tag, 'Giao việc');
      assert.deepEqual(state.feed[1].to, ['gfx-worker', 'voice-done']);

      const byName = Object.fromEntries(state.members.map((m) => [m.name, m]));
      assert.equal(byName.coordinator.status, 'waiting');
      assert.equal(byName['gfx-worker'].status, 'working');
      assert.equal(byName['gfx-worker'].activityKind, 'cmd');
      assert.equal(byName['gfx-worker'].unread, 1);
      assert.equal(byName['voice-done'].status, 'done');
      assert.equal(byName['stuck-worker'].status, 'stuck');

      assert.ok(state.attention.some((a) => a.member === 'stuck-worker' && a.kind === 'stuck'));
      assert.ok(state.attention.some((a) => a.member === 'coordinator' && a.kind === 'question'));
      assert.ok(state.peers['coordinator'].includes('gfx-worker'));

      // Hierarchical departments fallback (Command tier + specialized departments)
      assert.ok(Array.isArray(state.departments) && state.departments.length >= 2);
      assert.equal(state.departments[0].tier, 'command');
      assert.ok(state.departments[0].members.includes('coordinator'));
      const workerDepts = state.departments.filter((d) => d.tier === 'department');
      assert.ok(workerDepts.some((d) => d.members.includes('gfx-worker')));

      // When plan.json threads exist, departments follow plan.json threads explicitly
      writeFileSync(
        join(swDir, 'plan.json'),
        JSON.stringify({
          goal: { title: 'Graphics & Voice Plan', line: 'Ship crisp FX and voice.' },
          tasks: { 'gfx-worker': 'Upgrade shaders', 'voice-done': 'Add combat SFX' },
          threads: [
            { id: 't-gfx', title: 'Đồ họa Ultra', goal: 'Khử răng cưa', tasks: ['gfx-worker'] },
            { id: 't-audio', title: 'Âm thanh Chiến đấu', goal: 'Lồng tiếng skill', tasks: ['voice-done', 'stuck-worker'] },
          ],
        }),
      );
      const planned = buildSessionState([root], coordId, now);
      const pDepts = planned.departments.filter((d) => d.tier === 'department');
      assert.equal(pDepts.length, 2);
      assert.equal(pDepts[0].title, 'Đồ họa Ultra');
      assert.deepEqual(pDepts[0].members, ['gfx-worker']);
      assert.equal(pDepts[1].title, 'Âm thanh Chiến đấu');
      assert.equal(pDepts[1].stats.done, 1);
      assert.equal(pDepts[1].stats.alert, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses Subagent / Teamwork session from invoke_subagent + send_message + SYSTEM_MESSAGE', () => {
    const root = makeTempAppData();
    try {
      const now = Date.now();
      const leadId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
      const subId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

      writeTranscript(root, leadId, [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T00:00:00Z', content: '<USER_REQUEST>\nAudit toàn bộ backend\n</USER_REQUEST>' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T00:00:05Z',
          model: 'gemini-4-neon-xhigh',
          tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Security Auditor"', TypeName: '"research"', Prompt: '"Check SQL queries"' } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-11-22T00:00:06Z',
          content: `Created the following subagent:\n{\n  "conversationId": "${subId}"\n}`,
        },
        {
          step_index: 3,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: '2026-11-22T00:01:00Z',
          content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-22T00:01:00Z sender=${subId} priority=HIGH content=Audit PASS: 0 SQL injection found.\n</SYSTEM_MESSAGE>`,
        },
        {
          step_index: 4,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T00:01:05Z',
          model: 'gemini-4-neon-xhigh',
          content: 'Hoàn tất kiểm tra.',
        },
      ], now - 2000);

      writeTranscript(root, subId, [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T00:00:06Z', content: 'Check SQL queries' },
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T00:00:50Z', model: 'gemini-4-hydrogen-high', content: 'Audit PASS' },
      ], now - 5000);

      const sessions = scanSessions([root], { force: true });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].kind, 'subagent');
      assert.equal(sessions[0].id, leadId);

      const state = buildSessionState([root], leadId, now);
      assert.ok(state);
      assert.equal(state.members.length, 2);
      assert.equal(state.members[0].role, 'coordinator');
      assert.equal(state.members[1].name, 'Security Auditor');
      assert.equal(state.members[1].role, 'subagent');
      assert.equal(state.members[1].status, 'done');
      assert.equal(state.feed.length, 2);
      assert.equal(state.feed[0].tag, 'Báo cáo');
      assert.match(state.feed[0].text, /Audit PASS/);
      assert.equal(state.feed[1].tag, 'Giao việc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid / path-traversal sessionId safely', () => {
    const root = makeTempAppData();
    try {
      assert.equal(buildSessionState([root], '../etc/passwd', Date.now()), null);
      assert.equal(buildSessionState([root], '', Date.now()), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('smoke-tests real local Antigravity brain dir under 500ms if present', () => {
    const localAppData = join(homedir(), '.gemini', 'antigravity');
    if (!existsSync(join(localAppData, 'brain'))) return;
    const t0 = Date.now();
    const sessions = scanSessions([localAppData], { force: true });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `scanSessions took ${elapsed}ms, expected <500ms`);
    assert.ok(sessions.length >= 1, 'expected at least 1 local session');
    const state = buildSessionState([localAppData], sessions[0].id, Date.now());
    assert.ok(state && state.members.length >= 1);
  });
});

describe('mediaStore (custom bg image/video & glass theme)', () => {
  it('saves/clamps theme config, uploads deduplicated media, serves Range 206, and blocks traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixel-hq-media-'));
    try {
      const store = createMediaStore(dir);
      const saved = store.saveConfig({ mode: 'image', mediaFile: 'bg.png', dim: 2.5, blur: -5, glassOpacity: 0.1 });
      assert.equal(saved.dim, 0.9);
      assert.equal(saved.blur, 0);
      assert.equal(saved.glassOpacity, 0.45);

      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
      const up1 = store.uploadMedia('My Wall.png', pngBytes.toString('base64'));
      const up2 = store.uploadMedia('Duplicate.png', pngBytes.toString('base64'));
      assert.equal(up1.kind, 'image');
      assert.equal(up1.name, up2.name);
      assert.equal(store.listMedia().length, 1);

      const partial = store.readMediaRange(up1.name, 'bytes=0-3');
      assert.equal(partial.status, 206);
      assert.equal(partial.body.length, 4);
      assert.equal(partial.headers['Content-Range'], 'bytes 0-3/10');

      assert.throws(() => store.uploadMedia('evil.exe', pngBytes.toString('base64')), /unsupported/i);
      assert.equal(store.readMediaRange('../secret.txt', ''), null);

      store.saveConfig({ mode: 'image', mediaFile: up1.name, dim: 0.5, blur: 8, glassOpacity: 0.8 });
      assert.equal(store.deleteMedia(up1.name), true);
      assert.equal(store.listMedia().length, 0);
      assert.equal(store.getConfig().mode, 'default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports BGM audio uploads, volume clamping, Range 206 streaming, and clean reset on delete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixel-hq-bgm-'));
    try {
      const store = createMediaStore(dir);
      const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10]);
      const up1 = store.uploadMedia('Lofi Chill.mp3', mp3Bytes.toString('base64'));
      const up2 = store.uploadMedia('Lofi Copy.mp3', mp3Bytes.toString('base64'));
      assert.equal(up1.kind, 'audio');
      assert.equal(up1.name, up2.name);

      const saved = store.saveConfig({ bgmEnabled: true, bgmFile: up1.name, bgmVolume: 1.8 });
      assert.equal(saved.bgmEnabled, true);
      assert.equal(saved.bgmFile, up1.name);
      assert.equal(saved.bgmVolume, 1);

      const low = store.saveConfig({ bgmVolume: -0.5 });
      assert.equal(low.bgmVolume, 0);

      const badFile = store.saveConfig({ bgmEnabled: true, bgmFile: '../evil.mp3' });
      assert.equal(badFile.bgmEnabled, false);
      assert.equal(badFile.bgmFile, '');

      store.saveConfig({ bgmEnabled: true, bgmFile: up1.name, bgmVolume: 0.4 });
      const range = store.readMediaRange(up1.name, 'bytes=0-3');
      assert.equal(range.status, 206);
      assert.equal(range.contentType, 'audio/mpeg');
      assert.equal(range.body.length, 4);

      // Deleting active audio resets BGM fields without touching visual mode
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
      const img = store.uploadMedia('wall.png', pngBytes.toString('base64'));
      store.saveConfig({ mode: 'image', mediaFile: img.name });
      assert.equal(store.deleteMedia(up1.name), true);
      const after = store.getConfig();
      assert.equal(after.bgmEnabled, false);
      assert.equal(after.bgmFile, '');
      assert.equal(after.mode, 'image');
      assert.equal(after.mediaFile, img.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
