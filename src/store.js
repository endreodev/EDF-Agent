const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE = path.join(ROOT, 'config.example.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- config ----------
if (!fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_EXAMPLE, CONFIG_FILE);
const config = { ...readJson(CONFIG_EXAMPLE, {}), ...readJson(CONFIG_FILE, {}) };

function saveConfig() {
  writeJson(CONFIG_FILE, config);
}

// ---------- projetos ----------
const db = readJson(PROJECTS_FILE, { current: null, projects: {} });

function saveProjects() {
  writeJson(PROJECTS_FILE, db);
}

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Informações extras do projeto que são passadas ao Claude em toda tarefa.
const PROJECT_FIELDS = ['description', 'stack', 'url', 'testCommand', 'notes', 'permissionMode'];
const PERMISSION_MODES = ['', 'auto', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'];

function pickFields(fields = {}) {
  const out = {};
  for (const f of PROJECT_FIELDS) {
    if (fields[f] === undefined) continue;
    out[f] = String(fields[f] ?? '').trim();
  }
  if (out.permissionMode && !PERMISSION_MODES.includes(out.permissionMode)) delete out.permissionMode;
  return out;
}

const projects = {
  list() {
    return Object.entries(db.projects).map(([name, p]) => ({ name, ...p }));
  },
  get(name) {
    const key = normalize(name);
    return db.projects[key] ? { name: key, ...db.projects[key] } : null;
  },
  add(name, dir, aliases = [], extra = {}) {
    const key = normalize(name);
    const prev = db.projects[key] || {};
    db.projects[key] = {
      ...prev,
      path: dir,
      aliases: aliases.map(normalize).filter(Boolean),
      sessionId: prev.sessionId || null,
      ...pickFields(extra),
    };
    if (!db.current) db.current = key;
    saveProjects();
    return key;
  },
  update(name, fields) {
    const key = normalize(name);
    if (!db.projects[key]) return false;
    Object.assign(db.projects[key], pickFields(fields));
    saveProjects();
    return true;
  },
  remove(name) {
    const key = normalize(name);
    if (!db.projects[key]) return false;
    delete db.projects[key];
    if (db.current === key) db.current = Object.keys(db.projects)[0] || null;
    saveProjects();
    return true;
  },
  setAliases(name, aliases) {
    const key = normalize(name);
    if (!db.projects[key]) return false;
    db.projects[key].aliases = aliases.map(normalize).filter(Boolean);
    saveProjects();
    return true;
  },
  setSession(name, sessionId) {
    const key = normalize(name);
    if (!db.projects[key]) return;
    db.projects[key].sessionId = sessionId || null;
    saveProjects();
  },
  get current() {
    return db.current && db.projects[db.current] ? projects.get(db.current) : null;
  },
  setCurrent(name) {
    const key = normalize(name);
    if (!db.projects[key]) return false;
    db.current = key;
    saveProjects();
    return true;
  },
  // Procura nome/apelido de projeto mencionado no texto ("...no projeto do site da nivix...").
  // Retorna o projeto com o termo mais longo encontrado, ou null.
  findInText(text) {
    const t = normalize(text);
    let best = null;
    for (const [name, p] of Object.entries(db.projects)) {
      for (const term of [name, ...(p.aliases || [])]) {
        if (!term) continue;
        const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`);
        if (re.test(t) && (!best || term.length > best.len)) best = { name, len: term.length };
      }
    }
    return best ? projects.get(best.name) : null;
  },
};

module.exports = { config, saveConfig, projects, normalize, DATA_DIR, ROOT, PERMISSION_MODES };
