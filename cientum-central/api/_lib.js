import crypto from 'node:crypto';

const STORE_ID = process.env.NUVEMSHOP_STORE_ID;
const TOKEN = process.env.NUVEMSHOP_ACCESS_TOKEN;
const SECRET = process.env.SESSION_SECRET;
const UA = process.env.NUVEMSHOP_USER_AGENT || 'Central Cientum (contato@cientum.com.br)';

/* ---------------------------------------------------------------
   Chamada à API da Nuvemshop
   --------------------------------------------------------------- */

export async function nuvem(path, options = {}) {
  if (!STORE_ID || !TOKEN) {
    const e = new Error('Faltam as variáveis NUVEMSHOP_STORE_ID / NUVEMSHOP_ACCESS_TOKEN.');
    e.status = 500;
    throw e;
  }

  const res = await fetch(`https://api.nuvemshop.com.br/v1/${STORE_ID}${path}`, {
    ...options,
    headers: {
      // A API aceita os dois formatos dependendo da versão. Mandamos os dois.
      Authentication: `bearer ${TOKEN}`,
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': UA,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    const e = new Error(`Nuvemshop ${res.status}: ${body.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

/* ---------------------------------------------------------------
   Sessão (JWT-like assinado com HMAC, sem banco de dados)
   --------------------------------------------------------------- */

export function signSession(payload, ttlSeconds = 60 * 60 * 8) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function readSession(token) {
  try {
    if (!token || !token.includes('.')) return null;
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const body = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

export function requireSession(req) {
  const header = req.headers.authorization || '';
  const session = readSession(header.replace(/^Bearer\s+/i, ''));
  if (!session) {
    const e = new Error('Sessão expirada. Entre de novo com o número do pedido.');
    e.status = 401;
    throw e;
  }
  return session;
}

export function requirePainel(req) {
  const header = req.headers.authorization || '';
  const sessao = readSession(header.replace(/^Bearer\s+/i, ''));
  if (!sessao?.painel) {
    const e = new Error('Sessão expirada. Entre de novo com a senha da equipe.');
    e.status = 401;
    throw e;
  }
  return sessao;
}

export const normalizeEmail = (v) => String(v || '').trim().toLowerCase();

/* ---------------------------------------------------------------
   Reservatório de solicitações (Redis via API REST, sem biblioteca)
   --------------------------------------------------------------- */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const temReservatorio = () => Boolean(REDIS_URL && REDIS_TOKEN);

async function redis(...comando) {
  if (!temReservatorio()) {
    const e = new Error('O reservatório de solicitações ainda não foi conectado.');
    e.status = 503;
    throw e;
  }
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok || dados.error) {
    const e = new Error(`Reservatório: ${dados.error || res.status}`);
    e.status = 502;
    throw e;
  }
  return dados.result;
}

const CHAVE_LISTA = 'solicitacoes:indice';
const chaveDe = (protocolo) => `solicitacao:${protocolo}`;

export async function guardarSolicitacao(solicitacao) {
  await redis('SET', chaveDe(solicitacao.protocolo), JSON.stringify(solicitacao));
  await redis('LPUSH', CHAVE_LISTA, solicitacao.protocolo);
  await redis('LTRIM', CHAVE_LISTA, 0, 999);
}

export async function lerSolicitacao(protocolo) {
  const bruto = await redis('GET', chaveDe(protocolo));
  return bruto ? JSON.parse(bruto) : null;
}

export async function atualizarSolicitacao(protocolo, mudancas) {
  const atual = await lerSolicitacao(protocolo);
  if (!atual) return null;
  const nova = { ...atual, ...mudancas };
  await redis('SET', chaveDe(protocolo), JSON.stringify(nova));
  return nova;
}

export async function listarSolicitacoes(limite = 300) {
  const protocolos = await redis('LRANGE', CHAVE_LISTA, 0, limite - 1);
  if (!Array.isArray(protocolos) || !protocolos.length) return [];
  const valores = await redis('MGET', ...protocolos.map(chaveDe));
  return (valores || [])
    .map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean);
}

/* ---------------------------------------------------------------
   Limite de uma solicitação por e-mail a cada X dias
   --------------------------------------------------------------- */

const chaveLimite = (email) =>
  'limite:' + crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 16);

export async function marcarLimite(email, protocolo, dias) {
  const registro = JSON.stringify({ protocolo, em: new Date().toISOString(), dias });
  await redis('SET', chaveLimite(email), registro, 'EX', dias * 86400);
}

export async function lerLimite(email) {
  if (!temReservatorio()) return null;
  try {
    const bruto = await redis('GET', chaveLimite(email));
    if (!bruto) return null;
    const r = JSON.parse(bruto);
    const liberaEm = new Date(new Date(r.em).getTime() + r.dias * 86400000);
    const faltam = Math.max(0, Math.ceil((liberaEm - Date.now()) / 86400000));
    return { protocolo: r.protocolo, abertoEm: r.em, liberaEm: liberaEm.toISOString(), faltam };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------
   Leitura do status do pedido
   --------------------------------------------------------------- */

const STEPS = [
  { key: 'confirmado', label: 'Pedido confirmado', titulo: 'Pedido confirmado' },
  { key: 'preparacao', label: 'Em preparação', titulo: 'Em preparação' },
  { key: 'embalado', label: 'Embalado, aguardando a transportadora', titulo: 'Embalado, aguardando a transportadora' },
  { key: 'enviado', label: 'Pedido enviado', titulo: 'Seu pedido já foi enviado' },
];

function primeiroEnvio(order) {
  const lista = order.fulfillments || order.fulfillment_orders || [];
  return Array.isArray(lista) && lista.length ? lista[0] : null;
}

export function lerStatus(order) {
  const envio = primeiroEnvio(order);
  const fs = String(envio?.status || '').toUpperCase();
  const ss = String(order.shipping_status || '').toLowerCase();
  const pago = ['paid', 'authorized', 'partially_paid'].includes(order.payment_status);

  // Estados que interrompem a linha do tempo
  if (order.status === 'cancelled') {
    return {
      cor: 'vermelho',
      titulo: 'Pedido cancelado',
      detalhe: order.payment_status === 'refunded'
        ? 'O valor foi estornado. Estornos no cartão aparecem na fatura em até duas faturas.'
        : 'Se você não pediu o cancelamento, abra uma solicitação abaixo que a gente verifica.',
      etapaAtual: -1,
      etapas: [],
      ...extras(order, envio),
    };
  }

  if (!pago) {
    return {
      cor: 'vermelho',
      titulo: 'Aguardando pagamento',
      detalhe: 'Assim que o pagamento for aprovado, a preparação começa. Pix costuma cair em minutos; boleto leva até 3 dias úteis.',
      etapaAtual: -1,
      etapas: [],
      ...extras(order, envio),
    };
  }

  let atual = 0;
  let entregue = false;
  if (fs === 'IN_PREPARATION') atual = 1;
  if (fs === 'PACKED' || ['packed', 'partially_packed'].includes(ss)) atual = 2;
  if (['DISPATCHED', 'READY_FOR_PICKUP'].includes(fs) || ['shipped', 'fulfilled', 'partially_fulfilled'].includes(ss)) atual = 3;
  if (fs === 'DELIVERED' || ss === 'delivered') { atual = 3; entregue = true; }

  // Pago mas ainda não embalado = já está na fila de produção
  if (atual === 0) atual = 1;

  const detalhes = [
    'Recebemos seu pedido.',
    'Estamos separando e conferindo suas peças.',
    'Suas peças já estão embaladas. A transportadora recolhe nas próximas coletas.',
    'Você pode acompanhar cada etapa da entrega pelo link de rastreio abaixo.',
  ];

  return {
    cor: entregue ? 'ouro' : atual === 3 ? 'verde' : 'roxo',
    titulo: entregue ? 'Entregue' : STEPS[atual].titulo,
    detalhe: entregue
      ? 'Entregue. Que essas peças te lembrem do que importa.'
      : detalhes[atual],
    etapaAtual: atual,
    etapas: STEPS.map((s, i) => ({
      ...s,
      concluida: i < atual || entregue,
      atual: i === atual && !entregue,
    })),
    ...extras(order, envio),
  };
}

/* O prazo vem escrito no próprio nome da opção de frete.
   Ex.: "Frete Econômico para: São Paulo (5 até 9 dias úteis)"
   vira { nome: "Frete Econômico", prazo: "5 até 9 dias úteis" } */
function lerFrete(order, envio) {
  const bruto =
    envio?.shipping?.option?.name ||
    order.shipping_option ||
    envio?.shipping?.carrier?.name ||
    order.shipping_carrier_name ||
    null;

  let prazo = null;
  let nome = null;

  if (bruto) {
    const texto = String(bruto);
    const entreParenteses = texto.match(/\(([^)]*\bdias?\b[^)]*)\)/i);
    if (entreParenteses) prazo = entreParenteses[1].trim();

    nome = texto
      .replace(/\s*\([^)]*\)\s*$/, '')   // tira o "(5 até 9 dias úteis)"
      .replace(/\s*para:.*$/i, '')       // tira o "para: São Paulo"
      .trim() || null;
  }

  // Se a loja não escreveu o prazo no nome, cai para os campos numéricos.
  if (!prazo) {
    const min = order.shipping_min_days ?? envio?.shipping?.estimated_delivery_time?.min?.business_days;
    const max = order.shipping_max_days ?? envio?.shipping?.estimated_delivery_time?.max?.business_days;
    if (min && max) prazo = `${min} até ${max} dias úteis`;
    else if (max) prazo = `até ${max} dias úteis`;
  }

  return { nome, prazo, original: bruto ? String(bruto) : null };
}

function extras(order, envio) {
  // Na prática o link completo costuma ser colado no campo do código.
  // Por isso qualquer um dos dois campos pode conter a URL.
  const ehLink = (v) => /^https?:\/\//i.test(String(v || '').trim());

  const campoCodigo = envio?.tracking_info?.code || order.shipping_tracking_number || null;
  const campoUrl = envio?.tracking_info?.url || order.shipping_tracking_url || null;

  const url = ehLink(campoCodigo) ? String(campoCodigo).trim()
            : ehLink(campoUrl) ? String(campoUrl).trim()
            : null;

  // Só mostramos "código" se for mesmo um código, não uma URL repetida.
  const codigo = campoCodigo && !ehLink(campoCodigo) ? String(campoCodigo).trim() : null;

  const rastreio = {
    codigo,
    url,
    transportadora: envio?.shipping?.carrier?.name || order.shipping_carrier_name || null,
  };

  const previsao = {
    de: envio?.shipping?.min_delivery_date || null,
    ate: envio?.shipping?.max_delivery_date || null,
  };

  /* Os prazos de troca e devolução contam da ENTREGA, não da compra.
     Nem sempre a transportadora confirma a entrega, então usamos, nesta ordem:
     1) a data real de entrega;
     2) a previsão máxima, quando ela já passou.
     Se nenhuma das duas existir, não dá para afirmar que o prazo acabou. */
  const agora = Date.now();
  const previsaoVencida =
    previsao.ate && new Date(previsao.ate).getTime() < agora ? previsao.ate : null;
  const baseEntrega = envio?.fulfilled_at || previsaoVencida || null;
  const diasDesdeEntrega = baseEntrega
    ? Math.floor((agora - new Date(baseEntrega).getTime()) / 86400000)
    : null;

  return {
    rastreio,
    previsao,
    frete: lerFrete(order, envio),
    entregueEm: envio?.fulfilled_at || null,
    baseEntrega,
    diasDesdeEntrega,
    eventos: (envio?.tracking_events || []).map((e) => ({
      status: e.status,
      descricao: e.description,
      local: e.address,
      quando: e.happened_at || e.created_at,
    })),
  };
}

/* ---------------------------------------------------------------
   Formato enviado ao navegador (só o que o cliente precisa ver)
   --------------------------------------------------------------- */

export function montarPedido(order) {
  return {
    id: order.id,
    numero: order.number,
    criadoEm: order.created_at,
    pagoEm: order.paid_at,
    total: order.total,
    moeda: order.currency || 'BRL',
    formaPagamento: order.payment_details?.method || order.gateway_name || null,
    parcelas: order.payment_details?.installments || 1,
    entrega: {
      nome: order.shipping_address?.name || null,
      cidade: order.shipping_address?.city || null,
      estado: order.shipping_address?.province || null,
      cep: order.shipping_address?.zipcode || null,
      rua: order.shipping_address?.address || null,
      numero: order.shipping_address?.number || null,
      bairro: order.shipping_address?.locality || null,
      complemento: order.shipping_address?.floor || null,
    },
    itens: (order.products || []).map((p) => ({
      id: p.id,
      nome: p.name,
      variacao: (p.variant_values || []).join(' / ') || null,
      quantidade: Number(p.quantity) || 1,
      preco: p.price,
      imagem: p.image?.src || null,
    })),
    status: lerStatus(order),
  };
}
