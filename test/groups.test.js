const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/groups.js');

test('creates, renames, recolours and deletes groups', () => {
  const v = G.emptyView();
  const a = G.createGroup(v, ' Products ');
  const b = G.createGroup(v, '');
  assert.equal(a.name, 'Products');
  assert.equal(b.name, 'Group 2');
  assert.notEqual(a.id, b.id);
  G.renameGroup(v, a.id, 'Catalog');
  G.renameGroup(v, a.id, '   ');
  assert.equal(a.name, 'Catalog');
  G.setGroupColor(v, a.id, 'g5');
  G.setGroupColor(v, a.id, 'red');
  assert.equal(a.color, 'g5');
  G.setMembership(v, a.id, 'products', true);
  G.setTableShown(v, 'products', false);
  G.deleteGroup(v, a.id);
  assert.deepEqual(v.groups.map((g) => g.id), [b.id]);
  assert.equal(G.isShown(v, 'products'), false, 'deleting a group leaves its tables as they were');
});

test('new groups take unused palette colours, then the least used', () => {
  const v = G.emptyView();
  const colors = G.PALETTE.map(() => G.createGroup(v).color);
  assert.deepEqual(colors, G.PALETTE);
  G.setGroupColor(v, v.groups[0].id, 'g2');
  assert.equal(G.createGroup(v).color, 'g1');
  const third = G.createGroup(v);
  assert.ok(G.PALETTE.includes(third.color));
  // Ids stay unique after a delete.
  G.deleteGroup(v, v.groups[1].id);
  const ids = v.groups.map((g) => g.id);
  ids.push(G.createGroup(v).id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a table can be in several groups', () => {
  const v = G.emptyView();
  const a = G.createGroup(v, 'A');
  const b = G.createGroup(v, 'B');
  G.setMembershipMany(v, a.id, ['users', 'logs'], true);
  G.setMembership(v, b.id, 'users', true);
  G.setMembership(v, b.id, 'users', true);
  assert.deepEqual(G.groupsOf(v, 'users').map((g) => g.name), ['A', 'B']);
  assert.deepEqual(G.groupsOf(v, 'logs').map((g) => g.name), ['A']);
  assert.deepEqual(b.tables, ['users']);
  G.setMembershipMany(v, a.id, ['users', 'logs'], false);
  assert.deepEqual(a.tables, []);
});

test('a group tick sets all its tables, and the last click wins', () => {
  const v = G.emptyView();
  const a = G.createGroup(v, 'A');
  const b = G.createGroup(v, 'B');
  G.setMembershipMany(v, a.id, ['users', 'logs'], true);
  G.setMembershipMany(v, b.id, ['users', 'photos'], true);
  assert.equal(G.groupState(v, a.id), 'on');

  G.setGroupShown(v, a.id, false);
  assert.equal(G.isShown(v, 'users'), false);
  assert.equal(G.isShown(v, 'logs'), false);
  assert.equal(G.groupState(v, a.id), 'off');
  assert.equal(G.groupState(v, b.id), 'mixed');

  G.setTableShown(v, 'logs', true);
  assert.equal(G.groupState(v, a.id), 'mixed');

  G.setGroupShown(v, b.id, true);
  assert.equal(G.isShown(v, 'users'), true);
  assert.equal(G.groupState(v, a.id), 'on');
});

test('select all and none act on the given tables only', () => {
  const v = G.emptyView();
  G.setTablesShown(v, ['a', 'b', 'c'], false);
  G.setTablesShown(v, ['a', 'b'], true);
  assert.deepEqual(v.hidden, ['c']);
});

test('group state ignores tables that are gone for now', () => {
  const v = G.emptyView();
  const a = G.createGroup(v, 'A');
  G.setMembershipMany(v, a.id, ['users', 'old'], true);
  G.setTableShown(v, 'old', false);
  assert.equal(G.groupState(v, a.id), 'mixed');
  assert.equal(G.groupState(v, a.id, new Set(['users'])), 'on');
  assert.equal(G.groupState(G.emptyView(), 'nope'), 'on');
});

test('normalize repairs stored views', () => {
  assert.deepEqual(G.normalize(null), { groups: [], hidden: [] });
  const v = G.normalize({
    hidden: ['a', 'a', 3],
    groups: [
      { id: 'g1', name: 'Ok', color: 'g3', tables: ['a', 'a'] },
      { id: 'g1', name: 'Duplicate id' },
      { name: 'No id' },
      { id: 'g2', name: '', color: '#fff' },
    ],
  });
  assert.deepEqual(v.hidden, ['a']);
  assert.deepEqual(v.groups, [
    { id: 'g1', name: 'Ok', color: 'g3', tables: ['a'] },
    { id: 'g2', name: 'Group', color: 'g1', tables: [] },
  ]);
});
