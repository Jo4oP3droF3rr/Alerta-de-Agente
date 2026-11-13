'use strict';
// Servidor do Alerta de Agente: recebe avisos (POST), guarda no Postgres,
// entrega em tempo real para o app desktop (SSE) e serve as atualizações do app.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN_ENVIO = process.env.TOKEN_ENVIO || '';
const TOKEN_LEITURA = process.env.TOKEN_LEITURA || '';
const UPDATES_DIR = path.resolve(process.env.UPDATES_DIR || path.join(__dirname, 'updates'));
const MAX_AVISOS = Number(process.env.MAX_AVISOS) || 0; // 0 = guarda todos
const MAX_BODY = 1024 * 1024; // 1 MB
const HEARTBEAT_MS = 25000;
const LIMITE_BACKLOG = 1000;

if (TOKEN_ENVIO.length < 16 || TOKEN_LEITURA.length < 16) {
  console.error('Defina TOKEN_ENVIO e TOKEN_LEITURA no .env (mínimo 16 caracteres cada).');
  process.exit(1);
}
if (TOKEN_ENVIO === TOKEN_LEITURA) {
  console.error('TOKEN_ENVIO e TOKEN_LEITURA precisam ser diferentes.');
  process.exit(1);
}

// ---------- Banco de dados (Postgres) ----------
// Usa DATABASE_URL se existir; senão as variáveis padrão PGHOST, PGUSER, PGPASSWORD, PGDATABASE.
const db = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
db.on('error', (e) => console.error('Postgres:', e.message));

async function prepararBanco() {
  for (let tentativa = 1; ; tentativa++) {
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS avisos (
          seq         BIGSERIAL PRIMARY KEY,
          id          UUID NOT NULL UNIQUE,
          recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
          titulo      TEXT NOT NULL DEFAULT '',
          mensagem    TEXT NOT NULL
        )`);
      return;
    } catch (e) {
      if (tentativa >= 30) throw e;
      console.log(`Aguardando o Postgres (${e.message})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const COLUNAS = `seq::int AS seq, id, recebido_em AS "recebidoEm", titulo, mensagem`;

async function inserirAviso(titulo, mensagem) {
  const { rows } = await db.query(
    `INSERT INTO avisos (id, titulo, mensagem) VALUES ($1, $2, $3) RETURNING ${COLUNAS}`,
    [crypto.randomUUID(), titulo, mensagem]
  );
  if (MAX_AVISOS > 0) {
    await db.query('DELETE FROM avisos WHERE seq <= $1::bigint - $2', [rows[0].seq, MAX_AVISOS]);
  }
  return rows[0];
}

async function avisosDesde(desde) {
  const { rows } = await db.query(
    `SELECT ${COLUNAS} FROM avisos WHERE seq > $1 ORDER BY seq LIMIT $2`,
    [desde, LIMITE_BACKLOG]
  );
  return rows;
}

async function ultimoSeq() {
  const { rows } = await db.query('SELECT COALESCE(MAX(seq), 0)::int AS seq FROM avisos');
  return rows[0].seq;
}

// ---------- Autenticação ----------
const hash = (s) => crypto.createHash('sha256').update(s).digest();
const H_ENVIO = hash(TOKEN_ENVIO);
const H_LEITURA = hash(TOKEN_LEITURA);

function tokenDe(req) {
  const a = req.headers.authorization || '';
  if (a.startsWith('Bearer ')) return a.slice(7).trim();
  return String(req.headers['x-token'] || '');
}
function autorizado(req, h) {
  const t = tokenDe(req);
  return t.length > 0 && crypto.timingSafeEqual(hash(t), h);
}

// ---------- Utilidades HTTP ----------
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    let tamanho = 0;
    req.setEncoding('utf8');
    req.on('data', (c) => {
      tamanho += Buffer.byteLength(c);
      if (tamanho > MAX_BODY) {
        reject(new Error('grande'));
        req.destroy();
        return;
      }
      corpo += c;
    });
    req.on('end', () => resolve(corpo));
    req.on('error', reject);
  });
}

