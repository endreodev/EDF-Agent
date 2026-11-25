# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Ponte WhatsApp ⇄ Claude Code local. Um processo Node fica conectado ao WhatsApp (Baileys), ouve as conversas vinculadas e, para cada pedido, sobe um `claude -p` headless dentro da pasta do projeto cadastrado. A resposta volta pelo WhatsApp. Há também um painel web local em `http://localhost:3000`.

O código, os comentários, os logs e as mensagens ao usuário são em português do Brasil. Mantenha assim.

## Comandos

```
npm start                      # node src/index.js
start.bat                      # igual, mas reinicia sozinho 5 s depois de o processo sair
node --check src/index.js      # checagem de sintaxe (não há build, lint nem testes)
node ferramentas/f.js listar   # catálogo de ferramentas do agente (buscar | rodar <nome> | conexoes | registrar)
```

- Node >= 20, CommonJS puro, sem TypeScript e sem framework. A única exceção é `src/hostinger-guard.mjs` (ESM).
- Não existe suíte de testes. Valide com `node --check` e, quando fizer sentido, exercitando o módulo isolado.
- **Cuidado ao rodar `npm start` para testar:** o bot costuma estar rodando nesta máquina. Uma segunda instância usa a mesma sessão do WhatsApp (`data/auth`) e a mesma porta do painel. Para aplicar uma mudança, o processo em execução precisa ser reiniciado (com `start.bat`, basta encerrar o `node`).
- O `config.json` é lido uma vez na subida. `config.example.json` fornece os padrões e é mesclado por baixo; campo novo de configuração entra nos dois lugares e na tabela do README.
- Dependências externas opcionais, chamadas por `execFile`/`spawn`: `claude`, `git`, `gh`, `python` (faster-whisper e piper-tts), `cloudflared`, `php`.

## Arquitetura

### Fluxo de uma mensagem

`src/index.js` concentra quase tudo (cerca de 2.400 linhas, dividido por comentários `// ---------- seção ----------`). Os outros arquivos de `src/` são módulos auxiliares sem estado de orquestração.

1. `onMessage` filtra a mensagem do Baileys: duplicadas, histórico antigo, bloqueados, mensagens do próprio bot (prefixo `botPrefix`) e regras de acesso. Reações são desviadas para `onReaction`. Áudio é transcrito aqui (`transcribe.js` → `transcribe.py`).
2. `handleIncoming` separa comandos (`/…`, tratados em `handleCommand`, sem passar pelo Claude) de tarefas. O painel web entra por este mesmo ponto, via `ctx.sendTask`.
3. `enqueueTask` resolve o projeto, trata o plano pendente da pessoa ("ok" executa, outra resposta ajusta), decide entre **complementar** uma tarefa em andamento (`handle.inject`) ou enfileirar uma nova, e marca `planOnly` quando o pedido merece plano (`wantsPlan`).
4. `processQueue` → `pickLane` → `startTask` → `runTask`.
5. `runTask` monta o contexto, chama `runClaude` (`src/claude.js`), trata retomada, git, publicação e envia a resposta e os arquivos do outbox.

### Identidade: dono, pessoa e conversa

- `isOwner` vale para mensagens `fromMe` e para números em `allowedSenders`. Comandos administrativos, modo PC e publicação dependem dele.
- `person` é `'p:<número>'` para quem não é o próprio dono, ou `null` para o dono. Ele define a sessão do Claude (`projects.setSession(name, id, person)`), os limites diários e a fila por pessoa.
- A mesma conversa pode chegar como `@lid` ou `@s.whatsapp.net`; `onMessage` espelha `allowedChats`/`chatProjects` entre os dois JIDs.
- Resolução do projeto: `config.chatProjects[jid]` (grupo ligado) → nome/apelido citado no texto (`projects.findInText`) → projeto atual. Na conversa direta com o bot (`isFreeChat`), sem projeto citado, cai no projeto especial `pc` (agente livre).

### Fila, faixas e paralelismo

Estado em memória no topo do `index.js`: `queues` (por projeto), `running` (por id de tarefa), `locks` (pasta principal ocupada) e `pendingPatches`.

