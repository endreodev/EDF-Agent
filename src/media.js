const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 15 * 1024 * 1024;
const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

function cleanMime(m) {
  return String(m || '').split(';')[0].trim().toLowerCase();
}

// Tipo de mídia aceito numa mensagem do WhatsApp (conteúdo já normalizado), ou null.
function mediaInfo(content) {
  if (content?.imageMessage) return { mimetype: cleanMime(content.imageMessage.mimetype) || 'image/jpeg' };
  const doc = content?.documentMessage;
  if (doc && EXT[cleanMime(doc.mimetype)]) return { mimetype: cleanMime(doc.mimetype), fileName: doc.fileName };
  return null;
}

function isSupported(mimetype) {
  return !!EXT[cleanMime(mimetype)];
}

// Salva o arquivo em data/uploads e devolve o caminho completo.
function saveUpload(buffer, mimetype) {
  if (!buffer?.length) throw new Error('arquivo vazio');
  if (buffer.length > MAX_BYTES) throw new Error(`arquivo maior que ${MAX_BYTES / 1024 / 1024} MB`);
  const ext = EXT[cleanMime(mimetype)];
  if (!ext) throw new Error('tipo de arquivo não suportado (use imagem ou PDF)');
  const name = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}${ext}`;
  const file = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(file, buffer);
  return file;
}

// Caminho de um upload pelo nome (sem permitir sair da pasta), ou null.
function resolveUpload(name) {
  const base = path.basename(String(name || ''));
  const file = path.join(UPLOAD_DIR, base);
  return base && fs.existsSync(file) ? { file, mimetype: MIME[path.extname(base).toLowerCase()] || 'application/octet-stream' } : null;
}

// Remove uploads com mais de `days` dias.
function cleanupUploads(days = 7) {
  const limit = Date.now() - days * 86400000;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const file = path.join(UPLOAD_DIR, f);
    try {
      if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file);
    } catch {
      /* ignora */
    }
  }
}

// Arquivos recebidos sem texto ficam aguardando a próxima mensagem da mesma conversa.
const pending = new Map();

function addPending(key, files) {
  const list = pending.get(key) || [];
  list.push(...files);
  pending.set(key, list);
  return list.length;
}

function takePending(key) {
  const list = pending.get(key) || [];
  pending.delete(key);
  return list;
}

function attachmentsPrompt(files) {
  if (!files.length) return '';
  return (
    '\n\n[Arquivos enviados pelo usuário junto com esta mensagem — abra cada um com a ferramenta Read para visualizar antes de responder]\n' +
    files.map((f) => `- ${f}`).join('\n')
  );
}

module.exports = {
  UPLOAD_DIR,
  mediaInfo,
  isSupported,
  saveUpload,
  resolveUpload,
  cleanupUploads,
  addPending,
  takePending,
  attachmentsPrompt,
};
