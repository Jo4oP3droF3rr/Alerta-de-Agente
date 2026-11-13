// Envia a versão compilada (dist/) para a pasta de atualizações da VPS via scp.
// O .exe vai primeiro e o latest.yml por último, para nenhum app ver uma versão
// nova antes do instalador estar completo no servidor.
// Uso: npm run publicar   (precisa de PUBLICAR_SCP_DESTINO no app/.env)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const env = {};
try {
  for (const linha of fs.readFileSync(path.join(raiz, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !linha.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const destino = process.env.PUBLICAR_SCP_DESTINO || env.PUBLICAR_SCP_DESTINO;
if (!destino) {
  console.error('Defina PUBLICAR_SCP_DESTINO no app/.env (ex.: usuario@IP:/opt/alerta-de-agente/server/updates/)');
  process.exit(1);
}

const versao = require(path.join(raiz, 'package.json')).version;
const dist = path.join(raiz, 'dist');
const exe = path.join(dist, `Monitor-de-Avisos-Setup-${versao}.exe`);
const yml = path.join(dist, 'latest.yml');

for (const f of [exe, yml]) {
  if (!fs.existsSync(f)) {
    console.error(`Não encontrei ${path.relative(raiz, f)}. Rode "npm run dist" antes.`);
    process.exit(1);
  }
}

for (const f of [exe, yml]) {
  console.log(`Enviando ${path.basename(f)}...`);
  const r = spawnSync('scp', [f, destino], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('Falhou. Confira o acesso SSH à VPS.');
    process.exit(1);
  }
}
console.log(`Versão ${versao} publicada. Os apps instalados vão baixar sozinhos.`);
