#!/usr/bin/env node
'use strict';
/* Taste Genome server: serves the web app and proxies TMDB so your API key never reaches the browser.
   Zero dependencies. Needs Node 18 or newer.  Run:  node server.js  */
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
// Works both with the usual folders (lib/, public/) and flat, with every file in one folder (easier to upload).
let tmdbMod; try { tmdbMod = require('./lib/tmdb'); } catch (e) { tmdbMod = require('./tmdb'); }
const { Tmdb, TmdbError, publicFilm, kindOf } = tmdbMod;
const FLAT_FILES = new Set(['index.html', 'engine.js', 'tmdb-core.js']);

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (e) { /* no .env file */ }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function createServer(config = {}) {
  const publicDir = config.publicDir || (fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname);
  const flat = publicDir === __dirname;   // flat layout: only serve the three page files, never server code or .env
  const tmdb = config.tmdb || new Tmdb({
    key: config.key, token: config.token, base: config.base,
    cachePath: config.cachePath === undefined ? path.join(__dirname, '.tmdb-cache.json') : config.cachePath,
  });

  // Public hosting: optional CORS (ALLOWED_ORIGIN) and a per-IP rate limit so one visitor cannot burn the shared TMDB quota.
  const allowed = config.allowedOrigin || '';
  const limit = config.rateLimit === undefined ? 240 : config.rateLimit;   // API requests per IP per minute; 0 = off
  const hits = new Map();
  const tooMany = (req) => {
    if (!limit) return false;
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now(); let h = hits.get(ip);
    if (!h || now - h.t > 60000) { h = { t: now, n: 0 }; hits.set(ip, h); }
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > 60000) hits.delete(k);
    return ++h.n > limit;
  };
  const cors = (req, res) => {
    if (!allowed) return;
    const o = req.headers.origin;
    if (allowed === '*' || (o && allowed.split(',').map((x) => x.trim()).includes(o))) {
      res.setHeader('access-control-allow-origin', allowed === '*' ? '*' : o);
      res.setHeader('vary', 'Origin, accept-encoding');
    }
  };

  const json = (res, code, body, req) => {
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding' };
    if (req && text.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {   // candidate pools are large and compress ~10x
      headers['content-encoding'] = 'gzip';
      res.writeHead(code, headers);
      return res.end(zlib.gzipSync(text));
    }
    res.writeHead(code, headers);
    res.end(text);
  };
  const fail = (res, e) => {
    const status = e instanceof TmdbError && e.status >= 400 && e.status < 600 ? (e.status === 401 ? 502 : e.status) : 502;
    json(res, status, { error: e.message || 'Unexpected error.', code: e.status || 0 });
  };

  async function api(url, res, req) {
    if (url.pathname === '/api/status') return json(res, 200, { configured: tmdb.configured });
    if (!tmdb.configured) return json(res, 503, { error: 'No TMDB API key. Add TMDB_API_KEY (or TMDB_READ_TOKEN) to the .env file and restart.', code: 'no-key' });

    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { results: [] });
      return json(res, 200, { results: await tmdb.search(q, kindOf(url.searchParams.get('kind'))) });
    }
    const m = url.pathname.match(/^\/api\/(movie|tv)\/(\d{1,9})$/);
    if (m) return json(res, 200, { film: publicFilm(await tmdb.details(m[2], m[1])) });

    if (url.pathname === '/api/pool') {
      const ids = (url.searchParams.get('seeds') || '').split(',').filter((s) => /^\d{1,9}$/.test(s)).map(Number);
      const unique = [...new Set(ids)];
      if (unique.length < 1 || unique.length > 8) return json(res, 400, { error: 'Provide 1 to 8 numeric seed ids.' });
      const films = await tmdb.pool(unique, { kind: kindOf(url.searchParams.get('kind')) });
      return json(res, 200, { films: films.map(publicFilm) }, req);
    }
    return json(res, 404, { error: 'Unknown API route.' });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' }); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      if (url.pathname.startsWith('/api/') && tooMany(req)) return json(res, 429, { error: 'Too many requests. Please wait a moment.', code: 429 });
      if (url.pathname.startsWith('/api/')) return await api(url, res, req);
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (flat && !FLAT_FILES.has(rel)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
      const file = path.resolve(publicDir, rel);
      if (file !== publicDir && !file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    } catch (e) { fail(res, e); }
  });
}

if (require.main === module) {
  loadDotEnv(path.join(__dirname, '.env'));
  const port = parseInt(process.env.PORT, 10) || 3000;
  // Local only by default. Hosting platforms set PORT, so listen on all interfaces there (the rate limit protects the key).
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const server = createServer({ key: process.env.TMDB_API_KEY, token: process.env.TMDB_READ_TOKEN, base: process.env.TMDB_BASE,
    allowedOrigin: process.env.ALLOWED_ORIGIN, rateLimit: process.env.RATE_LIMIT === undefined ? undefined : Number(process.env.RATE_LIMIT),
    cachePath: process.env.CACHE_PATH || undefined });
  server.listen(port, host, () => {
    const ok = !!(process.env.TMDB_API_KEY || process.env.TMDB_READ_TOKEN);
    console.log(`DOMEVO running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (!ok) console.log('No TMDB key found. Copy .env.example to .env, add your key, and restart.');
  });
}

module.exports = { createServer, loadDotEnv };
