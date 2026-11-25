#!/usr/bin/env node
// Análise rápida de um CSV/JSON sem carregar o arquivo inteiro no contexto do modelo.
//   node perfil.js dados.csv                              perfil das colunas (tipo, vazios, mín/máx, mais comuns)
//   node perfil.js dados.csv --agrupar cliente --somar valor [--top 20]   soma/contagem por grupo
//   node perfil.js dados.csv --filtro "status=PAGO"        filtra antes (col=valor, col>n, col<n)
// CSV: separador ; ou , detectado sozinho. JSON: array de objetos.
const fs = require('fs');

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.slice(0, text.indexOf('\n') >>> 0 || text.length);
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) row.push(cur), (cur = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur), (cur = '');
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// Aceita 1.234,56 e 1234.56.
const num = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (!/^-?[\d.,]+$/.test(s)) return NaN;
  return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
};

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) (argv[i].startsWith('--') ? (opt[argv[i].slice(2)] = argv[++i]) : pos.push(argv[i]));
  if (!pos[0]) return console.error('uso: node perfil.js <arquivo.csv|json> [--agrupar col --somar col --top N --filtro "col=valor"]'), 2;
  const text = fs.readFileSync(pos[0], 'utf8');
  let rows = /^\s*[[{]/.test(text) ? [].concat(JSON.parse(text)) : parseCsv(text);

  if (opt.filtro) {
    const m = opt.filtro.match(/^(.+?)(>=|<=|!=|=|>|<)(.*)$/);
    if (!m) return console.error('filtro: col=valor, col!=valor, col>n, col<n'), 2;
    const [, c, op, v] = m;
    rows = rows.filter((r) => {
      const a = r[c.trim()];
      const n = num(a), b = num(v);
      return op === '=' ? String(a) === v : op === '!=' ? String(a) !== v : op === '>' ? n > b : op === '<' ? n < b : op === '>=' ? n >= b : n <= b;
    });
  }
  console.log(`${rows.length} linha(s)`);
  if (!rows.length) return 0;
  const top = Number(opt.top) || 15;

  if (opt.agrupar) {
    const keys = opt.agrupar.split(',');
    const g = new Map();
    for (const r of rows) {
      const k = keys.map((c) => r[c]).join(' / ');
      const e = g.get(k) || { n: 0, s: 0 };
      e.n++;
      if (opt.somar) e.s += num(r[opt.somar]) || 0;
      g.set(k, e);
    }
    const list = [...g].sort((a, b) => (opt.somar ? b[1].s - a[1].s : b[1].n - a[1].n));
    const total = list.reduce((t, [, e]) => t + e.s, 0);
    console.log(`${g.size} grupo(s) por ${keys.join(', ')}${opt.somar ? ` · total ${opt.somar}: ${total.toLocaleString('pt-BR')}` : ''}`);
    for (const [k, e] of list.slice(0, top)) console.log(`- ${k || '(vazio)'}: ${e.n} linha(s)${opt.somar ? ` · ${e.s.toLocaleString('pt-BR')} (${total ? ((e.s / total) * 100).toFixed(1) : 0}%)` : ''}`);
    if (list.length > top) console.log(`… mais ${list.length - top} grupo(s) (--top N)`);
    return 0;
  }

  for (const c of Object.keys(rows[0])) {
    const vals = rows.map((r) => r[c]);
    const filled = vals.filter((v) => v !== '' && v !== null && v !== undefined);
    const nums = filled.map(num).filter((n) => !Number.isNaN(n));
    const freq = new Map();
    for (const v of filled) freq.set(String(v), (freq.get(String(v)) || 0) + 1);
    let line = `- ${c}: ${rows.length - filled.length} vazio(s), ${freq.size} distinto(s)`;
    if (nums.length && nums.length >= filled.length * 0.9) {
      const sum = nums.reduce((a, b) => a + b, 0);
      line += ` · número mín ${Math.min(...nums)} máx ${Math.max(...nums)} média ${(sum / nums.length).toFixed(2)} soma ${sum.toLocaleString('pt-BR')}`;
    } else {
      const common = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${String(v).slice(0, 30)}(${n})`);
      line += ` · mais comuns: ${common.join(', ')}`;
    }
    console.log(line);
  }
  return 0;
}

process.exitCode = main();
