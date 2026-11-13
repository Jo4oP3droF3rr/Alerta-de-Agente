# Alerta de Agente

App desktop para Windows que recebe **avisos em Markdown** e mostra cada um formatado: uma barra lateral com os últimos avisos e o resto da tela com o conteúdo do aviso.

Os avisos podem chegar de dois jeitos:

- **Local:** um POST em `http://127.0.0.1:5055/aviso` no próprio PC. Funciona sem servidor.
- **Pela VPS:** qualquer serviço (n8n, Shopify, Claude Code, curl, celular) faz um POST no servidor. O servidor guarda o aviso no Postgres e entrega na hora pro app, que fica conectado. Se o PC estiver desligado, o aviso espera no banco e chega quando o app abrir.

O mesmo servidor também distribui as **atualizações automáticas** do app.

```
 n8n / Shopify / Claude / curl
          │  POST https://SEU-DOMINIO/aviso   (Authorization: Bearer TOKEN_ENVIO)
          ▼
 ┌──────────── VPS (Docker) ────────────┐
 │  Caddy (HTTPS) → servidor → Postgres │
 │                     │ /updates       │
 └─────────────────────┼────────────────┘
          │  conexão aberta pelo app (SSE, Bearer TOKEN_LEITURA)
          ▼
   Monitor de Avisos (Windows)
```

## Estrutura

```
app/      App desktop (Electron)
server/   Servidor de avisos + atualizações (Node + Postgres + Caddy, via Docker)
```

---

## 1. Rodar o app localmente (sem servidor)