- Cada tarefa roda numa faixa: `main` (a pasta do projeto) ou `wt` (cópia isolada via `git worktree` em `data/worktrees`, ver `src/worktree.js`).
- `pickLane` devolve `null` para "espere": projeto com lock, mesma pessoa já com tarefa ativa (salvo `forceNew`, de "nova tarefa:"), ou limite `maxPerProject` atingido. Tarefas de publicação e o modo PC nunca vão para `wt`.
- Ao fim de uma tarefa `wt`, a diferença vira patch e é aplicada na pasta principal por `applyParallel`. Se a faixa `main` estiver ocupada, o patch espera em `pendingPatches` e é aplicado por `flushPatches`. Em conflito, vira a branch `claude/paralelo-<id>`.
- Sessão do Claude só é retomada e gravada na faixa `main`; tarefas `wt` sempre começam conversa nova. Por isso, tudo que precisa continuar uma conversa (plano, execução de plano aprovado, diagnóstico e sua correção) é enfileirado com `noParallel`.
- A fila é persistida em `data/queue.json` (`saveQueue`, chamado no fim de `processQueue`) e restaurada por `restoreQueue` na primeira conexão. Antes disso `saveQueue` não grava, para não apagar a fila antiga. Tarefas que estavam rodando voltam com um aviso de retomada e `restarts` contado.

### Tarefas somente leitura

`task.planOnly` (plano antes de executar) e `task.diagnose` (aberta pelo vigia ou por falha de CI) rodam com `readOnly` em `runTask`: sem ferramentas de edição nem comandos git que alteram o repositório (`READ_ONLY_DENY`), sem branch, sem foto para desfazer, sem verificação, sem liberar exclusões na Hostinger e ignorando `[[PUBLICAR]]`. Diagnósticos usam a pessoa `sys:vigia`, uma sessão separada da conversa do dono, e `diagnose()` limita a um por problema a cada 6 h.

### SDD (src/sdd.js)

Especificação antes do código, configurada por projeto (`sdd`, `sddDir`, `sddTemplate`, `sddReview`, `sddRules` em `PROJECT_FIELDS`). É uma variação do plano:
- `enqueueTask` marca `task.sddSpec` (arquivo novo da spec) junto com `planOnly` quando `sdd.wants()` ou `!spec`. A rodada é só leitura, então o Claude devolve a spec entre `[[SPEC]]`…`[[/SPEC]]` e o `runTask` grava o arquivo, manda uma cópia pelo outbox e guarda `sddFile` no plano pendente.
- Aprovar (ok, 👍, painel) gera `task.sddExec` com o mesmo arquivo, que injeta `execInstructions`. Ajustar mantém `sddSpec` com `sddRevise`. A spec não commitada não bloqueia `gitx.startBranch` (parâmetro `allow`).
- Na execução, as linhas `[[MELHORIA]]` da retrospectiva viram sugestões (`addProposal` com `rule`). `acceptProposal` grava a regra em `sddRules` sem rodar o Claude, e as regras entram nas instruções das próximas specs e execuções.
- O `tasklog` registra `kind: 'spec'` e `kind: 'sdd'`.

### Pergunta no meio da tarefa, missões e lições

