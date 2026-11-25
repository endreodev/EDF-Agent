#!/usr/bin/env node
// Consulta qualquer banco cadastrado em ferramentas/conexoes/<nome>.json, com saída curta (economiza tokens).
//   node sql.js <conexao> "SELECT ..."             tabela em texto (até --max linhas, padrão 50)
//   node sql.js <conexao> "SELECT ..." --csv f.csv  grava TODAS as linhas em CSV e mostra só o resumo
//   node sql.js <conexao> "SELECT ..." --json       linhas em JSON
//   node sql.js <conexao> --tabelas [filtro]        lista tabelas (cache em ferramentas/cache; --atualizar refaz)
//   node sql.js <conexao> --colunas <tabela>        colunas da tabela (cache)
//   node sql.js <conexao> --testar                  só testa a conexão
// Só leitura, a não ser que a conexão tenha "escrita": true E o comando venha com --escrita.
// Conexão: {"tipo":"postgres|mysql|sqlserver|oracle|sqlite","host","porta","banco","usuario","senha","escrita":false,"descricao"}
//   oracle: "banco" = service name (ou use "connectString"); sqlite: "arquivo".
// O driver é instalado sozinho em ferramentas/node_modules no primeiro uso.
const fs = require('fs');
process.removeAllListeners('warning'); // sem o aviso "SQLite is experimental" na saída
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.dirname(__dirname);
const CONN_DIR = path.join(ROOT, 'conexoes');
const CACHE_DIR = path.join(ROOT, 'cache');
const DRIVERS = { postgres: 'pg', mysql: 'mysql2', sqlserver: 'mssql', oracle: 'oracledb' };
const ALIASES = { postgresql: 'postgres', pg: 'postgres', mariadb: 'mysql', mssql: 'sqlserver', sqlsrv: 'sqlserver' };

const die = (msg) => {
  console.error('ERRO: ' + msg);
  process.exit(1);
};

function driver(pkg) {
  const local = path.join(ROOT, 'node_modules', pkg);
  if (!fs.existsSync(local)) {
    console.error(`(instalando o driver ${pkg}…)`);
    if (!fs.existsSync(path.join(ROOT, 'package.json'))) fs.writeFileSync(path.join(ROOT, 'package.json'), '{"private":true}\n');
    execSync(`npm i --no-audit --no-fund --silent ${pkg}`, { cwd: ROOT, stdio: 'ignore' });
  }
  return require(local);
}

// Remove comentários e textos entre aspas antes de checar se é só leitura.
function isReadOnly(sql) {
  const s = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .toLowerCase();
  if (!/^\s*(select|with|show|describe|desc|explain|pragma)\b/.test(s)) return false;
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|call|replace|into|lock)\b/.test(s)) return false;
  return !/;\s*\S/.test(s); // um comando só
}

async function connect(c) {
  const tipo = ALIASES[c.tipo] || c.tipo;
  if (tipo === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(c.arquivo, { readOnly: !c.escritaAtiva });
    return { tipo, query: async (q) => db.prepare(q).all(), close: async () => db.close() };
  }
  const lib = driver(DRIVERS[tipo] || die(`tipo de banco desconhecido: ${c.tipo}`));
  if (tipo === 'postgres') {
    const cl = new lib.Client({ host: c.host, port: c.porta, database: c.banco, user: c.usuario, password: c.senha, ssl: c.ssl || undefined, ...(c.opcoes || {}) });
    await cl.connect();
    if (!c.escritaAtiva) await cl.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    return { tipo, query: async (q) => (await cl.query(q)).rows, close: () => cl.end() };
  }
  if (tipo === 'mysql') {
    const cn = await lib.createConnection({ host: c.host, port: c.porta, database: c.banco, user: c.usuario, password: c.senha, ...(c.opcoes || {}) });
    if (!c.escritaAtiva) await cn.query('SET SESSION TRANSACTION READ ONLY');
    return { tipo, query: async (q) => (await cn.query(q))[0], close: () => cn.end() };
  }
  if (tipo === 'sqlserver') {
    const pool = await lib.connect({ server: c.host, port: c.porta, database: c.banco, user: c.usuario, password: c.senha, options: { trustServerCertificate: true, encrypt: false, ...(c.opcoes || {}) } });
    return { tipo, query: async (q) => (await pool.request().query(q)).recordset || [], close: () => pool.close() };
  }
  if (tipo === 'oracle') {
    const cn = await lib.getConnection({ user: c.usuario, password: c.senha, connectString: c.connectString || `${c.host}:${c.porta || 1521}/${c.banco}` });
    return {
      tipo,
      query: async (q) => (await cn.execute(q.replace(/;\s*$/, ''), [], { outFormat: lib.OUT_FORMAT_OBJECT, maxRows: 100000 })).rows || [],
      close: () => cn.close(),
    };
  }
}

