const fs = require('fs');
const path = require('path');
const { DATA_DIR, ROOT, normalize } = require('./store');

// Missões: objetivos grandes que avançam sozinhos em várias rodadas (horas ou dias).
// Estado em data/missions.json; o checklist de cada uma fica em memoria/missoes/<id>-<resumo>.md,
// escrito pelo próprio Claude a cada rodada.
const FILE = path.join(DATA_DIR, 'missions.json');
const DIR = path.join(ROOT, 'memoria', 'missoes');

let list = [];
try {
  list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  list = [];
}

function save() {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(FILE + '.tmp', FILE);
  } catch {
    /* segue só em memória */
  }
}

const STATUS = { ativa: '🎯', pausada: '⏸️', concluida: '✅', cancelada: '🗑️' };

function create({ project, jid, goal }) {
  const id = list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  const slug = normalize(goal).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'missao';
  fs.mkdirSync(DIR, { recursive: true });
  const m = {
    id,
    project,
    jid,
    goal: String(goal).trim(),
    file: path.join(DIR, `${id}-${slug}.md`),
    status: 'ativa',
    created: Date.now(),
    updated: Date.now(),
    runs: 0,
    fails: 0,
    lastRun: null,
    nextRun: Date.now(),
    note: '',
    pauseReason: '',
  };
  list.push(m);
  save();
  return m;
}

const get = (id) => list.find((x) => x.id === Number(String(id).replace('#', '')));
const all = () => list;
const active = () => list.filter((x) => x.status === 'ativa' || x.status === 'pausada');

function update(id, fields) {
  const m = get(id);
  if (!m) return null;
  Object.assign(m, fields, { updated: Date.now() });
  save();
  return m;
}

function removeProject(project) {
  for (const m of list) if (m.project === project && (m.status === 'ativa' || m.status === 'pausada')) m.status = 'cancelada';
  save();
}

// Progresso pelo checklist do arquivo: itens "- [x]" de "- [ ]" + "- [x]".
function progress(m) {
  let text = '';
  try {
    text = fs.readFileSync(m.file, 'utf8');
  } catch {
    return { done: 0, total: 0 };
  }
  const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  const open = (text.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
  return { done, total: done + open };
}

// Rodadas de hoje (para o limite diário).
function runsToday(m) {
  const day0 = new Date();
  day0.setHours(0, 0, 0, 0);
  return (m.history || []).filter((t) => t >= day0.getTime()).length;
}

// Marca o início de uma rodada.
function started(id) {
  const m = get(id);
  if (!m) return null;
  m.runs++;
  m.lastRun = Date.now();
  m.history = [...(m.history || []), Date.now()].slice(-50);
  save();
  return m;
}

// Lê a linha final "[[MISSAO]] andamento|concluida|pausar resumo" e tira da resposta.
function extract(text) {
  let status = null;
  let note = '';
  const rest = String(text).replace(/^.*\[\[MISS[AÃ]O\]\][ \t]*(.*)$/gim, (_, r) => {
    const m = String(r).trim().match(/^(andamento|conclu[ií]da|pausar|pausada)\b[\s:—–-]*(.*)$/i);
    if (m) {
      status = /^conclu/i.test(m[1]) ? 'concluida' : /^paus/i.test(m[1]) ? 'pausar' : 'andamento';
      note = m[2].trim();
    } else {
      status = 'andamento';
      note = String(r).trim();
    }
    return '';
  });
  return { status, note: note.slice(0, 300), text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

function describe(m) {
  const p = progress(m);
  const bar = p.total ? ` · ${p.done}/${p.total} itens` : '';
  return `${STATUS[m.status] || ''} #${m.id} [${m.project}] ${m.goal.length > 90 ? m.goal.slice(0, 89) + '…' : m.goal}${bar} · ${m.runs} rodada(s)${m.status === 'pausada' && m.pauseReason ? `\n   ⏸️ ${m.pauseReason}` : m.note ? `\n   ↳ ${m.note}` : ''}`;
}

// Instruções da rodada (vão no contexto da tarefa).
function instructions(m, runMin) {
  const first = !fs.existsSync(m.file);
  return `## Missão #${m.id} (vários dias, em rodadas automáticas)
Objetivo: ${m.goal}
Esta é a rodada ${m.runs}. A missão avança sozinha em rodadas; nem sempre o dono está olhando.
Arquivo da missão: ${m.file}
${first ? `- Primeira rodada: crie esse arquivo com as seções "## Objetivo", "## Critério de pronto" (como saber que acabou, conferível), "## Checklist" (passos pequenos "- [ ] ...", cada um cabendo numa rodada), "## Decisões" e "## Diário". Depois já comece a executar os primeiros itens.` : `- Leia esse arquivo primeiro: ele é a memória da missão. Não refaça o que já está marcado [x].`}
- Em cada rodada avance um bloco de trabalho que caiba em uns ${runMin} min: os próximos itens do checklist. Marque [x] só o que concluiu E conferiu. Acrescente itens que descobrir.
- No fim da rodada, escreva no "## Diário" uma linha com a data, o que fez e o que vem a seguir.
- Decisão que só o dono pode tomar, ou algo irreversível (publicar, apagar dados, gastar dinheiro, mandar mensagem a terceiros): NÃO faça por conta própria. Pergunte com [[PERGUNTA]] se for rápido de responder; se não, pause a missão (abaixo) dizendo o que precisa do dono.
- A resposta desta rodada é curta: o que avançou, o que vem a seguir.
- Termine SEMPRE com uma linha exatamente assim:
[[MISSAO]] <andamento|concluida|pausar> <resumo de uma linha>
  andamento = ainda há itens; concluida = o critério de pronto foi atendido e conferido; pausar = precisa do dono para continuar.`;
}

module.exports = { create, get, all, active, update, removeProject, progress, runsToday, started, extract, describe, instructions, DIR, STATUS };
