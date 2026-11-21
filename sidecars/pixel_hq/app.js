import { renderDepartmentRoom, renderPixelRoom } from './pixel-scene.js';

const POLL_STATE_MS = 1500;
const POLL_SESSIONS_MS = 5000;
const ANIM_TICK_MS = 220;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
  viewMode: params.get('view') === 'grid' ? 'grid' : 'departments', // departments | grid
  followCurrent: !params.get('sessionId'),
  selectedSessionId: params.get('sessionId') || '',
  kindFilter: 'all',       // all | swarm | subagent
  statusFilter: '',        // '' | working | waiting | done | alert
  sessions: [],
  matchedSessionId: null,
  session: null,
  etag: '',
  selectedAgent: params.get('agent') || null,
  feedAgentFilter: '',
  drawerOpen: window.innerWidth > 780,
  drawerTab: params.get('agent') ? 'detail' : 'feed', // feed | detail
  lastFeedSeq: 0,
  pingAgents: new Set(),
  canvasHitboxes: new WeakMap(),
  tick: 0,
  online: true,
  theme: { mode: 'default', mediaFile: '', dim: 0.45, blur: 6, glassOpacity: 0.84 },
  mediaFiles: [],
};

const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';
const canOpenConv = () => Boolean(window.sidecar?.ui?.toggleConversation);
const canOpenFile = () => Boolean(window.sidecar?.ui?.toggleAuxPane);

function openConv(convId) {
  if (!convId || !canOpenConv()) return;
  window.sidecar.ui.toggleConversation(convId);
}

function openFile(fileUri) {
  if (!fileUri || !canOpenFile()) return;
  window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: fileUri });
}

