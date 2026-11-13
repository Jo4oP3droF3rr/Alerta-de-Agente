// Envia um aviso de teste para o app (ele precisa estar aberto).
// Uso: npm run teste
const http = require('http');

const PORT = Number(process.env.AVISOS_PORT) || 5055;
const aviso = {
  mensagem: [
    '# Pedido #1234 recebido',
    '',
    'Novo pedido na loja, **aguardando separação**.',
    '',
    '| Produto | Qtd | Valor |',
    '|---|---|---|',
    '| Banqueta Helena castanho | 2 | R$ 1.180,00 |',
    '| Buffet 4 portas | 1 | R$ 2.490,00 |',
    '',
    '## Próximos passos',
    '- [x] Pagamento confirmado',
    '- [ ] Separar no estoque',
    '- [ ] Emitir nota fiscal',
    '',
    '> Entrega prevista em 5 dias úteis.',
    '',
    'Código de rastreio: `BR123456789`',
  ].join('\n'),
};

const body = JSON.stringify(aviso);
const req = http.request(
  { host: '127.0.0.1', port: PORT, path: '/aviso', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
  (res) => {
    let r = '';
    res.on('data', (c) => (r += c));
    res.on('end', () => console.log(res.statusCode, r));
  }
);
req.on('error', (e) => console.error('Falhou (o app está aberto?):', e.message));
req.end(body);
