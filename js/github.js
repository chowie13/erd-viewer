/* Loads the .sql files in a GitHub repo folder: public repos without a token,
   private repos with a personal access token. Also reads and commits the folder's
   erd-layouts.json. Talks only to api.github.com (and raw.githubusercontent.com for
   public files).
   Works in the browser (window.ErdGitHub) and in Node (require). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ErdGitHub = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API = 'https://api.github.com';
  const RAW = 'https://raw.githubusercontent.com';
  const MAX_FILES = 500;
  const PARALLEL = 6;
  const LAYOUTS_FILE = 'erd-layouts.json';

  class GitHubError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status || 0;
    }
  }

  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const isSqlPath = (p) => /\.sql$/i.test(p) && !/(^|\/)(node_modules|\.git)\//.test(p);

  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  // Accepts github.com/owner/repo, .../tree/<branch>/<folder>, .../blob/<branch>/<file>,
  // owner/repo/<folder> (default branch), with or without https://.
  function parseGitHubUrl(input) {
    let s = String(input || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '');
    if (/^github\.com\//i.test(s)) s = s.slice('github.com/'.length);
    else if (/^[^/]*\.[^/]*\//.test(s)) return null; // some other website
    const segs = s.split('/').filter(Boolean).map(decode);
    if (segs.length < 2) return null;
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
    if (segs[2] === 'tree' || segs[2] === 'blob') {
      return { owner, repo, refPath: segs.slice(3), path: '', link: ['github.com', owner, repo, ...segs.slice(2)].join('/') };
    }
    const path = segs.slice(2).join('/');
    return { owner, repo, refPath: null, path, link: ['github.com', owner, repo, ...segs.slice(2)].join('/') };
  }

  function headers(token, accept) {
    const h = { Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  function apiError(res, token) {
    const status = res.status;
    if (status === 401) {
      return new GitHubError("GitHub didn't accept the token. It may have expired or been deleted. Create a new one and try again.", 401);
    }
    if ((status === 403 || status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const when = reset ? ' after ' + new Date(reset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ' later';
      return new GitHubError(
        token
          ? `GitHub's hourly request limit was reached. Try again${when}.`
          : `GitHub's hourly limit for requests without a token was reached. Add a token, or try again${when}.`,
        status
      );
    }
    if (status === 403 || status === 404 || status === 422) {
      return new GitHubError(
        token
          ? "Not found, or the token can't read it. Check the link, and that the token has access to this repo with Contents set to Read-only."
          : 'Not found. Check the link. If the repo is private, add a token.',
        status
      );
    }
    return new GitHubError(`GitHub returned an error (${status}). Try again in a moment.`, status);
  }

  // Saving needs write access, so its errors say so.
  function saveError(res, token) {
    const status = res.status;
    if (!token) return new GitHubError('Saving to GitHub needs a token with Contents set to Read and write.', status);
    if (status === 401) return apiError(res, token);
    if (status === 409 || (status === 422 && /sha/i.test(res.message || ''))) {
      return new GitHubError('The file changed on GitHub while saving. Try again.', 409);
    }
    if (status === 403 || status === 404) {
      if (res.headers.get('x-ratelimit-remaining') === '0') return apiError(res, token);
      return new GitHubError("The token can't save to this repo. Make a token for it with Contents set to Read and write.", status);
    }
    if (status === 422) return new GitHubError("GitHub refused the save. You can only save to a branch, not a tag or a commit.", status);
    return apiError(res, token);
  }

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function fetcher(opts) {
    const doFetch = opts.fetch || ((...args) => fetch(...args));
    return async (url, init) => {
      try {
        return await doFetch(url, init);
      } catch {
        throw new GitHubError("Couldn't reach GitHub. Check your internet connection.");
      }
    };
  }

  const contentsUrl = (where) =>
    `${API}/repos/${encodeURIComponent(where.owner)}/${encodeURIComponent(where.repo)}/contents/${encPath(where.path)}`;

  // The latest copy of one file on a branch: { sha, text }, or null if it isn't there.
  // where = { owner, repo, ref, path }.
  async function getFile(where, opts = {}) {
    const token = opts.token || null;
    const res = await fetcher(opts)(`${contentsUrl(where)}?ref=${encodeURIComponent(where.ref)}`, { headers: headers(token), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw apiError(res, token);
    const data = await res.json();
    return { sha: data.sha, text: fromBase64(data.content || '') };
  }

  // Commits one file to a branch. Pass the sha of the copy being replaced (none for a new
  // file); GitHub refuses if the file changed since. Returns { sha, commit }.
  async function saveFile(where, text, message, opts = {}) {
    const token = opts.token || null;
    if (!token) throw saveError({ status: 0, headers: { get: () => null } }, null);
    const body = { message, content: toBase64(text), branch: where.ref };
    if (where.sha) body.sha = where.sha;
    const res = await fetcher(opts)(contentsUrl(where), {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = '';
      try {
        msg = (await res.json()).message || '';
      } catch {
        // no body
      }
      throw saveError({ status: res.status, headers: res.headers, message: msg }, token);
    }
    const data = await res.json();
    return { sha: data.content && data.content.sha, commit: data.commit && data.commit.sha };
  }

  // A link like /tree/feature/login/db is ambiguous: the branch could be "feature" or
  // "feature/login". Ask GitHub which branches or tags exist and take the longest match.
  async function resolveRef(call, repoPath, segs) {
    const joined = segs.join('/');
    for (const kind of ['heads', 'tags']) {
      let list = [];
      try {
        list = await (await call(`${repoPath}/git/matching-refs/${kind}/${encPath(segs[0])}`)).json();
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      const names = (Array.isArray(list) ? list : []).map((x) => x.ref.replace(/^refs\/(heads|tags)\//, ''));
      const match = names.filter((n) => joined === n || joined.startsWith(n + '/')).sort((a, b) => b.length - a.length)[0];
      if (match) return { ref: match, path: joined.slice(match.length + 1) };
    }
    return { ref: segs[0], path: segs.slice(1).join('/') }; // a commit SHA, or let GitHub report it
  }

  // Returns { name, link, ref, sha, files: [{ path, text }], truncated }.
  async function loadFolder(input, opts = {}) {
    const loc = parseGitHubUrl(input);
    if (!loc) throw new GitHubError("That isn't a GitHub repo link. Use github.com/owner/repo, or a folder link copied from GitHub.");
    const token = opts.token || null;
    const doFetch = opts.fetch || ((...args) => fetch(...args));
    const progress = opts.onProgress || (() => {});

    async function get(url, init) {
      let res;
      try {
        res = await doFetch(url, init);
      } catch {
        throw new GitHubError("Couldn't reach GitHub. Check your internet connection.");
      }
      if (!res.ok) throw apiError(res, token);
      return res;
    }
    const call = (path, accept) => get(API + path, { headers: headers(token, accept) });

    const repoPath = `/repos/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}`;
    let ref;
    let folder;
    if (loc.refPath && loc.refPath.length) {
      ({ ref, path: folder } = await resolveRef(call, repoPath, loc.refPath));
    } else {
      ref = (await (await call(repoPath)).json()).default_branch;
      folder = loc.path;
    }
    folder = folder.replace(/^\/+|\/+$/g, '');

    const commit = await (await call(`${repoPath}/commits/${encPath(ref)}`)).json();
    const tree = await (await call(`${repoPath}/git/trees/${commit.commit.tree.sha}?recursive=1`)).json();
    const inFolder = (p) => !folder || p === folder || p.startsWith(folder + '/');
    const entries = tree.tree || [];
    if (folder && !entries.some((e) => inFolder(e.path))) {
      throw new GitHubError(`There's no "${folder}" on ${ref} in ${loc.owner}/${loc.repo}.`, 404);
    }
    const blobs = entries.filter((e) => e.type === 'blob' && inFolder(e.path) && isSqlPath(e.path));
    const layoutsPath = folder ? `${folder}/${LAYOUTS_FILE}` : LAYOUTS_FILE;
    const layoutsEntry = entries.find((e) => e.type === 'blob' && e.path === layoutsPath);
    if (!blobs.length) throw new GitHubError(`No .sql files in ${loc.owner}/${loc.repo}${folder ? '/' + folder : ''} on ${ref}.`);
    if (blobs.length > MAX_FILES) {
      throw new GitHubError(`That folder has ${blobs.length} .sql files, more than the ${MAX_FILES} this can open. Link to a smaller folder, such as the migrations folder.`);
    }

    // Public files come from raw.githubusercontent.com, which doesn't count against
    // GitHub's hourly limit. With a token, files come through the API so private repos work.
    const fetchText = (path) =>
      token
        ? call(`${repoPath}/contents/${encPath(path)}?ref=${commit.sha}`, 'application/vnd.github.raw+json').then((r) => r.text())
        : get(`${RAW}/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}/${commit.sha}/${encPath(path)}`).then((r) => r.text());

    const files = new Array(blobs.length);
    let next = 0;
    let done = 0;
    progress(0, blobs.length);
    async function worker() {
      while (next < blobs.length) {
        const i = next++;
        const full = blobs[i].path;
        const rel = !folder ? full : full === folder ? full.split('/').pop() : full.slice(folder.length + 1);
        files[i] = { path: rel, text: await fetchText(full) };
        progress(++done, blobs.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, blobs.length) }, worker));
    const layoutsFile = layoutsEntry ? { path: layoutsPath, sha: layoutsEntry.sha, text: await fetchText(layoutsPath) } : null;

    return {
      name: `${loc.owner}/${loc.repo}${folder ? '/' + folder : ''}`,
      link: loc.link,
      ref,
      sha: commit.sha,
      files,
      truncated: !!tree.truncated,
      owner: loc.owner,
      repo: loc.repo,
      folder,
      layoutsPath,
      layoutsFile,
    };
  }

  return { loadFolder, getFile, saveFile, parseGitHubUrl, GitHubError, LAYOUTS_FILE };
});
