const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  downloadMediaMessage,
  Browsers,
} = require('@whiskeysockets/baileys');
const { config, saveConfig, projects, normalize, DATA_DIR } = require('./store');
const { runClaude } = require('./claude');
const { startWeb } = require('./web');
const media = require('./media');

// Evita que o Claude filho ache que está aninhado em outra sessão do Claude Code.
delete process.env.CLAUDECODE;

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const STARTED_AT = Math.floor(Date.now() / 1000);

let sock = null;
const sentIds = new Set();
const seenIds = new Set();
const queue = [];
let running = null;

// Estado exibido no painel web.
let waStatus = 'iniciando';
let waUser = null;
let lastQr = null;
const history = []; // { from: 'user' | 'bot', text, who, files, time }
const logLines = [];

function addHistory(from, text, who = '', files = []) {
  history.push({ from, text, who, files: files.map((f) => path.basename(f)), time: Date.now() });
  if (history.length > 200) history.shift();
}

const HELP = `*Comandos*
/projetos — lista os projetos
/projeto — mostra o projeto atual
/projeto add <nome> <caminho> | <apelido1>, <apelido2>
/projeto rm <nome>
/alias <nome> <apelido1>, <apelido2>
/obs <nome> <texto> — observações que o Claude sempre considera no projeto
/info [nome] — mostra as informações cadastradas do projeto
/usar <nome> — define o projeto atual
/nova [nome] — começa uma conversa nova com o Claude no projeto
/status — tarefa em andamento e fila
/cancelar — cancela a tarefa atual (/cancelar tudo limpa a fila)
/desvincular — para de ouvir esta conversa
/autorizar <número> [nome] — libera outro número para mandar tarefas
/desautorizar <número> — remove o acesso
/autorizados — lista os números liberados

Qualquer outra mensagem vira uma tarefa para o Claude. Se o texto citar o nome ou apelido de um projeto, ele é usado; senão vai para o projeto atual.`;

// ---------- utilitários ----------
const LOG_FILE = path.join(DATA_DIR, 'bot.log');

function log(...args) {
  const line = [new Date().toLocaleString('pt-BR'), ...args]
    .map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  console.log(line);
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* sem log em arquivo */
  }
}

function toWhatsApp(text) {
  return String(text)
    .replace(/```[\s\S]*?(```|$)/g, '_(código omitido)_') // conversa mostra só status, nunca código
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

function splitMessage(text, max) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > max && current) {
      parts.push(current);
      current = '';
    }
    let l = line;
    while (l.length > max) {
      parts.push(l.slice(0, max));
      l = l.slice(max);
    }
    current = current ? current + '\n' + l : l;
  }
  if (current) parts.push(current);
  return parts;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function send(jid, text) {
  addHistory('bot', toWhatsApp(text));
  if (!sock || !jid) return;
  const parts = splitMessage(toWhatsApp(text), config.maxMessageLength || 3500);
  for (const part of parts) {
    try {
      const res = await sock.sendMessage(jid, { text: (config.botPrefix || '') + part });
      if (res?.key?.id) sentIds.add(res.key.id);
    } catch (err) {
      log(`Erro ao enviar mensagem para ${jid}:`, err);
    }
  }
}

function getText(msg) {
  const c = normalizeMessageContent(msg.message);
  return (
    c?.conversation ||
    c?.extendedTextMessage?.text ||
    c?.imageMessage?.caption ||
    c?.videoMessage?.caption ||
    c?.documentMessage?.caption ||
    ''
  );
}

// ---------- números autorizados ----------
function digits(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // número BR digitado sem o 55
  return d;
}

// Celular BR pode aparecer com ou sem o 9º dígito (55 65 9 9298-0037 x 55 65 9298-0037).
function sameNumber(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const br = (n) => (n.startsWith('55') && n.length === 13 && n[4] === '9' ? n.slice(0, 4) + n.slice(5) : n);
  return br(a) === br(b);
}

