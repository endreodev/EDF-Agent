const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { DATA_DIR } = require('./store');

// Preview público temporário: sobe o site do projeto numa porta local e abre um túnel do Cloudflare
// (https://<aleatório>.trycloudflare.com). Arquivos ocultos (.env, .git…) nunca são servidos.
const previews = new Map(); // projeto -> { port, url, server, procs, timer, started }

const BLOCKED = /(^|[\\/])\.|\.(env|sql|log|bak|ini|sqlite|db)$/i;
const ROUTER = path.join(DATA_DIR, 'preview-router.php');
fs.writeFileSync(
  ROUTER,
  `<?php
$p = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/');
if (preg_match('#(^|/)\\.#', $p) || preg_match('#\\.(env|sql|log|bak|ini|sqlite|db)$#i', $p)) { http_response_code(404); echo 'Not found'; return true; }
return false;
`,
  'utf8'
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function waitPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > until) resolve(false);
        else setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });
}

// Servidor estático simples (sites sem PHP e sem comando de preview).
function staticServer(root, port) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (BLOCKED.test(rel)) return res.writeHead(404).end('Not found');
    let file = path.join(root, rel);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function cloudflaredPath(config) {
  if (config.cloudflaredPath) return config.cloudflaredPath;
  for (const dir of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    const f = dir && path.join(dir, 'cloudflared', 'cloudflared.exe');
    if (f && fs.existsSync(f)) return f;
  }
  return 'cloudflared';
}

// Abre o túnel e espera o endereço público.
function openTunnel(config, port) {
  return new Promise((resolve) => {
    const child = spawn(cloudflaredPath(config), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => resolve({ child, error: 'o túnel não respondeu em 60 s' }), 60000);
    const onData = (d) => {
      out += d;
      const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[0] });
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ child: null, error: err.code === 'ENOENT' ? 'cloudflared não está instalado (winget install Cloudflare.cloudflared)' : err.message });
    });
  });
}

/**
 * Inicia o preview do projeto. Com `port`, só abre o túnel para um servidor que já está rodando.
 * Retorna { ok, url, port, how } ou { ok: false, error }.
 */
async function start(project, config, { port } = {}) {
  const old = previews.get(project.name);
  if (old) return { ok: true, url: old.url, port: old.port, how: old.how, existing: true };
  const procs = [];
  let server = null;
  let how = 'servidor já em execução';
  try {
    if (!port) {
      port = await freePort();
      const dir = project.path;
      if (project.previewCommand) {
        how = project.previewCommand;
        procs.push(spawn(project.previewCommand.replace(/\{port\}/g, port), { cwd: dir, shell: true, windowsHide: true }));
      } else if (fs.readdirSync(dir).some((f) => f.endsWith('.php'))) {
        how = 'PHP';
        procs.push(spawn(config.phpPath || 'php', ['-S', `127.0.0.1:${port}`, '-t', dir, ROUTER], { cwd: dir, windowsHide: true }));
      } else {
        how = 'arquivos estáticos';
        server = await staticServer(path.resolve(dir), port);
      }
      for (const p of procs) p.on('error', () => {});
      if (!(await waitPort(port, 45000))) throw new Error(`o site não subiu na porta ${port} (${how})`);
    } else if (!(await waitPort(port, 3000))) {
      throw new Error(`nada respondendo na porta ${port}`);
    }
    const t = await openTunnel(config, port);
    if (t.child) procs.push(t.child);
    if (!t.url) throw new Error(t.error);
    const hours = Number(config.previewHours) || 2;
    const entry = { port, url: t.url, server, procs, how, started: Date.now() };
    entry.timer = setTimeout(() => stop(project.name), hours * 3600000);
    previews.set(project.name, entry);
    return { ok: true, url: t.url, port, how, hours };
  } catch (err) {
    procs.forEach(killTree);
    server?.close();
    return { ok: false, error: err.message };
  }
}

function stop(name) {
  const p = previews.get(name);
  if (!p) return false;
  clearTimeout(p.timer);
  p.procs.forEach(killTree);
  p.server?.close();
  previews.delete(name);
  return true;
}

function stopAll() {
  for (const name of [...previews.keys()]) stop(name);
}

function list() {
  return [...previews].map(([name, p]) => ({ name, url: p.url, port: p.port, started: p.started }));
}

module.exports = { start, stop, stopAll, list };
