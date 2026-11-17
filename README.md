# Postly

Painel para **agendar publicações no Instagram**: feed (foto ou carrossel), Reels e Stories, em várias contas, com legenda e data/hora.

| Parte | Onde roda | O que faz |
|---|---|---|
| Site (painel) | **Vercel** | Você agenda, edita e acompanha os posts |
| Fotos e vídeos | **Vercel Blob** | Guarda as mídias; o Instagram baixa de lá |
| Posts e contas | **Este repositório** | `data/posts/*.json` e `data/accounts.json` |
| Publicador | **GitHub Actions** (`.github/workflows/publish.yml`) | A cada ~5 min publica no Instagram os posts cujo horário chegou |
| Tokens do Instagram | **Secrets do repositório** | Guardados criptografados; nunca vão para os arquivos |

Usa a API oficial da Meta ([Instagram Platform](https://developers.facebook.com/documentation/instagram-platform)).
Próxima etapa: integração com um número do [WhatsApp Business](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform).

## Funcionalidades

- **Várias contas do Instagram**, postar em várias de uma vez
- **Feed** (1 foto ou carrossel de até 10 fotos/vídeos, com reordenação), **Reels** (com opção de aparecer no feed) e **Stories**
- **Agendar**, **rascunhos**, **publicar agora**, **editar**, **cancelar** e **tentar de novo**
- **Painel** com filtros, **calendário**, **histórico** de cada publicação e **pré-visualização**
- **Validações** do Instagram (proporção do feed, 2.200 caracteres, 30 hashtags, 10 itens no carrossel)
- **Imagens convertidas para JPEG** no navegador; vídeos de até 300 MB
- **Renovação automática** dos tokens do Instagram (eles duram 60 dias)

## Configuração (uma vez só)

### 1. Token do GitHub
O site usa este token (guardado só na Vercel) para salvar os posts no repositório.

1. Abra [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. **Repository access** › *Only select repositories* › `postly`.
3. **Repository permissions** › **Read and write** em **Contents**, **Actions** e **Secrets**.
4. Gere e copie o token.

### 2. Vercel
No projeto da Vercel:

1. **Settings › Environment Variables** — adicione `GITHUB_TOKEN` com o token do passo 1.
   - Opcional: `POSTLY_PASSWORD` faz o painel pedir uma senha. **Sem ela, qualquer pessoa com o link do site consegue usar o painel e publicar nas suas contas.**
2. **Storage › Create › Blob** — crie um Blob Store e conecte ao projeto (isso cria `BLOB_READ_WRITE_TOKEN` sozinho).
3. **Deployments › Redeploy** para aplicar.

### 3. GitHub Actions
Na aba **Actions** do repositório, deixe os workflows ativados. Na primeira execução, o GitHub pode pedir para você aprovar.

### 4. Conta do Instagram
1. Em [developers.facebook.com/apps](https://developers.facebook.com/apps), crie um app com o produto **Instagram** (*API com login do Instagram*).
2. A conta precisa ser **profissional** (Comercial ou Criador de conteúdo). Com o app em modo de desenvolvimento, adicione a conta como **testadora** e aceite o convite no Instagram.
3. Em **Instagram › Configuração da API com login do Instagram › Gerar tokens de acesso**, gere o token da conta.
4. No Postly: **Contas › Conectar conta do Instagram**, cole o token (o GitHub Actions valida em ~30s).
5. Em **Contas › Configuração**, clique em **Ativar renovação automática**.

## Limitações

- **Horário aproximado**: o GitHub Actions roda a cada ~5 minutos e pode atrasar em horários de pico — conte com alguns minutos de atraso.
- **Repositório público**: legendas dos posts agendados ficam visíveis no repositório antes da publicação (os tokens ficam protegidos nos secrets).
- O GitHub **desativa workflows agendados** em repositórios sem atividade por 60 dias; se acontecer, reative na aba Actions.
- Limites do Instagram: 100 publicações por conta a cada 24 h; Stories só para contas Comerciais; sem figurinhas, músicas ou filtros pela API.

## Estrutura

```
index.html, assets/           site (servido pela Vercel)
api/                          funções da Vercel: acesso ao GitHub, upload de mídia, senha opcional
scripts/publish.mjs           publicador (roda no GitHub Actions)
scripts/lib/                  API do Instagram e máquina de estados da publicação
.github/workflows/publish.yml agenda do publicador
data/                         posts e contas
test/                         testes (API do Instagram simulada)
```

```bash
npm install
```

```bash
npm test
```
