// Põe (ou tira) conversas de uma lista/etiqueta do WhatsApp pela Evolution API.
// A lista precisa existir no app do WhatsApp (a Evolution não cria listas).
// Uso: node evolution-lista.js --env <projeto>/.env --lista "Prospecta" (--numeros 5565...,5565... | --arquivo nums.txt) [--remover] [--instancia nome] [--url http://localhost:8180]
//      node evolution-lista.js --env <projeto>/.env --listas   (só mostra as listas existentes)
const fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const env = Object.fromEntries(fs.readFileSync(arg('env', '.env'), 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const url = (arg('url') || env.EVOLUTION_URL || 'http://localhost:' + (env.EVOLUTION_PORT || 8180)).replace(/\/$/, '');
const inst = arg('instancia', env.EVOLUTION_INSTANCE || 'prospecta');
const h = { apikey: env.EVOLUTION_API_KEY || env.AUTHENTICATION_API_KEY, 'Content-Type': 'application/json' };

(async () => {
  const listas = await (await fetch(`${url}/label/findLabels/${inst}`, { headers: h })).json();
  if (flag('listas')) { for (const l of listas) console.log(l.id, '-', l.name); return; }
  const nome = arg('lista'); if (!nome) throw new Error('informe --lista');
  const lista = listas.find((l) => String(l.name).trim().toLowerCase() === nome.trim().toLowerCase());
  if (!lista) { console.log(`Lista "${nome}" não existe no WhatsApp. Existentes: ${listas.map((l) => l.name).join(', ')}`); process.exit(2); }
  const brutos = arg('numeros') ? arg('numeros').split(',') : fs.readFileSync(arg('arquivo'), 'utf8').split(/[\s,;]+/);
  const nums = [...new Set(brutos.map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 10)
    .map((n) => (n.length <= 11 ? '55' + n : n)))];
  const action = flag('remover') ? 'remove' : 'add';
  let ok = 0; const falhas = [];
  for (const n of nums) {
    try {
      const r = await fetch(`${url}/label/handleLabel/${inst}`, { method: 'POST', headers: h, body: JSON.stringify({ number: n, labelId: String(lista.id), action }) });
      if (r.ok) ok++; else falhas.push(n + ' (' + r.status + ')');
    } catch (e) { falhas.push(n + ' (' + e.message + ')'); }
    await new Promise((s) => setTimeout(s, 400));
  }
  console.log(`Lista "${lista.name}" (id ${lista.id}): ${action === 'add' ? 'adicionadas' : 'removidas'} ${ok} de ${nums.length} conversas.`);
  if (falhas.length) console.log('Falhas:', falhas.slice(0, 20).join(', '));
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
