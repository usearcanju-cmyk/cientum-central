import { nuvem, requireSession, normalizeEmail, montarPedido, lerLimite } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ erro: 'Método não permitido.' });
  }

  try {
    const { email, nome } = requireSession(req);

    const brutos = await nuvem(
      `/orders?q=${encodeURIComponent(email)}&per_page=50&status=any&aggregates=fulfillment_orders`
    );

    // A busca `q` é ampla: filtramos aqui para garantir que só voltem os pedidos deste e-mail.
    const meus = (brutos || []).filter((o) => {
      const emails = [o.contact_email, o.customer?.email].filter(Boolean).map(normalizeEmail);
      return emails.includes(normalizeEmail(email));
    });

    meus.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Avisa a tela se este e-mail já tem uma solicitação em andamento,
    // para não deixar a pessoa anexar 5 fotos e só então descobrir o bloqueio.
    const limite = await lerLimite(email);

    return res.status(200).json({
      nome: (nome || '').split(' ')[0] || null,
      pedidos: meus.map(montarPedido),
      limite,
    });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ erro: e.message });
    console.error(e);
    return res.status(500).json({ erro: 'Não conseguimos carregar seus pedidos agora. Tente de novo em alguns instantes.' });
  }
}
