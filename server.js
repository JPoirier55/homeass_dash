// Zero-dependency server: serves the dashboard and proxies a small allowlist of
// Home Assistant REST endpoints so the long-lived token never reaches the browser.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const HA_URL = (process.env.HA_URL || '').replace(/\/+$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

if (!HA_URL || !HA_TOKEN) {
  console.error('Missing HA_URL or HA_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Only these calls are forwarded to Home Assistant.
const ALLOWED = [
  { method: 'GET', re: /^\/api\/states$/ },
  { method: 'GET', re: /^\/api\/history\/period\/[^/]+$/ },
  { method: 'POST', re: /^\/api\/template$/ }, // used to look up each light's area
  { method: 'POST', re: /^\/api\/services\/(light|switch)\/(turn_on|turn_off|toggle)$/ },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function proxy(req, res, url) {
  const rule = ALLOWED.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!rule) return send(res, 403, 'Not allowed');
  try {
    const upstream = await fetch(HA_URL + url.pathname + url.search, {
      method: req.method,
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
      body: req.method === 'POST' ? await readBody(req) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    send(res, upstream.status, Buffer.from(await upstream.arrayBuffer()),
      upstream.headers.get('content-type') || 'application/json');
  } catch (err) {
    send(res, 502, JSON.stringify({ message: `Home Assistant unreachable: ${err.message}` }),
      MIME['.json']);
  }
}

async function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  // config.json lives at the project root so it can stay out of git.
  const file = pathname === '/config.json'
    ? join(ROOT, 'config.json')
    : normalize(join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC) && file !== join(ROOT, 'config.json')) return send(res, 403, 'Forbidden');
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found');
  }
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url);
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  return serveStatic(res, url.pathname);
}).listen(PORT, HOST, () => {
  console.log(`HOMELAB dashboard on http://${HOST}:${PORT}  →  ${HA_URL}`);
});