Requisitos: [Node.js 20+](https://nodejs.org) no Windows.

```bash
cd app
npm install
npm start
```

Teste mandando um aviso (com o app aberto):

```bash
npm run teste
```

ou, no PowerShell:

```powershell
curl.exe -X POST http://127.0.0.1:5055/aviso -H "Content-Type: text/markdown; charset=utf-8" --data-binary "# Olá`n`nAviso em **Markdown**."
```

O webhook local só aceita conexões do próprio PC.

---

## 2. Rodar o servidor localmente (Docker)

Requisitos: Docker com o Compose.

```bash
cd server
cp .env.example .env      # edite os tokens e a senha do Postgres
docker compose up --build postgres servidor
```

O servidor fica em `http://127.0.0.1:3000`. Pra fazer o app usar esse servidor, crie `app/.env`:

```env
SERVIDOR_URL=http://127.0.0.1:3000
SERVIDOR_TOKEN=<o mesmo TOKEN_LEITURA do server/.env>
```

e rode `npm start` de novo na pasta `app`.

---

## 3. Colocar na VPS (ex.: Hostinger, Ubuntu)

### 3.1. DNS

No painel do domínio, crie um registro **A** do subdomínio (ex.: `avisos.seudominio.com.br`) apontando pro IP da VPS.

### 3.2. Docker

Se a VPS ainda não tem Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

### 3.3. Código e configuração

```bash
sudo mkdir -p /opt/alerta-de-agente && sudo chown $USER /opt/alerta-de-agente
git clone https://github.com/Jo4oP3droF3rr/Alerta-de-Agente.git /opt/alerta-de-agente
cd /opt/alerta-de-agente/server
cp .env.example .env
nano .env
```

Preencha o `.env`:

| Variável | O que é |
|---|---|
| `DOMINIO` | O subdomínio do passo 3.1 (sem `https://`) |
| `TOKEN_ENVIO` | Senha pra **enviar** avisos. Gere com `openssl rand -hex 32` |
| `TOKEN_LEITURA` | Senha que vai dentro do app pra **ler** avisos e baixar atualizações. Diferente da de envio |
| `POSTGRES_PASSWORD` | Senha do banco. Gere com `openssl rand -hex 32` |
| `POSTGRES_USER` / `POSTGRES_DB` | Podem ficar como estão |
| `MAX_AVISOS` | Quantos avisos manter no banco (`0` = todos) |

### 3.4. Subir

```bash
docker compose up -d --build
docker compose logs -f servidor     # Ctrl+C para sair dos logs
```

O Caddy emite o certificado HTTPS sozinho. As portas **80 e 443** precisam estar livres e liberadas no firewall da VPS. Se já existir outro proxy rodando nelas (Traefik, Nginx, painel), remova o serviço `caddy` do `docker-compose.yml` e aponte o seu proxy para `127.0.0.1:3000`.

### 3.5. Testar de fora

```bash
curl https://avisos.seudominio.com.br/health

curl -X POST https://avisos.seudominio.com.br/aviso \
  -H "Authorization: Bearer SEU_TOKEN_ENVIO" \
  -H "Content-Type: text/markdown; charset=utf-8" \
  --data-binary "# Teste pela VPS

Funcionou **de fora**."
```

### 3.6. Atualizar o servidor

```bash
cd /opt/alerta-de-agente && git pull
cd server && docker compose up -d --build
```

### Banco de dados

- O Postgres roda no container `postgres` com volume próprio. Não fica exposto na internet.
- A tabela `avisos` é criada sozinha na primeira execução.
- Pra fazer backup: `docker compose exec postgres pg_dump -U alerta alerta > backup.sql`
- Pra usar um Postgres que você já tem: defina `DATABASE_URL=postgres://usuario:senha@host:5432/banco` no ambiente do serviço `servidor` e remova o serviço `postgres` do compose.

---

## 4. Gerar o instalador apontando pra VPS

No Windows, crie `app/.env` (nunca vai pro Git):

```env
SERVIDOR_URL=https://avisos.seudominio.com.br
SERVIDOR_TOKEN=<TOKEN_LEITURA>
PUBLICAR_SCP_DESTINO=usuario@IP-DA-VPS:/opt/alerta-de-agente/server/updates/
```

```bash
cd app
npm run dist
```

O instalador sai em `app/dist/Monitor-de-Avisos-Setup-<versão>.exe`. O endereço e o token do servidor vão **dentro do app compilado**, nunca no código do repositório.

> O Windows mostra "O Windows protegeu o computador" porque o app não tem certificado de assinatura pago. Clique em **Mais informações → Executar assim mesmo**.

## 5. Publicar uma atualização

1. Aumente a versão em `app/package.json` (ex.: `1.1.0` → `1.1.1`).
2. Compile e envie:

   ```bash
   npm run dist
   npm run publicar
   ```

   O `publicar` usa `scp` pra mandar o `.exe` e depois o `latest.yml` pra pasta `server/updates/` da VPS. Não precisa reiniciar o servidor.

3. Os apps instalados verificam atualizações ao abrir e a cada 4 horas. Quando acham uma versão nova, baixam em segundo plano e mostram um aviso no **canto inferior esquerdo**, com a opção **Reiniciar agora**. Se a pessoa escolher **Depois**, a atualização é instalada na próxima vez que o app fechar.

---

## Enviando avisos

`POST /aviso` aceita:

- **Markdown ou texto puro** (`Content-Type: text/markdown` ou `text/plain`)
- **JSON** com o conteúdo em `mensagem` (ou `message`, `text`, `content`, `markdown`). O `titulo` é opcional:

  ```json
  { "titulo": "Pedido novo", "mensagem": "## Pedido #1234\n\n- 2x Banqueta Helena" }
  ```

Sem `titulo`, o app usa a primeira linha do Markdown na barra lateral. O tamanho máximo é 1 MB.

Na VPS, mande o cabeçalho `Authorization: Bearer <TOKEN_ENVIO>`. O webhook local não pede token.

### Exemplo: aviso do Claude Code ao terminar uma tarefa

Em `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST \"$ALERTA_URL/aviso\" -H \"Authorization: Bearer $ALERTA_TOKEN\" -H \"Content-Type: text/markdown\" --data-binary \"## Claude terminou\n\nA tarefa foi concluída.\""
      }]
    }]
  }
}
```

(com `ALERTA_URL` e `ALERTA_TOKEN` definidos como variáveis de ambiente, fora do repositório)

## API do servidor

| Rota | Token | Descrição |
|---|---|---|
| `GET /health` | não | Confere se o servidor e o banco estão no ar |
| `POST /aviso` | envio | Cria um aviso |
| `GET /stream?desde=N` | leitura | Tempo real (SSE): primeiro os avisos depois do nº N, depois os novos |
| `GET /avisos?desde=N` | leitura | Lista os avisos depois do nº N (JSON) |
| `GET /updates/<arquivo>` | leitura | Arquivos de atualização do app |

## Segurança

- Tokens, senha do banco e endereço do servidor ficam só nos arquivos `.env`, que estão no `.gitignore`.
- O token de **envio** e o de **leitura** são separados. O de leitura vai dentro do app, então quem extrair esse token só consegue ler avisos, nunca enviar.
- O Postgres e a porta 3000 só aceitam conexões de dentro da VPS. O acesso externo passa pelo Caddy, com HTTPS.
- O conteúdo dos avisos passa por um filtro (DOMPurify) antes de ser mostrado, e os links abrem no navegador.

## No PC: iniciar com o Windows, desinstalar

- O app instalado inicia junto com o Windows, escondido, só com o ícone perto do relógio. Pra desligar: botão direito no ícone e desmarque **Iniciar com o Windows** (ou use Configurações → Aplicativos → Inicialização).
- Fechar no X só esconde a janela. Pra fechar de verdade: botão direito no ícone → **Sair**.
- Pra desinstalar: Configurações → Aplicativos → Aplicativos instalados → **Monitor de Avisos**. A desinstalação remove também o início automático e os avisos salvos no PC.

## Licença

Veja [LICENSE](LICENSE).
