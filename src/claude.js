const path = require('path');
const { spawn, execFile } = require('child_process');

const SYSTEM_PROMPT = `Você está sendo operado remotamente pelo WhatsApp. O usuário NÃO vê o terminal, só as suas mensagens finais.
Regras:
- Responda sempre em português do Brasil, de forma direta e curta.
- NUNCA inclua trechos de código, diffs, comandos, saídas de terminal ou conteúdo de arquivos nas respostas. Informe apenas o STATUS em linguagem simples.
- Formato da resposta final: *Status* (concluído / parcial / com erro), o que foi feito em poucos tópicos, os arquivos alterados (só os nomes) e próximos passos se houver.
- Use formatação compatível com WhatsApp: *negrito*, _itálico_, listas com "-". Não use tabelas markdown nem títulos com #.
- Trabalhe de forma autônoma até concluir a tarefa.
- Se precisar de uma decisão do usuário, faça a pergunta de forma clara e encerre a resposta; a resposta dele virá na próxima mensagem, na mesma sessão.
- Nunca faça git push, deploy, publicação ou exclusão de dados fora do projeto sem pedido explícito.`;

// Descrição amigável do passo (sem mostrar comandos ou código).
function describeTool(block) {
  const i = block.input || {};
  const file = i.file_path || i.notebook_path || '';
  const base = file ? path.basename(file) : '';
  switch (block.name) {
    case 'Read':
      return base ? `Lendo ${base}` : 'Lendo arquivos';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base ? `Editando ${base}` : 'Editando arquivos';
    case 'Write':
      return base ? `Salvando ${base}` : 'Salvando arquivo';
    case 'Bash':
    case 'PowerShell':
      return i.description ? `Executando: ${String(i.description).slice(0, 80)}` : 'Executando comando';
    case 'Grep':
    case 'Glob':
      return 'Pesquisando no projeto';
    case 'WebFetch':
    case 'WebSearch':
      return 'Pesquisando na web';
    case 'TodoWrite':
      return 'Organizando as etapas';
    case 'Task':
    case 'Agent':
      return 'Executando subtarefa';
    default:
      return block.name;
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    child.kill('SIGTERM');
  }
}

// Falhas passageiras (rede, servidor sobrecarregado): vale tentar de novo.
const TRANSIENT = /overloaded|529|50[0-4]\b|internal server error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|connection error|timed? ?out while|configuration file .* is corrupted/i;
const LIMIT = /usage limit|rate.?limit|limit reached|hit your limit|limite de uso/i;

// Pergunta no meio da tarefa: a rodada termina com [[PERGUNTA]] e o processo fica esperando a resposta.
const ASK = /\[\[PERGUNTA\]\]/;
const askText = (text) => String(text || '').replace(/\[\[PERGUNTA\]\][ \t]*/g, '').trim();

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

/**
 * Executa o Claude Code em modo headless dentro de `cwd`.
 * A entrada fica aberta (stream-json): inject(texto) manda uma mensagem extra para a tarefa em andamento.
 * onProgress({ text?, tool?, sessionId? }) é chamado a cada texto/ferramenta usada no meio do caminho.
 * Retorna { promise, cancel, inject }.
 */
/**
 * ask: { timeoutMin, max } liga a pausa por pergunta. onProgress recebe { ask: texto } quando a tarefa
 * pausa esperando o usuário, e { askTimeout: true } quando ninguém respondeu a tempo.
 */
