import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import { requireSession } from './_lib.js';

const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const LIMITE_BYTES = 3 * 1024 * 1024; // 3 MB por foto, já comprimida no navegador

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido.' });
  }

  try {
    const { email } = requireSession(req);
    const { dados, tipo } = req.body || {};

    const extensao = TIPOS[tipo];
    if (!extensao) {
      return res.status(400).json({ erro: 'Envie fotos em JPG, PNG ou WEBP.' });
    }
    if (typeof dados !== 'string' || !dados.length) {
      return res.status(400).json({ erro: 'A foto chegou vazia. Tente enviar de novo.' });
    }

    const binario = Buffer.from(dados, 'base64');
    if (binario.length > LIMITE_BYTES) {
      return res.status(413).json({ erro: 'Essa foto é grande demais. Tente outra.' });
    }

    const pasta = crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
    const nome = `solicitacoes/${pasta}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extensao}`;

    const blob = await put(nome, binario, {
      access: 'public',
      contentType: tipo,
      addRandomSuffix: true,
    });

    return res.status(200).json({ url: blob.url });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ erro: e.message });
    console.error(e);
    return res.status(500).json({ erro: 'Não conseguimos guardar essa foto. Tente de novo.' });
  }
}
