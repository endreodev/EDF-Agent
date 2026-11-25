const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

// Mensagens do painel separadas por conversa do WhatsApp (grupo ou privado), salvas em disco.
const FILE = path.join(DATA_DIR, 'chats.json');
const MAX_PER_CHAT = 400;

let db = { rev: 0, chats: {} }; // chats[jid] = { jid, name, kind, messages: [{ rev, from, text, who, files, time }] }
try {
  db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  db.chats ||= {};
  db.rev ||= 0;
} catch {
  /* primeiro uso */
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(db), 'utf8');
      fs.renameSync(FILE + '.tmp', FILE);
    } catch {
      /* tenta de novo na próxima mensagem */
    }
  }, 1500);
}

function kindOf(jid) {
  if (jid === 'painel') return 'panel';
  return jid.endsWith('@g.us') ? 'group' : 'direct';
}

function chat(jid) {
  return (db.chats[jid] ||= { jid, name: '', kind: kindOf(jid), messages: [] });
}

function add(jid, msg) {
  const c = chat(jid || 'painel');
  c.messages.push({ rev: ++db.rev, time: Date.now(), ...msg });
  if (c.messages.length > MAX_PER_CHAT) c.messages.splice(0, c.messages.length - MAX_PER_CHAT);
  save();
}

function setName(jid, name) {
  if (!jid || !name) return;
  const c = chat(jid);
  if (c.name !== name) {
    c.name = name;
    save();
  }
}

function nameOf(jid) {
  return db.chats[jid]?.name || '';
}

// Resumo de cada conversa (sem as mensagens), da mais recente para a mais antiga.
function list() {
  return Object.values(db.chats)
    .filter((c) => c.messages.length)
    .map((c) => {
      const last = c.messages[c.messages.length - 1];
      return { jid: c.jid, name: c.name, kind: c.kind, count: c.messages.length, rev: last.rev, last: { from: last.from, who: last.who, text: String(last.text || '').slice(0, 140), time: last.time } };
    })
    .sort((a, b) => b.rev - a.rev);
}

function messages(jid, after = 0) {
  return (db.chats[jid]?.messages || []).filter((m) => m.rev > after);
}

module.exports = { add, setName, nameOf, list, messages };
