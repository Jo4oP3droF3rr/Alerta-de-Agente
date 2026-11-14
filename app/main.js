const { app, BrowserWindow, ipcMain, Notification, shell, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.AVISOS_PORT) || 5055;
const MAX_AVISOS = 200;
const MAX_BODY = 1024 * 1024; // 1 MB

let win = null;
let avisos = [];

// Mesma pasta de dados na versão instalada e no "npm start" (%APPDATA%\monitor-avisos).
app.setPath('userData', path.join(app.getPath('appData'), 'monitor-avisos'));

const dataFile = () => path.join(app.getPath('userData'), 'avisos.json');
const configFile = () => path.join(app.getPath('userData'), 'config.json');

// ---------- Servidor remoto (definido no .env, gerado em config.gerado.json) ----------
// O endereço do servidor nunca fica no código: vem do .env de quem compila o app.
let SERVIDOR = { url: '', token: '' };
try {
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.gerado.json'), 'utf8'));
  SERVIDOR = { url: String(g.servidorUrl || '').replace(/\/+$/, ''), token: String(g.servidorToken || '') };
} catch {}
const temServidor = () => Boolean(SERVIDOR.url && SERVIDOR.token);

// ---------- Avisos salvos ----------
function carregar() {
  try {
    avisos = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    if (!Array.isArray(avisos)) avisos = [];
  } catch {
    avisos = [];
  }
}

function salvar() {
  try {
    fs.writeFileSync(dataFile(), JSON.stringify(avisos, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro ao salvar avisos:', e);
  }
}

// ---------- Configurações do app ----------
const TEMAS = { sistema: 'system', claro: 'light', escuro: 'dark' };
// 1px menor que a barra do HTML (36px) para a linha de baixo passar contínua sob os botões.
const BARRA_ALTURA = 35;
const CORES_BARRA = {
  claro: { color: '#ffffff', symbolColor: '#1f1f1f' },
  escuro: { color: '#1c1c1c', symbolColor: '#e4e4e4' },
};

let tema = 'claro';
let iniciarComWindows = true;
let ultimoSeqServidor = 0;

function carregarConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (TEMAS[c.tema]) tema = c.tema;
    if (typeof c.iniciarComWindows === 'boolean') iniciarComWindows = c.iniciarComWindows;
    // A contagem só vale para o mesmo servidor; trocou o endereço, recomeça.
    if (Number.isInteger(c.ultimoSeqServidor) && c.servidorUrl === SERVIDOR.url) {
      ultimoSeqServidor = c.ultimoSeqServidor;
    }
  } catch {}
}

function salvarConfig() {
  try {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ tema, iniciarComWindows, ultimoSeqServidor, servidorUrl: SERVIDOR.url }, null, 2),
      'utf8'
    );
  } catch (e) {
    console.error('Erro ao salvar config:', e);
  }
}

const corBarra = () => CORES_BARRA[nativeTheme.shouldUseDarkColors ? 'escuro' : 'claro'];

function atualizarBarra() {
  if (!win) return;
  const c = corBarra();
  win.setTitleBarOverlay({ ...c, height: BARRA_ALTURA });
  win.setBackgroundColor(c.color);
}

const enviarTela = (canal, dado) => {
  if (win && !win.isDestroyed()) win.webContents.send(canal, dado);
};

// ---------- Markdown -> texto (título, prévia, notificação) ----------
function textoPlano(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tituloDoMarkdown(md) {
  const linha = md.split('\n').map(textoPlano).find((l) => l);
  if (!linha) return 'Aviso';
  return linha.length > 80 ? linha.slice(0, 79) + '…' : linha;
}

// Aceita JSON em vários formatos (o nosso, Discord, Slack...) ou texto puro.
function extrair(corpo) {
  let d = null;
  try {
    d = JSON.parse(corpo);
  } catch {}
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { titulo: '', mensagem: corpo };
  const bruta = d.mensagem || d.message || d.msg || d.text || d.content || d.markdown || '';
  const mensagem = typeof bruta === 'string' ? bruta : JSON.stringify(bruta, null, 2);
  return { titulo: d.titulo || d.title || d.assunto || '', mensagem };
}

function montarAviso({ id, recebidoEm, titulo, mensagem }) {
  return {
    id: id || crypto.randomUUID(),
    recebidoEm: recebidoEm || new Date().toISOString(),
    lido: false,
    titulo: String(titulo || tituloDoMarkdown(mensagem)),
    mensagem,
  };
}

function notificar(titulo, corpo, idParaAbrir) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: titulo, body: corpo.slice(0, 200) });
  n.on('click', () => {
    mostrarJanela();
    if (idParaAbrir) enviarTela('aviso:selecionar', idParaAbrir);
  });
  n.show();
}

function novoAviso(aviso, { avisar = true } = {}) {
  if (avisos.some((a) => a.id === aviso.id)) return false;
  avisos.unshift(aviso);
  if (avisos.length > MAX_AVISOS) avisos.length = MAX_AVISOS;
  salvar();
  enviarTela('aviso:novo', aviso);
  if (avisar) notificar(aviso.titulo, textoPlano(aviso.mensagem), aviso.id);
  return true;
}

