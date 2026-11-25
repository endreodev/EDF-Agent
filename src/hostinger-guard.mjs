// Servidor MCP da Hostinger (hostinger-api-mcp, por token) com uma trava na frente de cada chamada à API.
// O token vem do config.json (hostingerApiToken), nunca da linha de comando, para não aparecer na lista de processos.
//
// Regras:
// - NUNCA: apagar site/conta de hospedagem, caixa de e-mail, loja; tirar domínio da conta, destravar domínio,
//   desligar renovação automática, apagar forma de pagamento, recriar (formatar) VPS.
// - Só com HOSTINGER_GUARD_ALLOW=1 (tarefa do dono, depois de ele confirmar): qualquer outra exclusão (DELETE),
//   restaurar backup/snapshot, compras, cancelar, revogar, desinstalar.
// - O resto (consultar e ajustar) passa direto.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import axios from 'axios';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'node_modules', 'hostinger-api-mcp');

try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  if (cfg.hostingerApiToken) process.env.HOSTINGER_API_TOKEN = cfg.hostingerApiToken;
} catch {
  /* sem token: o servidor cai no login OAuth */
}

const NEVER = new Set([
  'hosting_websites_delete',
  'mail_mailboxes_delete-mailbox',
  'ecommerce_stores_delete',
  'domains_move_start-outgoing',
  'domains_portfolio_disable-lock',
  'billing_subscriptions_disable-auto-renewal',
  'billing_payment-methods_delete',
  'vps_virtual-machines_recreate',
]);
const NEEDS_OK = /restore|recreate|purchase|reset|uninstall|revoke|cancel|reject|delete|remove/;
const allowed = process.env.HOSTINGER_GUARD_ALLOW === '1';

// Operações do catálogo -> regex do caminho, para reconhecer cada requisição.
const { default: tools } = await import(pathToFileURL(path.join(PKG, 'src', 'core', 'tools', 'all.js')).href);
const routes = tools
  .filter((t) => t.method && t.path)
  .map((t) => ({
    name: t.name,
    method: t.method.toUpperCase(),
    re: new RegExp('^' + t.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+') + '/?$'),
  }));

function operationOf(method, url) {
  let p = url;
  try {
    p = new URL(url, 'https://x').pathname;
  } catch {
    /* já é caminho */
  }
  return routes.find((r) => r.method === method && r.re.test(p))?.name || null;
}

axios.interceptors.request.use((req) => {
  const method = String(req.method || 'get').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return req;
  const url = `${req.baseURL || ''}${req.url || ''}`;
  if (!/hostinger\.com/i.test(url) && !req.url?.startsWith('/api/')) return req; // uploads etc. de outros hosts
  const op = operationOf(method, req.url?.startsWith('http') ? req.url : url) || '';
  if (NEVER.has(op)) {
    throw new Error(`BLOQUEADO pela trava do agente: "${op}" nunca é permitido (apagar conta, e-mail, domínio ou VPS). Não tente de outra forma; avise o usuário.`);
  }
  if ((method === 'DELETE' || NEEDS_OK.test(op)) && !allowed) {
    throw new Error(`BLOQUEADO pela trava do agente: "${op || method + ' ' + req.url}" apaga ou altera dados de forma irreversível e só é liberado pelo dono (Endreo), depois de confirmar. Não tente de outra forma; explique o que faria e peça a autorização dele.`);
  }
  return req;
});

await import(pathToFileURL(path.join(PKG, 'src', 'servers', 'all.js')).href);
