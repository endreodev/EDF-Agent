const { normalize } = require('./store');

// Lições aprendidas com correções e erros, para qualquer tipo de tarefa (projeto, agente livre, modo PC).
// O Claude sugere com [[LICAO]]; só entram no campo "lessons" do projeto com o 👍 do dono.
const MAX = 40;

const list = (p) =>
  String(p?.lessons || '')
    .split('\n')
    .map((l) => l.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);

// Lições com a nova no fim (sem duplicar), limitadas às MAX mais recentes. null = já existe.
function add(p, lesson) {
  const all = list(p);
  const key = normalize(lesson).replace(/[^\w ]+/g, '');
  if (all.some((l) => normalize(l).replace(/[^\w ]+/g, '') === key)) return null;
  return [...all, lesson].slice(-MAX).join('\n');
}

// "A mensagem nova corrige a resposta anterior?" (começo típico de correção).
const CORRECTION =
  /^(nao[,.! ]|nao$|errado|ta errad|esta errad|nao era|nao e isso|nao foi isso|nao funcionou|nao deu certo|na verdade|ainda (nao|esta|ta|continua)|continua (errad|igual|dando)|de novo|voce (esqueceu|errou|nao)|faltou|esqueceu|era pra|era para|eu (disse|pedi|falei)|nao pedi|pedi para|ta faltando|esta faltando|deu erro|quebrou)/;
const isCorrection = (text) => CORRECTION.test(normalize(text));

// Tira as linhas [[LICAO]] da resposta (até 2).
function extract(text) {
  const items = [];
  const rest = String(text).replace(/^.*\[\[LI[CÇ][AÃ]O\]\][ \t]*(.*)$/gim, (_, r) => {
    const l = String(r).trim().replace(/^[-*:\s]+/, '');
    if (l && items.length < 2) items.push(l.slice(0, 300));
    return '';
  });
  return { items, text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

// suggest = false (plano, diagnóstico): só as lições já aprovadas, sem pedir lições novas.
function instructions(p, { correction = false, suggest = true } = {}) {
  const known = list(p);
  if (!suggest) return known.length ? `## Lições aprovadas pelo dono para "${p.name}" (siga sempre)\n${known.map((l) => `- ${l}`).join('\n')}` : '';
  return `## Lições aprendidas (melhoria contínua)
${known.length ? `Lições aprovadas pelo dono para "${p.name}" (siga sempre):\n${known.map((l) => `- ${l}`).join('\n')}\n` : ''}${
    correction
      ? `\n⚠️ A mensagem do usuário parece CORRIGIR a sua resposta anterior. Entenda o que deu errado antes de refazer.\n`
      : ''
  }
Se nesta tarefa o usuário corrigiu você, algo falhou e você descobriu o jeito certo, ou você perdeu tempo com algo evitável, termine a resposta com até 2 linhas exatamente assim:
[[LICAO]] <regra curta, geral e reutilizável, no imperativo>
- Só o que vale para as PRÓXIMAS tarefas (preferência do dono, armadilha do ambiente, passo que não pode faltar). Nada específico só deste pedido, nada que já esteja nas lições acima, nunca senhas ou dados sensíveis.
- Sem correção, erro ou retrabalho, não escreva nenhuma. O dono aprova cada lição antes de ela valer.`;
}

module.exports = { list, add, isCorrection, extract, instructions, MAX };