function runClaude({ prompt, cwd, sessionId, fork = false, config, model, agents = null, onProgress, projectContext, permissionMode, addDirs = [], mcpConfig = null, allowedTools = [], disallowedTools = [], ask = null }) {
  const systemPrompt = projectContext ? `${SYSTEM_PROMPT}\n\n${projectContext}` : SYSTEM_PROMPT;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--replay-user-messages',
    '--verbose',
    '--permission-mode', permissionMode || config.permissionMode || 'auto',
    '--append-system-prompt', systemPrompt,
    // Só aceita o login da assinatura claude.ai (nunca chave de API / Console).
    '--settings', JSON.stringify({ forceLoginMethod: 'claudeai' }),
  ];
  const useModel = model !== undefined ? model : config.model;
  if (useModel) args.push('--model', useModel);
  if (agents) args.push('--agents', JSON.stringify(agents));
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (mcpConfig) args.push('--mcp-config', JSON.stringify(mcpConfig));
  if (allowedTools.length) args.push('--allowedTools', ...allowedTools);
  if (disallowedTools.length) args.push('--disallowedTools', ...disallowedTools);
  if (sessionId) args.push('--resume', sessionId);
  if (sessionId && fork) args.push('--fork-session');

  // Garante o uso do login da assinatura (claude.ai): sem chave de API nem provedores pagos à parte.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(k) || /^CLAUDE_CODE_USE_/i.test(k)) delete env[k];
  }

  const child = spawn(config.claudePath || 'claude', args, {
    cwd,
    windowsHide: true,
    env,
  });

  let cancelled = false;
  let timedOut = false;
  let inputOpen = true;
  let injected = 0; // mensagens extras enviadas
  let consumed = 0; // mensagens extras que o Claude já leu
  // Tempo limite da tarefa: fica parado enquanto ela espera a resposta de uma pergunta.
  let remaining = (config.taskTimeoutMin || 60) * 60 * 1000;
  let deadline = 0;
  let timer = null;
  const armTimer = () => {
    deadline = Date.now() + remaining;
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, remaining);
  };
  const pauseTimer = () => {
    clearTimeout(timer);
    remaining = Math.max(60000, deadline - Date.now());
  };
  armTimer();
  let asks = 0;
  let waiting = false; // parada esperando a resposta de uma pergunta
  let askTimer = null;
  const write = (text) => {
    injected++;
    child.stdin.write(userLine(text), 'utf8');
  };
  const resume = () => {
    if (!waiting) return;
    waiting = false;
    clearTimeout(askTimer);
    armTimer();
  };

  const closeInput = () => {
    if (!inputOpen) return;
    inputOpen = false;
    child.stdin.end();
  };

  const promise = new Promise((resolve) => {
    let buf = '';
    let stderr = '';
    const results = []; // um por rodada (mensagem extra que chega depois do fim abre outra rodada)
    let sid = sessionId || null;
    let lastText = '';
    let limit = null; // { resetsAt } quando o limite de uso da assinatura estourou
    let firstReplay = true;

    const handle = (ev) => {
      if (ev.session_id && ev.session_id !== sid) {
        sid = ev.session_id;
        onProgress?.({ sessionId: sid });
      }
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            lastText = block.text.trim();
            onProgress?.({ text: lastText });
          } else if (block.type === 'tool_use') {
            onProgress?.({ tool: describeTool(block) });
          }
        }
      } else if (ev.type === 'user' && ev.isReplay && typeof ev.message?.content === 'string') {
        if (firstReplay) firstReplay = false; // o pedido original
        else consumed++;
      } else if (ev.type === 'rate_limit_event') {
        const info = ev.rate_limit_info || {};
        if (info.status === 'rejected') limit = { resetsAt: Number(info.resetsAt) || null };
        onProgress?.({ rateLimit: info });
      } else if (ev.type === 'result') {
        results.push(ev);
        if (consumed < injected) return; // há mensagem extra esperando: o Claude abre outra rodada
        // Terminou perguntando algo: pausa (sem fechar a entrada) até a resposta chegar por inject().
        if (ask && !ev.is_error && !cancelled && ASK.test(String(ev.result || '')) && asks < (ask.max || 3)) {
          asks++;
          ev.asked = true;
          waiting = true;
          pauseTimer();
          const min = Math.max(1, Number(ask.timeoutMin) || 30);
          askTimer = setTimeout(() => {
            if (!waiting || !inputOpen) return;
            resume();
            onProgress?.({ askTimeout: true });
            write(`[Aviso do sistema: o usuário não respondeu em ${min} min. Siga com a opção mais segura e reversível (nada destrutivo, nada publicado, nenhuma mensagem a terceiros) e diga na resposta final qual escolheu e por quê. Não pergunte de novo a mesma coisa.]`);
          }, min * 60000);
          onProgress?.({ ask: askText(ev.result) });
          return;
        }
        closeInput();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          /* linha não-JSON: ignora */
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(askTimer);
      inputOpen = false;
      resolve({ ok: false, text: `Falha ao iniciar o Claude: ${err.message}`, sessionId: sid });
    });
    child.stdin.on('error', () => {
      inputOpen = false; // processo já saiu
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(askTimer);
      inputOpen = false;
      if (cancelled) return resolve({ ok: false, cancelled: true, text: 'Tarefa cancelada.', sessionId: sid });
      if (timedOut) return resolve({ ok: false, timedOut: true, text: `Tempo limite de ${config.taskTimeoutMin} min atingido.`, sessionId: sid });
      const last = results[results.length - 1];
      if (last) {
        // As rodadas que só perguntaram já foram enviadas como pergunta: ficam fora da resposta final.
        const text =
          results
            .filter((r) => !r.asked || r === last)
            .map((r) => (r.asked ? askText(r.result) : String(r.result || '').trim()))
            .filter(Boolean)
            .join('\n\n—\n\n') ||
          lastText ||
          '(sem resposta)';
        const failed = !!last.is_error;
        return resolve({
          ok: !failed,
          text,
          sessionId: last.session_id || sid,
          costUsd: results.reduce((s, r) => s + (r.total_cost_usd || 0), 0),
          durationMs: results.reduce((s, r) => s + (r.duration_ms || 0), 0),
          turns: results.reduce((s, r) => s + (r.num_turns || 0), 0),
          limit: failed && (limit || LIMIT.test(text)) ? limit || {} : null,
          transient: failed && !limit && TRANSIENT.test(`${text} ${stderr}`),
          raw: stderr,
        });
      }
      const text = (stderr.trim() || lastText || `Claude encerrou com código ${code}.`).slice(-3000);
      resolve({
        ok: false,
        text,
        sessionId: sid,
        limit: limit || (LIMIT.test(text) ? {} : null),
        transient: !limit && TRANSIENT.test(text),
        raw: stderr,
      });
    });

    child.stdin.write(userLine(prompt), 'utf8');
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      killTree(child);
    },
    // Entrega uma mensagem extra ao Claude. false se a tarefa já está terminando (aí vira tarefa nova).
    inject(text) {
      if (!inputOpen || cancelled) return false;
      resume();
      write(text);
      return true;
    },
    // true enquanto a tarefa está parada esperando a resposta de uma pergunta.
    get waiting() {
      return waiting;
    },
  };
}

module.exports = { runClaude };
