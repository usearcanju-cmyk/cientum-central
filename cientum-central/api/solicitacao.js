import crypto from 'node:crypto';
import {
  nuvem, requireSession, normalizeEmail, lerStatus,
  guardarSolicitacao, temReservatorio, marcarLimite, lerLimite,
} from './_lib.js';

/* `naNota`     = aparece na observação do pedido (muda o trabalho de bancada)
   `exigeEnvio` = só liberado depois que o pedido foi postado
   `fotos`      = quantidade mínima de fotos
   Todas as solicitações vão para o reservatório, independente disso. */
const ASSUNTOS = {
  alterar_tamanho: { rotulo: 'Alterar tamanho antes do envio', janelaDias: null, naNota: true,  exigeEnvio: false, fotos: 0, pedePeca: true },
  endereco:        { rotulo: 'Corrigir endereço',              janelaDias: null, naNota: true,  exigeEnvio: false, fotos: 0 },
  troca_tamanho:   { rotulo: 'Troca de tamanho',               janelaDias: 7,    naNota: false, exigeEnvio: true,  fotos: 5, pedePeca: true, travaPrazo: true },
  defeito:         { rotulo: 'Peça com defeito',               janelaDias: 90,   naNota: false, exigeEnvio: true,  fotos: 5 },
  devolucao:       { rotulo: 'Devolução e reembolso',          janelaDias: 7,    naNota: false, exigeEnvio: true,  fotos: 5, travaPrazo: true },
};

/* Três dias de folga em cima da janela: a data de entrega nem sempre é exata,
   e é melhor aceitar um caso limítrofe do que barrar quem tinha direito. */
const TOLERANCIA_DIAS = 3;

/* Uma solicitação por e-mail a cada 30 dias.
   Para liberar exceções, basta acrescentar o id do assunto na lista abaixo.
   Ex.: ['endereco', 'alterar_tamanho'] deixa esses dois sempre disponíveis. */
