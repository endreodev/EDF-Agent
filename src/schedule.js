const fs = require('fs');
const path = require('path');
const { DATA_DIR, normalize } = require('./store');

const FILE = path.join(DATA_DIR, 'schedules.json');
const DAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

let list = [];
try {
  list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  list = [];
}

function save() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(FILE + '.tmp', FILE);
}

// "diario", "seg-sex", "seg,qua,sex", "sab" -> [0..6]
function parseDays(token) {
  const t = normalize(token);
  if (['diario', 'todo-dia', 'todos'].includes(t)) return [0, 1, 2, 3, 4, 5, 6];
  if (['uteis', 'dias-uteis'].includes(t)) return [1, 2, 3, 4, 5];
  const days = new Set();
  for (const part of t.split(',')) {
    const [a, b] = part.split('-').map((d) => DAY_NAMES.indexOf(d.slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) return null;
    if (b === undefined) days.add(a);
    else for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  return [...days].sort();
}

/** "/agendar [dias] HH:MM tarefa" -> { days, time, text } ou null */
function parse(args) {
  const m = String(args).trim().match(/^(?:(\S+)\s+)?(\d{1,2})[:h](\d{2})?\s+([\s\S]+)$/i);
  if (!m) return null;
  const days = m[1] ? parseDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
  const h = Number(m[2]);
  const min = Number(m[3] || 0);
  if (!days || h > 23 || min > 59) return null;
  return { days, time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, text: m[4].trim() };
}

function describe(s) {
  const d = s.days.length === 7 ? 'todo dia' : s.days.join() === '1,2,3,4,5' ? 'seg a sex' : s.days.map((i) => DAY_NAMES[i]).join(', ');
  return `#${s.id} ${d} às ${s.time} [${s.project}] ${s.text}`;
}

function add(entry) {
  const id = list.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  list.push({ id, ...entry, lastRun: null });
  save();
  return id;
}

function remove(id) {
  const before = list.length;
  list = list.filter((s) => s.id !== Number(id));
  save();
  return list.length < before;
}

function removeProject(project) {
  list = list.filter((s) => s.project !== project);
  save();
}

function all() {
  return list;
}

// Verifica a cada 20s e dispara fire(s) uma vez por dia no horário marcado.
function start(fire) {
  setInterval(() => {
    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5);
    const today = now.toDateString();
    for (const s of list) {
      if (s.time !== hhmm || !s.days.includes(now.getDay()) || s.lastRun === today) continue;
      s.lastRun = today;
      save();
      fire(s);
    }
  }, 20000);
}

module.exports = { parse, describe, add, remove, removeProject, all, start };
