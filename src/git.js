const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

function run(cmd, args, cwd, timeoutMs = 120000, env = undefined) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}

const git = (cwd, ...args) => run('git', args, cwd);

// Remove usuário/token embutido em URLs de remote (https://token@github.com/...).
function cleanUrl(url) {
  return String(url || '').replace(/\/\/[^@/]+@/, '//');
}

async function info(dir) {
  if (!dir || !fs.existsSync(dir)) return { isRepo: false };
  const inside = await git(dir, 'rev-parse', '--is-inside-work-tree');
  if (!inside.ok || inside.out !== 'true') return { isRepo: false };
  const [branch, status, last, remote] = await Promise.all([
    git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(dir, 'status', '--porcelain'),
    git(dir, 'log', '-1', '--format=%h %s (%cr)'),
    git(dir, 'remote', 'get-url', 'origin'),
  ]);
  return {
    isRepo: true,
    branch: branch.out,
    changes: status.out ? status.out.split('\n').length : 0,
    lastCommit: last.ok ? last.out : '',
    remote: remote.ok ? cleanUrl(remote.out) : '',
  };
}

function slug(text) {
  return (
    String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'tarefa'
  );
}

/**
 * Prepara a branch da tarefa. Reaproveita a branch claude/* atual (continuação da conversa).
 * Retorna { branch, base, reused } ou { skipped: motivo } ou null (não é repositório).
 */
async function startBranch(dir, text, allow = '') {
  const i = await info(dir);
  if (!i.isRepo) return null;
  if (i.branch.startsWith('claude/')) return { branch: i.branch, reused: true };
  let changes = i.changes;
  // `allow`: arquivo (relativo, com /) que pode estar pendente, como a spec do SDD; ele vai junto para a branch.
  if (changes && allow) {
    const st = await git(dir, 'status', '--porcelain', '--untracked-files=all');
    changes = st.out.split('\n').filter((l) => l && l.slice(3).replace(/^"|"$/g, '') !== allow).length;
  }
  if (changes) return { skipped: `há ${changes} alteração(ões) não commitada(s) no projeto` };
  const name = `claude/${new Date().toLocaleDateString('sv')}-${slug(text)}`; // AAAA-MM-DD local
  let r = await git(dir, 'checkout', '-b', name);
  if (!r.ok) r = await git(dir, 'checkout', name); // já existe (mesmo texto no mesmo dia)
  if (!r.ok) return { skipped: r.err };
  return { branch: name, base: i.branch, reused: false };
}

// Commita tudo que o Claude deixou pendente. Retorna { changed, error? }.
async function commitAll(dir, message) {
  const st = await git(dir, 'status', '--porcelain');
  if (!st.ok || !st.out) return { changed: 0 };
  const changed = st.out.split('\n').length;
  await git(dir, 'add', '-A');
  const c = await git(dir, 'commit', '-m', message);
  return c.ok ? { changed } : { changed: 0, error: c.err };
}

// Quantos commits a branch tem a mais que a base.
async function aheadOf(dir, base, branch) {
  const r = await git(dir, 'rev-list', '--count', `${base}..${branch}`);
  return r.ok ? Number(r.out) || 0 : 0;
}