function senders() {
  return (config.allowedSenders || []).map((s) => (typeof s === 'string' ? { number: digits(s), name: '' } : s));
}

// Identificadores do remetente (número e/ou LID), só dígitos.
function senderIds(msg) {
  const k = msg.key;
  const raw = k.remoteJid?.endsWith('@g.us')
    ? [k.participant, k.participantAlt, k.participantPn]
    : [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participant, k.participantAlt];
  return [...new Set(raw.filter(Boolean).map((j) => j.split('@')[0].split(':')[0]))];
}

function findSender(msg) {
  const ids = senderIds(msg);
  return senders().find((s) => [s.number, ...(s.ids || [])].some((n) => ids.some((id) => sameNumber(digits(n), id))));
}

function addSender(number, name = '', ids = []) {
  const n = digits(number);
  if (n.length < 8) return { ok: false, error: 'Número inválido.' };
  const list = senders().filter((s) => !sameNumber(s.number, n));
  list.push({ number: n, name: String(name || '').trim(), ids: ids.filter((i) => i !== n) });
  config.allowedSenders = list;
  saveConfig();
  const i = pendingSenders.findIndex((p) => p.ids.some((id) => sameNumber(id, n)));
  if (i >= 0) pendingSenders.splice(i, 1);
  return { ok: true, number: n };
}

function removeSender(number) {
  const n = digits(number);
  const before = senders().length;
  config.allowedSenders = senders().filter((s) => !sameNumber(s.number, n));
  saveConfig();
  return { ok: config.allowedSenders.length < before };
}

// Últimos números não autorizados que tentaram falar com o bot (para autorizar pelo painel).
const pendingSenders = [];
function notePending(msg, text) {
  const ids = senderIds(msg);
  const number = ids.find((i) => i.length <= 13) || ids[0]; // LIDs têm mais dígitos que um telefone
  const existing = pendingSenders.find((p) => p.ids.some((i) => ids.includes(i)));
  const entry = existing || { ids, number, name: '', count: 0 };
  entry.name = msg.pushName || entry.name;
  entry.lastText = truncate(text, 120);
  entry.time = Date.now();
  entry.count++;
  if (!existing) pendingSenders.unshift(entry);
  if (pendingSenders.length > 20) pendingSenders.pop();
}

// ---------- mensagens ----------
async function onMessage(msg) {
  const id = msg.key?.id;
  if (!msg.message || !id || seenIds.has(id) || sentIds.has(id)) return;
  seenIds.add(id);
  if (seenIds.size > 5000) seenIds.clear();

  const ts = Number(msg.messageTimestamp || 0);
  if (ts && ts < STARTED_AT - 30) return; // ignora histórico antigo

  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;

  const text = getText(msg).trim();
  const mediaInfo = media.mediaInfo(normalizeMessageContent(msg.message));
  if (!text && !mediaInfo) return;
  const prefix = (config.botPrefix || '').trim();
  if (msg.key.fromMe && prefix && text.startsWith(prefix)) return; // mensagem do próprio bot

  // A mesma conversa pode chegar como @lid ou como número (@s.whatsapp.net).
  const altJid = msg.key.remoteJidAlt;
  if (altJid && !config.allowedChats.includes(jid) && config.allowedChats.includes(altJid)) {
    config.allowedChats.push(jid);
    saveConfig();
  }

  const fromMe = !!msg.key.fromMe;
  const isGroup = jid.endsWith('@g.us');
  const linked = config.allowedChats.includes(jid);

  if (fromMe && !linked && /^\/vincular\b/i.test(text)) {
    config.allowedChats.push(jid);
    saveConfig();
    log(`Conversa vinculada: ${jid}`);
    return send(jid, `Conversa vinculada ✅\n\n${HELP}`);
  }

  // Regras de acesso:
  // - conversa vinculada: aceita você e os números autorizados;
  // - conversa privada com um número autorizado: aceita só as mensagens DELE
  //   (as suas, nessa conversa, são conversa normal e não viram tarefa).
  let who = null;
  if (fromMe) {
    if (!linked) return;
    who = 'Você';
  } else {
    const sender = findSender(msg);
    if (!sender || (isGroup && !linked)) {
      if (!isGroup) {
        notePending(msg, text);
        log(`Ignorado: número não autorizado ${senderIds(msg).join('/')} (${msg.pushName || 'sem nome'})`);
      }
      return;
    }
    who = sender.name || msg.pushName || sender.number;
  }

  let files = [];
  if (mediaInfo) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      files.push(media.saveUpload(buffer, mediaInfo.mimetype));
    } catch (err) {
      log('Erro ao baixar arquivo:', err);
      return send(jid, `⚠️ Não consegui receber o arquivo: ${err.message}`);
    }
  }

  log(`<- [${who}] ${truncate(text || '(arquivo)', 200)}${files.length ? ` +${files.length} arquivo(s)` : ''}`);
  addHistory('user', text, who, files);
  return handleIncoming(jid, text, files, fromMe);
}

