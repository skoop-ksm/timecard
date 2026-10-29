#!/usr/bin/env node
// Timecard web server: a small JSON API plus static files. No dependencies.
//
//   PORT            listen port (default 8787)
//   HOST            bind address (default 127.0.0.1; use 0.0.0.0 in a container)
//   DATA_DIR        where timecard.json lives (default ./data next to this file)
//   TIMECARD_TOKEN  if set, POST /api/punch requires "Authorization: Bearer <token>"
//                   (for Shortcuts / curl punching that bypasses your SSO front door)

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { Store, ValidationError } from './lib/store.js';
import { snap } from './shared/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(here, 'data');
const TOKEN = process.env.TIMECARD_TOKEN || '';
const MAX_BODY = 1_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STATIC_ROOTS = [
  { prefix: '/shared/', dir: path.join(here, 'shared') },
  { prefix: '/', dir: path.join(here, 'public') },
];

export async function createServer({ dataFile = path.join(DATA_DIR, 'timecard.json') } = {}) {
  const store = await new Store(dataFile).load();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, store);
      else await serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err instanceof ValidationError ? err.status : err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: status >= 500 ? 'Internal error' : err.message });
    }
  });
  server.store = store;
  return server;
}

// API -------------------------------------------------------------------

async function handleApi(req, res, url, store) {
  const { method } = req;
  const p = url.pathname;
  res.setHeader('Cache-Control', 'no-store');

  if (p === '/api/state' && method === 'GET') {
    return sendJson(res, 200, { now: Date.now(), settings: store.getSettings(), entries: store.listEntries() });
  }
  if (p === '/api/entries' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 201, await store.insertEntry({ start: body.start, stop: body.stop ?? null }));
  }
  const entryMatch = p.match(/^\/api\/entries\/(\d+)$/);
  if (entryMatch) {
    const id = Number(entryMatch[1]);
    if (method === 'PATCH') {
      const body = await readJson(req);
      const patch = {};
      if ('start' in body) patch.start = body.start;
      if ('stop' in body) patch.stop = body.stop;
      return sendJson(res, 200, await store.updateEntry(id, patch));
    }
    if (method === 'DELETE') {
      await store.deleteEntry(id);
      res.writeHead(204).end();
      return;
    }
  }
  if (p === '/api/settings') {
    if (method === 'GET') return sendJson(res, 200, store.getSettings());
    if (method === 'PUT' || method === 'PATCH') return sendJson(res, 200, await store.updateSettings(await readJson(req)));
  }
  if (p === '/api/punch' && method === 'POST') {
    // Convenience endpoint for Shortcuts, Siri via Shortcuts, curl, scripts.
    // { "action": "in" | "out" | "toggle", "at"?: ms }. Rounds on the server's clock.
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      throw new ValidationError('Unauthorized', 401);
    }
    const body = await readJson(req);
    const { roundingMinutes } = store.getSettings();
    const running = store.runningEntry();
    let action = body.action || 'toggle';
    if (action === 'toggle') action = running ? 'out' : 'in';
    const at = Number.isInteger(body.at) ? body.at : Date.now();
    if (action === 'in') {
      if (running) throw new ValidationError('Already punched in.', 409);
      return sendJson(res, 201, { action, entry: await store.insertEntry({ start: snap(at, roundingMinutes, 'down') }) });
    }
    if (action === 'out') {
      if (!running) throw new ValidationError('Not punched in.', 409);
      let stop = snap(at, roundingMinutes, 'up');
      if (stop <= running.start) stop = running.start + Math.max(roundingMinutes, 1) * 60_000;
      return sendJson(res, 200, { action, entry: await store.updateEntry(running.id, { stop }) });
    }
    throw new ValidationError('action must be in, out or toggle.');
  }
  if (p === '/api/backup' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="timecard-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    return res.end(JSON.stringify(store.data, null, 1));
  }
  throw new ValidationError('Not found', 404);
}

// Static files ----------------------------------------------------------

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new ValidationError('Method not allowed', 405);
  if (pathname === '/') pathname = '/index.html';
  for (const root of STATIC_ROOTS) {
    if (!pathname.startsWith(root.prefix)) continue;
    const rel = decodeURIComponent(pathname.slice(root.prefix.length));
    const file = path.normalize(path.join(root.dir, rel));
    if (!file.startsWith(root.dir + path.sep)) throw new ValidationError('Not found', 404);
    let body;
    try {
      body = await fs.readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') continue;
      throw err;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  throw new ValidationError('Not found', 404);
}

// Helpers ---------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ValidationError('Body too large', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== 'object') throw new Error();
        resolve(v);
      } catch {
        reject(new ValidationError('Body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

// Main ------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().then((server) => {
    server.listen(PORT, HOST, () => {
      console.log(`Timecard listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
