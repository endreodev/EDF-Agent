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

/**
 * Executa o Claude Code em modo headless dentro de `cwd`.
 * onProgress({ text?, tool? }) é chamado a cada texto/ferramenta usada no meio do caminho.
 * Retorna { promise, cancel }.
 */
function runClaude({ prompt, cwd, sessionId, config, onProgress, projectContext, permissionMode, addDirs = [] }) {
  const systemPrompt = projectContext ? `${SYSTEM_PROMPT}\n\n${projectContext}` : SYSTEM_PROMPT;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode || config.permissionMode || 'auto',
    '--append-system-prompt', systemPrompt,
  ];
  if (config.model) args.push('--model', config.model);
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (sessionId) args.push('--resume', sessionId);

  // Garante o uso do login da assinatura (claude.ai): sem chave de API nem provedores pagos à parte.
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BASE_URL']) {
    delete env[k];
  }

  const child = spawn(config.claudePath || 'claude', args, {
    cwd,
    windowsHide: true,
    env,
  });

  let cancelled = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, (config.taskTimeoutMin || 60) * 60 * 1000);

  const promise = new Promise((resolve) => {
    let buf = '';
    let stderr = '';
    let result = null;
    let sid = sessionId || null;
    let lastText = '';

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
      } else if (ev.type === 'result') {
        result = ev;
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
      resolve({ ok: false, text: `Falha ao iniciar o Claude: ${err.message}`, sessionId: sid });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (cancelled) return resolve({ ok: false, cancelled: true, text: 'Tarefa cancelada.', sessionId: sid });
      if (timedOut) return resolve({ ok: false, timedOut: true, text: `Tempo limite de ${config.taskTimeoutMin} min atingido.`, sessionId: sid });
      if (result) {
        return resolve({
          ok: !result.is_error,
          text: (result.result || lastText || '(sem resposta)').trim(),
          sessionId: result.session_id || sid,
          costUsd: result.total_cost_usd,
          durationMs: result.duration_ms,
          turns: result.num_turns,
          raw: stderr,
        });
      }
      resolve({
        ok: false,
        text: (stderr.trim() || lastText || `Claude encerrou com código ${code}.`).slice(-3000),
        sessionId: sid,
        raw: stderr,
      });
    });

    child.stdin.end(prompt, 'utf8');
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      killTree(child);
    },
  };
}

module.exports = { runClaude };