// Texto + arquivos de uma mensagem (WhatsApp ou painel).
async function handleIncoming(jid, text, files, isOwner) {
  const key = jid || 'painel';
  if (!text) {
    // Arquivo sem legenda: guarda e espera a instrução (várias imagens seguidas viram um só pedido).
    if (media.addPending(key, files) === files.length) {
      await send(jid, '📎 Recebido. Agora me diga o que devo fazer com ele(s).');
    }
    return;
  }
  if (text.startsWith('/')) {
    if (files.length) media.addPending(key, files);
    return handleCommand(jid, text, isOwner);
  }
  return enqueueTask(jid, text, [...media.takePending(key), ...files]);
}

async function handleCommand(jid, text, isOwner = false) {
  const body = text.slice(1).trim();
  const [cmdRaw = ''] = body.split(/\s+/);
  const cmd = normalize(cmdRaw);
  const args = body.slice(cmdRaw.length).trim();

  switch (cmd) {
    case 'ajuda':
    case 'help':
      return send(jid, HELP);

    case 'vincular':
      return send(jid, 'Esta conversa já está vinculada.');

    case 'autorizar': {
      if (!isOwner) return send(jid, 'Só o dono do bot pode autorizar números.');
      const m = args.match(/^([\d\s()+-]+?)(?:\s+([^\d].*))?$/);
      if (!m) return send(jid, 'Uso: /autorizar <número com DDD> [nome]');
      const r = addSender(m[1], m[2]);
      return send(jid, r.ok ? `Número ${r.number} autorizado ✅ Ele já pode mandar tarefas no privado.` : r.error);
    }

    case 'desautorizar': {
      if (!isOwner) return send(jid, 'Só o dono do bot pode remover números.');
      return send(jid, removeSender(args).ok ? 'Número removido.' : 'Número não encontrado.');
    }

    case 'autorizados': {
      if (!isOwner) return send(jid, 'Só o dono do bot pode ver esta lista.');
      const list = senders();
      return send(jid, list.length ? '*Números autorizados*\n' + list.map((s) => `- ${s.number}${s.name ? ` (${s.name})` : ''}`).join('\n') : 'Nenhum número autorizado além de você.');
    }

    case 'desvincular':
      if (!isOwner) return send(jid, 'Só o dono do bot pode desvincular.');
      config.allowedChats = config.allowedChats.filter((c) => c !== jid);
      saveConfig();
      return send(jid, 'Conversa desvinculada. Envie /vincular para voltar.');

    case 'projetos': {
      const list = projects.list();
      if (!list.length) return send(jid, 'Nenhum projeto cadastrado. Use /projeto add <nome> <caminho>');
      const cur = projects.current?.name;
      return send(
        jid,
        '*Projetos*\n' +
          list
            .map((p) => `- ${p.name === cur ? '👉 ' : ''}*${p.name}*${p.aliases?.length ? ` (${p.aliases.join(', ')})` : ''}\n  ${p.path}`)
            .join('\n')
      );
    }

    case 'projeto': {
      const [sub = ''] = args.split(/\s+/);
      const rest = args.slice(sub.length).trim();
      if (normalize(sub) === 'add') {
        const [main, aliasPart = ''] = rest.split('|');
        const m = main.trim().match(/^(\S+)\s+(.+)$/);
        if (!m) return send(jid, 'Uso: /projeto add <nome> <caminho> | <apelido1>, <apelido2>');
        const dir = m[2].trim().replace(/^"|"$/g, '');
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(jid, `Pasta não encontrada: ${dir}`);
        const aliases = aliasPart.split(',').map((a) => a.trim());
        const name = projects.add(m[1], dir, aliases);
        return send(jid, `Projeto *${name}* cadastrado ✅\n${dir}`);
      }
      if (['rm', 'remover', 'del'].includes(normalize(sub))) {
        return send(jid, projects.remove(rest) ? `Projeto *${rest}* removido.` : `Projeto não encontrado: ${rest}`);
      }
      const cur = projects.current;
      return send(jid, cur ? `Projeto atual: *${cur.name}*\n${cur.path}\nSessão: ${cur.sessionId ? 'em andamento' : 'nova'}` : 'Nenhum projeto selecionado.');
    }

    case 'obs':
    case 'observacao': {
      const m = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return send(jid, 'Uso: /obs <projeto> <texto>  (substitui as observações do projeto)');
      const ok = projects.update(m[1], { notes: m[2] });
      return send(jid, ok ? `Observações de *${normalize(m[1])}* salvas ✅ Serão consideradas em todas as tarefas.` : `Projeto não encontrado: ${m[1]}`);
    }

    case 'info': {
      const p = args ? projects.get(args) : projects.current;
      if (!p) return send(jid, 'Projeto não encontrado.');
      return send(jid, `*${p.name}*\n${projectContext(p).replace(/^## .*\n/, '')}`);
    }

    case 'alias': {
      const m = args.match(/^(\S+)\s+(.+)$/);
      if (!m) return send(jid, 'Uso: /alias <nome> <apelido1>, <apelido2>');
      const ok = projects.setAliases(m[1], m[2].split(','));
      return send(jid, ok ? `Apelidos de *${m[1]}* atualizados.` : `Projeto não encontrado: ${m[1]}`);
    }

    case 'usar':
      return send(jid, projects.setCurrent(args) ? `Projeto atual: *${normalize(args)}*` : `Projeto não encontrado: ${args}`);

    case 'nova': {
      const p = args ? projects.get(args) : projects.current;
      if (!p) return send(jid, 'Projeto não encontrado.');
      projects.setSession(p.name, null);
      return send(jid, `Nova conversa iniciada em *${p.name}*. O Claude não vai lembrar do contexto anterior.`);
    }

    case 'status': {
      let msg = running
        ? `⏳ *${running.project}* há ${Math.round((Date.now() - running.started) / 60000)} min\nTarefa: ${truncate(running.text, 200)}\n` +
          (running.tools.length ? `Últimos passos:\n${running.tools.slice(-5).map((t) => '- ' + t).join('\n')}` : '')
        : 'Nenhuma tarefa em andamento.';
      if (queue.length) msg += `\n\n📥 Fila: ${queue.length}\n${queue.map((t, i) => `${i + 1}. [${t.projectName}] ${truncate(t.text, 80)}`).join('\n')}`;
      return send(jid, msg);
    }

    case 'cancelar': {
      if (normalize(args) === 'tudo') queue.length = 0;
      if (!running) return send(jid, normalize(args) === 'tudo' ? 'Fila limpa.' : 'Nada em andamento.');
      running.handle?.cancel();
      return send(jid, 'Cancelando…');
    }

    default:
      return send(jid, `Comando desconhecido: /${cmdRaw}\nEnvie /ajuda`);
  }
}

