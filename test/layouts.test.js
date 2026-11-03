const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/layouts.js');

const group = (id, name, tables, color = 'g1') => ({ id, name, color, tables });
const fileLayout = (name, groups = [], positions = {}) => ({ name, groups, positions });

test('the file round-trips and is stable', () => {
  const layouts = [
    fileLayout('Zed', [group('g1', 'B', ['b', 'a'])], { b: { x: 10.4, y: 3.6 }, a: { x: 1, y: 2 } }),
    fileLayout('Alpha'),
  ];
  const text = L.serializeFile(layouts);
  const data = JSON.parse(text);
  assert.equal(data.version, 1);
  assert.deepEqual(data.layouts.map((l) => l.name), ['Alpha', 'Zed']);
  assert.deepEqual(data.layouts[1].groups[0].tables, ['a', 'b']);
  assert.deepEqual(data.layouts[1].positions, { a: { x: 1, y: 2 }, b: { x: 10, y: 4 } });
  assert.deepEqual(Object.keys(data.layouts[1].positions), ['a', 'b']);
  const parsed = L.parseFile(text);
  assert.equal(L.serializeFile(parsed.layouts), text);
});

test('a bad file is reported, not used', () => {
  assert.match(L.parseFile('{ nope').error, /isn't valid JSON/);
  assert.match(L.parseFile('{"version":1}').error, /no layouts list/);
  assert.match(L.parseFile('{"version":9,"layouts":[]}').error, /version 9/);
  const p = L.parseFile('{"version":1,"layouts":[{"name":" A "},{"name":"A"},{"name":""},null]}');
  assert.deepEqual(p.layouts.map((l) => l.name), ['A']);
});

test('old groups and positions become one device-only layout', () => {
  const s = L.fromOld({ groups: [group('g1', 'Accounts', ['users'])], hidden: ['x'] }, { users: { x: 5, y: 6 } });
  assert.equal(s.current, 'My layout');
  assert.equal(s.layouts.length, 1);
  assert.equal(s.layouts[0].groups[0].name, 'Accounts');
  assert.deepEqual(s.layouts[0].positions, { users: { x: 5, y: 6 } });
  assert.equal(L.isShared(s.layouts[0]), false);
  assert.deepEqual(L.normalizeState(null).layouts.map((l) => l.name), ['My layout']);
});

test('new, rename and delete layouts', () => {
  const s = L.normalizeState(null);
  L.currentLayout(s).groups.push(group('g1', 'A', ['t']));
  const copy = L.addLayout(s, 'My layout', L.currentLayout(s));
  assert.equal(copy.name, 'My layout 2');
  assert.equal(s.current, 'My layout 2');
  assert.deepEqual(copy.groups[0].tables, ['t']);
  copy.groups[0].tables.push('u');
  assert.deepEqual(L.byName(s.layouts, 'My layout').groups[0].tables, ['t'], 'a copy is independent');

  assert.equal(L.renameLayout(s, 'My layout 2', 'My layout'), false, 'name taken');
  assert.equal(L.renameLayout(s, 'My layout 2', 'Phone'), true);
  assert.equal(s.current, 'Phone');

  L.deleteLayout(s, 'Phone');
  assert.equal(s.current, 'My layout');
  L.deleteLayout(s, 'My layout');
  assert.deepEqual(s.layouts.map((l) => l.name), ['My layout'], 'always at least one');
  assert.deepEqual(s.layouts[0].groups, []);
});

test('merging: new layouts from the file are added, and a fresh device shows them', () => {
  const s = L.normalizeState(null);
  const r = L.mergeFromFile(s, [fileLayout('Main', [group('g1', 'A', ['t'])])]);
  assert.deepEqual(r.added, ['Main']);
  assert.equal(s.current, 'Main');
  const main = L.byName(s.layouts, 'Main');
  assert.equal(L.isShared(main), true);
  assert.equal(L.isDirty(main), false);
  assert.ok(L.byName(s.layouts, 'My layout'), 'the device layout is kept');
});

test('merging: a device that has groups stays on its own layout', () => {
  const s = L.normalizeState(null);
  L.currentLayout(s).groups.push(group('g1', 'Mine', []));
  L.mergeFromFile(s, [fileLayout('Main')]);
  assert.equal(s.current, 'My layout');
});

test('merging: the file updates a copy with no unsaved changes', () => {
  const s = L.normalizeState(null);
  L.mergeFromFile(s, [fileLayout('Main', [group('g1', 'A', ['t'])])]);
  const r = L.mergeFromFile(s, [fileLayout('Main', [group('g1', 'A', ['t', 'u'])])]);
  assert.deepEqual(r.updated, ['Main']);
  assert.deepEqual(L.byName(s.layouts, 'Main').groups[0].tables, ['t', 'u']);
  assert.equal(L.isDirty(L.byName(s.layouts, 'Main')), false);
});

test('merging: unsaved changes stay when the file has not changed', () => {
  const s = L.normalizeState(null);
  const f = fileLayout('Main', [group('g1', 'A', ['t'])]);
  L.mergeFromFile(s, [f]);
  L.byName(s.layouts, 'Main').positions.t = { x: 50, y: 50 };
  assert.equal(L.isDirty(L.byName(s.layouts, 'Main')), true);
  const r = L.mergeFromFile(s, [f]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(L.byName(s.layouts, 'Main').positions.t, { x: 50, y: 50 });
});

test('merging: changed in both places is a conflict, and both choices work', () => {
  const setup = () => {
    const s = L.normalizeState(null);
    L.mergeFromFile(s, [fileLayout('Main', [group('g1', 'A', ['t'])])]);
    s.current = 'Main';
    L.byName(s.layouts, 'Main').groups[0].tables.push('mine');
    return s;
  };
  const theirs = fileLayout('Main', [group('g1', 'A', ['t', 'theirs'])]);

  let s = setup();
  assert.deepEqual(L.mergeFromFile(s, [theirs]).conflicts, ['Main']);
  assert.deepEqual(L.byName(s.layouts, 'Main').groups[0].tables, ['t', 'mine'], 'left alone until resolved');
  L.resolveUseFile(s, theirs);
  assert.deepEqual(L.byName(s.layouts, 'Main').groups[0].tables, ['t', 'theirs']);
  assert.equal(L.isDirty(L.byName(s.layouts, 'Main')), false);

  s = setup();
  L.mergeFromFile(s, [theirs]);
  assert.equal(L.resolveRename(s, theirs, 'Main'), false, 'name taken');
  assert.equal(L.resolveRename(s, theirs, 'Main (this device)'), true);
  assert.equal(s.current, 'Main (this device)');
  const mine = L.byName(s.layouts, 'Main (this device)');
  assert.deepEqual(mine.groups[0].tables, ['t', 'mine']);
  assert.equal(L.isShared(mine), false);
  assert.deepEqual(L.byName(s.layouts, 'Main').groups[0].tables, ['t', 'theirs']);
});

test('merging: a device-only layout with the same name is a conflict unless identical', () => {
  const s = L.normalizeState(null);
  L.currentLayout(s).groups.push(group('g1', 'A', ['t']));
  assert.deepEqual(L.mergeFromFile(s, [fileLayout('My layout', [group('g1', 'A', ['x'])])]).conflicts, ['My layout']);
  const same = L.normalizeState(null);
  L.currentLayout(same).groups.push(group('g1', 'A', ['t']));
  assert.deepEqual(L.mergeFromFile(same, [fileLayout('My layout', [group('g1', 'A', ['t'])])]).conflicts, []);
  assert.equal(L.isShared(L.currentLayout(same)), true);
});

test('merging: a layout removed from the file stays here, on this device only', () => {
  const s = L.normalizeState(null);
  L.mergeFromFile(s, [fileLayout('Main')]);
  const r = L.mergeFromFile(s, []);
  assert.deepEqual(r.untied, ['Main']);
  assert.equal(L.isShared(L.byName(s.layouts, 'Main')), false);
});

test('saving adds or replaces one layout in the file and marks it saved', () => {
  const s = L.normalizeState(null);
  const mine = L.currentLayout(s);
  mine.groups.push(group('g1', 'A', ['t']));
  const file = [fileLayout('Other'), fileLayout('My layout')];
  const next = L.withLayout(file, mine);
  assert.deepEqual(next.map((l) => l.name), ['Other', 'My layout']);
  assert.deepEqual(next[1].groups[0].tables, ['t']);
  L.markSaved(mine);
  assert.equal(L.isShared(mine), true);
  assert.equal(L.isDirty(mine), false);
  assert.deepEqual(L.withoutLayout(next, 'Other').map((l) => l.name), ['My layout']);
  // Renaming makes it a new layout as far as the file is concerned.
  L.renameLayout(s, 'My layout', 'Renamed');
  assert.equal(L.isShared(mine), false);
});
