# EDF-Agent · Agente autônomo WhatsApp ⇄ Claude Code

Peça tarefas pelo WhatsApp e o **Claude Code** do seu computador executa dentro da pasta do projeto certo, responde na própria conversa e mantém o contexto de cada projeto. Um agente de tarefas locais: você manda uma mensagem, ele trabalha, você acompanha pelo celular.

> 📖 **Quer instalar e usar?** Veja o guia: **[Instalação e uso](docs/instalacao-e-uso.md)**

![Dashboard do agente (dados sensíveis borrados)](docs/img/dashboard.png)

<sub>Dashboard local do agente. Nomes de projetos, pessoas, pedidos e endereços foram borrados.</sub>

## O que ele faz

- **Conversa = projeto.** Um grupo de WhatsApp por projeto; tudo que você escreve ali vira uma tarefa naquela pasta.
- **Várias tarefas ao mesmo tempo**, com fila que sobrevive a reinício e botão de cancelar.
- **Plano antes de executar**, perguntas no meio da tarefa e confirmação antes de ações arriscadas.
- **Desfazer e refazer** o que o agente alterou; checagem de build, testes e páginas antes de entregar.
- **Publicação com aprovação:** commit, push e deploy só quando autorizado.
- **Modo PC:** também cuida da máquina (prints, disco, processos, serviços, agendamentos).
- **Vigia de sites** (no ar, SSL) e alertas do PC direto no WhatsApp.
- **Missões de vários dias**, lições aprendidas e memória por projeto.
- **Áudio, imagens e arquivos:** entende o que você manda e devolve arquivos prontos.
- **Preview público temporário** do site do projeto e relatório em PDF para o cliente.
- **Dashboard local** com o que está rodando, tempo por projeto, taxa de sucesso e uso da assinatura.

## Como funciona

1. Um processo Node fica conectado ao WhatsApp e ouve só as conversas vinculadas por você.
2. Cada pedido sobe uma sessão do Claude Code na pasta do projeto, com o contexto daquela conversa.
3. O resultado volta para o WhatsApp, e o histórico fica registrado no dashboard.

## Segurança em resumo

- Só conversas vinculadas e números autorizados falam com o agente; comandos administrativos e publicação são do dono.
- Roda com as permissões do seu usuário do Windows: não adicione desconhecidos aos grupos.
- A sessão do WhatsApp, as conversas e o `config.json` ficam fora do git.

## Começar

Requisitos, instalação passo a passo, comandos e configuração estão em **[docs/instalacao-e-uso.md](docs/instalacao-e-uso.md)**.
