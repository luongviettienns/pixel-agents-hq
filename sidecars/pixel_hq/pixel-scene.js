/**
 * 16-bit Pixel Game 2D Department & Room Renderer (HTML5 Canvas 2D).
 * Exports:
 *   - renderDepartmentRoom(canvas, dept, members, opts) -> hitboxes [{name, x, y, w, h}]
 *   - renderPixelRoom(canvas, agent, tick)
 */

const CLOTH_PALETTE = [
  '#d94848', '#e87a24', '#e5a93c', '#45a859',
  '#35b8c9', '#4a7de0', '#945fd4', '#d65a96',
];

const ROOM_THEMES = {
  command: {
    wall: '#3a2220', wallAlt: '#4a2c29', trim: '#c89b54',
    floor: '#5c3c28', floorAlt: '#69452f',
    rugBorder: '#e8b948', rugInner: '#8a232b',
    windowSky: '#14203b',
  },
  server: {
    wall: '#202b36', wallAlt: '#293745', trim: '#537b8f',
    floor: '#2d3a42', floorAlt: '#35454f',
    rugBorder: '#35b8c9', rugInner: '#1b3540',
    windowSky: '#0e1a2b',
  },
  design: {
    wall: '#402c27', wallAlt: '#523832', trim: '#d98a4e',
    floor: '#8a6240', floorAlt: '#996d49',
    rugBorder: '#f2c15a', rugInner: '#475c4a',
    windowSky: '#1c2b4a',
  },
  lab: {
    wall: '#2c2738', wallAlt: '#383147', trim: '#9b83bd',
    floor: '#4c443c', floorAlt: '#595046',
    rugBorder: '#91c96b', rugInner: '#2e4738',
    windowSky: '#131b33',
  },
  studio: {
    wall: '#362921', wallAlt: '#45352a', trim: '#b8884f',
    floor: '#6e4e35', floorAlt: '#7a583d',
    rugBorder: '#d98a4e', rugInner: '#3f304a',
    windowSky: '#152038',
  },
};