const SCHEMA = {
  tabelas: {
    postgres: "SELECT table_schema||'.'||table_name AS tabela FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1",
    mysql: 'SELECT table_name AS tabela FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1',
    sqlserver: "SELECT TABLE_SCHEMA+'.'+TABLE_NAME AS tabela FROM INFORMATION_SCHEMA.TABLES ORDER BY 1",
    oracle: 'SELECT table_name AS TABELA FROM user_tables ORDER BY 1',
    sqlite: "SELECT name AS tabela FROM sqlite_master WHERE type IN ('table','view') ORDER BY 1",
  },
  colunas: {
    postgres: (t) => `SELECT column_name AS coluna, data_type AS tipo, is_nullable AS nulo FROM information_schema.columns WHERE table_name = '${t.split('.').pop()}' ORDER BY ordinal_position`,
    mysql: (t) => `SELECT column_name AS coluna, column_type AS tipo, is_nullable AS nulo FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${t}' ORDER BY ordinal_position`,
    sqlserver: (t) => `SELECT COLUMN_NAME AS coluna, DATA_TYPE AS tipo, IS_NULLABLE AS nulo FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${t.split('.').pop()}' ORDER BY ORDINAL_POSITION`,
    oracle: (t) => `SELECT column_name AS COLUNA, data_type||'('||data_length||')' AS TIPO, nullable AS NULO FROM all_tab_columns WHERE table_name = '${t.toUpperCase()}' ORDER BY column_id`,
    sqlite: (t) => `SELECT name AS coluna, type AS tipo, CASE "notnull" WHEN 1 THEN 'NO' ELSE 'YES' END AS nulo FROM pragma_table_info('${t}')`,
  },
};

const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

function table(rows, max) {
  if (!rows.length) return '(nenhuma linha)';
  const cols = Object.keys(rows[0]);
  const shown = rows.slice(0, max).map((r) => cols.map((c) => cell(r[c]).replace(/\s+/g, ' ').slice(0, 60)));
  const w = cols.map((c, i) => Math.max(c.length, ...shown.map((r) => r[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(w[i])).join(' | ');
  return [line(cols), w.map((n) => '-'.repeat(n)).join('-+-'), ...shown.map(line), rows.length > max ? `… ${rows.length} linhas (mostrando ${max}; use --csv para todas)` : `${rows.length} linha(s)`].join('\n');
}

function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (/[";\n,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(cell(r[c]))).join(';'))].join('\n') + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--csv', '--max', '--colunas'].includes(a)) opt[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) opt[a.slice(2)] = true;
    else pos.push(a);
  }
  const [nome, sql] = pos;
  if (!nome) die('uso: node sql.js <conexao> "SELECT ..." | --tabelas | --colunas <tabela> | --testar  (conexões: node f.js conexoes)');
  const file = path.join(CONN_DIR, nome + '.json');
  if (!fs.existsSync(file)) die(`conexão "${nome}" não cadastrada (crie ${file})`);
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.escritaAtiva = !!(c.escrita && opt.escrita);
  const tipo = ALIASES[c.tipo] || c.tipo;
  const max = Number(opt.max) || 50;

  // Esquema em cache: a mesma pergunta não vai de novo ao banco.
  const cacheFile = (k) => path.join(CACHE_DIR, nome, k.replace(/[^\w.-]+/g, '_') + '.json');
  const cached = async (k, q) => {
    const f = cacheFile(k);
    if (!opt.atualizar && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    const rows = await db.query(q);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(rows));
    return rows;
  };

  let query = sql;
  if (!opt.tabelas && !opt.colunas && !opt.testar) {
    if (!query) die('informe o SQL');
    if (!c.escritaAtiva && !isReadOnly(query)) die('só consultas de leitura (SELECT/WITH). Para alterar dados, a conexão precisa de "escrita": true e o comando, de --escrita (com autorização do dono).');
  }

  var db = await connect(c);
  try {
    let rows;
    if (opt.testar) {
      await db.query(tipo === 'oracle' ? 'SELECT 1 AS OK FROM dual' : 'SELECT 1 AS ok');
      return console.log(`Conexão ${nome} OK (${tipo})`);
    } else if (opt.tabelas) {
      rows = await cached('_tabelas', SCHEMA.tabelas[tipo]);
      const filtro = (sql || '').toLowerCase();
      const names = rows.map((r) => Object.values(r)[0]).filter((t) => !filtro || String(t).toLowerCase().includes(filtro));
      return console.log(`${names.length} tabela(s)${filtro ? ` com "${filtro}"` : ''}:\n${names.slice(0, opt.max ? max : 400).join(', ')}`);
    } else if (opt.colunas) {
      rows = await cached('col_' + opt.colunas, SCHEMA.colunas[tipo](String(opt.colunas).replace(/'/g, '')));
    } else {
      const t0 = Date.now();
      rows = await db.query(query);
      if (!Array.isArray(rows)) rows = [];
      console.error(`(${rows.length} linha(s) em ${Date.now() - t0} ms)`);
    }
    if (opt.csv) {
      fs.writeFileSync(opt.csv, '﻿' + csv(rows));
      console.log(`${rows.length} linha(s) gravadas em ${path.resolve(opt.csv)}\nPrimeiras linhas:\n${table(rows, Math.min(max, 5))}`);
    } else if (opt.json) console.log(JSON.stringify(rows.slice(0, max), (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    else console.log(table(rows, max));
  } finally {
    await db.close();
  }
}

main().catch((e) => die(e.message));
