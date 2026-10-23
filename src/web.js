const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { resolveUpload } = require('./media');

const PAGE = path.join(__dirname, 'panel.html');

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

/**
 * Painel web local. `ctx` fornece:
 *  getState(), sendTask(text), cancel(all), addProject(name, dir, aliases),
 *  removeProject(name), useProject(name), newSession(name)
 */
function startWeb(ctx, port, log) {
  let qrCache = { raw: null, img: null };

  const server = http.createServer(async (req, res) => {
    // Só aceita requisições locais com Host local (evita acesso de outros sites via DNS rebinding).
    const host = String(req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'host não permitido' });

    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(PAGE));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = ctx.getState();
        if (state.qr && state.qr !== qrCache.raw) {
          qrCache = { raw: state.qr, img: await QRCode.toDataURL(state.qr, { margin: 1, width: 280 }) };
        }
        return json(res, 200, { ...state, qr: state.qr ? qrCache.img : null });
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
          return json(res, 200, await ctx.sendTask(String(body.text || '').trim(), files));
        }
        case '/api/cancel':
          return json(res, 200, ctx.cancel(!!body.all));
        case '/api/projects':
          return json(res, 200, ctx.addProject(body.name, body.path, body.aliases || [], body));
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