async function apiGet(path) {
  const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const res = await fetcher(path, { method: 'GET' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function apiPost(path, payload) {
  const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const res = await fetcher(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtRelTime(ms) {
  if (!ms) return '—';
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function fmtClock(strOrMs) {
  const ms = typeof strOrMs === 'number' ? strOrMs : Date.parse(String(strOrMs || '').replace(' ', 'T'));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function roleShort(role) {
  if (role === 'coordinator') return 'C';
  if (role === 'subagent') return 'S';
  if (role === 'monitor') return 'M';
  if (role === 'narrator') return 'N';
  return 'W';
}

function deptEmblem(theme) {
  return { command: '👑', server: '⚙', design: '🎨', lab: '🔍', studio: '⚒' }[theme] || '⚒';
}

function statusText(st) {
  return {
    working: 'WORKING',
    waiting: 'IDLE',
    done: 'DONE',
    killed: 'STOPPED',
    error: 'ERROR',
    stuck: 'STUCK',
  }[st] || st;
}

function matchesStatusFilter(m) {
  if (!state.statusFilter) return true;
  if (state.statusFilter === 'alert') return m.status === 'error' || m.status === 'stuck';
  if (state.statusFilter === 'done') return m.status === 'done' || m.status === 'killed';
  return m.status === state.statusFilter;
}

function selectAgent(name) {
  state.selectedAgent = name;
  renderStage();
  renderDetail();
  setDrawer(true, 'detail');
}

function setDrawer(open, tab) {
  state.drawerOpen = open;
  if (tab) state.drawerTab = tab;
  $('side-drawer').classList.toggle('hidden', !state.drawerOpen);
  $('btn-toggle-drawer').setAttribute('aria-expanded', String(state.drawerOpen));
  document.querySelectorAll('.dtab').forEach((btn) => {
    const on = btn.dataset.dtab === state.drawerTab;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', String(on));
  });
  $('panel-feed').classList.toggle('hidden', state.drawerTab !== 'feed');
  $('panel-detail').classList.toggle('hidden', state.drawerTab !== 'detail');
}

function filteredSessions() {
  if (state.kindFilter === 'all') return state.sessions;
  return state.sessions.filter((s) => s.kind === state.kindFilter);
}

function renderSessionDropdown() {
  const sel = $('session-select');
  const list = filteredSessions();
  const activeId = state.followCurrent
    ? state.session?.id || state.matchedSessionId || ''
    : state.selectedSessionId;

  const opts = list.map((s) => {
    const tag = s.kind === 'swarm' ? '[Swarm]' : '[Sub]';
    return `<option value="${esc(s.id)}" ${s.id === activeId ? 'selected' : ''}>${esc(`${tag} ${s.title} (${s.memberCount})`)}</option>`;
  });
  sel.innerHTML = opts.length
    ? `<option value="">-- Chọn phiên (${list.length}) --</option>${opts.join('')}`
    : '<option value="">Không có phiên nào</option>';
  $('btn-follow-current').classList.toggle('active', state.followCurrent);
}

function renderHeaderAndAttention() {
  const s = state.session;
  $('live-pill').classList.toggle('paused', !state.online);
  $('live-pill').innerHTML = `<i class="dot"></i>${state.online ? 'Live · 0 Token' : 'Đang kết nối lại...'}`;

  if (!s) {
    $('session-title').textContent = state.followCurrent ? 'Chờ phiên Swarm / Subagent...' : 'Chưa chọn phiên';
    $('cnt-working').textContent = '0';
    $('cnt-waiting').textContent = '0';
    $('cnt-done').textContent = '0';
    $('cnt-alert').textContent = '0';
    $('meta-kind').textContent = '—';
    $('meta-steps').textContent = '0 bước';
    $('meta-tokens').textContent = '0 tok';
    $('feed-count').textContent = '0';
    $('attention-bar').classList.add('hidden');
    return;
  }

  $('session-title').textContent = s.title + (s.goal ? ` — ${s.goal}` : '');
  $('cnt-working').textContent = String(s.totals.working);
  $('cnt-waiting').textContent = String(s.totals.waiting);
  $('cnt-done').textContent = String(s.totals.done);
  $('cnt-alert').textContent = String(s.totals.alert);
  $('meta-kind').textContent = s.kind === 'swarm' ? 'SWARM' : 'SUBAGENT';
  $('meta-steps').textContent = `${s.totals.steps} bước`;
  $('meta-tokens').textContent = `${fmtTokens(s.totals.tokens)} tok`;
  $('feed-count').textContent = String(s.feed.length);

  const attBar = $('attention-bar');
  if (!s.attention.length) {
    attBar.classList.add('hidden');
    attBar.innerHTML = '';
  } else {
    attBar.classList.remove('hidden');
    attBar.innerHTML = s.attention
      .map((a) => `
        <div class="att-item ${esc(a.kind)}">
          <span class="att-msg">⚠ ${esc(a.text)}</span>
          ${a.conversationId && canOpenConv()
            ? `<button type="button" class="px-btn" data-open-conv="${esc(a.conversationId)}">Mở chat ↗</button>`
            : ''}
        </div>`)
      .join('');
  }
}

function renderDeptCardHtml(dept, memberMap, peersOfSelected) {
  const list = dept.members.map((n) => memberMap.get(n)).filter((m) => m && matchesStatusFilter(m));
  if (!list.length) return '';

  const pct = dept.stats.total ? Math.round((dept.stats.done / dept.stats.total) * 100) : 0;
  const hasAlert = dept.stats.alert > 0;

  return `
    <section class="dept-card theme-${esc(dept.theme)}" data-dept-id="${esc(dept.id)}">
      <div class="dept-head">
        <div class="dept-title-wrap">
          <span class="dept-emblem" aria-hidden="true">${deptEmblem(dept.theme)}</span>
          <div>
            <div class="dept-title">${esc(dept.title)}</div>
            ${dept.goal ? `<div class="dept-goal" title="${esc(dept.goal)}">${esc(dept.goal)}</div>` : ''}
          </div>
        </div>
        <div class="rpg-progress" title="Tiến độ hoàn thành phòng ban">
          <span>${dept.stats.done}/${dept.stats.total}</span>
          <div class="rpg-bar"><div class="rpg-fill ${hasAlert ? 'has-alert' : ''}" style="width:${pct}%"></div></div>
        </div>
      </div>
      <div class="dept-canvas-wrap">
        <canvas class="dept-canvas" data-dept-canvas="${esc(dept.id)}"></canvas>
      </div>
      <div class="dept-roster">
        ${list.map((m) => {
          const isSel = m.name === state.selectedAgent;
          const isPeer = !isSel && peersOfSelected.has(m.name);
          const isPing = state.pingAgents.has(m.name);
          const cls = ['agent-chip', `st-${m.status}`, isSel ? 'is-selected' : '', isPeer ? 'is-peer' : '', isPing ? 'is-ping' : ''].filter(Boolean).join(' ');
          return `
            <div class="${cls}" data-agent="${esc(m.name)}" tabindex="0">
              <div class="chip-top">
                <span class="role-tag ${esc(m.role)}">${roleShort(m.role)}</span>
                <span class="chip-name" title="${esc(m.name)}">${esc(m.name)}</span>
                ${m.unread > 0 ? `<span class="unread-pill">+${m.unread}</span>` : ''}
              </div>
              <div class="chip-act" title="${esc(m.activity)}">${esc(m.activity)}</div>
              <div class="chip-bot">
                <span class="status-pill ${esc(m.status)}">● ${statusText(m.status)}</span>
                <span class="card-right-meta">
                  <span data-rel-ms="${m.lastActiveAt || 0}">${fmtRelTime(m.lastActiveAt)}</span>
                  ${m.editedFiles?.length ? `<span title="${m.editedFiles.length} file đã sửa">📝${m.editedFiles.length}</span>` : ''}
                  ${m.conversationId && canOpenConv() ? `<button type="button" class="jump-btn" data-open-conv="${esc(m.conversationId)}" title="Mở chat">↗</button>` : ''}
                </span>
              </div>
            </div>`;
        }).join('')}
      </div>
    </section>`;
}

function renderStage() {
  const container = $('stage-content');
  const empty = $('empty-state');

  if (!state.session) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    const quick = filteredSessions().slice(0, 8);
    $('quick-sessions').innerHTML = quick.length
      ? quick.map((s) => `
          <button type="button" class="quick-item" data-pick-session="${esc(s.id)}">
            <span><b>${s.kind === 'swarm' ? '[Swarm]' : '[Sub]'}</b> ${esc(s.title)}</span>
            <span style="color:var(--parchment-dim)">${s.memberCount} phòng · ${fmtRelTime(s.updatedAt)}</span>
          </button>`).join('')
      : '<div class="empty-mini">Chưa phát hiện phiên Swarm hay Subagent nào trong thư mục brain/.</div>';
    return;
  }

  empty.classList.add('hidden');
  const members = state.session.members || [];
  const memberMap = new Map(members.map((m) => [m.name, m]));
  const peersOfSelected = new Set(state.session.peers?.[state.selectedAgent] || []);

  if (state.viewMode === 'departments') {
    let depts = state.session.departments;
    if (!Array.isArray(depts) || !depts.length) {
      // Fallback when sidecar process hasn't restarted to load updated store.mjs yet
      const cmd = members.filter((m) => m.role === 'coordinator' || m.role === 'monitor' || m.role === 'narrator');
      const wrk = members.filter((m) => !cmd.includes(m));
      const statOf = (arr) => ({
        total: arr.length,
        done: arr.filter((x) => x.status === 'done' || x.status === 'killed').length,
        alert: arr.filter((x) => x.status === 'error' || x.status === 'stuck').length,
      });
      depts = [];
      if (cmd.length) depts.push({ id: 'command', title: 'Phòng Chỉ Huy', goal: '', theme: 'command', tier: 'command', members: cmd.map((x) => x.name), stats: statOf(cmd) });
      if (wrk.length) depts.push({ id: 'dept-exec', title: 'Ban Thực Thi (khởi động lại plugin để phân ban đầy đủ)', goal: '', theme: 'studio', tier: 'department', members: wrk.map((x) => x.name), stats: statOf(wrk) });
    }
    state.resolvedDepts = depts;
    const cmdDept = depts.find((d) => d.tier === 'command');
    const subDepts = depts.filter((d) => d.tier !== 'command');
    const cmdHtml = cmdDept ? renderDeptCardHtml(cmdDept, memberMap, peersOfSelected) : '';
    const subHtmls = subDepts.map((d) => renderDeptCardHtml(d, memberMap, peersOfSelected)).filter(Boolean);

    if (!cmdHtml && !subHtmls.length) {
      container.innerHTML = '<div class="empty-mini">Không có agent nào khớp bộ lọc trạng thái hiện tại.</div>';
      return;
    }

    const connector = cmdHtml && subHtmls.length
      ? `<div class="org-connector" aria-hidden="true">
           <div class="org-stem"></div>
           ${subHtmls.length > 1
             ? `<div class="org-branch-bar"></div><div class="org-branch-drops"><span class="org-drop"></span><span class="org-drop"></span></div>`
             : `<div class="org-drop"></div>`}
         </div>`
      : '';

    container.innerHTML = `
      <div class="org-floorplan">
        ${cmdHtml ? `<div class="command-tier">${cmdHtml}</div>` : ''}
        ${connector}
        ${subHtmls.length ? `<div class="dept-grid">${subHtmls.join('')}</div>` : ''}
      </div>`;
  } else {
    const visible = members.filter(matchesStatusFilter);
    container.innerHTML = `
      <div class="room-grid">
        ${visible.map((m) => {
          const isSel = m.name === state.selectedAgent;
          const isPeer = !isSel && peersOfSelected.has(m.name);
          const cls = ['room-card', `st-${m.status}`, isSel ? 'is-selected' : '', isPeer ? 'is-peer' : ''].filter(Boolean).join(' ');
          return `
            <article class="${cls}" data-agent="${esc(m.name)}" tabindex="0">
              <div class="card-head">
                <span class="role-tag ${esc(m.role)}">${roleShort(m.role)}</span>
                <span class="card-name" title="${esc(m.name)}">${esc(m.name)}</span>
                ${m.unread > 0 ? `<span class="unread-pill">+${m.unread}</span>` : ''}
                <span class="card-steps">${m.steps}b</span>
              </div>
              <div class="room-canvas-wrap">
                <canvas class="room-canvas" data-canvas-agent="${esc(m.name)}"></canvas>
              </div>
              <div class="card-foot">
                <div class="card-activity" title="${esc(m.activity)}">${esc(m.activity)}</div>
                <div class="card-meta">
                  <span class="card-model" title="${esc(m.model || '—')}">${esc(m.model || '—')}</span>
                  <span class="card-right-meta">
                    <span data-rel-ms="${m.lastActiveAt || 0}">${fmtRelTime(m.lastActiveAt)}</span>
                    <span class="status-pill ${esc(m.status)}">● ${statusText(m.status)}</span>
                    ${m.conversationId && canOpenConv() ? `<button type="button" class="jump-btn" data-open-conv="${esc(m.conversationId)}" title="Mở chat">↗</button>` : ''}
                  </span>
                </div>
              </div>
            </article>`;
        }).join('')}
      </div>`;
  }

  paintAllCanvases();
}

function paintAllCanvases() {
  if (!state.session) return;
  const byName = new Map(state.session.members.map((m) => [m.name, m]));
  const peers = new Set(state.session.peers?.[state.selectedAgent] || []);

  if (state.viewMode === 'departments') {
    const deptsById = new Map((state.resolvedDepts || state.session.departments || []).map((d) => [d.id, d]));
    document.querySelectorAll('canvas[data-dept-canvas]').forEach((canvas) => {
      const dept = deptsById.get(canvas.dataset.deptCanvas);
      if (!dept) return;
      const list = dept.members.map((n) => byName.get(n)).filter((m) => m && matchesStatusFilter(m));
      if (!list.length) return;
      const boxes = renderDepartmentRoom(canvas, dept, list, {
        selectedAgent: state.selectedAgent,
        peers,
        pings: state.pingAgents,
        tick: state.tick,
      });
      state.canvasHitboxes.set(canvas, boxes);
    });
  } else {
    document.querySelectorAll('canvas[data-canvas-agent]').forEach((canvas) => {
      const agent = byName.get(canvas.dataset.canvasAgent);
      if (agent) renderPixelRoom(canvas, agent, state.tick);
    });
  }
}

function renderFeed() {
  const listEl = $('feed-list');
  const filterBar = $('feed-filter-bar');
  const feed = state.session?.feed || [];

  if (state.feedAgentFilter) {
    filterBar.classList.remove('hidden');
    $('feed-filter-label').textContent = `Đang lọc: ${state.feedAgentFilter}`;
  } else {
    filterBar.classList.add('hidden');
  }

  const rows = state.feedAgentFilter
    ? feed.filter((f) => f.from === state.feedAgentFilter || f.all || (f.to || []).includes(state.feedAgentFilter))
    : feed;

  if (!rows.length) {
    listEl.innerHTML = '<div class="empty-mini">Chưa có tin nhắn trao đổi nào.</div>';
    return;
  }

  listEl.innerHTML = rows.map((f) => {
    const tagCls = f.tag === 'Giao việc' ? 'task' : f.tag === 'Cảnh báo' ? 'alert' : 'report';
    const dest = f.all ? 'Cả đội (@all)' : (f.to?.length ? f.to.join(', ') : 'Board');
    return `
      <div class="feed-item">
        <div class="feed-top">
          <span class="feed-tag ${tagCls}">${esc(f.tag)}</span>
          <span class="feed-time">${esc(fmtClock(f.ts || f.time))}</span>
        </div>
        <div class="feed-route">${esc(f.from)} → ${esc(dest)}</div>
        <div class="feed-text">${esc(f.text)}</div>
      </div>`;
  }).join('');
}

function renderDetail() {
  const box = $('agent-detail');
  const agent = state.session?.members?.find((m) => m.name === state.selectedAgent);
  if (!agent) {
    box.innerHTML = '<div class="empty-mini">Click vào nhân vật trong phòng ban (hoặc thẻ Agent) để xem File đã sửa, 12 hành động gần nhất & mở chat.</div>';
    return;
  }

  const totalTok = (agent.tokens?.input || 0) + (agent.tokens?.output || 0);
  const actions = agent.recentActions || [];
  const edited = agent.editedFiles || [];
  const fileOpenReady = canOpenFile();

  box.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">
        <span><span class="role-tag ${esc(agent.role)}">${roleShort(agent.role)}</span> ${esc(agent.name)}</span>
        <span class="status-pill ${esc(agent.status)}">● ${statusText(agent.status)}</span>
      </div>
      <div class="detail-grid">
        <div>Model: <b>${esc(agent.model || '—')}</b></div>
        <div>Bước: <b>${agent.steps}</b></div>
        <div>Gần nhất: <b>${fmtRelTime(agent.lastActiveAt)}</b></div>
        <div>Token: <b>${fmtTokens(totalTok)}</b></div>
        <div>Tin đã gửi: <b>${agent.posts}</b></div>
        <div>Chưa đọc: <b>${agent.unread}</b></div>
      </div>
      ${agent.task ? `<div style="font-size:11px;color:var(--brass-bright)">Nhiệm vụ: ${esc(agent.task)}</div>` : ''}
      <div class="detail-actions">
        <button type="button" class="px-btn primary" data-open-conv="${esc(agent.conversationId)}" ${agent.conversationId && canOpenConv() ? '' : 'disabled'}>
          Mở chat Agent ↗
        </button>
        <button type="button" class="px-btn" data-filter-feed="${esc(agent.name)}">Xem tin nhắn</button>
      </div>
    </div>

    ${agent.failure ? `<div class="detail-alert"><b>⚠ ${esc(agent.failure.kind.toUpperCase())}:</b> ${esc(agent.failure.text)}</div>` : ''}

    <div class="section-label">File đã sửa (${edited.length})</div>
    ${edited.length
      ? `<div class="file-list">
           ${edited.map((f) => `
             <button type="button" class="file-chip" ${f.fileUri && fileOpenReady ? `data-open-file="${esc(f.fileUri)}"` : 'disabled'} title="${esc(f.path)}">
               <span>📝</span>
               <span class="file-chip-name">${esc(f.name)}</span>
               ${f.count > 1 ? `<span class="file-chip-cnt">×${f.count}</span>` : ''}
               ${f.fileUri && fileOpenReady ? '<span>↗</span>' : ''}
             </button>`).join('')}
         </div>`
      : '<div class="empty-mini">Chưa sửa file nào trong cửa sổ gần nhất.</div>'}

    <div class="section-label">12 hành động gần nhất</div>
    <div class="timeline">
      ${actions.length
        ? actions.map((a) => `
            <div class="tl-row st-${esc(a.status)}">
              <div class="tl-top">
                <span class="tl-label">${esc(a.label)}</span>
                <span class="tl-right">
                  <span class="tl-time">${esc(fmtClock(a.time))} · ${esc(a.status)}</span>
                  ${a.fileUri && fileOpenReady ? `<button type="button" class="jump-btn" data-open-file="${esc(a.fileUri)}" title="Mở ${esc(a.filePath || '')}">↗</button>` : ''}
                </span>
              </div>
              ${a.error ? `<div class="tl-err">${esc(a.error)}</div>` : ''}
            </div>`).join('')
        : '<div class="empty-mini">Chưa có hành động nào trong transcript.</div>'}
    </div>
  `;
}

function renderAll() {
  renderSessionDropdown();
  renderHeaderAndAttention();
  renderStage();
  renderFeed();
  renderDetail();
}

function refreshRelTimes() {
  document.querySelectorAll('[data-rel-ms]').forEach((el) => {
    const ms = Number(el.dataset.relMs) || 0;
    el.textContent = fmtRelTime(ms);
  });
}

async function pollSessions() {
  try {
    const conv = currentConv();
    const q = conv ? `?conversationId=${encodeURIComponent(conv)}` : '';
    const data = await apiGet(`/api/sessions${q}`);
    state.sessions = data.sessions || [];
    state.matchedSessionId = data.matchedSessionId || null;
    renderSessionDropdown();
  } catch {}
}

async function pollState(force = false) {
  if (document.hidden && !force) return;
  try {
    const qs = new URLSearchParams();
    const conv = currentConv();
    if (conv) qs.set('conversationId', conv);
    if (!state.followCurrent && state.selectedSessionId) {
      qs.set('sessionId', state.selectedSessionId);
    }
    if (!force && state.etag) qs.set('etag', state.etag);

    const data = await apiGet(`/api/state?${qs.toString()}`);
    const wasOffline = !state.online;
    state.online = true;
    if (data.unchanged) {
      if (wasOffline) renderHeaderAndAttention();
      refreshRelTimes();
      return;
    }

    const prevSessionId = state.session?.id || '';
    const nextSession = data.session || null;
    if (!nextSession && Array.isArray(data.sessions)) {
      state.sessions = data.sessions;
    }

    state.pingAgents.clear();
    if (nextSession && nextSession.id === prevSessionId && nextSession.feed?.length) {
      const newestSeq = nextSession.feed[0].seq || 0;
      if (state.lastFeedSeq > 0 && newestSeq > state.lastFeedSeq) {
        for (const msg of nextSession.feed) {
          if (msg.seq <= state.lastFeedSeq) break;
          state.pingAgents.add(msg.from);
          for (const to of msg.to || []) state.pingAgents.add(to);
        }
      }
      state.lastFeedSeq = newestSeq;
    } else {
      state.lastFeedSeq = nextSession?.feed?.[0]?.seq || 0;
      const keepInitial = !prevSessionId && state.selectedAgent && nextSession?.members?.some((m) => m.name === state.selectedAgent);
      if (!keepInitial) state.selectedAgent = null;
      state.feedAgentFilter = '';
    }

    state.session = nextSession;
    state.etag = nextSession?.etag || '';
    renderAll();
  } catch {
    state.online = false;
    renderHeaderAndAttention();
  }
}

// Event bindings
$('btn-follow-current').addEventListener('click', () => {
  state.followCurrent = true;
  state.selectedSessionId = '';
  state.etag = '';
  pollState(true);
});

$('session-select').addEventListener('change', (e) => {
  const id = e.target.value;
  if (!id) return;
  state.followCurrent = false;
  state.selectedSessionId = id;
  state.etag = '';
  pollState(true);
});

$('btn-toggle-drawer').addEventListener('click', () => setDrawer(!state.drawerOpen));
$('btn-close-drawer').addEventListener('click', () => setDrawer(false));

document.querySelectorAll('.dtab').forEach((btn) => {
  btn.addEventListener('click', () => setDrawer(true, btn.dataset.dtab));
});

document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.viewMode = btn.dataset.view;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.viewMode));
    renderStage();
  });
});

document.querySelectorAll('.kpi').forEach((btn) => {
  btn.addEventListener('click', () => {
    const st = btn.dataset.status;
    state.statusFilter = state.statusFilter === st ? '' : st;
    document.querySelectorAll('.kpi').forEach((b) => b.classList.toggle('on', b.dataset.status === state.statusFilter));
    renderStage();
  });
});

document.querySelectorAll('[data-kind]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.kindFilter = btn.dataset.kind;
    document.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === state.kindFilter));
    renderSessionDropdown();
    if (!state.session) renderStage();
  });
});

$('btn-clear-feed-filter').addEventListener('click', () => {
  state.feedAgentFilter = '';
  renderFeed();
});

document.addEventListener('click', (e) => {
  const fileBtn = e.target.closest('[data-open-file]');
  if (fileBtn) {
    e.stopPropagation();
    openFile(fileBtn.dataset.openFile);
    return;
  }

  const openBtn = e.target.closest('[data-open-conv]');
  if (openBtn) {
    e.stopPropagation();
    openConv(openBtn.dataset.openConv);
    return;
  }

  const pickBtn = e.target.closest('[data-pick-session]');
  if (pickBtn) {
    state.followCurrent = false;
    state.selectedSessionId = pickBtn.dataset.pickSession;
    state.etag = '';
    pollState(true);
    return;
  }

  const filterFeedBtn = e.target.closest('[data-filter-feed]');
  if (filterFeedBtn) {
    state.feedAgentFilter = filterFeedBtn.dataset.filterFeed;
    setDrawer(true, 'feed');
    renderFeed();
    return;
  }

  // Click directly onto a pixel character inside a 2D Department Room canvas
  const deptCanvas = e.target.closest('canvas[data-dept-canvas]');
  if (deptCanvas) {
    const boxes = state.canvasHitboxes.get(deptCanvas) || [];
    const r = deptCanvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * deptCanvas.width;
    const py = ((e.clientY - r.top) / r.height) * deptCanvas.height;
    const hit = boxes.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    if (hit) selectAgent(hit.name);
    return;
  }

  const target = e.target.closest('[data-agent]');
  if (target) {
    selectAgent(target.dataset.agent);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target.closest?.('[data-agent]');
  if (!target) return;
  e.preventDefault();
  selectAgent(target.dataset.agent);
});

// Init
document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === state.viewMode));
setDrawer(state.drawerOpen, state.drawerTab);
loadTheme();
pollSessions();
pollState(true);

setInterval(() => {
  if (!document.hidden) {
    state.tick++;
    paintAllCanvases();
  }
}, ANIM_TICK_MS);

setInterval(() => pollState(false), POLL_STATE_MS);
setInterval(() => pollSessions(), POLL_SESSIONS_MS);
document.addEventListener('visibilitychange', () => {
  const vid = $('bg-video');
  if (document.hidden) {
    if (vid && !vid.paused) vid.pause();
  } else {
    if (state.theme.mode === 'video' && vid?.src) vid.play().catch(() => {});
    pollState(false);
  }
});

// ==================== CUSTOM BACKGROUND & GLASS STUDIO ====================
let themeSaveTimer = null;

function releaseVideo(vid) {
  if (!vid) return;
  vid.pause();
  if (vid.getAttribute('src')) {
    vid.removeAttribute('src');
    vid.load();
  }
}

function applyThemeToDOM() {
  const t = state.theme;
  const root = document.documentElement.style;
  root.setProperty('--bg-dim', String(t.dim));
  root.setProperty('--bg-blur', `${t.blur}px`);
  root.setProperty('--glass-alpha', String(t.glassOpacity));

  const stage = $('bg-stage');
  const img = $('bg-img');
  const vid = $('bg-video');
  const active = (t.mode === 'image' || t.mode === 'video') && Boolean(t.mediaFile);

  document.body.classList.toggle('has-custom-bg', active);
  stage.classList.toggle('hidden', !active);

  if (!active) {
    img.classList.add('hidden');
    img.removeAttribute('src');
    vid.classList.add('hidden');
    releaseVideo(vid);
  } else {
    const src = `/media/file?name=${encodeURIComponent(t.mediaFile)}`;
    if (t.mode === 'image') {
      releaseVideo(vid);
      vid.classList.add('hidden');
      if (img.getAttribute('src') !== src) img.src = src;
      img.classList.remove('hidden');
    } else {
      img.classList.add('hidden');
      img.removeAttribute('src');
      if (vid.getAttribute('src') !== src) {
        vid.src = src;
        vid.play().catch(() => {});
      }
      vid.classList.remove('hidden');
    }
  }

  $('sl-dim').value = String(Math.round(t.dim * 100));
  $('val-dim').textContent = `${Math.round(t.dim * 100)}%`;
  $('sl-blur').value = String(Math.round(t.blur));
  $('val-blur').textContent = `${Math.round(t.blur)}px`;
  $('sl-glass').value = String(Math.round(t.glassOpacity * 100));
  $('val-glass').textContent = `${Math.round(t.glassOpacity * 100)}%`;
  document.querySelectorAll('[data-bg-mode]').forEach((b) => {
    b.classList.toggle('on', b.dataset.bgMode === t.mode);
  });
  renderMediaLibrary();
}

function renderMediaLibrary() {
  const box = $('media-library');
  if (!state.mediaFiles.length) {
    box.innerHTML = '<div class="empty-mini">Chưa có ảnh/video nào. Bấm "+ Tải ảnh/video" để thêm (ảnh ≤8MB, video ≤18MB).</div>';
    return;
  }
  box.innerHTML = state.mediaFiles.map((f) => {
    const active = state.theme.mediaFile === f.name && state.theme.mode === f.kind;
    const mb = (f.size / (1024 * 1024)).toFixed(1);
    return `
      <div class="media-item ${active ? 'on' : ''}">
        <button type="button" class="media-pick" data-pick-media="${esc(f.name)}" data-media-kind="${esc(f.kind)}" title="${esc(f.name)}">
          ${f.kind === 'video' ? '🎬' : '🖼'} ${esc(f.name)} (${mb}MB)
        </button>
        <button type="button" class="media-del" data-del-media="${esc(f.name)}" title="Xóa tệp">✕</button>
      </div>`;
  }).join('');
}

function scheduleSaveTheme() {
  clearTimeout(themeSaveTimer);
  themeSaveTimer = setTimeout(() => {
    apiPost('/api/theme', state.theme).catch(() => {});
  }, 180);
}

async function loadTheme() {
  try {
    const res = await apiGet('/api/theme');
    if (res?.config) state.theme = res.config;
    if (Array.isArray(res?.files)) state.mediaFiles = res.files;
    applyThemeToDOM();
  } catch {}
}

$('btn-theme-studio').addEventListener('click', () => {
  $('theme-modal').classList.toggle('hidden');
  loadTheme();
});

$('btn-close-theme').addEventListener('click', () => $('theme-modal').classList.add('hidden'));
$('theme-modal').addEventListener('click', (e) => {
  if (e.target === $('theme-modal')) $('theme-modal').classList.add('hidden');
});

document.querySelectorAll('[data-bg-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.bgMode;
    if (mode === 'default') {
      state.theme.mode = 'default';
    } else {
      const match = state.mediaFiles.find((f) => f.name === state.theme.mediaFile && f.kind === mode)
        || state.mediaFiles.find((f) => f.kind === mode);
      state.theme.mode = match ? mode : 'default';
      if (match) state.theme.mediaFile = match.name;
    }
    applyThemeToDOM();
    scheduleSaveTheme();
  });
});

$('sl-dim').addEventListener('input', (e) => {
  state.theme.dim = Number(e.target.value) / 100;
  applyThemeToDOM();
  scheduleSaveTheme();
});
$('sl-blur').addEventListener('input', (e) => {
  state.theme.blur = Number(e.target.value);
  applyThemeToDOM();
  scheduleSaveTheme();
});
$('sl-glass').addEventListener('input', (e) => {
  state.theme.glassOpacity = Number(e.target.value) / 100;
  applyThemeToDOM();
  scheduleSaveTheme();
});

$('media-upload-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const st = $('theme-upload-status');
  st.textContent = `Đang tải lên ${file.name}...`;
  st.classList.remove('hidden');
  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Không đọc được file'));
      reader.readAsDataURL(file);
    });
    const res = await apiPost('/api/media/upload', { name: file.name, dataBase64 });
    if (res?.config) state.theme = res.config;
    if (Array.isArray(res?.files)) state.mediaFiles = res.files;
    applyThemeToDOM();
    st.textContent = `Đã áp dụng ${file.name}`;
    setTimeout(() => st.classList.add('hidden'), 2000);
  } catch (err) {
    st.textContent = `Lỗi: ${err.message}`;
  }
});

$('media-library').addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-pick-media]');
  if (pick) {
    state.theme.mode = pick.dataset.mediaKind;
    state.theme.mediaFile = pick.dataset.pickMedia;
    applyThemeToDOM();
    scheduleSaveTheme();
    return;
  }
  const del = e.target.closest('[data-del-media]');
  if (del) {
    try {
      const res = await apiPost('/api/media/delete', { name: del.dataset.delMedia });
      if (res?.config) state.theme = res.config;
      if (Array.isArray(res?.files)) state.mediaFiles = res.files;
      applyThemeToDOM();
    } catch {}
  }
});
