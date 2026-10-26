const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFolder, parseGitHubUrl, GitHubError } = require('../js/github.js');

// A fake GitHub: `routes` maps a URL (without https://) to a JSON body or a text body.
function fakeGitHub(routes, opts = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, auth: (init.headers || {}).Authorization || null });
    const key = url.replace(/^https:\/\//, '');
    if (opts.status) return response(opts.status, '', opts.headers);
    if (!(key in routes)) return response(404, '{"message":"Not Found"}');
    const body = routes[key];
    return response(200, typeof body === 'string' ? body : JSON.stringify(body));
  };
  return { fetch, calls };
}

function response(status, text, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

const TREE = {
  tree: [
    { path: 'README.md', type: 'blob' },
    { path: 'db', type: 'tree' },
    { path: 'db/migrations', type: 'tree' },
    { path: 'db/migrations/0001_init.sql', type: 'blob' },
    { path: 'db/migrations/0002_more.sql', type: 'blob' },
    { path: 'db/seed.sql', type: 'blob' },
    { path: 'node_modules/x/schema.sql', type: 'blob' },
  ],
  truncated: false,
};

const API = 'api.github.com/repos/greg/shop';

test('reads GitHub links', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/greg/shop'), { owner: 'greg', repo: 'shop', refPath: null, path: '', link: 'github.com/greg/shop' });
  assert.deepEqual(parseGitHubUrl('github.com/greg/shop/tree/main/db/migrations').refPath, ['main', 'db', 'migrations']);
  assert.equal(parseGitHubUrl('greg/shop/db').path, 'db');
  assert.equal(parseGitHubUrl('https://github.com/greg/shop.git').repo, 'shop');
  assert.equal(parseGitHubUrl('https://github.com/greg/shop?tab=readme#x').link, 'github.com/greg/shop');
  assert.equal(parseGitHubUrl('https://gitlab.com/greg/shop'), null);
  assert.equal(parseGitHubUrl('just-words'), null);
});

test('loads a public folder from the default branch without a token', async () => {
  const gh = fakeGitHub({
    [API]: { default_branch: 'main' },
    [`${API}/commits/main`]: { sha: 'abc123', commit: { tree: { sha: 'tree1' } } },
    [`${API}/git/trees/tree1?recursive=1`]: TREE,
    'raw.githubusercontent.com/greg/shop/abc123/db/migrations/0001_init.sql': 'CREATE TABLE a (id int);',
    'raw.githubusercontent.com/greg/shop/abc123/db/migrations/0002_more.sql': 'CREATE TABLE b (id int);',
    'raw.githubusercontent.com/greg/shop/abc123/db/seed.sql': 'INSERT INTO a VALUES (1);',
  });
  const progress = [];
  const result = await loadFolder('github.com/greg/shop/db', { fetch: gh.fetch, onProgress: (d, n) => progress.push(`${d}/${n}`) });
  assert.equal(result.name, 'greg/shop/db');
  assert.equal(result.ref, 'main');
  assert.deepEqual(result.files.map((f) => f.path), ['migrations/0001_init.sql', 'migrations/0002_more.sql', 'seed.sql']);
  assert.equal(result.files[2].text, 'INSERT INTO a VALUES (1);');
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
  assert.ok(gh.calls.every((c) => c.auth === null));
});

test('loads a private folder on a branch with a slash, using the token', async () => {
  const gh = fakeGitHub({
    [`${API}/git/matching-refs/heads/feature`]: [{ ref: 'refs/heads/feature' }, { ref: 'refs/heads/feature/login' }],
    [`${API}/commits/feature/login`]: { sha: 'def456', commit: { tree: { sha: 'tree2' } } },
    [`${API}/git/trees/tree2?recursive=1`]: TREE,
    [`${API}/contents/db/migrations/0001_init.sql?ref=def456`]: 'CREATE TABLE a (id int);',
    [`${API}/contents/db/migrations/0002_more.sql?ref=def456`]: 'CREATE TABLE b (id int);',
  });
  const result = await loadFolder('https://github.com/greg/shop/tree/feature/login/db/migrations', { fetch: gh.fetch, token: 'secret' });
  assert.equal(result.ref, 'feature/login');
  assert.deepEqual(result.files.map((f) => f.path), ['0001_init.sql', '0002_more.sql']);
  assert.ok(gh.calls.every((c) => c.auth === 'Bearer secret'));
  assert.ok(gh.calls.every((c) => c.url.startsWith('https://api.github.com/')));
});

test('explains problems in plain words', async () => {
  const notFound = fakeGitHub({});
  await assert.rejects(loadFolder('github.com/greg/secret', { fetch: notFound.fetch }), /If the repo is private, add a token/);
  await assert.rejects(loadFolder('github.com/greg/secret', { fetch: notFound.fetch, token: 't' }), /token can't read it/);

  const badToken = fakeGitHub({}, { status: 401 });
  await assert.rejects(loadFolder('github.com/greg/shop', { fetch: badToken.fetch, token: 'old' }), /didn't accept the token/);

  const limited = fakeGitHub({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' } });
  await assert.rejects(loadFolder('github.com/greg/shop', { fetch: limited.fetch }), /hourly limit .* Add a token/);

  const routes = {
    [API]: { default_branch: 'main' },
    [`${API}/commits/main`]: { sha: 'abc', commit: { tree: { sha: 't' } } },
    [`${API}/git/trees/t?recursive=1`]: TREE,
  };
  await assert.rejects(loadFolder('greg/shop/docs', { fetch: fakeGitHub(routes).fetch }), /There's no "docs" on main/);

  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(loadFolder('greg/shop', { fetch: offline }), /Couldn't reach GitHub/);
  await assert.rejects(loadFolder('not a link'), GitHubError);
});