// ---------- Webhook local (127.0.0.1) ----------
function iniciarServidorLocal() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }

    if (req.method !== 'POST' || (url !== '/aviso' && url !== '/')) {
      res.writeHead(404);
      return res.end();
    }

    let corpo = '';
    let tamanho = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      tamanho += Buffer.byteLength(chunk);
      if (tamanho > MAX_BODY) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      corpo += chunk;
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const aviso = montarAviso(extrair(corpo));
      novoAviso(aviso);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: aviso.id }));
    });
  });

  server.on('error', (e) => console.error('Erro no webhook local:', e.message));
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Webhook local em http://127.0.0.1:${PORT}/aviso`);
  });
}

// ---------- Conexão com o servidor remoto (tempo real via SSE) ----------
let statusServidor = temServidor() ? 'conectando' : 'local';

function definirStatus(s) {
  statusServidor = s;
  enviarTela('servidor:status', s);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function conectarServidor() {
  if (!temServidor()) return;
  let espera = 2000;

  while (!saindo) {
    const ctrl = new AbortController();
    let vigia = null;
    // Sem nenhum dado por 70 s (o servidor manda ping a cada 25 s) = conexão morta.
    const rearmar = () => {
      clearTimeout(vigia);
      vigia = setTimeout(() => ctrl.abort(), 70000);
    };

    try {
      rearmar();
      const res = await fetch(`${SERVIDOR.url}/stream?desde=${ultimoSeqServidor}`, {
        headers: { Authorization: `Bearer ${SERVIDOR.token}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      definirStatus('conectado');
      espera = 2000;

      const decoder = new TextDecoder();
      let buffer = '';
      let sincronizado = false;
      let atrasados = 0;

      for await (const pedaco of res.body) {
        rearmar();
        buffer += decoder.decode(pedaco, { stream: true }).replace(/\r\n/g, '\n');
        let fim;
        while ((fim = buffer.indexOf('\n\n')) >= 0) {
          const bloco = buffer.slice(0, fim);
          buffer = buffer.slice(fim + 2);

          let evento = 'message';
          let dados = '';
          for (const linha of bloco.split('\n')) {
            if (linha.startsWith('event:')) evento = linha.slice(6).trim();
            else if (linha.startsWith('data:')) dados += linha.slice(5).trim();
          }

          if (evento === 'sincronizado') {
            const seqServidor = Number(JSON.parse(dados || '{}').seq);
            if (Number.isFinite(seqServidor) && seqServidor < ultimoSeqServidor) {
              // Servidor foi zerado (ou é outro): recomeça a contagem e reconecta.
              ultimoSeqServidor = 0;
              salvarConfig();
              espera = 0;
              throw new Error('servidor reiniciado, sincronizando de novo');
            }
            sincronizado = true;
            if (atrasados > 0) {
              notificar(
                `${atrasados} aviso${atrasados > 1 ? 's' : ''} recebido${atrasados > 1 ? 's' : ''}`,
                'Chegaram enquanto o app estava desconectado.'
              );
            }
          } else if (evento === 'aviso' && dados) {
            const s = JSON.parse(dados);
            if (s.seq > ultimoSeqServidor) {
              // Avisos atrasados entram sem notificação individual (vira um resumo).
              const entrou = novoAviso(montarAviso(s), { avisar: sincronizado });
              if (entrou && !sincronizado) atrasados++;
              ultimoSeqServidor = s.seq;
              salvarConfig();
            }
          }
        }
      }
      throw new Error('conexão encerrada');
    } catch (e) {
      if (saindo) break;
      console.error('Servidor de avisos:', e.message);
      definirStatus('offline');
      await dormir(espera);
      espera = Math.min(Math.max(espera * 2, 2000), 60000);
    } finally {
      clearTimeout(vigia);
    }
  }
}

// ---------- Atualização automática ----------
let statusUpdate = null;

function definirStatusUpdate(s) {
  statusUpdate = s;
  enviarTela('update:status', s);
}

function iniciarAtualizacoes() {
  // Só na versão instalada e com servidor configurado.
  if (!app.isPackaged || !temServidor()) return;

  autoUpdater.setFeedURL({ provider: 'generic', url: `${SERVIDOR.url}/updates` });
  autoUpdater.requestHeaders = { Authorization: `Bearer ${SERVIDOR.token}` };
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) =>
    definirStatusUpdate({ estado: 'baixando', versao: info.version, pct: 0 })
  );
  autoUpdater.on('download-progress', (p) =>
    definirStatusUpdate({ estado: 'baixando', versao: statusUpdate?.versao, pct: Math.round(p.percent) })
  );
  autoUpdater.on('update-downloaded', (info) =>
    definirStatusUpdate({ estado: 'pronta', versao: info.version })
  );
  autoUpdater.on('error', (e) => console.error('Atualização:', e.message));

  const verificar = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(verificar, 10 * 1000);
  setInterval(verificar, 4 * 60 * 60 * 1000);
}

// ---------- Iniciar com o Windows ----------
// Ao ligar o PC, o app abre escondido (--oculto), só com o ícone perto do relógio.
const INICIADO_OCULTO = process.argv.includes('--oculto');

function aplicarInicioAutomatico() {
  // Só a versão instalada se registra; rodar via "npm start" não mexe na inicialização.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    // Nome fixo: o desinstalador remove exatamente esta entrada.
    name: 'MonitorAvisos',
    openAtLogin: iniciarComWindows,
    path: process.execPath,
    args: ['--oculto'],
  });
}

// ---------- Ícone na bandeja (perto do relógio) ----------
let tray = null;
let saindo = false;

// Desenha o ícone (círculo azul com ponto branco) sem precisar de arquivo de imagem.
function criarIcone(tamanho) {
  const buf = Buffer.alloc(tamanho * tamanho * 4);
  const c = (tamanho - 1) / 2;
  const rFora = tamanho / 2 - 0.5;
  const rDentro = tamanho * 0.17;
  for (let y = 0; y < tamanho; y++) {
    for (let x = 0; x < tamanho; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * tamanho + x) * 4;
      if (d <= rDentro) {
        buf.set([255, 255, 255, 255], i); // BGRA
      } else if (d <= rFora) {
        const a = Math.round(Math.min(1, rFora - d + 0.5) * 255);
        buf.set([165, 111, 74, a], i); // #4a6fa5 em BGRA
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: tamanho, height: tamanho });
}

function montarMenuTray() {
  const itens = [{ label: 'Abrir', click: mostrarJanela }, { type: 'separator' }];
  if (app.isPackaged) {
    itens.push(
      {
        label: 'Iniciar com o Windows',
        type: 'checkbox',
        checked: iniciarComWindows,
        click: (item) => {
          iniciarComWindows = item.checked;
          salvarConfig();
          aplicarInicioAutomatico();
        },
      },
      { type: 'separator' }
    );
  }
  itens.push({ label: 'Sair', click: () => { saindo = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(itens));
}

function criarTray() {
  tray = new Tray(criarIcone(32).resize({ width: 16, height: 16 }));
  tray.setToolTip(`Monitor de Avisos ${app.getVersion()}`);
  tray.on('click', mostrarJanela);
  montarMenuTray();
}

// ---------- Janela ----------
function mostrarJanela() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function criarJanela() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 700,
    minHeight: 400,
    title: 'Monitor de Avisos',
    backgroundColor: corBarra().color,
    autoHideMenuBar: true,
    // Esconde a barra do Windows; o app desenha a própria (index.html).
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...corBarra(), height: BARRA_ALTURA },
    icon: criarIcone(64),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links dos avisos abrem no navegador, nunca dentro do app.
  const abrirFora = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    abrirFora(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    abrirFora(url);
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => {
    if (!INICIADO_OCULTO) win.show();
  });

  // Fechar no X só esconde a janela: o app continua recebendo avisos.
  win.on('close', (e) => {
    if (!saindo) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
}

// ---------- Comunicação com a tela ----------
ipcMain.handle('avisos:listar', () => avisos);
ipcMain.handle('avisos:marcarLido', (_e, id) => {
  const a = avisos.find((x) => x.id === id);
  if (a && !a.lido) {
    a.lido = true;
    salvar();
  }
});
ipcMain.handle('avisos:excluir', (_e, id) => {
  avisos = avisos.filter((x) => x.id !== id);
  salvar();
});
ipcMain.handle('avisos:limpar', () => {
  avisos = [];
  salvar();
});
ipcMain.handle('app:info', () => ({
  porta: PORT,
  versao: app.getVersion(),
  servidor: statusServidor,
  update: statusUpdate,
}));
ipcMain.handle('update:instalar', () => {
  saindo = true;
  autoUpdater.quitAndInstall(true, true);
});
ipcMain.handle('tema:obter', () => tema);
ipcMain.handle('tema:definir', (_e, novo) => {
  if (!TEMAS[novo]) return tema;
  tema = novo;
  nativeTheme.themeSource = TEMAS[tema];
  salvarConfig();
  return tema;
});

// Vale para troca manual e para quando o Windows muda de claro/escuro.
nativeTheme.on('updated', atualizarBarra);

// Uma instância só (evita duas janelas brigando pela mesma porta).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', mostrarJanela);
  app.setAppUserModelId('com.monitoravisos.app');
  app.whenReady().then(() => {
    carregar();
    carregarConfig();
    nativeTheme.themeSource = TEMAS[tema];
    aplicarInicioAutomatico();
    criarJanela();
    criarTray();
    iniciarServidorLocal();
    conectarServidor();
    iniciarAtualizacoes();
  });
  app.on('before-quit', () => (saindo = true));
}
