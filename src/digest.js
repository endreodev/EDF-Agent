const tasklog = require('./tasklog');

const cut = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));

/**
 * Resumo da manhã (texto para o WhatsApp).
 * s: { approvals, projects, plans, proposals, sites, schedules, queued, rateLimit, missions }
 */
function build(s) {
  const now = new Date();
  const lines = [`☀️ *Bom dia!* Resumo de ${now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })}`];

  // Ontem
  const from = tasklog.PERIODS.ontem.from();
  const to = tasklog.PERIODS.ontem.to();
  const done = tasklog.all().filter((t) => t.time >= from && t.time < to && t.kind !== 'plano');
  if (done.length) {
    const by = new Map();
    for (const t of done) {
      const g = by.get(t.project) || { n: 0, ms: 0, fail: 0 };
      g.n++;
      g.ms += t.ms || 0;
      if (!t.ok) g.fail++;
      by.set(t.project, g);
    }
    const total = done.reduce((sum, t) => sum + (t.ms || 0), 0);
    lines.push('', `*Ontem* · ${done.length} tarefa(s) · ${tasklog.fmtMin(total / 60000)}`);
    for (const [name, g] of [...by].sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`- ${name}: ${g.n} · ${tasklog.fmtMin(g.ms / 60000)}${g.fail ? ` · ${g.fail} com erro` : ''}`);
    }
  } else {
    lines.push('', '*Ontem*: nenhuma tarefa.');
  }

  // O que depende de você
  const wait = [];
  for (const a of s.approvals || []) wait.push(`- 🚀 Publicação #${a.id} em *${a.project}*: ${a.summary} → /aprovar ${a.id}`);
  for (const p of s.projects || []) if (p.gitBranch) wait.push(`- 🌿 *${p.name}*: branch ${p.gitBranch} → /pr ou /descartar`);
  for (const p of s.plans || []) wait.push(`- 📝 Plano em *${p.project}* esperando seu ok`);
  for (const m of s.missions || []) if (m.status === 'pausada') wait.push(`- ⏸️ Missão #${m.id} em *${m.project}*: ${m.pauseReason || 'pausada'} → /missao retomar ${m.id}`);
  if (s.proposals) wait.push(`- 💡 ${s.proposals} sugestão(ões) esperando 👍 (issues, e-mails, correções)`);
  if (wait.length) lines.push('', '*Esperando você*', ...wait);

  // Missões em andamento
  const act = (s.missions || []).filter((m) => m.status === 'ativa');
  if (act.length) {
    lines.push('', '*Missões em andamento*');
    for (const m of act) {
      const pr = m.progress || {};
      lines.push(`- 🎯 #${m.id} [${m.project}] ${cut(m.goal, 70)}${pr.total ? ` · ${pr.done}/${pr.total} itens` : ''} · ${m.runs} rodada(s)${m.note ? `\n  ↳ ${cut(m.note, 120)}` : ''}`);
    }
  }

  // Sites
  const sites = s.sites || [];
  if (sites.length) {
    const down = sites.filter((x) => !x.up);
    const ssl = sites.filter((x) => x.sslDays != null && x.sslDays < 15);
    lines.push('', '*Sites*');
    if (!down.length && !ssl.length) lines.push(`- 🟢 todos no ar (${sites.length})`);
    for (const x of down) lines.push(`- 🔴 *${x.project}*: ${x.status || 'fora do ar'}`);
    for (const x of ssl) lines.push(`- 🔐 *${x.project}*: SSL ${x.sslDays < 0 ? 'VENCIDO' : `vence em ${x.sslDays} dia(s)`}`);
  }

  // Hoje
  const today = (s.schedules || []).filter((x) => x.days.includes(now.getDay())).sort((a, b) => a.time.localeCompare(b.time));
  if (today.length) lines.push('', '*Agendado para hoje*', ...today.map((x) => `- ${x.time} [${x.project}] ${String(x.text).slice(0, 80)}`));
  if (s.queued) lines.push('', `📥 ${s.queued} tarefa(s) na fila.`);

  const week = s.rateLimit?.unifiedWindows?.seven_day;
  if (week) lines.push('', `📈 Assinatura do Claude: ${Math.round(week.utilization * 100)}% da semana usada.`);
  return lines.join('\n');
}

module.exports = { build };
