# Instalação e uso

Guia completo do agente. Para a visão geral do projeto, veja o [README](../README.md).

## Requisitos

- **Windows 10/11** (o agente controla o PC; o `start.bat` e alguns recursos são para Windows).
- **Node.js 20 ou mais novo** ([nodejs.org](https://nodejs.org)).
- **Claude Code** instalado e com login feito (`claude` funcionando no terminal). É ele que executa as tarefas.
- **Git** e, se quiser criar/clonar repositórios pelo WhatsApp, o **GitHub CLI** (`gh auth login`).
- Um **WhatsApp** no celular para parear o bot (de preferência um número dedicado).
- Opcional: Python 3 (transcrição de áudio), PHP e `cloudflared` (preview público), Edge ou Chrome (relatórios em PDF).

## Instalação

```
git clone https://github.com/endreodev/EDF-Agent.git
cd EDF-Agent
npm install
copy config.example.json config.json
```

Edite o `config.json` só se precisar mudar algo (os padrões já funcionam; veja a tabela de [Configuração](#configuração-configjson) abaixo). O `config.json` e a pasta `data/` guardam suas conversas e a sessão do WhatsApp e **nunca vão para o git**.

## Primeira execução (parear o WhatsApp)

1. Dê dois cliques em `start.bat` (ou rode `npm start`).
2. Aparece um QR Code no terminal. No celular: **WhatsApp > Aparelhos conectados > Conectar um aparelho** e escaneie.
3. Crie um **grupo só com você** (ex.: "Claude") ou use a conversa "Você" (mensagem para si mesmo).
4. Nessa conversa envie: `/vincular`. Pronto: o bot passa a ouvir só ela.

> O login fica salvo em `data/auth`. Para trocar de número, apague essa pasta.

### Painel e dashboard

`http://localhost:3000` abre no **Dashboard**: o que o agente está fazendo agora (com botão de cancelar), tarefas e tempo de hoje comparados com ontem, taxa de sucesso da semana, uso da assinatura do Claude, gráfico de tarefas dos últimos 14 dias, tempo por projeto nos últimos 30 dias, sites vigiados (no ar, SSL), as últimas tarefas e tudo que está **esperando você** (publicações, planos e sugestões), com botões para aprovar ou recusar ali mesmo. As outras telas (conversas, projetos, GitHub, WhatsApp, logs) ficam em `http://localhost:3000/painel`, acessíveis pela barra do topo. Todo o painel usa Bootstrap 5, instalado pelo `npm install` e servido localmente: funciona sem internet. O botão no canto troca entre tema claro e escuro.

## Uso

Mande a tarefa em linguagem natural, por texto **ou áudio**:

> faça uma nova task no projeto do site da nuvix: trocar o telefone do rodapé para (11) 99999-9999

O sistema detecta o projeto, responde `⏳ Trabalhando…`, manda atualizações periódicas e no fim o resumo do que foi feito (e os arquivos que o Claude gerar, como prints, PDFs e planilhas). Para continuar o assunto, é só responder: a próxima mensagem continua a mesma sessão do Claude.

### Um grupo por projeto

- No painel, clique em **Criar grupo** no projeto, ou envie `/grupo <projeto>`: o bot cria o grupo "🤖 projeto" e o liga ao projeto.
- Ou crie o grupo você mesmo e envie nele `/vincular <projeto>`.
- Tudo o que for mandado no grupo vai para aquele projeto, sem precisar citar o nome. `/status`, `/cancelar`, `/git`, `/pr` etc. valem só para ele.
- Até `maxParallel` tarefas rodam ao mesmo tempo no total, e até `maxPerProject` no mesmo projeto (veja *Várias tarefas ao mesmo tempo*).
- Qualquer participante de um grupo vinculado pode mandar tarefas; cada pessoa tem a própria conversa (sessão) com o Claude.
- A conversa vinculada sem projeto (ex.: "Você") continua como central: lá vale citar o projeto pelo nome/apelido.

### Várias tarefas ao mesmo tempo

- **Complemento**: o que você mandar enquanto a sua tarefa roda entra nela na hora (📌), sem esperar terminar. Responder citando uma mensagem do bot manda o complemento para aquela tarefa.
- **Em paralelo**: pedido de outra pessoa (ou começando com `nova tarefa:`) roda ao mesmo tempo numa cópia isolada do projeto (`git worktree`, em `data/worktrees`). Ao terminar, as alterações são aplicadas na pasta do projeto; se a tarefa principal ainda estiver rodando, esperam ela acabar. Se conflitarem com outra tarefa, ficam salvas numa branch `claude/paralelo-*`.
- Na cópia, pastas ignoradas pelo Git (`node_modules`, `vendor`…) são ligadas às originais e arquivos pequenos ignorados (`.env`) são copiados, para build e testes funcionarem.
- **Responder citando** qualquer mensagem leva o texto dela junto como contexto.
- **Retomada automática**: se o limite de uso da assinatura acabar ou a conexão cair, a tarefa pausa (⏸️) e é retomada sozinha quando o limite renovar (ou em alguns minutos), continuando de onde parou.

### Reações como comandos

Reaja às mensagens do bot (só você e os números autorizados):

| Reação | Na mensagem de… | Faz |
|---|---|---|
| 👍 ✅ 👌 | publicação aguardando aprovação · plano · issue, e-mail ou correção sugerida | aprova / executa |
| ❌ 👎 🛑 | tarefa em andamento · publicação · plano · sugestão | cancela / recusa / descarta |
| ↩️ | resposta de uma tarefa que alterou arquivos | desfaz |
| 🔁 | resposta de uma tarefa que alterou arquivos | desfaz e faz de novo |

O tom de pele do emoji não importa. O vínculo entre mensagem e ação fica em `data/reactions.json` e vale depois de reiniciar.

### Plano antes de executar

- Comece a mensagem com `!plano` para o Claude mostrar o plano antes de mexer em qualquer coisa. Pedidos grandes (mais de ~500 caracteres, ou com "refatorar", "migrar", "reescrever", "do zero"…) ganham plano sozinhos; `!direto` pula.
- Na rodada do plano o Claude roda sem as ferramentas de edição nem os comandos git que alteram o repositório.
- Responda *ok* (ou reaja 👍) para executar na mesma conversa; qualquer outra resposta ajusta o plano; "cancela o plano" (ou ❌) descarta. `/plano` lista os que estão esperando.
- `"planFirst"`: `"auto"` (padrão), `"sempre"` ou `"nunca"`. Tarefas agendadas nunca esperam plano.

### SDD: especificação antes do código (por projeto)

Ligue no painel, em **Projetos → Editar → SDD**. Em qualquer projeto, `!spec` no começo da mensagem força a especificação e `!direto` pula.

1. **Especificação.** O Claude pesquisa sem alterar nada e escreve a spec: contexto, requisitos (R1…), fora do escopo, critérios de aceite verificáveis (CA1…), plano técnico e tarefas em checklist. O bot grava em `docs/specs/AAAA-MM-DD-resumo.md` dentro do projeto e manda o resumo e o arquivo no WhatsApp.
2. **Aprovação.** *ok* ou 👍 executa; qualquer outra resposta revisa a spec no mesmo arquivo; ❌ descarta. Também aparece em "Esperando você" no dashboard.
3. **Execução.** O Claude segue as tarefas, marca cada `[x]` no arquivo, registra desvios e confere cada critério de aceite, escrevendo `## Resultado` com ✅/❌. Com `gitFlow: branch`, a spec vai junto na branch da tarefa.
4. **Melhoria contínua.** Na retrospectiva, o Claude anota no arquivo o que funcionou e o que faltou, e sugere até 3 regras para o processo. Cada uma chega numa mensagem: 👍 adota (entra em "Regras aprendidas" do projeto e passa a valer nas próximas specs), ❌ ignora.

| Campo do projeto | Valores |
|---|---|
| Quando usar (`sdd`) | desligado, `auto` (funcionalidades e pedidos grandes) ou `sempre` (todo pedido de alteração, menos perguntas) |
| Pasta (`sddDir`) | relativa ao projeto; padrão `docs/specs` |
| Retrospectiva (`sddReview`) | ligada (padrão) ou `nao` |
| Instruções (`sddTemplate`) | texto extra para toda spec do projeto (ex.: "incluir impacto no SEO") |
| Regras aprendidas (`sddRules`) | uma por linha; editáveis à mão; as últimas 30 valem |

### Pergunta no meio da tarefa

Quando falta algo que só você sabe (qual opção, um dado do cliente, a confirmação de algo irreversível), o Claude não chuta: manda uma mensagem ❓ e a tarefa fica **parada**, com tudo o que já fez (inclusive a cópia paralela). A sua próxima mensagem naquela conversa, ou uma resposta citando a pergunta, é entregue a ela, que continua de onde parou. O tempo limite da tarefa não corre enquanto ela espera.

- Sem resposta em `askTimeoutMin` (padrão 30 min), ele segue pela opção mais segura e reversível e diz qual escolheu.
- No máximo `maxQuestions` (padrão 3) perguntas por tarefa. Diagnósticos automáticos nunca perguntam.
- Para mandar outro pedido enquanto há uma pergunta aberta, comece com `nova tarefa:`. O `/status` e o dashboard mostram o que está esperando resposta.

### Missões (objetivos de vários dias)

`/missao <objetivo>` cria um objetivo grande que o agente leva sozinho, em rodadas, por horas ou dias. Ex.: `/missao migrar o site X para Laravel mantendo as mesmas páginas e o SEO`.

- Na primeira rodada o Claude monta o checklist em `memoria/missoes/<nº>-<resumo>.md` (objetivo, critério de pronto, checklist, decisões e diário) e já começa. Cada rodada lê o arquivo, avança os próximos itens, marca `[x]` o que conferiu e anota o diário.
- As rodadas rodam a cada `intervalMin` (padrão 60 min), no máximo `maxRunsPerDay` (8) por dia, só com o projeto livre e com o uso das 5 h da assinatura abaixo de `maxUsagePct` (70%). Cada missão tem a própria conversa do Claude, que continua de uma rodada para a outra.
- Decisão do dono ou algo irreversível: a rodada pergunta (❓) ou **pausa** a missão. 👍 no aviso retoma, ❌ cancela, e responder citando o aviso retoma com a sua orientação. Missão nunca publica sozinha: pede com `[[PUBLICAR]]` e espera o `/aprovar`.
- Três rodadas seguidas com erro pausam a missão.
- `/missao` lista · `/missao ver|agora|pausar|retomar|cancelar <nº>`. O progresso aparece no dashboard e no resumo da manhã.

### Lições aprendidas (melhoria contínua em qualquer tarefa)

Quando você corrige o agente ("não, era…", "ainda está errado", "faltou…"), quando algo falha e ele acha o jeito certo, ou quando perde tempo com algo evitável, ele sugere até 2 lições 🧠 no fim da resposta. Cada uma chega numa mensagem: 👍 guarda (entra em **Projetos → Editar → Lições aprendidas** e vale em todas as próximas tarefas daquele projeto, de qualquer tipo, inclusive no agente livre), ❌ ignora. Lições de tarefas de outras pessoas vão para a conversa central, para você aprovar. Desligue com `"lessons": false`.

### Publicação com aprovação

Quem não é o dono não publica direto: se pedir para publicar/subir/colocar no ar, o Claude termina o trabalho local e o bot avisa *🚀 Publicação aguardando aprovação (#N)* no grupo e na conversa central. Você responde `/aprovar N` (o Claude publica) ou `/recusar N`. `/aprovacoes` lista as pendentes. Desligue com `"requireDeployApproval": false`.

### Preview público

`/preview` sobe o site do projeto neste PC (PHP com `php -S`, arquivos estáticos, ou o `previewCommand` do projeto, com `{port}` no lugar da porta) e abre um túnel do Cloudflare com um link `https://….trycloudflare.com` para mostrar ao cliente antes de publicar. `/preview 8080` só abre o link para um servidor que já está rodando. Fecha sozinho depois de `previewHours` (padrão 2 h) ou com `/preview parar`. Arquivos ocultos (`.env`, `.git`…) nunca são servidos. Só você e os números autorizados podem abrir. Precisa do `cloudflared` (`winget install Cloudflare.cloudflared`).

### Navegador

O Claude tem um navegador (Playwright, Chrome sem janela): abre as páginas alteradas, testa formulários e manda prints de antes e depois. Desligue com `"browserCheck": false`.

### Memória do projeto

Ao fim das tarefas o Claude anota o que aprendeu (decisões do cliente, padrões, como publicar…) em `memoria/<projeto>.md`, fora do repositório do cliente. Essa memória e as últimas tarefas do projeto vão como contexto em toda conversa nova. Veja com `/memoria`, apague com `/memoria limpar`.

### Resumo, uso e limites

- `/resumo [hoje|ontem|semana|mes] [projeto]`: tarefas feitas, por projeto e pessoa, com tempo gasto (registro em `data/tasks.jsonl`).
- `/uso`: minutos usados hoje e quanto da assinatura do Claude já foi consumido.
- `/limite padrao 60`, `/limite <número> 30`, `/limite projeto <nome> 120`: minutos de tarefa por dia (0 = sem limite). Você nunca é limitado.

### Vigia dos sites e alertas do PC

- A cada `watchIntervalMin` (5 min) o bot confere os sites dos projetos: a URL cadastrada (`/site <projeto> <url>`) ou o nome/pasta do projeto quando for um domínio (ex.: `meusite.com.br`). Avisa no grupo do projeto quando cai (2 falhas seguidas) e quando volta, e quando o SSL estiver a menos de 15 dias de vencer. `/sites` mostra a situação; `/site <projeto> nenhum` para de vigiar.
- Alertas do PC (no grupo do modo PC, ou na conversa central): disco acima de `pcAlerts.diskPct` (90%), serviços de `pcAlerts.services` que pararem (ex.: `["MySQL80"]`) e quando o PC reiniciar.
- **Diagnóstico automático**: site fora do ar, disco cheio, serviço parado ou falha no GitHub Actions abrem sozinhos uma investigação **somente leitura** (sem editar, reiniciar nem publicar). O bot responde com causa provável e correção proposta; reaja 👍 para aplicar. No máximo um diagnóstico a cada 6 h por problema. Desligue com `"autoDiagnose": false`.

### Resumo da manhã

Todo dia às `morning.time` (padrão 08:00) a conversa central recebe: o que foi feito ontem por projeto, o que espera você (publicações, branches `claude/*` sem PR, planos, sugestões), sites fora do ar ou com SSL vencendo, os agendamentos do dia, a fila e o uso da assinatura. `/manha` mostra na hora. Configuração: `"morning": { "enabled": true, "time": "08:00", "days": [1,2,3,4,5] }` (`days` é opcional; 0 = domingo). Se o bot subir mais de 3 h depois do horário, o resumo daquele dia é pulado.

### Gatilhos externos

A cada `triggers.intervalMin` (10 min):
- **Issues novas** nos repositórios GitHub dos projetos: o bot avisa no grupo do projeto; reaja 👍 para virar tarefa.
- **Falhas do GitHub Actions**: aviso + diagnóstico automático.
- **E-mails novos** (via `ferramentas/bin/imap-caixa.py`): reaja 👍 e o Claude planeja a tarefa e espera o seu ok.

```json
"triggers": { "enabled": true, "intervalMin": 10, "github": true,
  "email": [{ "name": "suporte", "env": "C:\\projetos\\site\\.env", "project": "site", "from": ["@cliente.com.br"] }] }
```

Na primeira leitura de cada fonte nada é disparado (só marca o que já existe como visto). O texto de issues e e-mails vai para o Claude marcado como conteúdo de terceiros, nunca como instrução.

### Fila que sobrevive a reinício

A fila, as tarefas em andamento e os planos pendentes ficam em `data/queue.json`. Se o processo cair (ou o PC reiniciar), ao reconectar o bot retoma as tarefas interrompidas na mesma sessão do Claude ("▶️ Retomando…") e roda o que estava na fila. Uma tarefa que derrubar o bot duas vezes seguidas é abandonada com aviso.

### Relatório para o cliente

`/relatorio [projeto] [hoje|ontem|semana|mes] [sem-tempo]` gera um PDF com as entregas concluídas do período (padrão: últimos 30 dias), com o tempo gasto (omita com `sem-tempo`) e os prints de antes e depois que o Claude mandou. Ficam de fora planos, diagnósticos automáticos, tarefas com erro e conversas que não alteraram arquivos. Usa o Edge ou o Chrome sem janela (`"pdfBrowser"` para outro caminho), sem gastar tokens. Os prints ficam guardados por 180 dias em `data/relatorios/imagens`.

### GitHub

- **Conectar a conta**: painel → aba **GitHub** → *Conectar ao GitHub*. Aparece um código; clique em *Copiar código e abrir GitHub*, cole na página e confirme. Usa o GitHub CLI (`gh`), e o `git` passa a usar a mesma conta.
- **Trabalhar num repositório direto da conversa**: no seletor *Trabalhar em* do chat aparecem os projetos do computador e os seus repositórios do GitHub (⬇). Se escolher um que ainda não está no PC, ele é baixado e cadastrado ao enviar a mensagem. No WhatsApp: `/usar dono/repo` ou `/usar nome-do-repo`.
- Na aba GitHub, cada repositório tem *Baixar* / *Baixar e conversar* (e *Conversar*, se já estiver no PC).
- **Escolher pasta**: no painel, botão 📁 Procurar no cadastro de projeto. O repositório GitHub é detectado pela pasta.
- **Clonar**: painel → "Clonar do GitHub" (botão *Meus repos* lista seus repositórios via `gh`), ou `/clonar dono/repo [nome]`. Clona em `projectsRoot` (padrão: a pasta acima deste projeto). Enviado dentro de um grupo ainda sem projeto, o grupo passa a ser dele.
- **Branch por tarefa** (opção "Git por tarefa" no projeto): cada tarefa roda numa branch `claude/<data>-<resumo>` e é commitada no fim. Novas mensagens continuam na mesma branch. Depois:
  - `/pr` faz o push e abre o Pull Request (`gh pr create`), voltando para a branch principal;
  - `/descartar` apaga a branch e volta para a principal.
  Se houver alterações não commitadas antes da tarefa, a branch não é criada (para não misturar com o seu trabalho).

### Modo PC (máquina toda)

`/pc` cria o projeto especial **pc** (pasta do usuário). Envie `/pc` dentro de um grupo para ligá-lo, ou `/grupo pc` para criar um grupo novo. Nesse modo:
- o Claude pode fazer tarefas no Windows (instalar, procurar arquivos, tirar print da tela, organizar pastas…);
- ações destrutivas ou irreversíveis exigem sua confirmação ("sim") antes;
- nunca roda com `bypassPermissions` e só aceita tarefas suas (não de números autorizados);
- pastas extras liberadas: `pcDirs` no config (ex.: `["D:\\"]`).

### Agente livre (conversa direta com o bot)

Na conversa privada com o bot — a sua conversa "Você" e os números de `freeAgent.numbers` — o agente não fica preso a um projeto: opera o PC inteiro (modo PC), cria ferramentas e só entra num projeto se você citar o nome/apelido dele.

- **Memória permanente** em `memoria/agente/`: `INDICE.md` (curto, vai em toda tarefa) aponta para arquivos de tópico, que o Claude lê só quando precisa (economiza tokens). Ao fim de cada tarefa ele registra o que aprendeu e corrige o que ficou velho.
- **Ferramentas**: o que pode se repetir vira script em `memoria/agente/ferramentas/`, catalogado no `README.md` dela, e é reaproveitado nas próximas vezes.
- **Diário**: todo pedido e resposta fica em `memoria/agente/diario/AAAA-MM.md` (escrito pelo bot, sem gastar tokens). Pergunte "o que fizemos sobre X" e ele busca ali.
- `/memoria` mostra o índice; `/nova` começa conversa nova sem perder a memória.
- Ações destrutivas continuam pedindo "sim" antes.
- Config: `"freeAgent": { "enabled": true, "selfChat": true, "numbers": ["55659…"] }`. `selfChat: false` devolve a conversa "Você" ao comportamento antigo (projeto atual).

### Desfazer / refazer

Antes de cada tarefa o bot tira uma foto da pasta do projeto (só em projetos com Git). Se a tarefa alterou algo, a resposta termina com:
> Não gostou? Responda *desfazer* ou *refazer*.

- **desfazer** (ou `/desfazer`): volta os arquivos e os commits locais ao estado de antes da última tarefa. Seu trabalho não commitado de antes da tarefa é mantido; arquivos ignorados pelo Git (`.env`, `node_modules`…) não são tocados. Não desfaz o que já foi enviado ao GitHub (push).
- **refazer** (ou `/refazer`): desfaz e executa o mesmo pedido de novo.
- O estado de antes do desfazer fica guardado em `refs/agente/antes-do-desfazer`, caso precise recuperar.

### Checagem antes de entregar

Nos projetos, o Claude roda build/lint/testes e confere as páginas alteradas antes de dizer *concluído*, e informa o que verificou. Desligue com `"verifyBeforeDone": false`.

### Comandos rápidos do PC

Respondem na hora, sem passar pelo Claude (só o dono): `/print` (print de todas as telas), `/disco`, `/processos` ou `/ram` (RAM e os 10 que mais usam memória) e `/servico <nome> [iniciar|parar|reiniciar]`. Parar/iniciar serviços do sistema exige o bot rodando como administrador.

### Agendamentos

`/agendar [dias] HH:MM <tarefa>`: dias = `diario` (padrão), `uteis`, `seg-sex`, `seg,qua,sex`…
Ex.: `/agendar uteis 08:00 verificar se o site está no ar e me mandar um print`. Liste com `/agendas` e remova com `/desagendar <nº>`.

### Comandos

| Comando | O que faz |
|---|---|
| `/projetos` | lista projetos (💬 = tem grupo) |
| `/projeto add nome C:caminhodapasta | apelido1, apelido2` | cadastra projeto |
| `/projeto rm nome` | remove |
| `/clonar dono/repo [nome]` | clona do GitHub e cadastra |
| `/grupo nome` | cria grupo do WhatsApp ligado ao projeto |
| `/vincular [nome]` | ouve a conversa (com nome: liga ao projeto) |
| `/alias nome apelido1, apelido2` | define apelidos |
| `/usar nome` ou `/usar dono/repo` | define o projeto atual; baixa do GitHub se não estiver no PC |
| `/nova [nome]` | começa conversa nova (esquece o contexto) |
| `/git` · `/pr` · `/descartar` | status do git / abre PR / descarta a branch da tarefa |
| `/pc` | modo PC |
| `/desfazer` · `/refazer` | volta a última tarefa / desfaz e faz de novo |
| `/print` · `/disco` · `/processos` · `/servico` | comandos rápidos do PC |
| `/agendar` · `/agendas` · `/desagendar` | tarefas agendadas |
| `/missao <objetivo>` · `/missao [ver\|agora\|pausar\|retomar\|cancelar <nº>]` | missões de vários dias |
| `/status` | tarefas em andamento e fila |
| `/plano` | planos esperando o seu ok (`!plano` / `!direto` no começo da mensagem) |
| `/manha` | resumo da manhã agora |
| `/relatorio [projeto] [semana\|mes] [sem-tempo]` | PDF das entregas para o cliente |
| `/cancelar [projeto|tudo]` | cancela |
| `/desvincular` | para de ouvir a conversa |
| `/ferramentas [busca]` · `/f <nome> [args]` | lista as ferramentas do agente · roda uma direto, sem gastar tokens (só o dono; as perigosas só rodam na conversa direta) |

## Ferramentas e modelos mais baratos

A pasta [ferramentas/](ferramentas/README.md) guarda o que o agente aprendeu a fazer. Cada script dali (consulta a banco, análise de dados, publicação de add-on Sankhya…) fica registrado em `catalogo.json`.
- **O catálogo vai em toda tarefa.** Antes de criar algo, o Claude verifica se já existe uma ferramenta. Quando faz algo que pode se repetir, ele transforma em ferramenta e a registra.
- **Bancos de dados:** cada banco tem um arquivo `ferramentas/conexoes/<nome>.json`, que fica fora do git e é só leitura por padrão. A ferramenta `sql` responde com saída curta e guarda o esquema em cache.
- **Subagentes baratos:** o modelo principal manda o trabalho braçal para o `executor` (Haiku), que roda comandos e consultas e devolve só o resumo. Análises e ferramentas novas vão para o `analista` (Sonnet).
- **Roteamento:** quando uma ferramenta do catálogo resolve o pedido, a tarefa roda no modelo econômico (`modelos.economico`). Para forçar um modelo, comece a mensagem com `!forte` ou `!barato`. Os modelos ficam em `"modelos"` no `config.json`; `"rotear": false` desliga o roteamento.

## Áudio

Mensagens de voz são transcritas localmente com [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`pip install faster-whisper`). O bot responde com a transcrição e executa como se fosse texto. Na primeira vez o modelo é baixado (~500 MB para `small`). Desligue com `"transcribeAudio": false`.

**Resposta em áudio**: com a voz ligada, o bot responde em todas as conversas em texto e também com uma mensagem de voz curta (resumo falado), gerada localmente com [Piper](https://github.com/rhasspy/piper) e convertida para OGG/Opus pelo `ffmpeg-static`. O Claude também pode mandar áudio quando pedirem ("me manda em áudio"). `/voz ligar|desligar` liga/desliga para todas as conversas (só o dono, na conversa direta com o bot; começa desligada); `/voz <texto>` fala o texto.
Instalação: `pip install piper-tts` e `python -m piper.download_voices --data-dir data\voices pt_BR-faber-medium`. Outra voz: `"piperVoice": "caminho\voz.onnx"`.

## Configuração (`config.json`)

| Campo | Descrição |
|---|---|
| `allowedChats` | conversas vinculadas (preenchido pelo `/vincular`) |
| `chatProjects` | conversa → projeto (preenchido por `/vincular <projeto>` e `/grupo`) |
| `allowedSenders` | números extras autorizados. Por padrão só **você** (mensagens enviadas pelo seu próprio WhatsApp) é aceito |
| `permissionMode` | modo do Claude: `auto` (padrão, autônomo com checagem de segurança), `acceptEdits` (só edita arquivos), `bypassPermissions` (libera tudo — use com cuidado) |
| `model` | modelo do Claude (vazio = padrão) |
| `taskTimeoutMin` | tempo máximo por tarefa |
| `progressIntervalSec` | intervalo das mensagens de progresso |
| `maxParallel` | quantas tarefas podem rodar ao mesmo tempo no total (padrão 3) |
| `maxPerProject` · `parallelPerProject` | tarefas simultâneas no mesmo projeto (padrão 3) · `false` desliga o paralelo por projeto |
| `sessionPerPerson` | cada pessoa do grupo com a própria conversa do Claude (padrão `true`) |
| `browserCheck` | navegador para o Claude conferir as páginas (padrão `true`) |
| `requireDeployApproval` | publicação pedida por outras pessoas espera sua aprovação (padrão `true`) |
| `limits` | `{ defaultMinPerDay, people: { número: min }, projects: { nome: min } }` (use `/limite`) |
| `watchSites` · `watchIntervalMin` | vigia dos sites (padrão ligado, a cada 5 min) |
| `pcAlerts` | `{ enabled, diskPct, services: [] }` alertas do PC |
| `previewHours` · `phpPath` · `cloudflaredPath` | preview público |
| `projectsRoot` | onde o `/clonar` cria as pastas (vazio = pasta acima deste projeto) |
| `verifyBeforeDone` | o Claude confere build/testes/páginas antes de entregar (padrão `true`) |
| `pcDirs` | pastas extras liberadas no modo PC |
| `transcribeAudio`, `pythonPath`, `whisperModel` | transcrição de áudio (`tiny`, `base`, `small`, `medium`) |
| `planFirst` | plano antes de executar: `auto` (padrão), `sempre`, `nunca` |
| `autoDiagnose` | diagnóstico automático dos alertas (padrão `true`) |
| `askMidTask` · `askTimeoutMin` · `maxQuestions` | pergunta no meio da tarefa (padrão ligada, 30 min, 3 por tarefa) |
| `lessons` | lições aprendidas com correções e erros (padrão `true`) |
| `missions` | `{ enabled, intervalMin, maxRunsPerDay, maxUsagePct, runMin }` missões de vários dias (padrão 60 min, 8 por dia, 70% do uso das 5 h, rodadas de ~20 min) |
| `morning` | `{ enabled, time, days? }` resumo da manhã |
| `triggers` | `{ enabled, intervalMin, github, email: [] }` gatilhos externos |
| `pdfBrowser` | caminho do Edge/Chrome para o `/relatorio` (vazio = detecta) |

Reinicie o processo após editar.

## Manter rodando

- `start.bat` reinicia automaticamente se cair.
- Para iniciar com o Windows: `Win+R` → `shell:startup` → crie um atalho para o `start.bat`.

## Segurança

- Só as conversas vinculadas são ouvidas. Em grupos vinculados, qualquer participante pode pedir tarefas; no privado, só você e `allowedSenders`. Comandos administrativos, modo PC e publicação continuam só seus.
- O Claude roda com os mesmos acessos do seu usuário do Windows. Não adicione outras pessoas a grupos vinculados, principalmente o do modo PC.
- O Claude foi instruído a não fazer push/deploy sem pedido explícito; o push do fluxo de branch só acontece no `/pr`.
- As credenciais do WhatsApp ficam em `data/auth` (fora do git).
