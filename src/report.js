const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR } = require('./store');
const { run } = require('./git');
const tasklog = require('./tasklog');

// Relatório de entregas para o cliente (PDF gerado pelo Edge/Chrome sem janela, sem gastar tokens).
// Os prints que o Claude manda em cada tarefa ficam guardados aqui para entrar no relatório.
const IMG_DIR = path.join(DATA_DIR, 'relatorios', 'imagens');
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const safeName = (s) => String(s || '').replace(/[^\w.-]+/g, '-');

// Copia até 4 imagens da pasta de envio da tarefa (antes/depois primeiro). Retorna os caminhos guardados.
function keepImages(outbox, project) {
  let files = [];
  try {
    files = fs.readdirSync(outbox).filter((f) => IMG_MIME[path.extname(f).toLowerCase()]);
  } catch {
    return [];
  }
  const rank = (f) => (/antes/i.test(f) ? 0 : /depois/i.test(f) ? 1 : 2);
  const dir = path.join(IMG_DIR, safeName(project));
  const out = [];
  for (const f of files.sort((a, b) => rank(a) - rank(b)).slice(0, 4)) {
    const src = path.join(outbox, f);
    try {
      if (fs.statSync(src).size > 3 * 1024 * 1024) continue;
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}-${safeName(f)}`);
      fs.copyFileSync(src, dest);
      out.push(dest);
    } catch {
      /* imagem problemática: fica de fora */
    }
  }
  return out;
}

function cleanup(days = 180) {
  const limit = Date.now() - days * 86400000;
  let dirs = [];
  try {
    dirs = fs.readdirSync(IMG_DIR);
  } catch {
    return;
  }
  for (const d of dirs) {
    const dir = path.join(IMG_DIR, d);
    try {
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file);
      }
    } catch {
      /* ignora */
    }
  }
}

function browserPath(config) {
  const local = process.env.LOCALAPPDATA || '';
  return [
    config.pdfBrowser,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find((p) => p && fs.existsSync(p));
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Pedido sem as marcações internas do bot (mensagem citada, avisos do sistema, plano aprovado…).
function cleanRequest(text) {
  return String(text || '')
    .replace(/^\[Respondendo à mensagem:[\s\S]*?"\]\s*/, '')
    .replace(/\[(Tarefa agendada|Aviso do sistema[^\]]*|Plano aprovado[^\]]*|Ajuste no plano[^\]]*|O dono autorizou[^\]]*)\]\s*/g, '')
    .replace(/^Pedido original:\s*/m, '')
    .trim();
}

// Resultado em HTML: sem a linha de status, com o *negrito* e _itálico_ do WhatsApp.
function resultHtml(text) {
  const body = String(text || '')
    .split('\n')
    .filter((l) => !/^\s*\*?status\*?\s*[:：]?/i.test(l))
    .join('\n')
    .trim();
  return esc(body)
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/\n/g, '<br>');
}

// Título da entrega: as primeiras frases do pedido (pula cumprimento curto), em até 160 caracteres, sem cortar palavra.
function headline(text) {
  const t = cleanRequest(text).replace(/\s+/g, ' ').trim();
  let out = '';
  for (const s of t.match(/[^.!?]+[.!?]*/g) || [t]) {
    if (out.length >= 45) break;
    out = (out + ' ' + s.trim()).trim();
  }
  if (out.length <= 160) return out;
  return out.slice(0, 160).replace(/\s+\S*$/, '') + '…';
}

function imgTag(file) {
  try {
    const mime = IMG_MIME[path.extname(file).toLowerCase()];
    return mime ? `<img src="data:${mime};base64,${fs.readFileSync(file).toString('base64')}">` : '';
  } catch {
    return '';
  }
}

function buildHtml({ project, label, tasks, hideTime }) {
  const total = tasks.reduce((s, t) => s + (t.ms || 0), 0) / 60000;
  const items = tasks
    .map((t) => {
      const imgs = (t.images || []).slice(0, 2).map(imgTag).filter(Boolean).join('');
      return `<section>
  <div class="meta">${esc(new Date(t.time).toLocaleDateString('pt-BR'))}${hideTime ? '' : ` · ${esc(tasklog.fmtMin((t.ms || 0) / 60000))}`}${t.who && t.who !== 'Você' ? ` · pedido por ${esc(t.who)}` : ''}</div>
  <h3>${esc(headline(t.text))}</h3>
  ${t.result ? `<p>${resultHtml(t.result)}</p>` : ''}
  ${imgs ? `<div class="imgs">${imgs}</div>` : ''}
</section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório ${esc(project)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1d2433; font-size: 11pt; line-height: 1.45; }
  header { border-bottom: 3px solid #2f6fed; padding-bottom: 10px; margin-bottom: 18px; }
  header h1 { margin: 0; font-size: 20pt; }
  header .sub { color: #5b6475; margin-top: 4px; }
  .totais { display: flex; gap: 28px; margin: 14px 0 22px; }
  .totais div { font-size: 9pt; color: #5b6475; }
  .totais b { display: block; font-size: 16pt; color: #1d2433; }
  section { border-left: 3px solid #d5dcea; padding: 2px 0 2px 12px; margin: 0 0 16px; page-break-inside: avoid; }
  section h3 { margin: 2px 0 4px; font-size: 11.5pt; }
  section p { margin: 0; color: #343c4d; }
  .meta { font-size: 8.5pt; color: #7a8395; text-transform: uppercase; letter-spacing: .03em; }
  .imgs { display: flex; gap: 8px; margin-top: 8px; }
  .imgs img { max-width: 49%; max-height: 230px; border: 1px solid #d5dcea; border-radius: 4px; }
  footer { margin-top: 28px; font-size: 8.5pt; color: #7a8395; }
</style></head><body>
<header><h1>Relatório de entregas · ${esc(project)}</h1><div class="sub">Período: ${esc(label)} · gerado em ${esc(new Date().toLocaleDateString('pt-BR'))}</div></header>
<div class="totais"><div><b>${tasks.length}</b>entrega(s)</div>${hideTime ? '' : `<div><b>${esc(tasklog.fmtMin(total))}</b>tempo de trabalho</div>`}</div>
${items}
<footer>Relatório gerado automaticamente a partir do registro de tarefas.</footer>
</body></html>`;
}

/** { project, periodName, hideTime, config, outDir } -> { ok, file, count } | { ok: false, error } */
async function generate({ project, periodName = 'mes', hideTime = false, config, outDir }) {
  const period = tasklog.PERIODS[periodName] || tasklog.PERIODS.mes;
  const from = period.from();
  const to = period.to ? period.to() : Infinity;
  // Para o cliente: só entregas concluídas que alteraram algo (sem planos, diagnósticos, perguntas e erros).
  // Registros antigos não têm "changed": entram como antes.
  const tasks = tasklog
    .all()
    .filter((t) => t.project === project && t.time >= from && t.time < to && t.ok && t.changed !== false && !['plano', 'diagnostico'].includes(t.kind));
  if (!tasks.length) return { ok: false, error: `nenhuma entrega concluída em *${project}* (${period.label}).` };
  const browser = browserPath(config);
  if (!browser) return { ok: false, error: 'não achei o Edge nem o Chrome para gerar o PDF (configure "pdfBrowser").' };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relatorio-'));
  try {
    const html = path.join(work, 'relatorio.html');
    fs.writeFileSync(html, buildHtml({ project, label: period.label, tasks, hideTime }), 'utf8');
    const file = path.join(outDir, `relatorio-${safeName(project)}-${periodName}-${new Date().toLocaleDateString('sv')}.pdf`);
    const r = await run(
      browser,
      ['--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(work, 'perfil')}`, '--no-pdf-header-footer', `--print-to-pdf=${file}`, `file:///${html.replace(/\\/g, '/')}`],
      work,
      120000
    );
    if (!fs.existsSync(file)) return { ok: false, error: `o navegador não gerou o PDF: ${(r.err || '').slice(0, 200)}` };
    return { ok: true, file, count: tasks.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { keepImages, cleanup, generate, cleanRequest, buildHtml };
