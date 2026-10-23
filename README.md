# Agente autônomo WhatsApp ⇄ Claude Code

Fica conectado ao WhatsApp, ouve **uma conversa específica** e executa as tarefas recebidas usando o **Claude Code local** dentro da pasta do projeto cadastrado. O Claude responde no próprio WhatsApp e mantém o contexto da conversa por projeto.

## Primeira execução

1. Dê dois cliques em `start.bat` (ou rode `npm start`).
2. Aparece um QR Code no terminal. No celular: **WhatsApp > Aparelhos conectados > Conectar um aparelho** e escaneie.
3. Crie um **grupo só com você** (ex.: "Claude") ou use a conversa "Você" (mensagem para si mesmo).
4. Nessa conversa envie: `/vincular`. Pronto: o bot passa a ouvir só ela.

> O login fica salvo em `data/auth`. Para trocar de número, apague essa pasta.

## Uso

Mande a tarefa em linguagem natural:

> faça uma nova task no projeto do site da nuvix: trocar o telefone do rodapé para (11) 99999-9999

O sistema detecta o projeto pelo nome/apelido citado (senão usa o projeto atual), responde `⏳ Trabalhando…`, manda atualizações periódicas e no fim o resumo do que foi feito. Para continuar o assunto, é só responder: a próxima mensagem continua a mesma sessão do Claude.

### Comandos

| Comando | O que faz |
|---|---|
| `/projetos` | lista projetos |
| `/projeto add nome C:\caminho\da\pasta \| apelido1, apelido2` | cadastra projeto |
| `/projeto rm nome` | remove |
| `/alias nome apelido1, apelido2` | define apelidos |
| `/usar nome` | define o projeto atual |
| `/nova [nome]` | começa conversa nova (esquece o contexto) |
| `/status` | tarefa atual e fila |
| `/cancelar` / `/cancelar tudo` | cancela a atual / limpa a fila |
| `/desvincular` | para de ouvir a conversa |

Já cadastrado: **nivix** → `C:\Users\Ibyt_Software\Documents\Desenvolvimento\nivixtecnologiapredial.com.br` (apelidos: nuvix, site nivix, nivix tecnologia).

## Configuração (`config.json`)

| Campo | Descrição |
|---|---|
| `allowedChats` | conversas vinculadas (preenchido pelo `/vincular`) |
| `allowedSenders` | números extras autorizados (ex.: `"5511999999999"`). Por padrão só **você** (mensagens enviadas pelo seu próprio WhatsApp) é aceito |
| `permissionMode` | modo do Claude: `auto` (padrão, autônomo com checagem de segurança), `acceptEdits` (só edita arquivos), `bypassPermissions` (libera tudo — use com cuidado) |
| `model` | modelo do Claude (vazio = padrão) |
| `taskTimeoutMin` | tempo máximo por tarefa |
| `progressIntervalSec` | intervalo das mensagens de progresso |

Reinicie o processo após editar.

## Manter rodando

- `start.bat` reinicia automaticamente se cair.
- Para iniciar com o Windows: `Win+R` → `shell:startup` → crie um atalho para o `start.bat`.

## Segurança

- Só a conversa vinculada é ouvida, e só mensagens suas (ou de `allowedSenders`).
- O Claude roda com os mesmos acessos do seu usuário do Windows nas pastas dos projetos. Não adicione outras pessoas ao grupo vinculado.
- O Claude foi instruído a não fazer push/deploy sem pedido explícito.