const DIAS_ENTRE_SOLICITACOES = 30;
const ASSUNTOS_SEM_LIMITE = [];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido.' });
  }

  try {
    const { email, nome } = requireSession(req);
    const { pedidoId, assunto, itens = [], mensagem = '',
            fotos = [], tamanhoDesejado = '', modeloDesejado = '',
            declaracao = false } = req.body || {};

    const config = ASSUNTOS[assunto];
    if (!config) return res.status(400).json({ erro: 'Escolha o motivo da solicitação.' });
    if (String(mensagem).trim().length < 10) {
      return res.status(400).json({ erro: 'Escreva pelo menos uma frase explicando o que aconteceu.' });
    }

    if (!ASSUNTOS_SEM_LIMITE.includes(assunto)) {
      const limite = await lerLimite(email);
      if (limite) {
        return res.status(429).json({
          erro: `Você já abriu a solicitação ${limite.protocolo} e ela ainda está em análise. `
              + `É permitida uma solicitação a cada ${DIAS_ENTRE_SOLICITACOES} dias. `
              + `Você poderá abrir outra em ${limite.faltam} `
              + (limite.faltam === 1 ? 'dia.' : 'dias.'),
          limite,
        });
      }
    }

    const pedido = await nuvem(`/orders/${encodeURIComponent(pedidoId)}?aggregates=fulfillment_orders`);
    const emails = [pedido.contact_email, pedido.customer?.email].filter(Boolean).map(normalizeEmail);
    if (!emails.includes(normalizeEmail(email))) {
      return res.status(403).json({ erro: 'Esse pedido não está na sua conta.' });
    }

    const status = lerStatus(pedido);
    const jaSaiu = status.etapaAtual >= 3;

    // Trava: alguns assuntos só existem depois que o pedido foi postado.
    if (config.exigeEnvio && !jaSaiu) {
      return res.status(409).json({
        erro: 'Seu pedido ainda não foi enviado. Essa opção é liberada só depois do envio.',
      });
    }

    // Fotos: a quantidade mínima é conferida também aqui, não só na tela.
    const listaFotos = (Array.isArray(fotos) ? fotos : [])
      .filter((u) => typeof u === 'string' && /^https:\/\//.test(u))
      .slice(0, 12);

    if (listaFotos.length < config.fotos) {
      return res.status(400).json({
        erro: config.fotos === 1
          ? 'Envie a foto pedida para a gente conseguir analisar.'
          : `Envie pelo menos ${config.fotos} fotos para a gente conseguir analisar.`,
      });
    }

    if (assunto === 'devolucao' && declaracao !== true) {
      return res.status(400).json({ erro: 'Marque a declaração sobre o prazo do reembolso para continuar.' });
    }

    if (config.pedePeca && !String(tamanhoDesejado).trim()) {
      return res.status(400).json({ erro: 'Diga para qual tamanho você quer trocar.' });
    }

    if (config.pedePeca && !String(modeloDesejado).trim()) {
      return res.status(400).json({ erro: 'Diga se a peça é tradicional ou baby look.' });
    }

    const dias = status.diasDesdeEntrega;

    // Sem data de entrega confiável, o benefício da dúvida é do cliente.
    const dentroDoPrazo = config.janelaDias == null || dias == null
      ? true
      : dias <= config.janelaDias;

    if (config.travaPrazo && dias != null && dias > config.janelaDias + TOLERANCIA_DIAS) {
      return res.status(409).json({
        erro: `O prazo de ${config.janelaDias} dias após a entrega já passou `
            + `(seu pedido foi entregue há ${dias} dias).`,
      });
    }

    const protocolo = `CT-${pedido.number}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const admin = (process.env.LOJA_ADMIN_URL || 'https://cientum.lojavirtualnuvem.com.br').replace(/\/+$/, '');

    const solicitacao = {
      protocolo,
      status: 'aberta',
      assunto,
      assuntoRotulo: config.rotulo,
      naNota: config.naNota,
      pedidoId: pedido.id,
      pedidoNumero: pedido.number,
      pedidoLink: `${admin}/admin/orders/${pedido.id}`,
      pedidoStatus: status.titulo,
      pedidoCriadoEm: pedido.created_at,
      rastreio: status.rastreio?.url || status.rastreio?.codigo || null,
      clienteNome: nome || pedido.contact_name || '',
      clienteEmail: email,
      clienteTelefone: pedido.contact_phone || '',
      entrega: [
        pedido.shipping_address?.address,
        pedido.shipping_address?.number,
        pedido.shipping_address?.locality,
        pedido.shipping_address?.city,
        pedido.shipping_address?.province,
        pedido.shipping_address?.zipcode,
      ].filter(Boolean).join(', '),
      itens,
      fotos: listaFotos,
      tamanhoDesejado: String(tamanhoDesejado).trim().slice(0, 40) || null,
      modeloDesejado: String(modeloDesejado).trim().slice(0, 40) || null,
      declaracao: assunto === 'devolucao' ? true : null,
      mensagem: String(mensagem).trim().slice(0, 2000),
      dentroDoPrazo,
      diasDesdeEntrega: dias,
      janelaDias: config.janelaDias,
      abertoEm: new Date().toISOString(),
      resolvidoEm: null,
    };

    // Só os assuntos operacionais entram na observação do pedido.
    if (config.naNota) {
      const bloco = [
        '',
        '──────────────────────────────',
        `[${protocolo}] ${config.rotulo}`,
        `Aberto em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        `Cliente: ${solicitacao.clienteNome || '—'} · ${email}`,
        itens.length ? `Peças: ${itens.join(' | ')}` : null,
        solicitacao.tamanhoDesejado
          ? `Peça desejada: ${solicitacao.modeloDesejado || '—'} · tamanho ${solicitacao.tamanhoDesejado}`
          : null,
        `Pedido do cliente: ${solicitacao.mensagem}`,
        '──────────────────────────────',
      ].filter(Boolean).join('\n');

      await nuvem(`/orders/${pedido.id}`, {
        method: 'PUT',
        body: JSON.stringify({ owner_note: ((pedido.owner_note || '') + bloco).slice(-4000) }),
      });
    }

    // O reservatório recebe tudo. Se ainda não estiver conectado, a
    // solicitação não pode se perder: cai na observação como reserva.
    if (temReservatorio()) {
      await guardarSolicitacao(solicitacao);
    } else if (!config.naNota) {
      const bloco = [
        '',
        `[${protocolo}] ${config.rotulo} — registrado na observação porque o painel não está conectado`,
        `Cliente: ${solicitacao.clienteNome} · ${email}`,
        `Relato: ${solicitacao.mensagem}`,
      ].join('\n');
      await nuvem(`/orders/${pedido.id}`, {
        method: 'PUT',
        body: JSON.stringify({ owner_note: ((pedido.owner_note || '') + bloco).slice(-4000) }),
      });
    }

    if (temReservatorio() && !ASSUNTOS_SEM_LIMITE.includes(assunto)) {
      await marcarLimite(email, protocolo, DIAS_ENTRE_SOLICITACOES);
    }

    await avisarEquipe(solicitacao);

    return res.status(200).json({
      protocolo,
      dentroDoPrazo,
      proximoPasso: proximoPasso(assunto, dentroDoPrazo, status),
    });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ erro: e.message });
    console.error(e);
    return res.status(500).json({ erro: 'Não conseguimos registrar sua solicitação agora. Tente de novo em alguns instantes.' });
  }
}

