const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

// Registro de todas as tarefas executadas (uma linha JSON por tarefa), base do /resumo e dos limites de uso.
const FILE = path.join(DATA_DIR, 'tasks.jsonl');

function record(entry) {
  try {
    fs.appendFileSync(FILE, JSON.stringify({ time: Date.now(), ...entry }) + '\n', 'utf8');
  } catch {
    /* sem registro */
  }
}

function all() {
  try {
    return fs
      .readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Minutos de tarefa usados hoje, filtrando por pessoa e/ou projeto.
function minutesToday({ person, project } = {}) {
  const from = startOfToday();
  return all()
    .filter((t) => t.time >= from && (!person || t.person === person) && (!project || t.project === project))
    .reduce((s, t) => s + (t.ms || 0) / 60000, 0);
}

// Últimas tarefas do projeto, para dar contexto a sessões novas e tarefas em paralelo.
function recent(project, n = 5) {
  return all()
    .filter((t) => t.project === project)
    .slice(-n);
}

const PERIODS = {
  hoje: { label: 'hoje', from: () => startOfToday() },
  ontem: { label: 'ontem', from: () => startOfToday() - 86400000, to: () => startOfToday() },
  semana: { label: 'últimos 7 dias', from: () => startOfToday() - 6 * 86400000 },
  mes: { label: 'últimos 30 dias', from: () => startOfToday() - 29 * 86400000 },
};

function fmtMin(m) {
  m = Math.round(m);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

// Texto do /resumo [hoje|ontem|semana|mes] [projeto].
function summary(periodName = 'hoje', project = null) {
  const period = PERIODS[periodName] || PERIODS.hoje;
  const from = period.from();
  const to = period.to ? period.to() : Infinity;
  const list = all().filter((t) => t.time >= from && t.time < to && (!project || t.project === project));
  if (!list.length) return `📊 Nenhuma tarefa ${period.label}${project ? ` em *${project}*` : ''}.`;

  const byProject = new Map();
  for (const t of list) {
    const g = byProject.get(t.project) || [];
    g.push(t);
    byProject.set(t.project, g);
  }
  const total = list.reduce((s, t) => s + (t.ms || 0) / 60000, 0);
  const parts = [`📊 *Resumo ${period.label}* · ${list.length} tarefa(s) · ${fmtMin(total)}`];
  for (const [name, tasks] of [...byProject].sort((a, b) => b[1].length - a[1].length)) {
    const mins = tasks.reduce((s, t) => s + (t.ms || 0) / 60000, 0);
    const failed = tasks.filter((t) => !t.ok).length;
    const people = [...new Set(tasks.map((t) => t.who).filter(Boolean))];
    parts.push(
      `\n*${name}* · ${tasks.length} tarefa(s) · ${fmtMin(mins)}${failed ? ` · ${failed} com erro` : ''}${people.length ? `\nPor: ${people.join(', ')}` : ''}\n` +
        tasks
          .slice(-8)
          .map((t) => `- ${t.ok ? '' : '⚠️ '}${String(t.text || '').replace(/\s+/g, ' ').slice(0, 90)}`)
          .join('\n') +
        (tasks.length > 8 ? `\n- … e mais ${tasks.length - 8}` : '')
    );
  }
  return parts.join('\n');
}

module.exports = { record, all, minutesToday, recent, summary, fmtMin, PERIODS };