- **Pergunta (`[[PERGUNTA]]`)**: em `runClaude` com a opção `ask`, uma rodada cujo `result` contém a marcação não fecha o stdin. A tarefa fica parada (`handle.waiting`, `state.asking`), o tempo limite pausa, e `onProgress({ ask })` manda a pergunta. A resposta entra por `inject()`. Ela é encontrada no começo do `enqueueTask` por `findAsking`, só para mensagens de gente (`opts.canAnswer`, marcado em `handleIncoming`). Sem resposta em `askTimeoutMin`, o próprio `claude.js` injeta o aviso para seguir pela opção segura. As rodadas que só perguntaram ficam fora do texto final.
- **Missões (`src/missions.js`, `data/missions.json`)**: `missionTick` (a cada 60 s) enfileira uma rodada por vez com `person: 'sys:missao:<id>'`, sessão própria, `keepSession` e `task.mission`. Só roda com o projeto livre, abaixo de `maxRunsPerDay` e de `maxUsagePct` do uso das 5 h. O checklist fica em `memoria/missoes/` e é escrito pelo Claude. A linha `[[MISSAO]] andamento|concluida|pausar` é lida por `afterMissionRun`. Rodadas de missão não podem publicar direto (`canPublish` falso) nem fazer exclusões na Hostinger, e não mandam mensagens de progresso.
- **Lições (`src/lessons.js`)**: o campo `lessons` do projeto entra no contexto de toda tarefa. Sem `readOnly`, o Claude pode sugerir até 2 `[[LICAO]]`, que viram sugestões (`addProposal` com `lesson`). `acceptProposal` grava a lição sem rodar o Claude. `enqueueTask` marca `task.correction` quando a mensagem parece corrigir uma tarefa recente da mesma pessoa.

### Reações e sugestões

Cada resposta final do bot registra em `msgMeta` (via `remember(ids, meta)`) o que uma reação nela faz: `{ approval, plan, proposal, mission, project }`. O estado fica em `data/reactions.json`. Conteúdo externo (issue, e-mail, correção de diagnóstico) não vira tarefa direto: vira uma **sugestão** (`addProposal`) que só é executada com o 👍 do dono (`acceptProposal`). Texto de terceiros vai para o Claude embrulhado em `untrustedNote`.

### `runClaude` (src/claude.js)

- Usa `--input-format stream-json` com o stdin aberto. É isso que permite `inject()` mandar mensagens extras durante a tarefa. O stdin só fecha quando chega um `result` e todas as mensagens injetadas já foram lidas (contadores `injected`/`consumed`, alimentados por `--replay-user-messages`).
- Remove variáveis `ANTHROPIC_*` e `CLAUDE_CODE_USE_*` do ambiente e força `forceLoginMethod: 'claudeai'`: o bot só usa o login da assinatura, nunca chave de API. O `index.js` também apaga `CLAUDECODE` do ambiente para o filho não se achar aninhado.
- Devolve `limit` (limite de uso, com `resetsAt`) e `transient` (falha de rede). `runTask` usa os dois para reenfileirar a tarefa com `notBefore` e retomar sozinho na mesma sessão.

### Contexto e marcações

O prompt de sistema de cada tarefa é a concatenação de funções `*Instructions()` do `index.js` (projeto, modo PC, verificação, navegador, Hostinger, memória, ferramentas, voz…). Para mudar o comportamento do agente, normalmente é ali que se mexe, e não no `SYSTEM_PROMPT` base de `claude.js`.

O Claude filho conversa com o bot por marcações no texto da resposta, removidas antes do envio:

- `[[PUBLICAR]] resumo`: pedido de publicação. Quem pode publicar (`canPublish`) gera uma tarefa de push na hora; os demais ficam em `data/approvals.json` esperando `/aprovar`.
- `[[VOZ]] texto`: versão falada da resposta (`tts.js`, Piper).
- `[[SPEC]]…[[/SPEC]]` e `[[MELHORIA]] regra`: especificação e sugestões de melhoria do SDD (ver acima).
- `[[PERGUNTA]] texto`: pausa a tarefa esperando a resposta (ver acima).
- `[[MISSAO]] status resumo` e `[[LICAO]] lição`: fim de rodada de missão e lição sugerida.
- `[[NOVA_MENSAGEM]]`: divide a resposta em várias mensagens (projetos com `chatMode: 'sim'`).

Arquivos para o usuário: o Claude grava numa pasta outbox temporária (`media.createOutbox`), que `sendOutbox` envia e apaga ao fim da tarefa.

### Permissões e travas

