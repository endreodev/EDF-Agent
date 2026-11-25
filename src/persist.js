const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

// Estado que precisa sobreviver a um reinício do bot:
// - queue.json: fila, tarefas que estavam rodando e planos esperando o ok do usuário;
// - reactions.json: o que cada mensagem do bot faz quando recebe uma reação, e as sugestões pendentes.
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const META_FILE = path.join(DATA_DIR, 'reactions.json');

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function write(file, value) {
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(value), 'utf8');
    fs.renameSync(file + '.tmp', file);
  } catch {
    /* sem persistência: segue só em memória */
  }
}

module.exports = {
  loadQueue: () => read(QUEUE_FILE, { queued: [], running: [], plans: [] }),
  saveQueue: (state) => write(QUEUE_FILE, state),
  loadMeta: () => read(META_FILE, { meta: [], proposals: [] }),
  saveMeta: (state) => write(META_FILE, state),
};
