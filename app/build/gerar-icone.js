// Gera build/icon.png (256x256): o mesmo ícone da bandeja, círculo azul com ponto branco.
// Uso: node build/gerar-icone.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const T = 256;
const px = Buffer.alloc(T * T * 4);
const c = (T - 1) / 2;
const rFora = T / 2 - 4;
const rDentro = T * 0.17;

for (let y = 0; y < T; y++) {
  for (let x = 0; x < T; x++) {
    const d = Math.hypot(x - c, y - c);
    const i = (y * T + x) * 4;
    if (d <= rDentro) {
      const a = Math.round(Math.min(1, rDentro - d + 0.5) * 255);
      // mistura branco sobre azul na borda do ponto
      const k = a / 255;
      px.set([Math.round(255 * k + 0x4a * (1 - k)), Math.round(255 * k + 0x6f * (1 - k)), Math.round(255 * k + 0xa5 * (1 - k)), 255], i);
    } else if (d <= rFora + 0.5) {
      const a = Math.round(Math.min(1, rFora - d + 0.5) * 255);
      px.set([0x4a, 0x6f, 0xa5, a], i);
    }
  }
}

const crcTabela = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTabela[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(tipo, dados) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(T, 0);
ihdr.writeUInt32BE(T, 4);
ihdr[8] = 8; // 8 bits por canal
ihdr[9] = 6; // RGBA

const linhas = Buffer.alloc(T * (T * 4 + 1));
for (let y = 0; y < T; y++) {
  linhas[y * (T * 4 + 1)] = 0; // sem filtro
  px.copy(linhas, y * (T * 4 + 1) + 1, y * T * 4, (y + 1) * T * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(linhas)),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('icon.png gerado');
