// SDD: desenvolvimento guiado por especificação, configurável por projeto, com melhoria contínua.
// Fluxo: spec (só leitura, o bot grava o arquivo) → aprovação → execução seguindo as tarefas
// → verificação dos critérios de aceite → retrospectiva com sugestões de regra ([[MELHORIA]]).
const fs = require('fs');
const path = require('path');
const { normalize } = require('./store');

const DEFAULT_DIR = 'docs/specs';
// Pedido que vale uma especificação no modo "auto".
const FEATURE = /\b(funcionalidade|feature|m[oó]dulo|tela nova|nova tela|p[aá]gina nova|nova p[aá]gina|implement\w*|cri(e|ar) (um|uma) (sistema|tela|p[aá]gina|api|integra\w*|relat[oó]rio|cadastro)|integra[cç][aã]o|refator\w*|reescrev\w*|migr[ae]\w*|redesenh\w*|reestrutur\w*|arquitetura|do zero)\b/i;
const MAX_RULES = 30;

const enabled = (p) => !!p && (p.sdd === 'auto' || p.sdd === 'sempre') && p.scope !== 'pc' && p.chatMode !== 'sim';

// O pedido passa pelo SDD? ("sempre": tudo, menos perguntas curtas; "auto": pedidos grandes ou de funcionalidade.)
function wants(p, text) {
  if (!enabled(p)) return false;
  const t = String(text || '').trim();
  if (p.sdd === 'sempre') return t.length >= 25 && !/\?\s*$/.test(t);
  return t.length >= 400 || FEATURE.test(t);
}

const rulesOf = (p) => String(p.sddRules || '').split('\n').map((s) => s.replace(/^[-*\s]+/, '').trim()).filter(Boolean);

function specDir(p) {
  const rel = p.sddDir || DEFAULT_DIR;
  const dir = path.resolve(p.path, rel);
  return dir.startsWith(path.resolve(p.path)) ? dir : path.resolve(p.path, DEFAULT_DIR);
}

// Arquivo novo da spec: AAAA-MM-DD-resumo-do-pedido.md (sem sobrescrever outra do mesmo dia).
function newSpecFile(p, text) {
  const slug = normalize(String(text).replace(/\[[^\]]*\]/g, ' ')).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 7).join('-') || 'spec';
  const base = path.join(specDir(p), `${new Date().toISOString().slice(0, 10)}-${slug}`);
  let file = `${base}.md`;
  for (let i = 2; fs.existsSync(file); i++) file = `${base}-${i}.md`;
  return file;
}

function rulesBlock(p) {
  const rules = rulesOf(p);
  return rules.length ? `\n### Regras aprendidas neste projeto (melhoria contínua; siga sempre)\n${rules.map((r) => `- ${r}`).join('\n')}` : '';
}

// Rodada 1: escrever (ou revisar) a especificação, sem alterar nada.
function specInstructions(p, file, revising) {
  return `## Desenvolvimento guiado por especificação (SDD): etapa de ESPECIFICAÇÃO
Este projeto usa SDD. ${revising ? 'O usuário pediu ajustes: revise a especificação anterior desta conversa incorporando o pedido.' : 'Antes de qualquer alteração, escreva a especificação do pedido.'}
- Leia e pesquise o código o quanto precisar, mas NÃO altere nada (sem editar ou criar arquivos, sem comandos que mudem estado, sem commit). O sistema grava a especificação para você em ${file}.
- Escreva a especificação COMPLETA em Markdown entre as linhas [[SPEC]] e [[/SPEC]], com estas seções:
  # <título curto>
  ## Contexto (o problema e para quem é)
  ## Requisitos (numerados: R1, R2…)
  ## Fora do escopo
  ## Critérios de aceite (verificáveis, numerados: CA1, CA2…, cada um dizendo como conferir)
  ## Plano técnico (arquivos e partes afetadas, decisões, riscos)
  ## Tarefas (checklist "- [ ] T1 …" em ordem de execução, pequenas e verificáveis)
  ## Dúvidas em aberto (só se houver; se mudarem o plano, pergunte)
- FORA dos marcadores, responda curto para o WhatsApp: o objetivo em uma frase, os requisitos e critérios principais em até 6 tópicos, e as dúvidas, se houver. Termine perguntando se pode executar.${p.sddTemplate ? `\n- Instruções do responsável para as especificações deste projeto: ${p.sddTemplate}` : ''}${rulesBlock(p)}`;
}

// Rodada 2: executar a especificação aprovada, conferir e fazer a retrospectiva.
function execInstructions(p, file) {
  const review = p.sddReview !== 'nao';
  return `## Desenvolvimento guiado por especificação (SDD): etapa de EXECUÇÃO
A especificação aprovada está em ${file}. Ela é o contrato desta tarefa.
- Leia o arquivo e execute as tarefas na ordem. Ao concluir cada uma, marque "- [x]" no próprio arquivo.
- Não amplie o escopo além dos requisitos. Se algo da especificação se mostrar errado ou impossível, ajuste o mínimo, registre na seção "## Desvios" do arquivo e explique na resposta.
- No fim, confira CADA critério de aceite de verdade (rodando, testando, abrindo a página) e escreva no arquivo a seção "## Resultado" com ✅ ou ❌ e a evidência de cada CA.
- Na resposta, liste os critérios de aceite com ✅/❌ em uma linha cada.${review ? `
- Retrospectiva (melhoria contínua): acrescente ao arquivo a seção "## Retrospectiva" com o que funcionou, o que atrapalhou e o que a especificação deixou de prever. Depois, se houver aprendizado que valha para as PRÓXIMAS especificações deste projeto, termine a resposta com até 3 linhas exatamente assim (uma regra curta e acionável por linha, sem repetir as regras já existentes):
[[MELHORIA]] <regra para o processo deste projeto>
  Se não houver nada útil, não escreva nenhuma.` : ''}${rulesBlock(p)}`;
}

// Separa a spec ([[SPEC]]…[[/SPEC]]) do resumo para o WhatsApp.
function extractSpec(text) {
  const m = String(text).match(/\[\[SPEC\]\]\s*([\s\S]*?)\s*(?:\[\[\/SPEC\]\]|$)/);
  if (!m) return { spec: null, text };
  return { spec: m[1].trim(), text: String(text).replace(m[0], '').trim() };
}

// Tira as linhas [[MELHORIA]] da resposta.
function extractImprovements(text) {
  const items = [];
  const rest = String(text).replace(/^.*\[\[MELHORIA\]\][ \t]*(.*)$/gm, (_, r) => {
    const rule = r.trim().replace(/^[-*:\s]+/, '');
    if (rule && items.length < 3) items.push(rule.slice(0, 300));
    return '';
  });
  return { items, text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

function writeSpec(file, spec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, spec.endsWith('\n') ? spec : spec + '\n', 'utf8');
}

// Regras com a nova no fim (sem duplicar), limitadas às MAX_RULES mais recentes.
function addRule(p, rule) {
  const rules = rulesOf(p);
  if (rules.some((r) => normalize(r) === normalize(rule))) return null;
  return [...rules, rule].slice(-MAX_RULES).join('\n');
}

const relFile = (p, file) => path.relative(p.path, file).replace(/\\/g, '/');

module.exports = { enabled, wants, newSpecFile, specInstructions, execInstructions, extractSpec, extractImprovements, writeSpec, addRule, rulesOf, relFile, DEFAULT_DIR };
