# Postly

Painel para **agendar publicações no Instagram**: feed (foto ou carrossel), Reels e Stories, em várias contas, com legenda e data/hora.
No horário marcado, o Postly publica sozinho pela API oficial da Meta ([Instagram Platform](https://developers.facebook.com/documentation/instagram-platform)).

> Próxima etapa: integração com um número do WhatsApp Business ([WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform)).

## O que já funciona

- **Várias contas do Instagram**: conecte com "Entrar com Instagram" (OAuth) ou colando um token de acesso. Os tokens ficam criptografados (AES-256-GCM) e são **renovados automaticamente** antes de expirar (duram 60 dias).
- **Formatos**
  - **Feed**: 1 foto, ou **carrossel** com 2 a 10 fotos/vídeos (com reordenação)
  - **Reels**: 1 vídeo, com opção de aparecer também no feed
  - **Stories**: 1 foto ou vídeo
- **Agendamento** com data/hora (no fuso do navegador), **rascunhos**, **publicar agora**, **cancelar**, **editar** e **tentar de novo** quando falha.
- **Postar em várias contas de uma vez** (cria um post para cada conta).
- **Painel** com filtros (próximos, falhas, publicados, rascunhos), **calendário mensal** e **histórico** de cada post (cada passo da publicação fica registrado).
- **Pré-visualização** do post enquanto você edita.
- **Validações** antes de agendar: proporção das fotos no feed (4:5 a 1.91:1), limite de 2.200 caracteres, 30 hashtags, 20 menções e 10 itens no carrossel.
- **Imagens convertidas para JPEG** automaticamente (único formato de imagem aceito pela API), com orientação corrigida e largura máxima de 1440 px.
- **Consulta do limite diário** de publicações via API de cada conta.
- **Publicação resistente a falhas**: o progresso fica salvo no banco, então se o servidor reiniciar no meio de um vídeo sendo processado, ele continua de onde parou. Erros temporários da API são tentados de novo (até 3 vezes); token expirado marca a conta para reconexão.

## Requisitos

- Node.js 20.6 ou mais recente
- Contas do Instagram **profissionais** (Comercial ou Criador de conteúdo)
- Um app no [painel de desenvolvedores da Meta](https://developers.facebook.com/apps) com o produto **Instagram → API com login do Instagram**
- Uma **URL pública com HTTPS** onde o Postly fique acessível (o Instagram baixa as mídias dela)

## Como rodar

```bash
npm install
```

```bash
cp .env.example .env
```

Preencha o `.env` (veja os comentários no arquivo). Para gerar o `APP_SECRET`:

```bash
openssl rand -hex 32
```

```bash
npm start
```

Acesse `http://localhost:3000` e entre com a senha definida em `ADMIN_PASSWORD`.

### Testando localmente

A API do Instagram **não aceita mídias em `localhost`**: ela precisa baixar o arquivo de uma URL pública. Para testar no seu computador, abra um túnel e use a URL dele como `PUBLIC_BASE_URL`:

```bash
cloudflared tunnel --url http://localhost:3000
```

(ou `ngrok http 3000`). Acesse o painel pela URL do túnel, para que o redirecionamento do OAuth funcione.

## Configurando o app da Meta

1. Em [developers.facebook.com/apps](https://developers.facebook.com/apps), crie um app do tipo **Empresa** e adicione o produto **Instagram**.
2. Em **Instagram → Configuração da API com login do Instagram**:
   - Copie o **ID do app do Instagram** e a **Chave secreta do app do Instagram** para `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET`.
   - Em **Configurar login comercial do Instagram**, cadastre a URL de redirecionamento: `https://SEU-DOMINIO/auth/instagram/callback` (a URL exata aparece na tela **Contas** do Postly).
3. Permissões usadas: `instagram_business_basic` e `instagram_business_content_publish`.
4. Enquanto o app estiver em modo de desenvolvimento, só contas adicionadas como **testadoras** do app conseguem se conectar. Para usar com qualquer conta, envie o app para a **Análise do app** da Meta pedindo essas duas permissões.

Atalho para testes: na mesma tela do painel da Meta dá para **gerar um token** para uma conta testadora e colá-lo em **Contas → Adicionar com token**.

## Como a publicação funciona

A cada 15 segundos o agendador procura posts cujo horário chegou e segue o fluxo da API de publicação de conteúdo:

1. `POST /{ig-user-id}/media` cria o *container* (`image_url`; `media_type=REELS` + `video_url`; `media_type=STORIES`; ou itens `is_carousel_item` + container `CAROUSEL` com `children`).
2. `GET /{container-id}?fields=status_code` até ficar `FINISHED` (vídeos levam alguns minutos).
3. `POST /{ig-user-id}/media_publish` com `creation_id`.
4. Busca o `permalink` para mostrar o link do post no painel.

Limites importantes da API: 100 publicações por conta a cada 24 h; **stories só podem ser publicados por contas comerciais**; stickers, músicas, filtros e marcações de produto não estão disponíveis pela API.

## Estrutura

```
src/
  server.js              servidor HTTP, login do painel e OAuth do Instagram
  routes/api.js          API usada pelo front-end
  config.js              leitura do .env
  db.js                  banco SQLite (contas, mídias, posts, histórico)
  crypto.js              criptografia dos tokens e assinatura da sessão
  accounts.js            conexão de contas e renovação de tokens
  media.js               upload e conversão de mídias
  posts.js               regras e validação dos posts
  scheduler.js           agendador
  instagram/client.js    chamadas à API do Instagram
  instagram/publisher.js máquina de estados da publicação
public/                  front-end (HTML, CSS e JS, sem etapa de build)
test/                    testes (API do Instagram simulada)
```

Rode os testes com:

```bash
npm test
```

## Hospedagem

O Postly precisa de um servidor que fique **sempre ligado** (o agendador roda dentro do processo) e de **disco persistente** para a pasta `data/` (banco + mídias). Funciona bem em uma VPS, Railway, Render (com disco), Fly.io (com volume) etc. Rode **uma única instância**. Plataformas *serverless* (como Vercel) não servem sem adaptações, porque não mantêm o processo nem os arquivos.