// ---------- tarefas ----------

// Informações cadastradas do projeto, anexadas ao system prompt do Claude.
function projectContext(p) {
  const lines = [`## Projeto "${p.name}"`, `- Pasta: ${p.path}`];
  if (p.description) lines.push(`- Descrição: ${p.description}`);
  if (p.stack) lines.push(`- Tecnologias: ${p.stack}`);
  if (p.url) lines.push(`- Site/URL em produção: ${p.url}`);
  if (p.testCommand) lines.push(`- Como rodar/testar: ${p.testCommand}`);
  if (p.notes) lines.push('', 'Observações do responsável (siga sempre, têm prioridade sobre suposições):', p.notes);
  return lines.join('\n');
}
function enqueueTask(jid, text, files = []) {
  let project = projects.findInText(text);
  if (project) projects.setCurrent(project.name);
  else project = projects.current;
  if (!project) return send(jid, 'Nenhum projeto cadastrado. Use /projeto add <nome> <caminho>');

  queue.push({ jid, text, files, projectName: project.name });
  if (running) send(jid, `📥 Na fila (posição ${queue.length}) para *${project.name}*.`);
  processQueue();
}

async function processQueue() {
  if (running || !queue.length) return;
  const task = queue.shift();
  running = { project: task.projectName, text: task.text, started: Date.now(), tools: [] };
  try {
    await runTask(task, running);
  } catch (err) {
    log('Erro na tarefa:', err);
    await send(task.jid, `⚠️ Erro interno: ${err.message}`);
  } finally {
    running = null;
    processQueue();
  }
}

