import { nuvem, signSession, normalizeEmail } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido.' });
  }

  try {
    const numero = String(req.body?.numero || '').replace(/\D/g, '');
    const email = normalizeEmail(req.body?.email);

    if (!numero || !email.includes('@')) {
      return res.status(400).json({ erro: 'Informe o número do pedido e o e-mail usado na compra.' });
    }

    // A busca `q` aceita o número do pedido. Confirmamos o casamento depois, no servidor.
    const encontrados = await nuvem(
      `/orders?q=${encodeURIComponent(numero)}&per_page=50&status=any&fields=id,number,contact_email,customer`
    );

    const pedido = (encontrados || []).find((o) => String(o.number) === numero);

    // Atraso curto para desestimular tentativa de adivinhação em série.
    if (!pedido) {
      await new Promise((r) => setTimeout(r, 700));
      return res.status(404).json({
        erro: 'Não encontramos esse pedido. Confira o número no e-mail de confirmação da compra.',
      });
    }

    const emailsDoPedido = [pedido.contact_email, pedido.customer?.email]
      .filter(Boolean)
      .map(normalizeEmail);

    if (!emailsDoPedido.includes(email)) {
      await new Promise((r) => setTimeout(r, 700));
      return res.status(404).json({
        erro: 'Esse e-mail não confere com o pedido. Use o mesmo e-mail que recebeu a confirmação.',
      });
    }

    const nome = pedido.customer?.name || '';
    return res.status(200).json({
      token: signSession({ email, nome }),
      nome: nome.split(' ')[0] || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(e.status === 401 ? 401 : 500).json({
      erro: 'Não conseguimos consultar seus pedidos agora. Tente de novo em alguns instantes.',
    });
  }
}