function hashName(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function drawWallBackdrop(ctx, w, h, themeKey, tick, hasAlert) {
  const pal = ROOM_THEMES[themeKey] || ROOM_THEMES.studio;
  const wallH = 38;

  // Wall base + brick/plank pattern
  rect(ctx, 0, 0, w, wallH, pal.wall);
  for (let y = 4; y < wallH - 4; y += 7) {
    const off = ((y - 4) / 7) % 2 === 0 ? 0 : 9;
    for (let x = off; x < w; x += 18) {
      rect(ctx, x, y, 16, 5, pal.wallAlt);
    }
  }
  // Wainscoting / brass trim
  rect(ctx, 0, wallH - 3, w, 3, '#18110e');
  rect(ctx, 0, wallH, w, 2, pal.trim);

  // Tiled wood / stone floor
  rect(ctx, 0, wallH + 2, w, h - wallH - 2, pal.floor);
  for (let y = wallH + 4; y < h; y += 10) {
    const off = ((y - wallH - 4) / 10) % 2 === 0 ? 0 : 12;
    for (let x = off; x < w; x += 24) {
      rect(ctx, x, y, 22, 8, pal.floorAlt);
    }
  }

  // Subtle floor shadow along wall
  rect(ctx, 0, wallH + 2, w, 3, 'rgba(0,0,0,0.28)');

  // Theme-specific props along back wall
  if (themeKey === 'command') {
    // Wide panoramic city night window in center
    const wx = Math.floor(w / 2) - 42;
    rect(ctx, wx - 2, 6, 88, 24, '#18110e');
    rect(ctx, wx, 8, 84, 20, pal.windowSky);
    // City skyline silhouettes + twinkling lights
    const bldgs = [[4, 10, 10], [16, 6, 14], [30, 12, 8], [44, 8, 12], [60, 5, 15], [72, 11, 9]];
    for (const [bx, by, bw] of bldgs) {
      rect(ctx, wx + bx, 8 + by, bw, 20 - by, '#0b1021');
      if ((tick + bx) % 5 !== 0) rect(ctx, wx + bx + 2, 10 + by, 2, 2, '#f2c15a');
      if ((tick + by) % 4 !== 0) rect(ctx, wx + bx + 5, 13 + by, 2, 2, '#35b8c9');
    }
    // Crescent moon
    rect(ctx, wx + 68, 10, 4, 4, '#fff0b8');
    rect(ctx, wx + 70, 10, 2, 2, pal.windowSky);
    // Window mullions
    rect(ctx, wx + 28, 8, 2, 20, '#593e31');
    rect(ctx, wx + 56, 8, 2, 20, '#593e31');
    // Royal banners flanking window
    for (const bx of [wx - 18, wx + 92]) {
      if (bx < 4 || bx + 12 > w - 4) continue;
      rect(ctx, bx, 7, 12, 20, '#8a232b');
      rect(ctx, bx + 2, 9, 8, 14, '#b52d38');
      rect(ctx, bx + 4, 12, 4, 4, '#f2c15a');
      rect(ctx, bx, 6, 12, 2, '#e8b948');
    }
    // Royal carpet
    rect(ctx, 14, 48, w - 28, h - 56, pal.rugBorder);
    rect(ctx, 17, 51, w - 34, h - 62, pal.rugInner);
  } else if (themeKey === 'server') {
    // Blinking Server Racks
    for (let sx = 12; sx < w - 28; sx += 76) {
      rect(ctx, sx, 6, 22, 30, '#121820');
      rect(ctx, sx + 2, 8, 18, 26, '#1f2b36');
      for (let r = 0; r < 5; r++) {
        rect(ctx, sx + 4, 10 + r * 5, 14, 3, '#10161d');
        const led = ((tick + r + sx) % 3 === 0) ? '#45a859' : ((tick + r) % 4 === 0 ? '#f2c15a' : '#254236');
        rect(ctx, sx + 5, 11 + r * 5, 2, 1, led);
        rect(ctx, sx + 9, 11 + r * 5, 6, 1, '#35b8c9');
      }
    }
    // Whiteboard
    if (w > 180) {
      const mx = Math.floor(w / 2) - 24;
      rect(ctx, mx, 8, 48, 22, '#475766');
      rect(ctx, mx + 2, 10, 44, 18, '#e8eef2');
      rect(ctx, mx + 5, 13, 14, 2, '#4a7de0');
      rect(ctx, mx + 5, 17, 24, 2, '#45a859');
      rect(ctx, mx + 5, 21, 18, 2, '#e87a24');
    }
  } else if (themeKey === 'design') {
    // Color swatch board + pixel paintings + potted plants
    const cx = Math.floor(w / 2) - 26;
    rect(ctx, cx, 8, 52, 20, '#2b1f1a');
    rect(ctx, cx + 2, 10, 48, 16, '#f4e4c1');
    const sw = ['#d94848', '#f2c15a', '#45a859', '#35b8c9', '#945fd4', '#e87a24'];
    for (let i = 0; i < sw.length; i++) {
      rect(ctx, cx + 5 + i * 7, 13, 5, 10, sw[i]);
    }
    // Potted pixel plants in corners
    for (const px of [12, w - 26]) {
      rect(ctx, px + 3, 27, 8, 9, '#b85c38');
      rect(ctx, px + 2, 25, 10, 3, '#d4744c');
      rect(ctx, px + 4, 16, 6, 9, '#398a4b');
      rect(ctx, px + 1, 19, 4, 5, '#59b864');
      rect(ctx, px + 9, 18, 4, 6, '#59b864');
    }
  } else if (themeKey === 'lab') {
    // Towering colorful bookshelves
    const books = ['#d94848', '#f2c15a', '#35b8c9', '#45a859', '#945fd4', '#e87a24'];
    for (let bx = 12; bx < w - 34; bx += 68) {
      rect(ctx, bx, 6, 30, 30, '#261914');
      rect(ctx, bx + 2, 8, 26, 26, '#3d281e');
      for (let row = 0; row < 3; row++) {
        const ry = 10 + row * 8;
        rect(ctx, bx + 2, ry + 6, 26, 2, '#261914');
        for (let b = 0; b < 6; b++) {
          rect(ctx, bx + 4 + b * 4, ry + (b % 2), 3, 6 - (b % 2), books[(row * 6 + b + bx) % books.length]);
        }
      }
    }
  } else {
    // Cozy guild studio: window + warm wall torches
    rect(ctx, 14, 8, 28, 20, '#18110e');
    rect(ctx, 16, 10, 24, 16, pal.windowSky);
    rect(ctx, 32, 12, 4, 4, '#fff0b8');
    rect(ctx, 27, 10, 2, 16, '#593e31');
    rect(ctx, 16, 17, 24, 2, '#593e31');
    // Framed parchment board
    if (w > 180) {
      const mx = Math.floor(w / 2) - 22;
      rect(ctx, mx, 9, 44, 20, '#261914');
      rect(ctx, mx + 2, 11, 40, 16, '#c89b54');
      rect(ctx, mx + 5, 14, 12, 6, '#f4e4c1');
      rect(ctx, mx + 20, 13, 14, 8, '#f4e4c1');
      rect(ctx, mx + 10, 15, 2, 2, '#d94848');
      rect(ctx, mx + 26, 14, 2, 2, '#45a859');
    }
  }

  // Wall lantern or flashing red alert siren at top-right
  const lx = w - 18;
  rect(ctx, lx + 2, 14, 4, 8, '#2b1f1a');
  if (hasAlert) {
    const on = tick % 2 === 0;
    rect(ctx, lx, 8, 8, 6, on ? '#e43b44' : '#6e1b24');
    if (on) rect(ctx, lx - 4, 4, 16, 14, 'rgba(228,59,68,0.28)');
  } else {
    const fc = ['#f2c15a', '#e87a24', '#fff0b8'][tick % 3];
    rect(ctx, lx + 1, 9, 6, 5, fc);
    rect(ctx, lx - 3, 5, 14, 13, 'rgba(242,193,90,0.14)');
  }
}

function drawWorkstation(ctx, x, y, agent, { selected, isPeer, isPing, tick }) {
  const status = agent.status;
  const isWorking = status === 'working';
  const isDone = status === 'done';
  const isAlert = status === 'error' || status === 'stuck';
  const isKilled = status === 'killed';

  // Floor highlight under workstation
  if (selected) {
    rect(ctx, x + 4, y + 32, 64, 26, 'rgba(242,193,90,0.26)');
    rect(ctx, x + 4, y + 32, 64, 2, '#f2c15a');
    rect(ctx, x + 4, y + 56, 64, 2, '#f2c15a');
  } else if (isPeer) {
    rect(ctx, x + 6, y + 34, 60, 22, 'rgba(53,184,201,0.18)');
  } else if (isAlert) {
    rect(ctx, x + 6, y + 34, 60, 22, tick % 2 === 0 ? 'rgba(228,59,68,0.28)' : 'rgba(228,59,68,0.1)');
  }

  // Desk
  const deskTop = agent.role === 'coordinator' ? '#a66b38' : '#855330';
  const deskFace = agent.role === 'coordinator' ? '#7a4b25' : '#633c22';
  rect(ctx, x + 12, y + 26, 48, 11, deskFace);
  rect(ctx, x + 12, y + 26, 48, 3, deskTop);
  rect(ctx, x + 14, y + 37, 4, 8, '#3b2214');
  rect(ctx, x + 54, y + 37, 4, 8, '#3b2214');

  // CRT Monitor / Tactical Screen
  rect(ctx, x + 23, y + 13, 24, 14, '#18110e');
  const scrBg = isWorking ? '#12362a' : isAlert ? '#3d141b' : isDone ? '#293d20' : '#1b2436';
  rect(ctx, x + 25, y + 15, 20, 10, scrBg);
  rect(ctx, x + 32, y + 27, 6, 2, '#3d332f');

  if (isWorking) {
    const sh = tick % 3;
    rect(ctx, x + 27, y + 17, 9 + sh * 2, 2, '#63c74d');
    rect(ctx, x + 27, y + 20, 14 - sh * 2, 2, '#35b8c9');
    rect(ctx, x + 27, y + 23, 8 + sh, 1, '#a7f070');
  } else if (isAlert) {
    rect(ctx, x + 28, y + 17, 14, 2, '#e43b44');
    rect(ctx, x + 30, y + 21, 10, 2, '#f2c15a');
  } else if (isDone) {
    rect(ctx, x + 32, y + 19, 2, 2, '#63c74d');
    rect(ctx, x + 34, y + 21, 2, 2, '#63c74d');
    rect(ctx, x + 36, y + 19, 2, 2, '#63c74d');
    rect(ctx, x + 38, y + 17, 2, 2, '#63c74d');
  } else if (status === 'waiting') {
    // Steaming mug on desk
    rect(ctx, x + 51, y + 21, 6, 6, '#f4e4c1');
    rect(ctx, x + 52, y + 22, 4, 2, '#633c22');
    rect(ctx, x + 53 + (tick % 2), y + 17, 2, 3, 'rgba(244,228,193,0.6)');
  }

  // Character sprite
  const h = hashName(agent.name || 'agent');
  const tunic = agent.role === 'coordinator' ? '#e8a838' : CLOTH_PALETTE[h % CLOTH_PALETTE.length];
  const skin = '#f0cfa0';
  const hair = ['#291b16', '#5e3522', '#1d2738', '#8a5534'][h % 4];
  const cx = x + 30;
  const bob = isWorking ? (tick % 2) : isDone ? (tick % 4 === 0 ? -1 : 0) : (tick % 6 === 0 ? 1 : 0);
  const cy = y + 34 + bob;

  // Shadow + boots
  rect(ctx, cx - 2, y + 53, 16, 4, 'rgba(0,0,0,0.38)');
  rect(ctx, cx + 1, cy + 16, 4, 4, '#1c1512');
  rect(ctx, cx + 7, cy + 16, 4, 4, '#1c1512');

  // Tunic
  rect(ctx, cx, cy + 8, 12, 9, isKilled ? '#5c5866' : tunic);
  rect(ctx, cx + 4, cy + 9, 4, 7, 'rgba(0,0,0,0.18)');

  // Arms
  if (isDone) {
    rect(ctx, cx - 3, cy + 3, 3, 7, tunic);
    rect(ctx, cx + 12, cy + 3, 3, 7, tunic);
  } else if (isWorking) {
    const t = tick % 2 === 0 ? 0 : 2;
    rect(ctx, cx - 3, cy + 8 - t, 3, 5, tunic);
    rect(ctx, cx + 12, cy + 6 + t, 3, 5, tunic);
  } else if (isAlert) {
    rect(ctx, cx - 3, cy + 4, 3, 6, tunic);
    rect(ctx, cx + 12, cy + 4, 3, 6, tunic);
  } else {
    rect(ctx, cx - 2, cy + 9, 2, 6, isKilled ? '#47434f' : tunic);
    rect(ctx, cx + 12, cy + 9, 2, 6, isKilled ? '#47434f' : tunic);
  }

  // Head + role headgear
  rect(ctx, cx + 1, cy, 10, 8, isKilled ? '#a69e98' : skin);
  rect(ctx, cx, cy - 2, 12, 3, hair);
  if (agent.role === 'coordinator') {
    rect(ctx, cx + 1, cy - 5, 10, 3, '#f2c15a');
    rect(ctx, cx + 1, cy - 7, 2, 2, '#fff5cc');
    rect(ctx, cx + 5, cy - 7, 2, 2, '#fff5cc');
    rect(ctx, cx + 9, cy - 7, 2, 2, '#fff5cc');
  } else if (agent.role === 'subagent') {
    rect(ctx, cx + 1, cy, 10, 2, '#35b8c9');
  } else if (agent.role === 'monitor' || agent.role === 'narrator') {
    rect(ctx, cx + 2, cy + 1, 3, 2, '#63c74d');
    rect(ctx, cx + 7, cy + 1, 3, 2, '#63c74d');
  }

  // Eyes
  if (isKilled) {
    rect(ctx, cx + 3, cy + 4, 2, 1, '#18110e');
    rect(ctx, cx + 7, cy + 4, 2, 1, '#18110e');
  } else {
    rect(ctx, cx + 3, cy + 3, 2, 2, '#18110e');
    rect(ctx, cx + 7, cy + 3, 2, 2, '#18110e');
  }

  // Speech / Activity Bubble
  const bx = x + 27;
  const by = y + 1 + (tick % 4 < 2 ? 0 : 1);
  if (isDone) {
    rect(ctx, bx, by, 18, 12, '#18110e');
    rect(ctx, bx + 1, by + 1, 16, 10, '#f4e4c1');
    rect(ctx, bx + 5, by + 6, 2, 2, '#359c4d');
    rect(ctx, bx + 7, by + 8, 2, 2, '#359c4d');
    rect(ctx, bx + 9, by + 6, 2, 2, '#359c4d');
    rect(ctx, bx + 11, by + 4, 2, 2, '#359c4d');
  } else if (isAlert) {
    rect(ctx, bx, by, 18, 12, '#e43b44');
    rect(ctx, bx + 1, by + 1, 16, 10, '#2b1016');
    rect(ctx, bx + 8, by + 2, 2, 5, '#ff8a90');
    rect(ctx, bx + 8, by + 8, 2, 2, '#ff8a90');
  } else if (isWorking) {
    rect(ctx, bx, by, 18, 12, '#18110e');
    rect(ctx, bx + 1, by + 1, 16, 10, '#f4e4c1');
    const kind = agent.activityKind;
    if (kind === 'cmd') {
      rect(ctx, bx + 8, by + 2, 4, 2, '#e87a24');
      rect(ctx, bx + 6, by + 4, 4, 2, '#f2c15a');
      rect(ctx, bx + 8, by + 6, 4, 2, '#e87a24');
      rect(ctx, bx + 7, by + 8, 3, 2, '#f2c15a');
    } else if (kind === 'read' || kind === 'search') {
      rect(ctx, bx + 4, by + 3, 4, 6, '#3b73d9');
      rect(ctx, bx + 10, by + 3, 4, 6, '#35b8c9');
      rect(ctx, bx + 8, by + 4, 2, 5, '#18110e');
    } else if (kind === 'edit') {
      rect(ctx, bx + 5, by + 7, 3, 3, '#e87a24');
      rect(ctx, bx + 8, by + 4, 3, 3, '#f2c15a');
      rect(ctx, bx + 11, by + 2, 2, 2, '#d94848');
    } else if (kind === 'board') {
      rect(ctx, bx + 4, by + 3, 10, 6, '#f2c15a');
      rect(ctx, bx + 6, by + 5, 6, 2, '#633c22');
    } else {
      const a = tick % 3;
      for (let d = 0; d < 3; d++) {
        rect(ctx, bx + 4 + d * 4, by + 5, 2, 2, d === a ? '#945fd4' : '#8a7e72');
      }
    }
  } else if (status === 'waiting') {
    const a = tick % 3;
    rect(ctx, bx + 2, by + 2, 14, 9, '#18110e');
    rect(ctx, bx + 3, by + 3, 12, 7, '#263042');
    for (let d = 0; d < 3; d++) {
      rect(ctx, bx + 5 + d * 3, by + 6, 2, 2, d === a ? '#35b8c9' : '#566882');
    }
  }

  // Flying pixel mail badge on fresh Board ping
  if (isPing) {
    const py = y + 4 + (tick % 2 === 0 ? -2 : 0);
    rect(ctx, x + 50, py, 12, 8, '#18110e');
    rect(ctx, x + 51, py + 1, 10, 6, '#f2c15a');
    rect(ctx, x + 52, py + 2, 8, 1, '#633c22');
    rect(ctx, x + 54, py + 3, 4, 1, '#633c22');
  }

  // Classic RPG golden selection pointer arrow above selected character
  if (selected) {
    const ay = y + 25 + (tick % 2);
    rect(ctx, x + 6, ay, 8, 2, '#f2c15a');
    rect(ctx, x + 8, ay + 2, 4, 2, '#fff5cc');
    rect(ctx, x + 9, ay + 4, 2, 2, '#f2c15a');
  }
}

export function renderDepartmentRoom(canvas, dept, members, { selectedAgent = null, peers = new Set(), pings = new Set(), tick = 0 } = {}) {
  const count = Math.max(1, members.length);
  const cols = dept.tier === 'command' ? Math.min(4, Math.max(2, count)) : Math.min(4, Math.max(2, count));
  const rows = Math.ceil(count / cols);
  const slotW = 74;
  const rowH = 62;
  const padX = 14;
  const minW = dept.tier === 'command' ? 280 : 228;
  const w = Math.max(minW, padX * 2 + cols * slotW);
  const h = 40 + rows * rowH + 8;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  ctx.imageSmoothingEnabled = false;

  const hasAlert = members.some((m) => m.status === 'error' || m.status === 'stuck');
  drawWallBackdrop(ctx, w, h, dept.theme || 'studio', tick, hasAlert);

  const hitboxes = [];
  for (let i = 0; i < members.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const rowCount = Math.min(cols, members.length - row * cols);
    const rowWidth = rowCount * slotW;
    const startX = Math.floor((w - rowWidth) / 2);
    const sx = startX + col * slotW;
    const sy = 40 + row * rowH;

    const m = members[i];
    drawWorkstation(ctx, sx, sy, m, {
      selected: m.name === selectedAgent,
      isPeer: peers.has(m.name),
      isPing: pings.has(m.name),
      tick,
    });
    hitboxes.push({ name: m.name, x: sx, y: sy, w: slotW, h: rowH });
  }

  return hitboxes;
}

export function renderPixelRoom(canvas, agent, tick) {
  const w = 160;
  const h = 96;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;

  const theme = agent.role === 'coordinator' ? 'command' : agent.role === 'subagent' ? 'lab' : 'studio';
  const isAlert = agent.status === 'error' || agent.status === 'stuck';
  drawWallBackdrop(ctx, w, h, theme, tick, isAlert);
  drawWorkstation(ctx, Math.floor((w - 72) / 2), 34, agent, {
    selected: false,
    isPeer: false,
    isPing: false,
    tick,
  });
}