async function defaultBranch(dir) {
  const r = await git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  return r.ok ? r.out.replace(/^origin\//, '') : 'main';
}

async function openPr(dir, branch, base) {
  const push = await git(dir, 'push', '-u', 'origin', branch);
  if (!push.ok) return { ok: false, error: `push falhou: ${push.err}` };
  const pr = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--fill'], dir);
  if (!pr.ok && !/already exists/i.test(pr.err)) return { ok: false, error: `gh pr create falhou: ${pr.err}` };
  const url = (pr.out + '\n' + pr.err).match(/https:\/\/github\.com\/\S+/)?.[0] || '';
  await git(dir, 'checkout', base);
  return { ok: true, url };
}

async function discard(dir, branch, base) {
  const co = await git(dir, 'checkout', base);
  if (!co.ok) return { ok: false, error: co.err };
  const del = await git(dir, 'branch', '-D', branch);
  return del.ok ? { ok: true } : { ok: false, error: del.err };
}

// ---------- foto da pasta antes da tarefa (para /desfazer) ----------

// Árvore Git com tudo o que está na pasta agora (inclusive arquivos novos), sem mexer no índice real.
async function worktreeTree(dir) {
  const tmp = path.join(os.tmpdir(), `agente-index-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const idx = await git(dir, 'rev-parse', '--git-path', 'index');
    const real = idx.ok ? path.resolve(dir, idx.out) : '';
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp); // aproveita o cache do índice: bem mais rápido
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    const add = await run('git', ['add', '-A'], dir, 300000, env);
    if (!add.ok) return null;
    const w = await run('git', ['write-tree'], dir, 120000, env);
    return w.ok ? w.out : null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// { head, branch, tree, time } ou null (não é repositório).
async function snapshot(dir) {
  const i = await info(dir);
  if (!i.isRepo) return null;
  const [head, tree] = await Promise.all([git(dir, 'rev-parse', 'HEAD'), worktreeTree(dir)]);
  if (!tree) return null;
  return { head: head.ok ? head.out : null, branch: i.branch, tree, time: Date.now() };
}

// A pasta mudou desde a foto?
async function changedSince(dir, snap) {
  const [head, tree] = await Promise.all([git(dir, 'rev-parse', 'HEAD'), worktreeTree(dir)]);
  return !tree || tree !== snap.tree || (head.ok ? head.out : null) !== snap.head;
}

// Volta a pasta (e commits locais) para a foto. Arquivos ignorados pelo .gitignore não são tocados.
// O estado anterior fica guardado em refs/agente/antes-do-desfazer.
async function restore(dir, snap) {
  const i = await info(dir);
  if (!i.isRepo) return { ok: false, error: 'a pasta não é mais um repositório Git.' };
  if (snap.branch && i.branch !== snap.branch) return { ok: false, error: `a tarefa trocou de branch (${snap.branch} → ${i.branch}).` };
  const head = await git(dir, 'rev-parse', 'HEAD');
  const moved = snap.head && head.ok && head.out !== snap.head;
  if (moved) {
    const pushed = await git(dir, 'branch', '-r', '--contains', head.out);
    if (pushed.ok && pushed.out) return { ok: false, error: 'as alterações já foram enviadas ao GitHub (push). Peça uma tarefa para reverter.' };
  }
  const cur = await worktreeTree(dir);
  if (!cur) return { ok: false, error: 'não consegui ler o estado atual da pasta.' };

  const backup = await git(dir, 'commit-tree', cur, ...(head.ok ? ['-p', head.out] : []), '-m', 'agente: estado antes do /desfazer');
  if (backup.ok) await git(dir, 'update-ref', 'refs/agente/antes-do-desfazer', backup.out);

  if (moved) {
    const r = await git(dir, 'reset', '--soft', snap.head);
    if (!r.ok) return { ok: false, error: r.err };
  }
  // Apaga o que a tarefa criou e restaura o resto.
  const added = await git(dir, 'diff-tree', '-r', '-z', '--name-only', '--diff-filter=A', snap.tree, cur);
  for (const f of added.out.split('\0').filter(Boolean)) {
    const file = path.join(dir, f);
    fs.rmSync(file, { force: true });
    for (let d = path.dirname(file); d.length > dir.length; d = path.dirname(d)) {
      try {
        fs.rmdirSync(d); // só remove pastas que ficaram vazias
      } catch {
        break;
      }
    }
  }
  const r = await git(dir, 'restore', '--source', snap.tree, '--worktree', '--', '.');
  if (!r.ok && !/did not match any file/i.test(r.err)) return { ok: false, error: r.err };
  await git(dir, 'reset', '-q');
  return { ok: true };
}

// Aceita "dono/repo", URL https ou ssh.
function repoName(repo) {
  const s = String(repo || '').trim().replace(/\.git$/, '');
  const m = s.match(/github\.com[/:]([^/\s]+\/[^/\s]+)$/) || s.match(/^([\w.-]+\/[\w.-]+)$/);
  return m ? m[1] : null;
}

async function clone(repo, dest) {
  if (fs.existsSync(dest)) return { ok: false, error: `a pasta já existe: ${dest}` };
  const r = await run('gh', ['repo', 'clone', repo, dest], path.dirname(dest), 15 * 60 * 1000);
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

// Repositórios do usuário logado (ou de uma organização, com `owner`).
async function listRepos(owner) {
  const args = ['repo', 'list', ...(owner ? [owner] : []), '--limit', '300', '--json', 'nameWithOwner,description,updatedAt,isPrivate,url'];
  const r = await run('gh', args);
  if (!r.ok) return { ok: false, error: r.err };
  try {
    return { ok: true, repos: JSON.parse(r.out) };
  } catch {
    return { ok: false, error: 'resposta inválida do gh' };
  }
}

// ---------- conta do GitHub (via GitHub CLI) ----------

// { installed, connected, login, name, avatar, url, orgs }
async function account() {
  const v = await run('gh', ['--version'], undefined, 15000);
  if (!v.ok) return { installed: false, connected: false };
  const u = await run('gh', ['api', 'user', '--jq', '{login,name,avatar_url,html_url}'], undefined, 20000);
  if (!u.ok) return { installed: true, connected: false };
  const o = await run('gh', ['api', 'user/orgs', '--jq', '[.[].login]'], undefined, 20000);
  try {
    const user = JSON.parse(u.out);
    return {
      installed: true,
      connected: true,
      login: user.login,
      name: user.name || '',
      avatar: user.avatar_url,
      url: user.html_url,
      orgs: o.ok ? JSON.parse(o.out || '[]') : [],
    };
  } catch {
    return { installed: true, connected: false };
  }
}

// Login pelo navegador com código de dispositivo: o gh mostra o código e espera a autorização.
let login = { status: 'idle' }; // idle | waiting | done | error
let loginChild = null;

function startLogin() {
  if (loginChild) return login;
  login = { status: 'waiting', code: '', url: 'https://github.com/login/device' };
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'repo,read:org,workflow'], {
    windowsHide: true,
  });
  loginChild = child;
  let out = '';
  const onData = (d) => {
    out += d;
    const code = out.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
    if (code) login.code = code[1];
    const url = out.match(/https:\/\/github\.com\/login\/device\S*/);
    if (url) login.url = url[0];
  };
  child.stdout.setEncoding('utf8').on('data', onData);
  child.stderr.setEncoding('utf8').on('data', onData);
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 15 * 60 * 1000); // o código expira em 15 min
  child.on('close', async (code) => {
    clearTimeout(timer);
    loginChild = null;
    if (code === 0) {
      await run('gh', ['auth', 'setup-git']); // git push/clone passam a usar a conta do gh
      login = { status: 'done' };
    } else if (login.status === 'waiting') {
      login = { status: 'error', error: out.trim().split('\n').pop() || 'login cancelado ou expirado' };
    }
  });
  child.on('error', (err) => {
    loginChild = null;
    login = { status: 'error', error: err.message };
  });
  return login;
}

function cancelLogin() {
  loginChild?.kill();
  loginChild = null;
  login = { status: 'idle' };
  return login;
}

function loginState() {
  return login;
}

async function logout() {
  const r = await run('gh', ['auth', 'logout', '--hostname', 'github.com']);
  login = { status: 'idle' };
  return r.ok ? { ok: true } : { ok: false, error: r.err };
}

module.exports = {
  run,
  info,
  startBranch,
  commitAll,
  aheadOf,
  defaultBranch,
  openPr,
  discard,
  snapshot,
  changedSince,
  restore,
  worktreeTree,
  repoName,
  clone,
  listRepos,
  cleanUrl,
  account,
  startLogin,
  cancelLogin,
  loginState,
  logout,
};
