# Central do pedido — Cientum

Página de autoatendimento da Cientum: o cliente entra com o número do
pedido e o e-mail, vê todos os pedidos dele, o status de cada um, o rastreio, a
previsão de entrega, e abre solicitações de troca ou devolução sem falar com ninguém.

As solicitações caem direto na **observação interna do pedido** dentro do painel da
Nuvemshop. Você não precisa de nenhum sistema novo pra atender: abre o pedido e a
solicitação está lá.

---

## Passo 1 — Criar o app na Nuvemshop e pegar o token

O token da API não sai do painel da loja. Ele vem de um "app" que você cria pra si mesmo.

1. Crie a conta em **partners.nuvemshop.com.br** (é grátis, você já é lojista).
2. Vá em **Aplicações → Criar aplicação**.
3. Preencha:
   - **Nome:** Central do pedido
   - **URL de redirecionamento:** `https://SEU-PROJETO.vercel.app/` (ajuste depois do deploy)
   - **URL, URL de preferências, política de privacidade:** pode apontar tudo pra `https://cientum.com.br` por enquanto
4. Marque os **escopos**:
   - `read_orders` e `write_orders` (o write é o que permite gravar a solicitação na observação do pedido)
   - `read_customers`
   - `read_shipping` / `read_fulfillment_orders`, se aparecerem na lista
5. Salve e anote o **App ID** e o **Client Secret**.
6. Abra no navegador, logado como dono da loja:
   `https://www.nuvemshop.com.br/apps/SEU_APP_ID/authorize`
7. Autorize. Você vai ser redirecionado com um `?code=xxxx` na URL. **Copie esse código, ele expira em 5 minutos.**
8. Troque o código pelo token. Se não quiser usar terminal, use qualquer cliente HTTP
   (Postman, Hoppscotch, ReqBin) e faça um **POST** para
   `https://www.nuvemshop.com.br/apps/authorize/token` com corpo **JSON**:

   ```json
   {
     "client_id": "SEU_APP_ID",
     "client_secret": "SEU_CLIENT_SECRET",
     "grant_type": "authorization_code",
     "code": "O_CODIGO_DA_URL"
   }
   ```

   A resposta traz `access_token` e `user_id`. O `user_id` é o **ID da sua loja**
  .

O token não expira. Ele só morre se você gerar outro ou desinstalar o app.

---

## Passo 2 — Subir pro GitHub

Crie um repositório novo (pode ser privado) e suba estes arquivos mantendo a estrutura:

```
api/_lib.js
api/session.js
api/pedidos.js
api/solicitacao.js
public/index.html
package.json
vercel.json
```

Pela interface web do GitHub: **Add file → Create new file**, e digite
`api/_lib.js` no nome — a barra cria a pasta sozinha.

---

## Passo 3 — Publicar na Vercel

1. **Add New → Project**, importe o repositório.
2. Framework Preset: **Other**. Não mexa em build command nem output directory.
3. Em **Environment Variables**, adicione:

| Nome | Valor |
|---|---|
| `NUVEMSHOP_STORE_ID` | o `user_id` que voltou no passo 1 |
| `NUVEMSHOP_ACCESS_TOKEN` | o `access_token` do passo 1 |
| `SESSION_SECRET` | uma string aleatória longa e única |
| `NUVEMSHOP_USER_AGENT` | `Central Cientum (contato@cientum.com.br)` |

4. Deploy.

Opcionais, se quiser ser avisado a cada solicitação aberta:

| Nome | Para quê |
|---|---|
| `WEBHOOK_URL` | URL de webhook do Discord ou Slack — chega uma mensagem por solicitação |
| `RESEND_API_KEY` + `EMAIL_REMETENTE` + `EMAIL_DESTINO` | envia a solicitação por e-mail (conta grátis em resend.com) |

Sem nenhuma dessas, tudo continua funcionando: a solicitação fica gravada no pedido.

---

## Passo 4 — Colocar no site

Você já tem o item **"Rastreie seu pedido"** no menu apontando pro Vercel. O mais
simples é trocar esse link pelo novo endereço e renomear para **"Meus pedidos"**.

Se preferir que fique dentro do layout da loja, crie uma página de conteúdo na
Nuvemshop (**Loja online → Páginas → Criar página**), abra o editor em modo HTML e cole:

```html
<iframe
  src="https://SEU-PROJETO.vercel.app/"
  style="width:100%;height:1400px;border:0;display:block"
  title="Central do pedido"
  loading="lazy"></iframe>
```

O `vercel.json` já libera o iframe para `cientum.com.br`. Se você usar outro
domínio, adicione ele na linha `frame-ancestors`.

Coloque o link em três lugares, que é onde o cliente procura:
o menu do topo, o rodapé, e o e-mail de confirmação da compra.

---

## O que o cliente vê

| Situação na Nuvemshop | O que aparece pra ele |
|---|---|
| Pagamento pendente | "Aguardando pagamento" + explicação de prazo de Pix e boleto |
| Pago, não embalado | "Em preparação" |
| Embalado | "Embalado, aguardando a transportadora" |
| Enviado | "A caminho" + código e link de rastreio |
| Entregue | "Entregue" |
| Cancelado | "Pedido cancelado" |

A previsão de entrega vem do próprio cálculo de frete da Nuvemshop
(`min_delivery_date` / `max_delivery_date`). Se a transportadora manda eventos de
rastreio pra Nuvemshop, eles aparecem também numa lista de movimentações.

---

## Ajustes que valem a pena fazer

- **Perguntas frequentes:** estão no topo do `<script>` em `public/index.html`, na
  constante `FAQ`. Elas aparecem antes do formulário de solicitação e são o que
  mais reduz volume de atendimento. Vale reescrever com as dúvidas reais que os
  clientes mandam.
- **Prazos de troca e devolução:** estão em `api/solicitacao.js`, na constante
  `ASSUNTOS`. Hoje: 30 dias para troca, 7 para devolução (é o mínimo legal do CDC),
  90 para defeito. Deixe igual à sua Política de Devolução e Reembolso.
- **E-mail de contato:** aparece no rodapé do `index.html`.

## Limites desta versão

- **Etiqueta de devolução automática** não está incluída. Depende de integração com
  Melhor Envio ou Correios. Hoje o fluxo é: cliente abre a solicitação → você envia
  o código de postagem. Dá pra automatizar depois.
- **Login por número do pedido + e-mail** é o padrão do e-commerce brasileiro e não
  exige serviço de e-mail. Se quiser algo mais forte, o próximo passo é código de
  6 dígitos enviado por e-mail.
- A busca lista até 50 pedidos por cliente, o que é bem mais do que o suficiente.
