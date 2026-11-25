const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');
const { run, worktreeTree } = require('./git');

// Cópias isoladas do projeto (git worktree) para rodar várias tarefas ao mesmo tempo.
// A cópia parte do estado atual da pasta (inclusive alterações não commitadas); no fim, a diferença
// vira um patch aplicado na pasta principal.
const WT_DIR = path.join(DATA_DIR, 'worktrees');
const PATCH_DIR = path.join(DATA_DIR, 'patches');
fs.mkdirSync(WT_DIR, { recursive: true });
fs.mkdirSync(PATCH_DIR, { recursive: true });

const git = (cwd, ...args) => run('git', args, cwd);
const manifest = (id) => path.join(WT_DIR, `${id}.json`);

// Arquivos ignorados pelo Git (node_modules, vendor, .env…) não vão para a cópia: pastas viram
// junções para as originais e arquivos pequenos são copiados, para build e testes funcionarem.
async function linkIgnored(src, dest) {
  const r = await git(src, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z');
  const links = [];
  for (const rel of r.out.split('\0').filter(Boolean).slice(0, 300)) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    try {
      if (fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (rel.endsWith('/')) {
        fs.symlinkSync(from, to.replace(/[\\/]+$/, ''), 'junction');
        links.push(to.replace(/[\\/]+$/, ''));
      } else if (fs.statSync(from).size < 2 * 1024 * 1024) {
        fs.copyFileSync(from, to);
      }
    } catch {
      /* item problemático: segue sem ele */
    }
  }
  return links;
}

// Cria a cópia. Retorna { id, dir, projectDir, baseTree, links } ou { error }.
async function create(projectDir, id) {
  const tree = await worktreeTree(projectDir);
  if (!tree) return { error: 'não consegui ler o estado da pasta do projeto.' };
  const head = await git(projectDir, 'rev-parse', 'HEAD');
  const base = await git(projectDir, 'commit-tree', tree, ...(head.ok ? ['-p', head.out] : []), '-m', 'agente: base da tarefa paralela');
  if (!base.ok) return { error: base.err };
  const dir = path.join(WT_DIR, id);
  const add = await git(projectDir, 'worktree', 'add', '--detach', dir, base.out);
  if (!add.ok) return { error: add.err };
  const info = { id, dir, projectDir, baseTree: tree, links: [] };
  fs.writeFileSync(manifest(id), JSON.stringify(info), 'utf8'); // antes dos links: a limpeza precisa saber deles
  info.links = await linkIgnored(projectDir, dir);
  fs.writeFileSync(manifest(id), JSON.stringify(info), 'utf8');
  return info;
}

// Remove a cópia. As junções são desfeitas antes, para nunca apagar o conteúdo das pastas originais.
async function remove(info) {
  for (const l of info.links || []) {
    try {
      if (fs.lstatSync(l).isSymbolicLink()) fs.unlinkSync(l);
    } catch {
      /* já removida */
    }
  }
  const leftLinks = (info.links || []).some((l) => {
    try {
      return fs.lstatSync(l).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!leftLinks) {
    const r = await git(info.projectDir, 'worktree', 'remove', '--force', info.dir);
    if (!r.ok) fs.rmSync(info.dir, { recursive: true, force: true });
    await git(info.projectDir, 'worktree', 'prune');
  }
  fs.rmSync(manifest(info.id), { force: true });
}

// Sobras de tarefas interrompidas (bot fechado no meio).
async function cleanupAll() {
  for (const f of fs.readdirSync(WT_DIR).filter((n) => n.endsWith('.json'))) {
    try {
      await remove(JSON.parse(fs.readFileSync(path.join(WT_DIR, f), 'utf8')));
    } catch {
      /* manifesto inválido */
    }
  }
}

// Patch com tudo o que a tarefa mudou na cópia. Retorna o arquivo do patch, ou null se nada mudou.
async function makePatch(info) {
  const tree = await worktreeTree(info.dir);
  if (!tree || tree === info.baseTree) return null;
  const file = path.join(PATCH_DIR, `${info.id}.patch`);
  const r = await run('git', ['diff', '--binary', '--full-index', info.baseTree, tree], info.projectDir, 120000);
  if (!r.ok) return { error: r.err || 'falha ao gerar o patch' };
  if (!r.out) return null;
  fs.writeFileSync(file, r.out + '\n', 'utf8');
  return { file, tree };
}

// Aplica (ou desfaz, com reverse) o patch na pasta principal. Não aplica nada se houver conflito.
async function applyPatch(projectDir, file, reverse = false) {
  const args = ['apply', '--whitespace=nowarn', ...(reverse ? ['-R'] : [])];
  const check = await git(projectDir, ...args, '--check', file);
  if (!check.ok) return { ok: false, error: check.err.split('\n').slice(0, 3).join(' ') };
  const r = await git(projectDir, ...args, file);
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

// Guarda o resultado num branch quando não deu para aplicar (conflito com outra tarefa).
async function saveAsBranch(info, tree, name) {
  const c = await git(info.projectDir, 'commit-tree', tree, '-m', `agente: tarefa paralela ${info.id}`);
  if (!c.ok) return null;
  const b = await git(info.projectDir, 'branch', '-f', name, c.out);
  return b.ok ? name : null;
}

// Apaga patches com mais de `days` dias.
function cleanupPatches(days = 14) {
  const limit = Date.now() - days * 86400000;
  for (const f of fs.readdirSync(PATCH_DIR)) {
    const file = path.join(PATCH_DIR, f);
    try {
      if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file);
    } catch {
      /* ignora */
    }
  }
}

module.exports = { create, remove, cleanupAll, makePatch, applyPatch, saveAsBranch, cleanupPatches };
