#!/usr/bin/env node
// Catálogo e executor das ferramentas do agente.
//   node f.js listar                       lista curta (nome — para que serve)
//   node f.js buscar <texto>               ferramentas que combinam com o pedido
//   node f.js info <nome>                  detalhes e como chamar
//   node f.js rodar <nome> [args...]       executa (saída cortada em --max=N caracteres, padrão 8000)
//   node f.js registrar <nome> <arquivo> --desc "..." --tags a,b --uso "..." [--perigosa]
//   node f.js conexoes                     nomes das conexões de banco (sem senhas)
// Cada uso/falha é contado no catálogo: é assim que o agente aprende quais ferramentas valem a pena.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const CAT = path.join(DIR, 'catalogo.json');
const CONN_DIR = path.join(DIR, 'conexoes');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(CAT, 'utf8'));
  } catch {
    return { ferramentas: [] };
  }
};
const save = (cat) => {
  cat.ferramentas.sort((a, b) => a.nome.localeCompare(b.nome));
  const tmp = CAT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cat, null, 2) + '\n');
  fs.renameSync(tmp, CAT);
};
const find = (cat, nome) => cat.ferramentas.find((t) => norm(t.nome) === norm(nome));

// Pontua o quanto uma ferramenta combina com um texto (nome, tags e descrição).
function score(t, text) {
  const words = new Set(norm(text).split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  if (!words.size) return 0;
  let s = 0;
  if (norm(text).includes(norm(t.nome))) s += 5;
  for (const tag of t.tags || []) if (words.has(norm(tag)) || norm(text).includes(norm(tag))) s += 3;
  for (const w of norm(t.descricao).split(/[^a-z0-9]+/)) if (w.length > 3 && words.has(w)) s += 1;
  return s;
}

function search(text, min = 3) {
  return load()
    .ferramentas.map((t) => ({ t, s: score(t, text) }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t);
}

function runner(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return [process.execPath, [file]];
  if (ext === '.py') return ['python', [file]];
  if (ext === '.ps1') return ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]];
  if (ext === '.cmd' || ext === '.bat') return ['cmd', ['/c', file]];
  return [file, []];
}

function run(nome, args) {
  const cat = load();
  const t = find(cat, nome);
  if (!t) {
    const sug = search(nome, 1).slice(0, 5).map((x) => x.nome);
    console.error(`Ferramenta "${nome}" não existe.${sug.length ? ' Parecidas: ' + sug.join(', ') : ''}`);
    return 2;
  }
  let max = 8000;
  args = args.filter((a) => (a.startsWith('--max=') ? ((max = Number(a.slice(6)) || max), false) : true));
  const [cmd, pre] = runner(path.join(DIR, t.arquivo));
  const r = spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] });
  let out = (r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '');
  if (r.error) out += `\n${r.error.message}`;
  if (out.length > max) out = out.slice(0, max) + `\n… (saída cortada: ${out.length} caracteres; use --max=N ou exporte para arquivo)`;
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  const ok = r.status === 0;
  t.usos = (t.usos || 0) + 1;
  if (!ok) t.falhas = (t.falhas || 0) + 1;
  t.ultimoUso = new Date().toISOString().slice(0, 10);
  save(cat);
  return r.status ?? 1;
}

function flags(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      f[k] = v;
    } else f._.push(a);
  }
  return f;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cat = load();
  switch (cmd) {
    case 'listar':
    case undefined:
      for (const t of cat.ferramentas) console.log(`- ${t.nome}: ${t.descricao}${t.perigosa ? ' [pede confirmação]' : ''}`);
      return 0;
    case 'buscar': {
      const list = search(rest.join(' '), 1);
      if (!list.length) console.log('Nenhuma ferramenta combina. Se a tarefa pode se repetir, crie uma e registre.');
      for (const t of list.slice(0, 8)) console.log(`- ${t.nome}: ${t.descricao}\n  uso: ${t.uso}`);
      return 0;
    }
    case 'info': {
      const t = find(cat, rest[0]);
      if (!t) return console.error('Não existe.'), 2;
      console.log(JSON.stringify(t, null, 2));
      return 0;
    }
    case 'rodar':
      return run(rest[0], rest.slice(1));
    case 'registrar': {
      const f = flags(rest);
      const [nome, arquivo] = f._;
      if (!nome || !arquivo || !f.desc) return console.error('Uso: registrar <nome> <arquivo em bin/> --desc "..." --tags a,b --uso "..." [--perigosa]'), 2;
      const rel = path.relative(DIR, path.resolve(DIR, arquivo)).replace(/\\/g, '/');
      if (!fs.existsSync(path.join(DIR, rel))) return console.error(`Arquivo não encontrado: ${rel}`), 2;
      const old = find(cat, nome);
      const t = {
        ...(old || { criada: new Date().toISOString().slice(0, 10), usos: 0 }),
        nome,
        arquivo: rel,
        descricao: String(f.desc),
        tags: f.tags ? String(f.tags).split(',').map((s) => s.trim()).filter(Boolean) : old?.tags || [],
        uso: f.uso ? String(f.uso) : old?.uso || `node ferramentas/f.js rodar ${nome}`,
        ...(f.perigosa ? { perigosa: true } : {}),
      };
      if (old) Object.assign(old, t);
      else cat.ferramentas.push(t);
      save(cat);
      console.log(`${old ? 'Atualizada' : 'Registrada'}: ${nome}`);
      return 0;
    }
    case 'conexoes': {
      let files = [];
      try {
        files = fs.readdirSync(CONN_DIR).filter((f) => f.endsWith('.json'));
      } catch {}
      if (!files.length) console.log('Nenhuma conexão cadastrada.');
      for (const f of files) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CONN_DIR, f), 'utf8'));
          console.log(`- ${f.slice(0, -5)}: ${c.tipo || '?'}${c.host ? ' @ ' + c.host : ''}${c.banco ? '/' + c.banco : ''}${c.escrita ? ' (escrita liberada)' : ' (só leitura)'}${c.descricao ? ' · ' + c.descricao : ''}`);
        } catch {
          console.log(`- ${f.slice(0, -5)}: (arquivo inválido)`);
        }
      }
      return 0;
    }
    default:
      console.error('Comandos: listar | buscar <texto> | info <nome> | rodar <nome> [args] | registrar ... | conexoes');
      return 2;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { load, search, find, DIR };