async function runTask(task, state) {
  const project = projects.get(task.projectName);
  if (!project) return send(task.jid, `Projeto não encontrado: ${task.projectName}`);
  if (!fs.existsSync(project.path)) return send(task.jid, `Pasta do projeto não existe: ${project.path}`);

  await send(task.jid, `⏳ Trabalhando em *${project.name}*…`);

  let pendingTools = [];
  let pendingText = '';
  const flush = () => {
    if (!pendingTools.length && !pendingText) return;
    let msg = '⚙️ Em andamento…';
    if (pendingText) msg += '\n' + truncate(pendingText, 600);
    if (pendingTools.length) msg += '\n' + pendingTools.slice(-5).map((t) => '- ' + t).join('\n');
    pendingTools = [];
    pendingText = '';
    send(task.jid, msg);
  };
  const interval = setInterval(flush, (config.progressIntervalSec || 90) * 1000);

  const attempt = (sessionId) => {
    const handle = runClaude({
      prompt: task.text + media.attachmentsPrompt(task.files || []),
      cwd: project.path,
      sessionId,
      config,
      addDirs: task.files?.length ? [media.UPLOAD_DIR] : [],
      projectContext: projectContext(project),
      permissionMode: project.permissionMode,
      onProgress: (p) => {
        if (p.sessionId) projects.setSession(project.name, p.sessionId);
        if (p.tool) {
          state.tools.push(p.tool);
          pendingTools.push(p.tool);
          log(`   [${project.name}] ${p.tool}`);
        }
        if (p.text) pendingText = p.text;
      },
    });
    state.handle = handle;
    return handle.promise;
  };

  let res;
  try {
    res = await attempt(project.sessionId);
    // Sessão antiga sumiu: tenta de novo com conversa nova.
    if (!res.ok && project.sessionId && !res.cancelled && !res.timedOut && /no conversation found/i.test(`${res.text} ${res.raw || ''}`)) {
      projects.setSession(project.name, null);
      res = await attempt(null);
    }
  } finally {
    clearInterval(interval);
  }

  if (res.sessionId) projects.setSession(project.name, res.sessionId);

  const mins = res.durationMs ? Math.max(1, Math.round(res.durationMs / 60000)) : 0;
  const footer = `\n\n_${project.name}${mins ? ` · ${mins} min` : ''}_`;
  // Custo estimado só no log (com assinatura Claude não é cobrado à parte).
  const cost = res.costUsd ? ` (custo estimado US$ ${res.costUsd.toFixed(2)})` : '';
  log(`-> [${project.name}] ${res.ok ? 'ok' : 'falhou'} ${mins} min${cost}`);
  if (!res.ok) log(`   erro: ${res.text}\n   stderr: ${(res.raw || '').slice(-2000)}`);
  await send(task.jid, (res.ok ? '' : '⚠️ ') + res.text + footer);
}

