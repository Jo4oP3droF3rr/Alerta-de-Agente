// Lê app/.env e gera app/config.gerado.json, que vai dentro do app compilado.
// Assim o endereço do servidor nunca fica no código (o repositório é público).
// Uso: node build/gerar-config.js  (rodado automaticamente por "npm start" e "npm run dist")
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const env = {};
try {
  for (const linha of fs.readFileSync(path.join(raiz, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !linha.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const config = {
  servidorUrl: (process.env.SERVIDOR_URL || env.SERVIDOR_URL || '').replace(/\/+$/, ''),
  servidorToken: process.env.SERVIDOR_TOKEN || env.SERVIDOR_TOKEN || '',
};

fs.writeFileSync(path.join(raiz, 'config.gerado.json'), JSON.stringify(config, null, 2));

if (config.servidorUrl && config.servidorToken) {
  console.log(`config.gerado.json: servidor configurado (${new URL(config.servidorUrl).host})`);
} else {
  console.log('config.gerado.json: sem servidor (só webhook local). Preencha app/.env para usar a VPS.');
}
