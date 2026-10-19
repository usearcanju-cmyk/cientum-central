import crypto from 'node:crypto';
import {
  signSession, requirePainel, temReservatorio,
  listarSolicitacoes, atualizarSolicitacao,
} from './_lib.js';

const senhaConfere = (enviada) => {
  const correta = process.env.PAINEL_SENHA || '';
  if (!correta) return false;
  const a = crypto.createHash('sha256').update(String(enviada)).digest();
  const b = crypto.createHash('sha256').update(correta).digest();
  return crypto.timingSafeEqual(a, b);
};

export default async function handler(req, res) {
  try {
    // Entrar no painel
    if (req.method === 'POST') {
      if (!process.env.PAINEL_SENHA) {
        return res.status(503).json({ erro: 'Defina a variável PAINEL_SENHA na Vercel para liberar o painel.' });
      }
      if (!senhaConfere(req.body?.senha)) {
        await new Promise((r) => setTimeout(r, 800));
        return res.status(401).json({ erro: 'Senha incorreta.' });
      }
      return res.status(200).json({ token: signSession({ painel: true }, 60 * 60 * 12) });
    }

    // Listar solicitações
    if (req.method === 'GET') {
      requirePainel(req);
      if (!temReservatorio()) {
        return res.status(503).json({ erro: 'O reservatório ainda não foi conectado na Vercel.' });
      }
      const solicitacoes = await listarSolicitacoes(300);
      solicitacoes.sort((a, b) => new Date(b.abertoEm) - new Date(a.abertoEm));
      return res.status(200).json({ solicitacoes });
    }

    // Marcar como resolvida ou reabrir
    if (req.method === 'PATCH') {
      requirePainel(req);
      const { protocolo, status } = req.body || {};
      if (!protocolo || !['aberta', 'resolvida'].includes(status)) {
        return res.status(400).json({ erro: 'Informe o protocolo e o novo status.' });
      }
      const nova = await atualizarSolicitacao(protocolo, {
        status,
        resolvidoEm: status === 'resolvida' ? new Date().toISOString() : null,
      });
      if (!nova) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
      return res.status(200).json({ solicitacao: nova });
    }

    return res.status(405).json({ erro: 'Método não permitido.' });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ erro: e.message });
    if (e.status === 503) return res.status(503).json({ erro: e.message });
    console.error(e);
    return res.status(500).json({ erro: 'Não conseguimos carregar o painel agora.' });
  }
}
