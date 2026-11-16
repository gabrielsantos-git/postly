# Postly

Painel para **agendar publicações no Instagram**: feed (foto ou carrossel), Reels e Stories, em várias contas, com legenda e data/hora.

Roda **100% no GitHub**, sem servidor:

| Parte | Onde roda | O que faz |
|---|---|---|
| Site (painel) | **GitHub Pages** | Você agenda, edita e acompanha os posts |
| Dados | **Este repositório** | Posts em `data/posts/*.json`, mídias em `data/media/`, contas em `data/accounts.json` |
| Publicador | **GitHub Actions** (`.github/workflows/publish.yml`) | A cada ~5 min publica no Instagram os posts cujo horário chegou |
| Tokens do Instagram | **Secrets do repositório** | Guardados criptografados; nunca vão para os arquivos |

Usa a API oficial da Meta ([Instagram Platform](https://developers.facebook.com/documentation/instagram-platform)).
Próxima etapa: integração com um número do [WhatsApp Business](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform).

## Funcionalidades

- **Várias contas do Instagram**, postar em várias de uma vez (um post por conta)
- **Feed** (1 foto ou carrossel de até 10 fotos/vídeos, com reordenação), **Reels** (com opção de aparecer no feed) e **Stories**
- **Agendar**, **rascunhos**, **publicar agora**, **editar**, **cancelar** e **tentar de novo**
- **Painel** com filtros, **calendário mensal**, **histórico** de cada publicação e **pré-visualização** enquanto edita
- **Validações**: proporção do feed (4:5 a 1.91:1), 2.200 caracteres, 30 hashtags, 20 menções, 10 itens no carrossel
- **Imagens convertidas para JPEG** no navegador (único formato aceito pela API), com no máximo 1440 px de largura
- **Publicação resistente a falhas**: se o Instagram demorar para processar um vídeo, a próxima execução continua de onde parou; erros temporários são tentados de novo (até 3 vezes)
- **Renovação automática** dos tokens do Instagram (opcional)

## Configuração (uma vez só)

### 1. GitHub Pages
Em **Settings › Pages**: *Source* = **Deploy from a branch**, escolha a branch principal do repositório e a pasta **/ (root)**.
O site fica em `https://SEU-USUARIO.github.io/postly/`.

### 2. GitHub Actions
Em **Settings › Actions › General**, deixe as Actions permitidas. Se a aba **Actions** pedir para ativar os workflows, ative.

### 3. Token do GitHub (para entrar no site)
O site não tem servidor: ele grava os posts direto no repositório usando um token seu.

1. Abra [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) (token *fine-grained*).
2. **Repository access** › *Only select repositories* › este repositório.
3. **Repository permissions** › **Read and write** em: **Contents**, **Actions** e **Secrets**.
4. Gere o token, abra o site e cole na tela de entrada. Ele fica salvo só no seu navegador.

### 4. App da Meta e token do Instagram
1. Em [developers.facebook.com/apps](https://developers.facebook.com/apps), crie um app e adicione o produto **Instagram** (*API com login do Instagram*).
2. A conta do Instagram precisa ser **profissional** (Comercial ou Criador de conteúdo). Enquanto o app estiver em modo de desenvolvimento, adicione a conta como **testadora** do app (em *Funções do app*) e aceite o convite no Instagram.
3. Em **Instagram › Configuração da API com login do Instagram › Gerar tokens de acesso**, adicione a conta e clique em **Gerar token**.
4. No Postly, vá em **Contas › Conectar conta do Instagram** e cole o token. O site salva o token como secret do repositório e o GitHub Actions confere se ele funciona (leva uns 30 segundos).

### 5. (Recomendado) Renovação automática dos tokens
Os tokens do Instagram expiram em **60 dias**. Em **Contas › Configuração**, clique em **Ativar usando meu token do GitHub**: o publicador passa a renovar os tokens toda semana sozinho.

## Limitações (importante)

- **Horário aproximado**: o GitHub Actions roda a cada ~5 minutos e o GitHub pode atrasar execuções agendadas em horários de pico. Conte com **alguns minutos de atraso** (às vezes mais de 10).
- **Repositório público = posts públicos**: no plano gratuito, o GitHub Pages exige repositório público. Legendas e mídias dos posts agendados ficam visíveis no repositório **antes** da publicação. Os tokens ficam protegidos (secrets).
- **Vídeos de até 95 MB** (limite de arquivo do GitHub). As mídias de posts publicados são apagadas do repositório após 7 dias (o site do Pages tem limite de 1 GB).
- O GitHub **desativa workflows agendados** em repositórios sem atividade por 60 dias. Se isso acontecer, reative na aba Actions.
- As regras do GitHub não permitem usar o Actions como servidor. Um publicador agendado leve como este costuma ser tolerado, mas para uso profissional com muitas contas o ideal é migrar para uma hospedagem própria.
- Limites da API do Instagram: 100 publicações por conta a cada 24 h; Stories só para contas Comerciais; sem figurinhas, músicas ou filtros.

## Estrutura

```
index.html                    o site (GitHub Pages)
assets/
  app.js                      interface
  github.js                   leitura/gravação no repositório pela API do GitHub
  rules.js                    regras de validação (usadas pelo site e pelo publicador)
  styles.css
  vendor/                     libsodium (criptografia dos secrets)
scripts/
  publish.mjs                 publicador (roda no GitHub Actions)
  lib/instagram.mjs           chamadas à API do Instagram
  lib/publisher.mjs           máquina de estados da publicação
.github/workflows/publish.yml agenda do publicador
data/                         posts, mídias e contas (gravados pelo site e pelo publicador)
test/                         testes (API do Instagram simulada)
```

Rodar os testes:

```bash
npm install
```

```bash
npm test
```