function proximoPasso(assunto, dentroDoPrazo, status) {
  const jaSaiu = status?.etapaAtual === 3;

  if (assunto === 'alterar_tamanho') {
    return jaSaiu
      ? 'Seu pedido já saiu daqui, então não dá mais para trocar o tamanho antes do envio. Vamos responder por e-mail em até 1 dia útil explicando como fazer a troca depois que ele chegar.'
      : 'Se o pedido ainda não foi embalado, trocamos o tamanho e você recebe a confirmação por e-mail em até 1 dia útil.';
  }
  if (assunto === 'endereco') {
    return jaSaiu
      ? 'O pedido já foi postado com o endereço antigo. Vamos acionar a transportadora e te responder por e-mail em até 1 dia útil.'
      : 'Vamos corrigir o endereço antes da postagem e confirmar por e-mail em até 1 dia útil.';
  }
  if (assunto === 'devolucao' && !dentroDoPrazo) {
    return 'O prazo de 7 dias para desistência já passou, mas vamos analisar o caso e responder por e-mail em até 1 dia útil.';
  }
  if (assunto === 'troca_tamanho') {
    return 'Vamos conferir o estoque do tamanho que você quer e enviar o código de postagem por e-mail em até 1 dia útil.';
  }
  if (assunto === 'defeito') {
    return 'Responda o e-mail que você vai receber anexando as fotos da peça. Com as fotos, a troca é aprovada no mesmo dia.';
  }
  if (assunto === 'devolucao') {
    return 'Vamos enviar o código de postagem por e-mail em até 1 dia útil. O reembolso sai em até 10 dias após a peça chegar aqui.';
  }
  return 'Você recebe uma resposta por e-mail em até 1 dia útil.';
}

/* Avisos opcionais: só disparam se as variáveis de ambiente existirem. */
async function avisarEquipe(s) {
  const linhas = [
    `${s.protocolo} — ${s.assuntoRotulo}`,
    `Pedido #${s.pedidoNumero} · ${s.clienteNome} · ${s.clienteEmail}`,
    s.itens.length ? `Peças: ${s.itens.join(' | ')}` : null,
    s.janelaDias != null
      ? `${s.dentroDoPrazo ? 'Dentro do prazo' : 'Fora do prazo'} (${s.diasDesdeEntrega ?? '—'} dias desde a entrega)`
      : null,
    '',
    s.mensagem,
  ].filter(Boolean).join('\n');

  const tarefas = [];

  if (process.env.WEBHOOK_URL) {
    tarefas.push(
      fetch(process.env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: linhas, text: linhas, ...s }),
      })
    );
  }

  if (process.env.RESEND_API_KEY && process.env.EMAIL_DESTINO && process.env.EMAIL_REMETENTE) {
    tarefas.push(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_REMETENTE,
          to: [process.env.EMAIL_DESTINO],
          reply_to: s.clienteEmail,
          subject: `${s.protocolo} · ${s.assuntoRotulo} · pedido #${s.pedidoNumero}`,
          text: linhas,
        }),
      })
    );
  }

  await Promise.allSettled(tarefas);
}
