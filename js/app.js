/* ERD Viewer page: loading files, drawing the diagram, the table list and the details panel. */
(function () {
  'use strict';

  const P = window.ErdParser;
  const $ = (id) => document.getElementById(id);

  const FONT = '-apple-system, "Segoe UI", system-ui, Roboto, sans-serif';
  const MONO = 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace';
  const TITLE_FONT = '600 13px ' + FONT;
  const COL_FONT = '13px ' + FONT;
  const TYPE_FONT = '12px ' + MONO;
  const BADGE_FONT = '600 11px ' + FONT;
  const HEADER = 34;
  const ROW = 22;
  const PAD = 12;
  const GAP_X = 90;
  const GAP_Y = 36;
  const MAX_SEED_ROWS = 500;

  const STORE_PROJECT = 'erd-viewer:project';
  const STORE_FILTER = 'erd-viewer:filter';
  const layoutKey = (name) => 'erd-viewer:layout:' + name;

  const state = {
    project: null, // { name, files: [{ path, text, include }] }
    model: null,
    byKey: new Map(),
    pos: {},
    size: {},
    selected: null,
    filter: 'all',
    search: '',
    view: { x: 0, y: 0, k: 1 },
    dirHandle: null,
  };

  // ---------- Small helpers ----------

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function load(key) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const measureCtx = document.createElement('canvas').getContext('2d');
  function textWidth(text, font) {
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  const shortType = (type) => (type.length > 24 ? type.slice(0, 23) + '…' : type || '');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const isMobile = () => window.matchMedia('(max-width: 767px)').matches;
  const hasSeed = (t) => t.rows.length > 0 || t.queryInserts > 0;
  const seedLabel = (t) => (t.rows.length ? plural(t.rows.length, 'row') : 'rows');

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---------- Loading a project ----------

  function prepareFiles(files, previous) {
    const was = new Map((previous || []).map((f) => [f.path, f.include]));
    return P.sortFiles(files).map((f) => ({
      path: f.path,
      text: f.text,
      include: was.has(f.path) ? was.get(f.path) : !P.isDownMigration(f.path),
    }));
  }

  function openProject(name, files) {
    if (!files.length) {
      toast('No .sql files found there.');
      return;
    }
    const project = { name, files: prepareFiles(files) };
    if (!save(STORE_PROJECT, project)) toast('Loaded. This project is too big to remember after you close the page.');
    showProject(project);
  }

  function showProject(project) {
    state.project = project;
    state.pos = load(layoutKey(project.name)) || {};
    state.selected = null;
    $('openDialog').close();
    rebuild();
    fit();
  }

  function rebuild() {
    const included = state.project.files.filter((f) => f.include);
    state.model = P.parseProject(included);
    state.byKey = new Map(state.model.tables.map((t) => [t.key, t]));
    state.size = {};
    for (const t of state.model.tables) state.size[t.key] = measure(t);
    if (state.selected && !state.byKey.has(state.selected)) state.selected = null;
    placeNewTables();
    renderAll();
  }

  async function readDirectory(handle, prefix) {
    const out = [];
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'directory') {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        out.push(...(await readDirectory(entry, prefix + name + '/')));
      } else if (/\.sql$/i.test(name)) {
        const file = await entry.getFile();
        out.push({ path: prefix + name, text: await file.text() });
      }
    }
    return out;
  }

  async function chooseFolder() {
    if (window.showDirectoryPicker) {
      let handle;
      try {
        handle = await window.showDirectoryPicker({ id: 'erd-viewer', mode: 'read' });
      } catch {
        return; // cancelled
      }
      state.dirHandle = handle;
      openProject(handle.name, await readDirectory(handle, ''));
    } else {
      $('folderInput').click();
    }
  }

  async function reloadFolder() {
    const handle = state.dirHandle;
    if (!handle) return;
    try {
      const files = await readDirectory(handle, '');
      state.project = { name: handle.name, files: prepareFiles(files, state.project.files) };
      save(STORE_PROJECT, state.project);
      rebuild();
      toast(`Reloaded ${plural(files.length, 'file')}.`);
    } catch {
      toast('Could not read the folder again. Choose it with Open.');
    }
  }

  async function readFileInput(input, fromFolder) {
    const list = [...input.files];
    input.value = '';
    if (!list.length) return;
    const files = [];
    let name = 'Selected files';
    for (const f of list) {
      let path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
      if (fromFolder && path.includes('/')) {
        name = path.split('/')[0];
        path = path.slice(name.length + 1);
      }
      if (!P.isSqlPath(path)) continue;
      files.push({ path, text: await f.text() });
    }
    state.dirHandle = null;
    openProject(name, files);
  }

  function handleOpen(kind) {
    if (kind === 'folder') chooseFolder();
    else if (kind === 'files') $('filesInput').click();
    else if (kind === 'sample') {
      state.dirHandle = null;
      openProject(window.ErdSample.name, window.ErdSample.files);
    }
  }

  // ---------- Layout ----------

  function measure(t) {
    let w = textWidth(t.name, TITLE_FONT) + PAD * 2;
    if (hasSeed(t)) w += textWidth(seedLabel(t), BADGE_FONT) + 26;
    for (const c of t.columns) {
      w = Math.max(w, PAD + 22 + textWidth(c.name, COL_FONT) + 24 + textWidth(shortType(c.type), TYPE_FONT) + PAD);
    }
    return { w: Math.ceil(Math.min(Math.max(w, 170), 440)), h: HEADER + 8 + Math.max(t.columns.length, 1) * ROW };
  }

  const rowCenter = (i) => HEADER + 4 + i * ROW + ROW / 2;

  // Tables that others point to go on the left, the tables pointing at them to the right.
  // Tables with no relationships go in a grid underneath.
  function autoLayout(tables) {
    const keys = new Set(tables.map((t) => t.key));
    const parents = new Map();
    const linked = new Set();
    for (const t of tables) {
      const ps = new Set(t.fks.map((f) => f.refTable).filter((k) => keys.has(k) && k !== t.key));
      parents.set(t.key, ps);
      if (ps.size) {
        linked.add(t.key);
        ps.forEach((k) => linked.add(k));
      }
    }
    const level = new Map();
    const visiting = new Set();
    function depth(key) {
      if (level.has(key)) return level.get(key);
      if (visiting.has(key)) return 0;
      visiting.add(key);
      let d = 0;
      for (const p of parents.get(key)) d = Math.max(d, depth(p) + 1);
      visiting.delete(key);
      level.set(key, d);
      return d;
    }
    const connected = tables.filter((t) => linked.has(t.key));
    const loose = tables.filter((t) => !linked.has(t.key));
    connected.forEach((t) => depth(t.key));

    const levels = [];
    for (const t of connected) (levels[level.get(t.key)] ||= []).push(t);
    const childCount = (t) => connected.filter((c) => parents.get(c.key).has(t.key)).length;
    const order = new Map();
    const pos = {};
    let x = 0;
    let maxY = 0;
    const maxColumnHeight = Math.max(900, Math.sqrt(connected.length) * 260);

    levels.forEach((group, li) => {
      if (!group) return;
      if (li === 0) group.sort((a, b) => childCount(b) - childCount(a) || a.name.localeCompare(b.name));
      else {
        const bary = (t) => {
          const ps = [...parents.get(t.key)].filter((k) => order.has(k));
          return ps.length ? ps.reduce((s, k) => s + order.get(k), 0) / ps.length : 1e9;
        };
        group.sort((a, b) => bary(a) - bary(b) || a.name.localeCompare(b.name));
      }
      let y = 0;
      let colWidth = 0;
      group.forEach((t, i) => {
        const s = state.size[t.key];
        if (y > 0 && y + s.h > maxColumnHeight) {
          x += colWidth + GAP_X / 2;
          y = 0;
          colWidth = 0;
        }
        pos[t.key] = { x, y };
        order.set(t.key, i);
        y += s.h + GAP_Y;
        colWidth = Math.max(colWidth, s.w);
        maxY = Math.max(maxY, y);
      });
      x += colWidth + GAP_X;
    });

    const gridWidth = Math.max(x - GAP_X, 1100);
    let gx = 0;
    let gy = connected.length ? maxY + 40 : 0;
    let rowHeight = 0;
    loose.sort((a, b) => a.name.localeCompare(b.name)).forEach((t) => {
      const s = state.size[t.key];
      if (gx > 0 && gx + s.w > gridWidth) {
        gx = 0;
        gy += rowHeight + GAP_Y;
        rowHeight = 0;
      }
      pos[t.key] = { x: gx, y: gy };
      gx += s.w + GAP_X / 2;
      rowHeight = Math.max(rowHeight, s.h);
    });
    return pos;
  }

  function bounds(keys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const k of keys) {
      const p = state.pos[k];
      const s = state.size[k];
      if (!p || !s) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + s.w);
      maxY = Math.max(maxY, p.y + s.h);
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  // Keeps positions the user arranged; lays out only tables that have none yet.
  function placeNewTables() {
    const tables = state.model.tables;
    const missing = tables.filter((t) => !state.pos[t.key]);
    if (!missing.length) return;
    const placed = tables.filter((t) => state.pos[t.key]).map((t) => t.key);
    const fresh = autoLayout(missing);
    const b = bounds(placed);
    const dx = b ? b.minX : 0;
    const dy = b ? b.maxY + 80 : 0;
    for (const [k, p] of Object.entries(fresh)) state.pos[k] = { x: p.x + dx, y: p.y + dy };
    saveLayout();
  }

  function saveLayout() {
    if (!state.project) return;
    const keep = {};
    for (const t of state.model.tables) keep[t.key] = state.pos[t.key];
    save(layoutKey(state.project.name), keep);
  }

  function tidy() {
    state.pos = {};
    placeNewTables();
    renderDiagram();
    fit();
  }

  // ---------- Diagram ----------

  function matchesSearch(t) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return t.key.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q));
  }

  const isVisible = (t) => matchesSearch(t) && (state.filter !== 'seed' || hasSeed(t));

  function relatedKeys(key) {
    const t = state.byKey.get(key);
    const out = new Set();
    if (!t) return out;
    t.fks.forEach((f) => out.add(f.refTable));
    t.referencedBy.forEach((r) => out.add(r.table));
    out.delete(key);
    return out;
  }

  function nodeSvg(t, related) {
    const p = state.pos[t.key];
    const s = state.size[t.key];
    const cls = ['node'];
    if (hasSeed(t)) cls.push('seeded');
    if (t.key === state.selected) cls.push('selected');
    else if (related.has(t.key)) cls.push('related');
    if (!isVisible(t)) cls.push('dim');

    let h = `<g class="${cls.join(' ')}" data-key="${esc(t.key)}" transform="translate(${p.x},${p.y})">`;
    h += `<title>${esc(t.key)}</title>`;
    h += `<rect class="node-box" width="${s.w}" height="${s.h}" rx="8"/>`;
    h += `<path class="node-head" d="M0.5,8.5 a8,8 0 0 1 8,-8 h${s.w - 17} a8,8 0 0 1 8,8 v${HEADER - 8.5} h${-(s.w - 1)} z"/>`;
    h += `<text class="node-title" x="${PAD}" y="22">${esc(t.name)}</text>`;
    if (hasSeed(t)) {
      const label = seedLabel(t);
      const bw = textWidth(label, BADGE_FONT) + 14;
      h += `<rect class="node-badge" x="${s.w - PAD - bw}" y="8" width="${bw}" height="18" rx="9"/>`;
      h += `<text class="node-badge-text" x="${s.w - PAD - bw / 2}" y="21" text-anchor="middle">${esc(label)}</text>`;
    }
    t.columns.forEach((c, i) => {
      const y = rowCenter(i) + 4.5;
      if (c.pk || c.fk) h += `<text class="col-key ${c.pk ? 'pk' : 'fk'}" x="${PAD}" y="${y - 0.5}">${c.pk ? 'PK' : 'FK'}</text>`;
      h += `<text class="col-name${c.notNull ? '' : ' nullable'}" x="${PAD + 22}" y="${y}">${esc(c.name)}</text>`;
      h += `<text class="col-type" x="${s.w - PAD}" y="${y}" text-anchor="end">${esc(shortType(c.type))}</text>`;
    });
    if (!t.columns.length) h += `<text class="col-empty" x="${PAD}" y="${rowCenter(0) + 4}">no columns</text>`;
    return h + '</g>';
  }

  function anchor(t, colName) {
    const p = state.pos[t.key];
    const s = state.size[t.key];
    const i = t.columns.findIndex((c) => c.name === colName);
    return { y: p.y + (i === -1 ? HEADER / 2 : rowCenter(i)), left: p.x, right: p.x + s.w };
  }

  function edgeSvg(child, fk) {
    const parent = state.byKey.get(fk.refTable);
    const a = anchor(child, fk.columns[0]);
    const b = anchor(parent, fk.refColumns[0]);
    let ax, ad, bx, bd;
    if (child !== parent && a.right + 30 < b.left) { ax = a.right; ad = 1; bx = b.left; bd = -1; }
    else if (child !== parent && b.right + 30 < a.left) { ax = a.left; ad = -1; bx = b.right; bd = 1; }
    else { ax = a.right; ad = 1; bx = b.right; bd = 1; }
    const bend = Math.max(48, Math.abs(bx - ax) / 2);
    // Crow's foot (many) at the child end, a bar (one) at the parent end.
    const col = child.columns.find((c) => c.name === fk.columns[0]);
    const one = fk.columns.length === 1 && col && (col.unique || (col.pk && child.primaryKey.length === 1));
    let d = `M${ax},${a.y} h${ad * 14} C${ax + ad * bend},${a.y} ${bx + bd * bend},${b.y} ${bx + bd * 14},${b.y} h${-bd * 14}`;
    d += one ? ` M${ax + ad * 9},${a.y - 6} v12` : ` M${ax + ad * 12},${a.y} L${ax},${a.y - 6} M${ax + ad * 12},${a.y} L${ax},${a.y + 6}`;
    d += ` M${bx + bd * 9},${b.y - 6} v12`;
    const hi = state.selected && (child.key === state.selected || parent.key === state.selected);
    const dim = !hi && (!isVisible(child) || !isVisible(parent));
    return `<path class="edge${hi ? ' hi' : ''}${dim ? ' dim' : ''}" d="${d}"/>`;
  }

  function drawEdges() {
    let h = '';
    for (const t of state.model.tables) {
      for (const fk of t.fks) if (!fk.missing && state.byKey.has(fk.refTable)) h += edgeSvg(t, fk);
    }
    $('edges').innerHTML = h;
  }

  function renderDiagram() {
    const related = state.selected ? relatedKeys(state.selected) : new Set();
    // Draw the selected table last so it sits on top.
    const tables = state.model.tables.slice().sort((a, b) => (a.key === state.selected) - (b.key === state.selected));
    $('nodes').innerHTML = tables.map((t) => nodeSvg(t, related)).join('');
    drawEdges();
  }

  function applyView() {
    const v = state.view;
    $('viewport').setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
  }

  const clampZoom = (k) => Math.min(2.5, Math.max(0.08, k));

  function zoomAt(px, py, factor) {
    const v = state.view;
    const k = clampZoom(v.k * factor);
    const wx = (px - v.x) / v.k;
    const wy = (py - v.y) / v.k;
    v.k = k;
    v.x = px - wx * k;
    v.y = py - wy * k;
    applyView();
  }

  function fit() {
    const b = bounds(state.model ? state.model.tables.map((t) => t.key) : []);
    if (!b) return;
    const r = $('diagram').getBoundingClientRect();
    const pad = 32;
    const k = clampZoom(Math.min((r.width - pad * 2) / (b.maxX - b.minX), (r.height - pad * 2) / (b.maxY - b.minY), 1.2));
    state.view = {
      k,
      x: (r.width - (b.maxX - b.minX) * k) / 2 - b.minX * k,
      y: Math.max(pad, (r.height - (b.maxY - b.minY) * k) / 2) - b.minY * k,
    };
    applyView();
  }

  function centerOn(key) {
    const p = state.pos[key];
    const s = state.size[key];
    if (!p) return;
    const r = $('diagram').getBoundingClientRect();
    const v = state.view;
    v.k = Math.max(v.k, 0.7);
    // On phones the details sheet covers the lower part of the screen.
    const targetY = isMobile() ? r.height * 0.18 : r.height / 2 - (s.h * v.k) / 2;
    v.x = r.width / 2 - (p.x + s.w / 2) * v.k;
    v.y = targetY - p.y * v.k;
    applyView();
  }

  // ---------- Pointer and wheel ----------

  function setupGestures() {
    const svg = $('diagram');
    const pointers = new Map();
    let g = null;

    const local = (e) => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function startPinch() {
      const [a, b] = [...pointers.values()];
      return {
        type: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        v0: { ...state.view },
      };
    }

    svg.addEventListener('pointerdown', (e) => {
      if (!state.model) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      svg.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 2) {
        g = startPinch();
        return;
      }
      if (pointers.size > 2) return;
      const node = e.target.closest('.node');
      const key = node && node.dataset.key;
      g = {
        type: node ? 'node' : 'pan',
        key,
        el: node,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        origin: node ? { ...state.pos[key] } : { x: state.view.x, y: state.view.y },
      };
    });

    svg.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !g) return;
      pointers.set(e.pointerId, local(e));
      if (g.type === 'pinch') {
        if (pointers.size < 2) return;
        const [a, b] = [...pointers.values()];
        const k = clampZoom((g.v0.k * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const wx = (g.m0.x - g.v0.x) / g.v0.k;
        const wy = (g.m0.y - g.v0.y) / g.v0.k;
        state.view = { k, x: mid.x - wx * k, y: mid.y - wy * k };
        applyView();
        return;
      }
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < 5) return;
      g.moved = true;
      if (g.type === 'node') {
        const p = { x: g.origin.x + dx / state.view.k, y: g.origin.y + dy / state.view.k };
        state.pos[g.key] = p;
        g.el.setAttribute('transform', `translate(${p.x},${p.y})`);
        drawEdges();
      } else {
        svg.classList.add('panning');
        state.view.x = g.origin.x + dx;
        state.view.y = g.origin.y + dy;
        applyView();
      }
    });

    function end(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      svg.classList.remove('panning');
      if (!g) return;
      if (g.type === 'pinch') {
        if (pointers.size === 0) g = null;
        else g = { type: 'none' };
        return;
      }
      if (e.type === 'pointerup' && !g.moved) {
        if (g.type === 'node') select(g.key);
        else if (g.type === 'pan') select(null);
      }
      if (g.type === 'node' && g.moved) saveLayout();
      if (pointers.size === 0) g = null;
    }
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    svg.addEventListener('wheel', (e) => {
      if (!state.model) return;
      e.preventDefault();
      const p = local(e);
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(p.x, p.y, Math.exp(-step * 0.0015));
    }, { passive: false });
  }

  // ---------- Table list ----------

  function renderList() {
    const tables = state.model.tables;
    $('countAll').textContent = tables.length;
    $('countSeed').textContent = tables.filter(hasSeed).length;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === state.filter)));

    const shown = tables.filter(isVisible).sort((a, b) => a.key.localeCompare(b.key));
    if (!shown.length) {
      const why = state.filter === 'seed' && !state.search ? 'No tables have seed rows.' : 'No tables match.';
      $('tableList').innerHTML = `<li class="list-empty">${why}</li>`;
      return;
    }
    $('tableList').innerHTML = shown.map((t) => `<li><button type="button" data-key="${esc(t.key)}"${t.key === state.selected ? ' aria-current="true"' : ''}>
        <span class="t-name">${esc(t.key)}</span>
        ${hasSeed(t) ? `<span class="badge seed">${esc(seedLabel(t))}</span>` : `<span class="t-meta">${plural(t.columns.length, 'col')}</span>`}
      </button></li>`).join('');
  }

  // ---------- Details ----------

  function tableLink(key, label) {
    if (!state.byKey.has(key)) return `<span class="muted">${esc(label || key)} (not found)</span>`;
    return `<button type="button" class="link" data-goto="${esc(key)}">${esc(label || key)}</button>`;
  }

  function cellHtml(v) {
    if (v === undefined) return '<td class="none" title="Not set; uses the column default">default</td>';
    if (v === null) return '<td class="null">NULL</td>';
    if (typeof v === 'object') return `<td class="expr" title="${esc(v.expr)}">${esc(v.expr)}</td>`;
    return `<td title="${esc(v)}">${esc(v)}</td>`;
  }

  function seedSection(t) {
    if (!hasSeed(t)) return '';
    const names = t.columns.map((c) => c.name);
    const used = new Set();
    t.rows.forEach((r) => Object.keys(r.values).forEach((k) => used.add(k)));
    const cols = [...names.filter((n) => used.has(n)), ...[...used].filter((n) => !names.includes(n))];
    const rows = t.rows.slice(0, MAX_SEED_ROWS);
    const files = [...new Set(t.rows.map((r) => r.file))];
    let h = `<section class="section"><h3>Seed rows <span class="badge seed">${t.rows.length}</span></h3>`;
    if (rows.length) {
      h += `<div class="seed-wrap"><table class="seed-table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>`;
      h += rows.map((r) => `<tr>${cols.map((c) => cellHtml(r.values[c])).join('')}</tr>`).join('');
      h += '</tbody></table></div>';
    }
    const notes = [];
    if (files.length) notes.push(`From ${files.map(esc).join(', ')}`);
    if (t.rows.length > MAX_SEED_ROWS) notes.push(`Showing the first ${MAX_SEED_ROWS}.`);
    if (t.queryInserts) notes.push(`Plus ${plural(t.queryInserts, 'INSERT')} that copy rows from a query, which can't be listed.`);
    return h + `<div class="seed-note">${notes.join(' · ')}</div></section>`;
  }

  function columnItem(t, c) {
    const badges = [];
    if (c.pk) badges.push('<span class="badge pk">PK</span>');
    if (c.fk) badges.push('<span class="badge fk">FK</span>');
    if (c.unique && !c.pk) badges.push('<span class="badge plain">unique</span>');
    if (!c.notNull) badges.push('<span class="badge plain">nullable</span>');
    if (c.identity) badges.push('<span class="badge plain">auto</span>');
    const extra = [];
    if (c.fk) extra.push(`→ ${tableLink(c.fk.table, c.fk.column ? `${c.fk.table}.${c.fk.column}` : c.fk.table)}`);
    if (c.default !== null) extra.push(`default <code>${esc(c.default)}</code>`);
    if (c.generated) extra.push(`generated from <code>${esc(c.generated)}</code>`);
    if (c.enumValues) extra.push(`one of ${c.enumValues.map((v) => `<code>${esc(v)}</code>`).join(', ')}`);
    if (c.comment) extra.push(esc(c.comment));
    return `<li><div class="col-line"><strong>${esc(c.name)}</strong><code>${esc(c.type)}</code>${badges.join('')}</div>
      ${extra.map((x) => `<div class="col-extra">${x}</div>`).join('')}</li>`;
  }

  function renderDetails() {
    const el = $('details');
    const t = state.selected && state.byKey.get(state.selected);
    if (!t) {
      el.hidden = true;
      return;
    }
    const cols = (list) => list.map(esc).join(', ');
    let h = `<div class="details-head"><div><h2>${esc(t.name)}</h2>
      <div class="sub">${t.schema !== 'public' ? `schema ${esc(t.schema)} · ` : ''}${plural(t.columns.length, 'column')} · defined in ${esc(t.file)}</div></div>
      <button type="button" class="btn icon-btn" id="closeDetails" aria-label="Close details">✕</button></div>`;
    if (t.comment) h += `<section class="section"><p class="comment">${esc(t.comment)}</p></section>`;
    h += seedSection(t);
    h += `<section class="section"><h3>Columns</h3><ul class="col-list">${t.columns.map((c) => columnItem(t, c)).join('')}</ul></section>`;

    const refs = t.fks.map((f) => `<li>${cols(f.columns)} → ${tableLink(f.refTable, `${f.refTable}${f.refColumns.length ? ' (' + cols(f.refColumns) + ')' : ''}`)}${f.onDelete ? ` <span class="muted">on delete ${esc(f.onDelete)}</span>` : ''}</li>`);
    const back = t.referencedBy.map((r) => `<li>${tableLink(r.table)} <span class="muted">(${cols(r.columns)})</span> → ${cols(r.refColumns)}</li>`);
    if (refs.length || back.length) {
      h += '<section class="section"><h3>Relationships</h3>';
      if (refs.length) h += `<p class="muted">Points to</p><ul class="rel-list">${refs.join('')}</ul>`;
      if (back.length) h += `<p class="muted"${refs.length ? ' style="margin-top:10px"' : ''}>Pointed to by</p><ul class="rel-list">${back.join('')}</ul>`;
      h += '</section>';
    }
    const keys = [];
    if (t.primaryKey.length) keys.push(`<li><span class="badge pk">PK</span> ${cols(t.primaryKey)}</li>`);
    t.uniques.forEach((u) => keys.push(`<li><span class="badge plain">unique</span> ${cols(u.columns)} <span class="muted">${esc(u.name)}</span></li>`));
    t.indexes.forEach((ix) => keys.push(`<li><span class="badge plain">${ix.unique ? 'unique index' : 'index'}</span> ${cols(ix.columns)} <span class="muted">${esc(ix.name)}${ix.where ? ' where ' + esc(ix.where) : ''}</span></li>`));
    if (keys.length) h += `<section class="section"><h3>Keys and indexes</h3><ul class="rel-list">${keys.join('')}</ul></section>`;

    el.innerHTML = h;
    el.hidden = false;
    el.scrollTop = 0;
  }

  // ---------- Files dialog ----------

  function renderFiles() {
    const files = state.project.files;
    $('fileList').innerHTML = files.map((f, i) => `<li><label><input type="checkbox" data-file="${i}"${f.include ? ' checked' : ''}>
      <span>${esc(f.path)}</span></label></li>`).join('');
    const warnings = state.model.warnings;
    $('warnings').innerHTML = warnings.length
      ? `<h3>${plural(warnings.length, 'thing')} couldn't be shown</h3><ul class="warn-list">${warnings.map((w) => `<li>${esc(w.file)}: ${esc(w.message)}</li>`).join('')}</ul>`
      : '';
  }

  // ---------- Page ----------

  function renderAll() {
    const has = !!state.model;
    $('empty').hidden = has;
    $('tablesPanel').hidden = !has;
    $('zoomControls').hidden = !has;
    $('btnFiles').hidden = !has;
    $('btnTables').hidden = !has;
    $('btnReload').hidden = !state.dirHandle;
    if (!has) return;
    const n = state.model.tables.length;
    $('projectName').textContent = `${state.project.name} · ${plural(n, 'table')}`;
    const w = state.model.warnings.length;
    $('btnFiles').innerHTML = `Files${w ? ` <span class="warn-count" title="${plural(w, 'warning')}">⚠ ${w}</span>` : ''}`;
    renderDiagram();
    renderList();
    renderDetails();
    applyView();
  }

  function select(key, opts = {}) {
    state.selected = key;
    renderDiagram();
    renderList();
    renderDetails();
    if (key && opts.center) centerOn(key);
  }

  function setFilter(filter) {
    state.filter = filter;
    save(STORE_FILTER, filter);
    renderDiagram();
    renderList();
  }

  function init() {
    state.filter = load(STORE_FILTER) === 'seed' ? 'seed' : 'all';
    setupGestures();

    document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => handleOpen(b.dataset.open)));
    $('btnOpen').addEventListener('click', () => $('openDialog').showModal());
    $('btnReload').addEventListener('click', reloadFolder);
    $('btnFiles').addEventListener('click', () => {
      renderFiles();
      $('filesDialog').showModal();
    });
    $('folderInput').addEventListener('change', (e) => readFileInput(e.target, true));
    $('filesInput').addEventListener('change', (e) => readFileInput(e.target, false));

    $('fileList').addEventListener('change', (e) => {
      const i = e.target.dataset.file;
      if (i === undefined) return;
      state.project.files[i].include = e.target.checked;
      save(STORE_PROJECT, state.project);
      rebuild();
      renderFiles();
    });

    $('btnTables').addEventListener('click', () => $('tablesPanel').classList.toggle('open'));
    $('search').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderDiagram();
      renderList();
    });
    document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => setFilter(c.dataset.filter)));
    $('tableList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-key]');
      if (!b) return;
      $('tablesPanel').classList.remove('open');
      select(b.dataset.key, { center: true });
    });
    $('details').addEventListener('click', (e) => {
      if (e.target.closest('#closeDetails')) return select(null);
      const link = e.target.closest('[data-goto]');
      if (link) select(link.dataset.goto, { center: true });
    });

    $('zoomIn').addEventListener('click', () => {
      const r = $('diagram').getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, 1.25);
    });
    $('zoomOut').addEventListener('click', () => {
      const r = $('diagram').getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, 0.8);
    });
    $('zoomFit').addEventListener('click', fit);
    $('tidy').addEventListener('click', tidy);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.selected && !document.querySelector('dialog[open]')) select(null);
    });

    const saved = load(STORE_PROJECT);
    if (saved && saved.files && saved.files.length) showProject(saved);
    else renderAll();
  }

  init();
})();
