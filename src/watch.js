const tls = require('tls');
const pc = require('./pc');

// Vigia dos sites dos projetos (fora do ar / SSL vencendo) e alertas do PC (disco, serviços, reinício).
const sites = new Map(); // url -> { up, fails, since, status, checked, sslDays, sslWarned }
let pcState = { disks: {}, services: {} };

async function checkUrl(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (agente-monitor)' } });
    // 401/403 indicam site no ar, só protegido.
    const up = res.status < 400 || res.status === 401 || res.status === 403;
    return { up, status: `HTTP ${res.status}` };
  } catch (err) {
    return { up: false, status: err.cause?.code || err.name === 'TimeoutError' ? `sem resposta (${err.cause?.code || 'tempo esgotado'})` : err.message };
  }
}

// A internet deste PC está funcionando? Usado para não culpar o site por falha de rede local.
async function internetOk() {
  for (const ref of ['https://www.google.com', 'https://www.cloudflare.com']) {
    try {
      await fetch(ref, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      return true;
    } catch {}
  }
  return false;
}

// Dias até o certificado vencer, ou null.
function sslDays(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      resolve(cert?.valid_to ? Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000) : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(null);
    });
  });
}

/**
 * opts: {
 *   config, log,
 *   targets(): [{ project, url, jid }]   sites a vigiar e para onde avisar
 *   pcTarget(): jid                     para onde mandar os alertas do PC
 *   notify(jid, text)
 *   onIssue?({ key, project, jid, detail })   problema novo (site fora, disco cheio, serviço parado): abre um diagnóstico
 * }
 */
function start(opts) {
  const { config, log, notify } = opts;
  const intervalMin = () => Math.max(1, Number(config.watchIntervalMin) || 5);

  async function siteRound() {
    if (config.watchSites === false) return;
    for (const t of opts.targets()) {
      const s = sites.get(t.url) || { up: true, fails: 0, since: Date.now(), notified: false };
      const r = await checkUrl(t.url);
      // Sem resposta e sem internet no PC: falha de rede local, não conta contra o site.
      if (!r.up && !r.status.startsWith('HTTP') && !(await internetOk())) {
        log(`[vigia] ${t.url} sem resposta, mas a internet do PC também caiu; checagem ignorada`);
        continue;
      }
      s.checked = Date.now();
      s.status = r.status;
      s.project = t.project;
      if (r.up) {
        if (s.notified) {
          const mins = Math.round((Date.now() - s.since) / 60000);
          notify(t.jid, `✅ *${t.project}* voltou ao ar (${r.status}) depois de ~${mins} min.\n${t.url}`);
          log(`[vigia] ${t.url} voltou`);
        }
        if (!s.up) s.since = Date.now();
        Object.assign(s, { up: true, fails: 0, notified: false });
      } else {
        s.fails++;
        if (s.up) s.since = Date.now();
        s.up = false;
        // Duas falhas seguidas antes de avisar (evita alarme falso por oscilação).
        if (s.fails === 2 && !s.notified) {
          s.notified = true;
          notify(t.jid, `🔴 *${t.project}* parece fora do ar: ${r.status}\n${t.url}\nAviso de novo quando voltar.`);
          log(`[vigia] ${t.url} fora do ar: ${r.status}`);
          opts.onIssue?.({ key: `site:${t.url}`, project: t.project, jid: t.jid, detail: `O site ${t.url} do projeto "${t.project}" está fora do ar: ${r.status} (2 checagens seguidas).` });
        }
      }
      // SSL: confere a cada 12 h; avisa uma vez por dia quando faltar menos de 15 dias.
      if (t.url.startsWith('https://') && (!s.sslChecked || Date.now() - s.sslChecked > 12 * 3600000)) {
        s.sslChecked = Date.now();
        s.sslDays = await sslDays(new URL(t.url).hostname);
        const today = new Date().toDateString();
        if (s.sslDays !== null && s.sslDays < 15 && s.sslWarned !== today) {
          s.sslWarned = today;
          notify(t.jid, `🔐 O certificado SSL de *${t.project}* ${s.sslDays < 0 ? 'está VENCIDO' : `vence em ${s.sslDays} dia(s)`}.\n${t.url}`);
        }
      }
      sites.set(t.url, s);
    }
  }

  async function pcRound() {
    const a = config.pcAlerts || {};
    if (a.enabled === false) return;
    const jid = opts.pcTarget();
    if (!jid) return;
    const limit = Number(a.diskPct) || 90;
    const today = new Date().toDateString();
    const d = await pc.diskList();
    if (d.ok) {
      for (const disk of d.list) {
        if (disk.pct >= limit && pcState.disks[disk.id] !== today) {
          pcState.disks[disk.id] = today;
          notify(jid, `💽 Disco quase cheio:\n${pc.describeDisk(disk)}`);
          opts.onIssue?.({ key: `disco:${disk.id}`, project: null, jid, detail: `O disco ${disk.id} do PC está com ${disk.pct}% de uso (limite ${limit}%). Descubra o que mais ocupa espaço e o que pode ser liberado com segurança.` });
        }
      }
    }
    const names = Array.isArray(a.services) ? a.services : [];
    const st = await pc.serviceStatus(names);
    for (const n of names) {
      const now = st[n] ?? 'não encontrado';
      const before = pcState.services[n];
      const stopped = now !== 'Running' && (before === undefined || before !== now);
      if (before !== undefined && before !== now) {
        notify(jid, now === 'Running' ? `🟢 Serviço *${n}* voltou a rodar.` : `🔴 Serviço *${n}* ${now === 'Stopped' ? 'parou' : `está ${now}`}.\nPara religar: /servico ${n} iniciar`);
      } else if (before === undefined && now !== 'Running') {
        notify(jid, `🔴 Serviço *${n}* não está rodando (${now}).\nPara religar: /servico ${n} iniciar`);
      }
      if (stopped && now !== 'não encontrado') {
        opts.onIssue?.({ key: `servico:${n}`, project: null, jid, detail: `O serviço do Windows "${n}" não está rodando (estado: ${now}). Veja no Visualizador de Eventos e nos logs dele por que parou.` });
      }
      pcState.services[n] = now;
    }
  }

  // Avisa se o PC reiniciou há pouco (o bot sobe junto com o Windows).
  async function bootCheck() {
    if ((config.pcAlerts || {}).enabled === false) return;
    const boot = await pc.bootTime();
    const jid = opts.pcTarget();
    if (boot && jid && Date.now() - boot < 20 * 60000) {
      notify(jid, `🔄 O PC foi ligado/reiniciado às ${new Date(boot).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. O agente está no ar.`);
    }
  }

  const safe = (fn, name) => () => fn().catch((err) => log(`[vigia] erro em ${name}:`, err));
  const loopSites = safe(siteRound, 'sites');
  const loopPc = safe(pcRound, 'pc');
  setTimeout(safe(bootCheck, 'boot'), 90000);
  setTimeout(function tick() {
    loopSites().finally(() => setTimeout(tick, intervalMin() * 60000));
  }, 60000);
  setTimeout(function tick() {
    loopPc().finally(() => setTimeout(tick, 10 * 60000));
  }, 120000);
}

function status() {
  return [...sites].map(([url, s]) => ({ url, ...s }));
}

module.exports = { start, status, checkUrl };
