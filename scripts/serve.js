// Serves the viewer at http://localhost:4000 (npm start). Opening index.html directly also works.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT) || 4000;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      urlPath = '/';
    }
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || /(^|[\\/])(\.|node_modules)/.test(rel)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`ERD Viewer: http://localhost:${port}`));
