#!/usr/bin/env node
// Gera o QR Code de conexão de uma instância da Evolution API (cria a instância se não existir).
// Uso: evolution-qrcode --env <arquivo .env> --saida <arquivo.png> [--instancia nome] [--url http://localhost:8180]
// Lê EVOLUTION_API_KEY, EVOLUTION_INSTANCE e PORT_EVOLUTION do .env indicado.
const fs = require('fs');
const a = process.argv.slice(2);
const arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
const envFile = arg('env', '.env');
const saida = arg('saida');
if (!saida) { console.log('uso: --env <.env> --saida <png> [--instancia x] [--url y]'); process.exit(1); }
const env = {};
for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const key = env.EVOLUTION_API_KEY;
const inst = arg('instancia', env.EVOLUTION_INSTANCE || 'prospecta');
const url = arg('url', 'http://localhost:' + (env.PORT_EVOLUTION || '8080')).replace(/\/$/, '');
const h = { apikey: key, 'Content-Type': 'application/json' };
(async () => {
  const lista = await (await fetch(url + '/instance/fetchInstances', { headers: h })).json();
  const ex = (Array.isArray(lista) ? lista : []).find((i) => i.name === inst);
  if (ex && ex.connectionStatus === 'open') { console.log(`instância ${inst} já conectada (${ex.ownerJid || ''})`); return; }
  if (!ex) {
    const r = await fetch(url + '/instance/create', { method: 'POST', headers: h,
      body: JSON.stringify({ instanceName: inst, integration: 'WHATSAPP-BAILEYS', qrcode: true, groupsIgnore: true }) });
    console.log('instância criada:', r.status);
    await new Promise((s) => setTimeout(s, 3000));
  }
  const j = await (await fetch(url + '/instance/connect/' + encodeURIComponent(inst), { headers: h })).json();
  if (!j.base64) { console.log('sem QR:', JSON.stringify(j).slice(0, 200)); process.exit(2); }
  fs.writeFileSync(saida, Buffer.from(j.base64.split(',').pop(), 'base64'));
  console.log(`QR salvo em ${saida} (vale ~1 min; rode de novo se expirar)`);
})().catch((e) => { console.log('erro:', e.message); process.exit(3); });
