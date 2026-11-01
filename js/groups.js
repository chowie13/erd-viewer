/* Table groups and which tables are shown on the diagram.
   A view is { groups: [{ id, name, color, tables: [tableKey] }], hidden: [tableKey] }.
   A table can be in several groups. Hidden tables are stored (not shown ones), so tables
   added by a new migration start shown. Keys of tables that are gone for now (e.g. their
   file is unticked) are kept, so they come back in their groups. Functions change the view
   in place and return it.
   Works in the browser (window.ErdGroups) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ErdGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Colour names; styles.css defines --g1 … --g8 for light and dark mode.
  const PALETTE = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];

  function emptyView() {
    return { groups: [], hidden: [] };
  }

  // Accepts whatever was stored (or nothing) and returns a well-formed view.
  function normalize(raw) {
    const view = emptyView();
    if (!raw || typeof raw !== 'object') return view;
    if (Array.isArray(raw.hidden)) view.hidden = [...new Set(raw.hidden.filter((k) => typeof k === 'string'))];
    if (Array.isArray(raw.groups)) {
      const ids = new Set();
      for (const g of raw.groups) {
        if (!g || typeof g.id !== 'string' || ids.has(g.id)) continue;
        ids.add(g.id);
        view.groups.push({
          id: g.id,
          name: typeof g.name === 'string' && g.name.trim() ? g.name : 'Group',
          color: PALETTE.includes(g.color) ? g.color : PALETTE[0],
          tables: Array.isArray(g.tables) ? [...new Set(g.tables.filter((k) => typeof k === 'string'))] : [],
        });
      }
    }
    return view;
  }

  const findGroup = (view, id) => view.groups.find((g) => g.id === id) || null;

  // The first palette colour no group uses yet; when all are used, the least used one.
  function nextColor(view) {
    const used = new Map(PALETTE.map((c) => [c, 0]));
    view.groups.forEach((g) => used.set(g.color, (used.get(g.color) || 0) + 1));
    let best = PALETTE[0];
    for (const c of PALETTE) if (used.get(c) < used.get(best)) best = c;
    return best;
  }

  function createGroup(view, name) {
    let n = view.groups.length + 1;
    while (findGroup(view, 'g' + n)) n++;
    const group = { id: 'g' + n, name: String(name || '').trim() || 'Group ' + n, color: nextColor(view), tables: [] };
    view.groups.push(group);
    return group;
  }

  function renameGroup(view, id, name) {
    const g = findGroup(view, id);
    const clean = String(name || '').trim();
    if (g && clean) g.name = clean;
    return view;
  }

  function setGroupColor(view, id, color) {
    const g = findGroup(view, id);
    if (g && PALETTE.includes(color)) g.color = color;
    return view;
  }

  // The group goes; its tables stay, and keep whether they're shown.
  function deleteGroup(view, id) {
    view.groups = view.groups.filter((g) => g.id !== id);
    return view;
  }

  function setMembershipMany(view, id, keys, on) {
    const g = findGroup(view, id);
    if (!g) return view;
    const set = new Set(g.tables);
    keys.forEach((k) => (on ? set.add(k) : set.delete(k)));
    g.tables = [...set];
    return view;
  }

  const setMembership = (view, id, key, on) => setMembershipMany(view, id, [key], on);

  // The table's groups, in the order the groups were made.
  const groupsOf = (view, key) => view.groups.filter((g) => g.tables.includes(key));

  const isShown = (view, key) => !view.hidden.includes(key);

  function setTablesShown(view, keys, on) {
    const set = new Set(view.hidden);
    keys.forEach((k) => (on ? set.delete(k) : set.add(k)));
    view.hidden = [...set];
    return view;
  }

  const setTableShown = (view, key, on) => setTablesShown(view, [key], on);

  // Ticking or unticking a group sets all its tables. Last click wins.
  function setGroupShown(view, id, on) {
    const g = findGroup(view, id);
    return g ? setTablesShown(view, g.tables, on) : view;
  }

  // 'on' when all its tables are shown, 'off' when none are, 'mixed' otherwise.
  // An empty group counts as 'on'. Pass existing keys to ignore tables that are gone.
  function groupState(view, id, existing) {
    const g = findGroup(view, id);
    if (!g) return 'on';
    const keys = existing ? g.tables.filter((k) => existing.has(k)) : g.tables;
    const shown = keys.filter((k) => isShown(view, k)).length;
    if (shown === keys.length) return 'on';
    return shown === 0 ? 'off' : 'mixed';
  }

  return {
    PALETTE,
    emptyView,
    normalize,
    createGroup,
    renameGroup,
    setGroupColor,
    deleteGroup,
    setMembership,
    setMembershipMany,
    groupsOf,
    isShown,
    setTableShown,
    setTablesShown,
    setGroupShown,
    groupState,
  };
});
