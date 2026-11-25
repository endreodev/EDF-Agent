const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');
const { run, repoName } = require('./git');

// Gatilhos externos: issues novas e falhas do GitHub Actions nos repositórios dos projetos, e e-mails novos.
// Na primeira leitura de cada fonte só marca o que já existe como visto (não dispara nada antigo).
const FILE = path.join(DATA_DIR, 'triggers.json');
let st = {};
try {
  st = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  st = {};
}
st.issues ||= {};
st.runs ||= {};
st.emails ||= {};

function save() {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(st), 'utf8');
    fs.renameSync(FILE + '.tmp', FILE);
  } catch {
    /* sem estado: na próxima subida marca tudo como visto de novo */
  }
}

async function gh(args) {
  const r = await run('gh', args, undefined, 60000);
  if (!r.ok) throw new Error(r.err || 'gh falhou');
  return JSON.parse(r.out || '[]');
}

const FAILED = ['failure', 'timed_out', 'startup_failure'];

async function githubRound(opts) {
  for (const p of opts.projects()) {
    const repo = repoName(p.repo);
    if (!repo) continue;
    try {
      const issues = await gh(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '15', '--json', 'number,title,body,author,url']);
      const last = st.issues[repo];
      if (last !== undefined) {
        for (const i of issues.filter((x) => x.number > last).sort((a, b) => a.number - b.number)) {
          await opts.onIssue({ project: p.name, repo, number: i.number, title: i.title, body: i.body, url: i.url, author: i.author?.login || '' });
        }
      }
      st.issues[repo] = issues.reduce((m, i) => Math.max(m, i.number), last || 0);
    } catch (err) {
      opts.warn(`issues de ${repo}`, err);
    }
    try {
      const runs = await gh(['run', 'list', '-R', repo, '--limit', '10', '--json', 'databaseId,displayTitle,workflowName,headBranch,status,conclusion,url']);
      const seen = st.runs[repo];
      const done = runs.filter((r) => r.status === 'completed');
      if (seen) {
        for (const r of done) {
          if (!seen.includes(r.databaseId) && FAILED.includes(r.conclusion)) await opts.onRunFailed({ project: p.name, repo, ...r });
        }
      }
      st.runs[repo] = [...new Set([...done.map((r) => r.databaseId), ...(seen || [])])].slice(0, 50);
    } catch (err) {
      opts.warn(`Actions de ${repo}`, err);
    }
  }
  save();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d) => `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;

// Saída do ferramentas/bin/imap-caixa.py: "--- data | de | assunto" seguido do trecho do corpo, indentado.
function parseMails(out) {
  const mails = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('--- ')) {
      const [date = '', from = '', ...subject] = line.slice(4).split(' | ');
      mails.push({ date: date.trim(), from: from.trim(), subject: subject.join(' | ').trim(), body: '' });
    } else if (mails.length && line.trim()) {
      mails[mails.length - 1].body += (mails[mails.length - 1].body ? ' ' : '') + line.trim();
    }
  }
  return mails;
}

const mailHash = (m) => crypto.createHash('sha1').update(`${m.date}|${m.from}|${m.subject}`).digest('hex').slice(0, 16);

// config.triggers.email: [{ name, env, project?, from?: ["@cliente.com.br"], pasta? }]
async function emailRound(opts) {
  const boxes = Array.isArray(opts.config.triggers?.email) ? opts.config.triggers.email : [];
  for (const b of boxes) {
    if (!b?.env) continue;
    const key = b.name || b.env;
    const env = path.isAbsolute(b.env) ? b.env : path.join(opts.root, b.env);
    const args = [opts.imapTool, '--env', env, '--desde', imapDate(new Date(Date.now() - 86400000)), '--max', '30', '--chars', '800'];
    if (b.pasta) args.push('--pasta', b.pasta);
    const r = await run(opts.config.pythonPath || 'python', args, undefined, 90000, { ...process.env, PYTHONIOENCODING: 'utf-8' });
    if (!r.ok) {
      opts.warn(`e-mail ${key}`, new Error(r.err));
      continue;
    }
    const mails = parseMails(r.out);
    const seen = st.emails[key];
    const filters = (b.from || []).map((f) => String(f).toLowerCase());
    if (seen) {
      for (const m of mails) {
        if (seen.includes(mailHash(m))) continue;
        if (filters.length && !filters.some((f) => m.from.toLowerCase().includes(f))) continue;
        await opts.onEmail({ box: key, project: b.project || null, ...m });
      }
    }
    st.emails[key] = [...new Set([...mails.map(mailHash), ...(seen || [])])].slice(0, 300);
  }
  save();
}

/**
 * opts: { config, log, root, imapTool, ready(), projects(), onIssue(i), onRunFailed(r), onEmail(m) }
 */
function start(opts) {
  const warned = new Set();
  // Cada falha (gh sem login, repositório sem issues, caixa errada) é avisada no log uma vez só.
  opts.warn = (what, err) => {
    if (warned.has(what)) return;
    warned.add(what);
    opts.log(`[gatilhos] não consegui ler ${what}: ${String(err?.message || err).split('\n')[0].slice(0, 200)}`);
  };
  const minutes = () => Math.max(2, Number(opts.config.triggers?.intervalMin) || 10);
  const tick = async () => {
    const t = opts.config.triggers || {};
    if (t.enabled !== false && opts.ready()) {
      if (t.github !== false) await githubRound(opts).catch((err) => opts.log('[gatilhos] erro no GitHub:', err));
      await emailRound(opts).catch((err) => opts.log('[gatilhos] erro nos e-mails:', err));
    }
    setTimeout(tick, minutes() * 60000);
  };
  setTimeout(tick, 3 * 60000);
}

module.exports = { start, parseMails };