// Aceita JSON (nosso formato, Discord, Slack...) ou Markdown/texto puro.
function normalizar(corpo) {
  let d = null;
  try {
    d = JSON.parse(corpo);
  } catch {}
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { titulo: '', mensagem: corpo };
  const bruta = d.mensagem ?? d.message ?? d.msg ?? d.text ?? d.content ?? d.markdown ?? '';
  const mensagem = typeof bruta === 'string' ? bruta : JSON.stringify(bruta, null, 2);
  const titulo = d.titulo || d.title || d.assunto || '';
  return { titulo: String(titulo).slice(0, 200), mensagem };
}

// ---------- Tempo real (Server-Sent Events) ----------
// Cada cliente: { res, fila } — fila != null enquanto o histórico ainda está sendo enviado.
const clientes = new Set();

function eventoSSE(aviso) {
  return `id: ${aviso.seq}\nevent: aviso\ndata: ${JSON.stringify(aviso)}\n\n`;
}

function transmitir(aviso) {
  const ev = eventoSSE(aviso);
  for (const c of clientes) {
    if (c.fila) c.fila.push(aviso);
    else c.res.write(ev);
  }
}

async function abrirStream(req, res, desde) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Entra na lista ANTES de ler o histórico; o que chegar nesse meio-tempo
  // fica na fila e é enviado depois, em ordem e sem repetir.
  const cliente = { res, fila: [] };
  clientes.add(cliente);
  const ping = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(ping);
    clientes.delete(cliente);
  });

  try {
    let ultimo = desde;
    for (const a of await avisosDesde(desde)) {
      res.write(eventoSSE(a));
      ultimo = a.seq;
    }
    for (const a of cliente.fila) if (a.seq > ultimo) res.write(eventoSSE(a));
    cliente.fila = null;

    // Informa o último nº do servidor: se o app tiver um maior, o banco foi zerado.
    res.write(`event: sincronizado\ndata: ${JSON.stringify({ seq: await ultimoSeq() })}\n\n`);
  } catch (e) {
    console.error('Stream:', e.message);
    res.end();
  }
}

// ---------- Atualizações do app ----------
const TIPOS = {
  '.yml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

function servirAtualizacao(req, res, nomeUrl) {
  let nome;
  try {
    nome = path.basename(decodeURIComponent(nomeUrl));
  } catch {
    return json(res, 400, { erro: 'nome inválido' });
  }
  if (!nome || nome.startsWith('.')) return json(res, 404, { erro: 'não encontrado' });

  const arquivo = path.join(UPDATES_DIR, nome);
  fs.stat(arquivo, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { erro: 'não encontrado' });
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(nome)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(arquivo).pipe(res);
  });
}

// ---------- Rotas ----------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rota = url.pathname;

  try {
    if (req.method === 'GET' && rota === '/health') {
      await db.query('SELECT 1');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && rota === '/aviso') {
      if (!autorizado(req, H_ENVIO)) return json(res, 401, { erro: 'token inválido' });
      let corpo;
      try {
        corpo = await lerCorpo(req);
      } catch {
        return json(res, 413, { erro: 'aviso maior que 1 MB' });
      }
      const { titulo, mensagem } = normalizar(corpo);
      if (!mensagem.trim()) return json(res, 400, { erro: 'mensagem vazia' });

      const aviso = await inserirAviso(titulo, mensagem);
      transmitir(aviso);
      return json(res, 200, { ok: true, id: aviso.id, seq: aviso.seq });
    }

    if (req.method === 'GET' && (rota === '/stream' || rota === '/avisos')) {
      if (!autorizado(req, H_LEITURA)) return json(res, 401, { erro: 'token inválido' });
      const desde = Math.max(0, Number(url.searchParams.get('desde')) || 0);
      if (rota === '/stream') return abrirStream(req, res, desde);
      return json(res, 200, { avisos: await avisosDesde(desde) });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && rota.startsWith('/updates/')) {
      if (!autorizado(req, H_LEITURA)) return json(res, 401, { erro: 'token inválido' });
      return servirAtualizacao(req, res, rota.slice('/updates/'.length));
    }

    json(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { erro: 'erro interno' });
  }
});

prepararBanco()
  .then(async () => {
    servidor.listen(PORT, async () => {
      console.log(`Alerta de Agente: servidor na porta ${PORT} (último aviso nº ${await ultimoSeq()})`);
    });
  })
  .catch((e) => {
    console.error('Não consegui conectar no Postgres:', e.message);
    process.exit(1);
  });

const encerrar = () => {
  for (const c of clientes) c.res.end();
  servidor.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
