/* Named layouts (groups + table positions) and the erd-layouts.json file that shares them
   through a repo.

   On a device, a project keeps { current, layouts: [{ name, groups, positions, repo }] }.
   `repo` is the layout as it was in the file when this device last read or saved it (a
   canonical JSON string), or null for a layout that's only on this device. A layout in the
   file has unsaved changes when its groups or positions differ from `repo`.

   The file wins for layouts that are in it: a copy with no unsaved changes is simply
   updated. A copy that changed both here and in the file, or a device-only layout with the
   same name as one in the file, is a conflict, and the person chooses what to keep.

   Works in the browser (window.ErdLayouts) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./groups.js'));
  else root.ErdLayouts = factory(root.ErdGroups);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const FILE_NAME = 'erd-layouts.json';
  const DEFAULT_NAME = 'My layout';
  const VERSION = 1;

  const byName = (list, name) => list.find((l) => l.name === name) || null;

  function cleanPositions(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(raw).sort()) {
      const p = raw[key];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[key] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return out;
  }

  // Groups and positions in a fixed shape and order, so two copies can be compared as text.
  function content(layout) {
    const groups = G.normalize({ groups: layout.groups }).groups.map((g) => ({ ...g, tables: [...g.tables].sort() }));
    return { groups, positions: cleanPositions(layout.positions) };
  }

  const canon = (layout) => JSON.stringify(content(layout));

  const isShared = (layout) => layout.repo !== null && layout.repo !== undefined;
  const isDirty = (layout) => isShared(layout) && canon(layout) !== layout.repo;

  // ---------- The file ----------

  // Returns { layouts: [{ name, groups, positions }] }, or { error } for a file that can't be used.
  function parseFile(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: `${FILE_NAME} isn't valid JSON.` };
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.layouts)) return { error: `${FILE_NAME} has no layouts list.` };
    if (data.version !== VERSION) return { error: `${FILE_NAME} is version ${data.version}, which this page doesn't know. Reload the page to get the latest version.` };
    const layouts = [];
    for (const l of data.layouts) {
      if (!l || typeof l.name !== 'string' || !l.name.trim() || byName(layouts, l.name.trim())) continue;
      layouts.push({ name: l.name.trim(), ...content(l) });
    }
    return { layouts };
  }

  function serializeFile(layouts) {
    const list = layouts
      .map((l) => ({ name: l.name, ...content(l) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({ version: VERSION, layouts: list }, null, 2) + '\n';
  }

  // The file's layouts with this one added or replaced.
  function withLayout(fileLayouts, layout) {
    const rest = fileLayouts.filter((l) => l.name !== layout.name);
    return [...rest, { name: layout.name, ...content(layout) }];
  }

  const withoutLayout = (fileLayouts, name) => fileLayouts.filter((l) => l.name !== name);

  // ---------- On this device ----------

  function newLayout(name, groups, positions) {
    return { name, groups: groups || [], positions: positions || {}, repo: null };
  }

  // Accepts whatever was stored (or nothing) and returns a well-formed set of layouts.
  function normalizeState(raw) {
    const layouts = [];
    if (raw && Array.isArray(raw.layouts)) {
      for (const l of raw.layouts) {
        if (!l || typeof l.name !== 'string' || !l.name.trim() || byName(layouts, l.name)) continue;
        layouts.push({
          name: l.name,
          groups: G.normalize({ groups: l.groups }).groups,
          positions: l.positions && typeof l.positions === 'object' ? l.positions : {},
          repo: typeof l.repo === 'string' ? l.repo : null,
        });
      }
    }
    if (!layouts.length) layouts.push(newLayout(DEFAULT_NAME));
    const current = raw && byName(layouts, raw.current) ? raw.current : layouts[0].name;
    return { current, layouts };
  }

  // Groups and positions saved before layouts existed become one device-only layout.
  function fromOld(oldGroups, oldPositions) {
    const groups = G.normalize(oldGroups).groups;
    return normalizeState({ current: DEFAULT_NAME, layouts: [newLayout(DEFAULT_NAME, groups, oldPositions || {})] });
  }

  const currentLayout = (state) => byName(state.layouts, state.current) || state.layouts[0];

  function uniqueName(state, base) {
    const clean = String(base || '').trim() || DEFAULT_NAME;
    if (!byName(state.layouts, clean)) return clean;
    let n = 2;
    while (byName(state.layouts, `${clean} ${n}`)) n++;
    return `${clean} ${n}`;
  }

  function addLayout(state, name, from) {
    const copy = from ? JSON.parse(JSON.stringify(content(from))) : { groups: [], positions: {} };
    const layout = newLayout(uniqueName(state, name), copy.groups, copy.positions);
    state.layouts.push(layout);
    state.current = layout.name;
    return layout;
  }

  // Returns false when the name is empty or taken.
  function renameLayout(state, oldName, newName) {
    const l = byName(state.layouts, oldName);
    const clean = String(newName || '').trim();
    if (!l || !clean || (clean !== oldName && byName(state.layouts, clean))) return false;
    if (state.current === oldName) state.current = clean;
    l.name = clean;
    // A renamed layout is a new one as far as the file is concerned.
    if (clean !== oldName) l.repo = null;
    return true;
  }

  // A project always keeps at least one layout.
  function deleteLayout(state, name) {
    state.layouts = state.layouts.filter((l) => l.name !== name);
    if (!state.layouts.length) state.layouts.push(newLayout(DEFAULT_NAME));
    if (!byName(state.layouts, state.current)) state.current = state.layouts[0].name;
    return state;
  }

  function setFromFile(layout, fileLayout) {
    const c = content(fileLayout);
    layout.groups = c.groups;
    layout.positions = c.positions;
    layout.repo = JSON.stringify(c);
  }

  function markSaved(layout) {
    layout.repo = canon(layout);
  }

  // Brings the file's layouts in. Changes `state`; returns what happened:
  // { added: [names], updated: [names], untied: [names], conflicts: [names] }.
  // Conflicting layouts are left as they are until resolveUseFile / resolveRename.
  function mergeFromFile(state, fileLayouts) {
    const out = { added: [], updated: [], untied: [], conflicts: [] };
    for (const f of fileLayouts) {
      const fc = JSON.stringify(content(f));
      const local = byName(state.layouts, f.name);
      if (!local) {
        const l = newLayout(f.name);
        setFromFile(l, f);
        state.layouts.push(l);
        out.added.push(f.name);
      } else if (canon(local) === fc) {
        local.repo = fc;
      } else if (isShared(local) && local.repo === fc) {
        // Unchanged in the file; this device's changes are simply not saved yet.
      } else if (isShared(local) && !isDirty(local)) {
        setFromFile(local, f);
        out.updated.push(f.name);
      } else {
        out.conflicts.push(f.name);
      }
    }
    for (const l of state.layouts) {
      if (isShared(l) && !byName(fileLayouts, l.name)) {
        l.repo = null;
        out.untied.push(l.name);
      }
    }
    // Someone starting fresh (a device-only layout with no groups): show the file's layout.
    // Nothing is deleted, so the device's layout is still in the list.
    const cur = currentLayout(state);
    if (out.added.length && !isShared(cur) && !cur.groups.length) state.current = out.added[0];
    return out;
  }

  // Conflict choice: discard this device's copy and use the file's.
  function resolveUseFile(state, fileLayout) {
    const local = byName(state.layouts, fileLayout.name);
    if (local) setFromFile(local, fileLayout);
    return state;
  }

  // Conflict choice: keep this device's copy as a device-only layout under a new name,
  // and add the file's under the original name.
  function resolveRename(state, fileLayout, newName) {
    const local = byName(state.layouts, fileLayout.name);
    const clean = String(newName || '').trim();
    if (!local || !clean || byName(state.layouts, clean)) return false;
    const wasCurrent = state.current === local.name;
    local.name = clean;
    local.repo = null;
    const l = newLayout(fileLayout.name);
    setFromFile(l, fileLayout);
    state.layouts.push(l);
    if (wasCurrent) state.current = clean;
    return true;
  }

  return {
    FILE_NAME,
    DEFAULT_NAME,
    parseFile,
    serializeFile,
    withLayout,
    withoutLayout,
    normalizeState,
    fromOld,
    currentLayout,
    uniqueName,
    addLayout,
    renameLayout,
    deleteLayout,
    mergeFromFile,
    resolveUseFile,
    resolveRename,
    markSaved,
    isShared,
    isDirty,
    canon,
    byName,
  };
});