- `allowedTools`/`disallowedTools` são montados por tarefa em `runTask`: ferramentas de git/publicação só para quem pode publicar, Hostinger só para o dono, Playwright MCP conforme `browserCheck`.
- No modo PC, `bypassPermissions` é rebaixado para `auto`.
- `src/hostinger-guard.mjs` embrulha o `hostinger-api-mcp` com um interceptor do axios: uma lista `NEVER` de operações sempre bloqueadas e operações destrutivas liberadas só com `HOSTINGER_GUARD_ALLOW=1`. O token vem de `config.hostingerApiToken`, nunca da linha de comando.
- O painel (`src/web.js`) só aceita `Host` local e `POST` com `application/json` (proteção contra DNS rebinding e formulários de outros sites). Ele não tem lógica própria: cada rota chama uma função do objeto `ctx` montado no fim do `index.js`. Rota nova = caso no `switch` de `web.js` + função no `ctx`. A interface usa Bootstrap 5.3 e Bootstrap Icons com as cores padrão, servidos do `node_modules` em `/vendor/` (sem CDN): `GET /` entrega `src/dashboard.html` e `GET /painel` entrega `src/panel.html` (conversas, projetos, GitHub, WhatsApp e logs, abas por `#hash`). Ambos são lidos a cada requisição, então mudar o HTML não exige reiniciar. O visual segue o template Sneat (menu lateral `.layout-menu`, barra flutuante `.layout-navbar`, roxo `#696cff`, tema claro por padrão), recriado em `src/tema.css` (`GET /tema.css`, também lido a cada requisição) sobre o Bootstrap; o menu fica repetido nos dois HTML. Prefira componentes e utilitários do Bootstrap a CSS próprio. O dashboard usa `GET /api/dashboard` (`dashboardData()` no `index.js`, agregados do `tasklog` com cache de 15 s) e `POST /api/pending` (`resolvePending`: publicação, plano ou sugestão).

### Desfazer e fluxo Git (src/git.js)

- Antes de cada tarefa na faixa `main`, `gitx.snapshot` tira uma "foto" do projeto. Ela só é guardada em `lastTask` se a tarefa de fato mudou algo, e é o que `/desfazer` e `/refazer` usam.
- Projetos com `gitFlow: 'branch'` rodam cada tarefa numa branch `claude/<data>-<resumo>`, commitada no fim. O push só acontece no `/pr`.

### Onde fica o estado

Tudo abaixo está fora do git:

| Local | Conteúdo |
|---|---|
| `config.json` | configuração, conversas vinculadas, números autorizados, tokens |
| `data/projects.json` | projetos, apelidos, sessões do Claude, estado git por projeto (`src/store.js`; campos editáveis em `PROJECT_FIELDS`, o resto via `setState`) |
| `data/auth/` | credenciais do WhatsApp |
| `data/tasks.jsonl` | registro de tarefas (`tasklog.js`), base de `/resumo`, `/uso`, dos limites, do resumo da manhã (`digest.js`) e do `/relatorio` (`report.js`); campos `kind`, `changed` e `images` |
| `data/queue.json`, `data/reactions.json` | fila persistente, planos pendentes, ações das reações e sugestões (`persist.js`) |
| `data/missions.json`, `memoria/missoes/` | missões e seus checklists (`missions.js`) |
| `data/triggers.json` | o que os gatilhos externos já viram (`triggers.js`) |
| `data/relatorios/imagens/` | prints das tarefas guardados para o relatório |
| `data/worktrees/`, `data/patches/` | cópias paralelas e seus patches |
| `memoria/<projeto>.md` | memória por projeto, escrita pelo Claude filho |
| `memoria/agente/` | memória do agente livre: `INDICE.md`, tópicos e `diario/AAAA-MM.md` |
| `ferramentas/conexoes/`, `ferramentas/cache/` | credenciais de banco e cache de esquemas |

Nunca leia nem exiba o conteúdo de `ferramentas/conexoes/`, `data/auth/` ou os tokens do `config.json`.

### `ferramentas/`

Caixa de ferramentas que o agente filho cria e reaproveita (detalhes em `ferramentas/README.md`). É um pacote à parte, com `package.json` próprio. `f.js` é ao mesmo tempo CLI e módulo: o `index.js` faz `require('../ferramentas/f.js')` e usa `toolbox.search` para injetar o catálogo no contexto e para rotear pedidos ao modelo econômico (`pickModel`). O `catalogo.json` só deve ser alterado por `f.js registrar`.
