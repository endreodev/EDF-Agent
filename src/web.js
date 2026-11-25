const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { resolveUpload } = require('./media');

const PAGE = path.join(__dirname, 'panel.html');
const DASH = path.join(__dirname, 'dashboard.html');
const NM = path.join(__dirname, '..', 'node_modules');
// Arquivos do Bootstrap servidos localmente (o painel funciona sem internet).
const VENDOR = {
  'bootstrap.min.css': [path.join(NM, 'bootstrap/dist/css/bootstrap.min.css'), 'text/css'],
  'bootstrap.bundle.min.js': [path.join(NM, 'bootstrap/dist/js/bootstrap.bundle.min.js'), 'text/javascript'],
  'bootstrap-icons.min.css': [path.join(NM, 'bootstrap-icons/font/bootstrap-icons.min.css'), 'text/css'],
  'fonts/bootstrap-icons.woff2': [path.join(NM, 'bootstrap-icons/font/fonts/bootstrap-icons.woff2'), 'font/woff2'],
  'fonts/bootstrap-icons.woff': [path.join(NM, 'bootstrap-icons/font/fonts/bootstrap-icons.woff'), 'font/woff'],
};
const HIDDEN_DIRS = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information', '$WinREAgent']);

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 60e6) req.destroy(); // anexos vêm em base64
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function listDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(d)) out.push({ name: d, path: d });
  }
  return out;
}

// Subpastas de `dir` para o seletor de pastas do painel (sem `dir`: unidades do Windows).
function browse(dir) {
  const home = os.homedir();
  if (!dir) return { ok: true, path: '', parent: null, home, dirs: process.platform === 'win32' ? listDrives() : [{ name: '/', path: '/' }] };
  const abs = path.resolve(dir);
  try {
    const dirs = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !HIDDEN_DIRS.has(e.name))
      .map((e) => ({ name: e.name, path: path.join(abs, e.name), git: fs.existsSync(path.join(abs, e.name, '.git')) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
    const parent = path.dirname(abs) === abs ? '' : path.dirname(abs);
    return { ok: true, path: abs, parent, home, isGit: fs.existsSync(path.join(abs, '.git')), dirs };
  } catch (err) {
    return { ok: false, error: `Não consegui abrir ${abs}: ${err.code || err.message}` };
  }
}

/**
 * Painel web local. `ctx` fornece:
 *  getState(), dashboard(), resolvePending(kind, id, accept), sendTask(text, files, project), cancel(all, project), addProject(name, dir, aliases, extra),
 *  cloneProject(repo, name), listRepos(), createGroup(name), gitAction(name, action), removeSchedule(id),
 *  removeProject(name), useProject(name), newSession(name), addSender(...), removeSender(number)
 */
function startWeb(ctx, port, log) {
  let qrCache = { raw: null, img: null };

  const server = http.createServer(async (req, res) => {
    // Só aceita requisições locais com Host local (evita acesso de outros sites via DNS rebinding).
    const host = String(req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'host não permitido' });

    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/painel')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(url.pathname === '/' ? DASH : PAGE));
      }
      if (req.method === 'GET' && url.pathname === '/tema.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'tema.css')));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
        const v = VENDOR[url.pathname.slice('/vendor/'.length)];
        if (!v || !fs.existsSync(v[0])) return json(res, 404, { error: 'rode npm install' });
        res.writeHead(200, { 'Content-Type': v[1], 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(v[0]).pipe(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = ctx.getState();
        if (state.qr && state.qr !== qrCache.raw) {
          qrCache = { raw: state.qr, img: await QRCode.toDataURL(state.qr, { margin: 1, width: 280 }) };
        }
        return json(res, 200, { ...state, qr: state.qr ? qrCache.img : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        return json(res, 200, ctx.dashboard());
      }
      if (req.method === 'GET' && url.pathname === '/api/chat') {
        const jid = url.searchParams.get('jid') || '';
        return json(res, 200, { ok: true, messages: ctx.chatMessages(jid, Number(url.searchParams.get('after')) || 0) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        const up = resolveUpload(decodeURIComponent(url.pathname.slice('/uploads/'.length)));
        if (!up) return json(res, 404, { error: 'arquivo não encontrado' });
        res.writeHead(200, { 'Content-Type': up.mimetype, 'Cache-Control': 'private, max-age=86400' });
        return fs.createReadStream(up.file).pipe(res);
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'não encontrado' });

      // POST só com JSON (bloqueia formulários de outros sites).
      if (!String(req.headers['content-type'] || '').includes('application/json')) {
        return json(res, 415, { error: 'use application/json' });
      }
      const body = await readBody(req);
      switch (url.pathname) {
        case '/api/task': {
          const files = Array.isArray(body.files) ? body.files.slice(0, 10) : [];
          if (!String(body.text || '').trim() && !files.length) return json(res, 400, { error: 'mensagem vazia' });
          return json(res, 200, await ctx.sendTask(String(body.text || '').trim(), files, body.project || null, body.jid ? String(body.jid) : null));
        }
        case '/api/cancel':
          return json(res, 200, ctx.cancel(!!body.all, body.project || null));
        case '/api/browse':
          return json(res, 200, browse(body.path));
        case '/api/projects':
          return json(res, 200, await ctx.addProject(body.name, body.path, body.aliases || [], body));
        case '/api/projects/clone':
          return json(res, 200, await ctx.cloneProject(body.repo, body.name));
        case '/api/projects/group':
          return json(res, 200, await ctx.createGroup(body.name));
        case '/api/projects/git':
          return json(res, 200, await ctx.gitAction(body.name, body.action));
        case '/api/github/repos':
          return json(res, 200, await ctx.listRepos(body.owner || ''));
        case '/api/github':
          return json(res, 200, { ok: true, ...(await ctx.github()) });
        case '/api/github/login':
          return json(res, 200, { ok: true, ...ctx.githubLogin() });
        case '/api/github/login/cancel':
          return json(res, 200, { ok: true, ...ctx.githubCancel() });
        case '/api/github/logout':
          return json(res, 200, await ctx.githubLogout());
        case '/api/whatsapp/blocklist':
          return json(res, 200, await ctx.whatsappBlocklist());
        case '/api/whatsapp/unblock':
          return json(res, 200, await ctx.whatsappUnblock(String(body.jid || '')));
        case '/api/autodelete':
          return json(res, 200, await ctx.setAutoDelete(body.number, body.enabled !== false));
        case '/api/pending':
          return json(res, 200, await ctx.resolvePending(String(body.kind || ''), String(body.id || ''), body.accept !== false));
        case '/api/schedules/remove':
          return json(res, 200, ctx.removeSchedule(body.id));
        case '/api/senders':
          return json(res, 200, ctx.addSender(body.number, body.name, body.ids));
        case '/api/senders/remove':
          return json(res, 200, ctx.removeSender(body.number));
        case '/api/projects/remove':
          return json(res, 200, ctx.removeProject(body.name));
        case '/api/projects/use':
          return json(res, 200, ctx.useProject(body.name));
        case '/api/projects/new':
          return json(res, 200, ctx.newSession(body.name));
        default:
          return json(res, 404, { error: 'não encontrado' });
      }
    } catch (err) {
      log('Erro no painel:', err);
      return json(res, 500, { error: err.message });
    }
  });

  server.on('error', (err) => log(`Painel web não iniciou na porta ${port}: ${err.message}`));
  server.listen(port, '127.0.0.1', () => log(`🖥️  Painel: http://localhost:${port}`));
  return server;
}

module.exports = { startWeb };