// ---------- conexão WhatsApp ----------
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    /* usa a versão padrão da lib */
  }

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    ...(version ? { version } : {}),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      lastQr = u.qr;
      waStatus = 'aguardando QR';
      log('Escaneie o QR Code no WhatsApp (Aparelhos conectados > Conectar um aparelho):');
      qrcode.generate(u.qr, { small: true });
    }
    if (u.connection === 'open') {
      lastQr = null;
      waStatus = 'conectado';
      waUser = sock.user?.id || null;
      log(`✅ Conectado ao WhatsApp como ${sock.user?.id}`);
      if (!config.allowedChats.length) log('Nenhuma conversa vinculada. Envie /vincular na conversa que o bot deve usar.');
    }
    if (u.connection === 'close') {
      waStatus = 'reconectando';
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log('Sessão do WhatsApp encerrada. Será necessário escanear o QR Code de novo.');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        log(`Conexão caiu (código ${code}). Reconectando…`);
      }
      setTimeout(() => connect().catch((e) => log('Falha ao reconectar:', e.message)), 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        await onMessage(m);
      } catch (err) {
        log('Erro ao processar mensagem:', err);
      }
    }
  });
}

process.on('unhandledRejection', (err) => log('Erro não tratado:', err));
process.on('SIGINT', () => {
  running?.handle?.cancel();
  process.exit(0);
});

// ---------- painel web ----------
startWeb(
  {
    getState: () => ({
      whatsapp: { status: waStatus, user: waUser, chats: config.allowedChats },
      qr: lastQr,
      permissionMode: config.permissionMode,
      projects: projects.list().map((p) => ({ ...p, current: p.name === projects.current?.name, hasSession: !!p.sessionId })),
      running: running && {
        project: running.project,
        text: running.text,
        started: running.started,
        tools: running.tools.slice(-15),
      },
      queue: queue.map((t) => ({ project: t.projectName, text: t.text })),
      senders: senders(),
      pendingSenders,
      history,
      logs: logLines.slice(-150),
    }),
    sendTask: async (text, uploads = []) => {
      const files = uploads.map((u) => media.saveUpload(Buffer.from(String(u.data || ''), 'base64'), u.type));
      log(`<- [painel] ${truncate(text || '(arquivo)', 200)}${files.length ? ` +${files.length} arquivo(s)` : ''}`);
      addHistory('user', text, 'Painel', files);
      await handleIncoming(config.allowedChats[0] || null, text, files, true);
      return { ok: true };
    },
    cancel: (all) => {
      if (all) queue.length = 0;
      running?.handle?.cancel();
      return { ok: true };
    },
    addProject: (name, dir, aliases, extra) => {
      if (!name || !dir) return { ok: false, error: 'Informe nome e caminho.' };
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: `Pasta não encontrada: ${dir}` };
      return { ok: true, name: projects.add(name, dir, aliases, extra) };
    },
    addSender: (number, name, ids) => addSender(number, name, ids || []),
    removeSender: (number) => removeSender(number),
    removeProject: (name) => ({ ok: projects.remove(name) }),
    useProject: (name) => ({ ok: projects.setCurrent(name) }),
    newSession: (name) => {
      projects.setSession(name, null);
      return { ok: true };
    },
  },
  config.webPort || 3000,
  log
);

media.cleanupUploads(7);
log('Iniciando ponte WhatsApp ⇄ Claude Code…');
log(`Projetos: ${projects.list().map((p) => p.name).join(', ') || '(nenhum)'} · modo de permissão: ${config.permissionMode}`);
connect().catch((err) => {
  log('Falha ao conectar:', err);
  process.exit(1);
});
