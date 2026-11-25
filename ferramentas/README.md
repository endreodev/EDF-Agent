# Ferramentas do agente

Esta pasta guarda a parte do sistema que aprende. Toda tarefa que pode se repetir (conectar num banco, rodar uma consulta, analisar dados, publicar algo) vira um script aqui. Na próxima vez, o agente chama o script em vez de refazer o trabalho do zero. Assim o pedido gasta menos tokens e um modelo mais barato dá conta.

## Como usar

```
node ferramentas/f.js listar                 # o que existe
node ferramentas/f.js buscar "vendas por cliente"
node ferramentas/f.js rodar <nome> [args]    # executa e conta o uso
node ferramentas/f.js conexoes               # bancos cadastrados (sem senha)
```

Pelo WhatsApp, só o dono: `/ferramentas` lista as ferramentas e `/f <nome> [args]` roda uma direto, sem passar pelo Claude (zero tokens).

## Estrutura

- `catalogo.json`: registro das ferramentas (nome, descrição, tags, uso, contagem de usos e falhas). Não edite à mão; use `f.js registrar`.
- `bin/`: os scripts (Node, Python, PowerShell).
- `conexoes/<nome>.json`: um arquivo por banco ou serviço, com as credenciais. Fica **fora do git** e nunca é lido nem mostrado nas respostas.
- `cache/`: esquemas de banco já consultados. Fica fora do git.
- `node_modules/`: drivers instalados sob demanda. Fica fora do git.

## Criar uma ferramenta

1. Grave o script em `bin/` com parâmetros, sem nada fixo de um projeto só. As credenciais vêm de `conexoes/` ou do ambiente, nunca do código.
2. Faça a saída **curta**: resumo, contagem e as primeiras linhas. Dados completos vão para um arquivo (CSV/JSON). Saída curta é o que economiza tokens.
3. Registre: `node ferramentas/f.js registrar <nome> bin/<arquivo> --desc "para que serve" --tags a,b,c --uso "node ferramentas/f.js rodar <nome> ..."`.
   Se ela publica, apaga ou altera dados de produção, acrescente `--perigosa`. Assim o agente sempre pede confirmação antes de rodar.

## Conexão de banco

`conexoes/<nome>.json`:

```json
{ "tipo": "postgres", "host": "10.0.0.5", "porta": 5432, "banco": "erp", "usuario": "leitura", "senha": "…",
  "escrita": false, "descricao": "ERP do cliente X" }
```

O campo `tipo` aceita `postgres`, `mysql`, `sqlserver`, `oracle` (`banco` = service name, ou `connectString`) e `sqlite` (`arquivo`).
A conexão é só leitura, a não ser que tenha `"escrita": true` **e** o comando venha com `--escrita`.

## API do painel do bot (útil em ferramentas)

- Estado e tarefas: `GET http://127.0.0.1:3000/api/state` (campos running, queue, chats).
- Cancelar: `POST /api/cancel` com `{"all":false,"project":"<projeto>"}`.
- Cadastrar projeto: `POST /api/projects` com `{"name","path","aliases":[]}`.
- Criar grupo de projeto: `POST /api/projects/group` com `{"name":"<projeto>"}`.
- Toda rota é POST com `Content-Type: application/json`. Lista completa em `src/web.js`.
