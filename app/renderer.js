const api = window.avisosApi;

const elLista = document.getElementById('lista');
const elDetalhe = document.getElementById('detalhe');
const elContador = document.getElementById('contador');
const elEndereco = document.getElementById('endereco');
const elLimpar = document.getElementById('limpar');

let avisos = [];
let selecionadoId = null;

marked.setOptions({ gfm: true, breaks: true });

function el(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

function horaCurta(iso) {
  const d = new Date(iso);
  const hoje = new Date();
  if (d.toDateString() === hoje.toDateString()) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// Markdown -> texto simples, para a prévia na barra lateral.
function textoPlano(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A prévia pula a linha que já virou título, para não repetir.
function previa(a) {
  const plano = textoPlano(a.mensagem);
  const semTitulo = plano.startsWith(a.titulo.replace(/…$/, ''))
    ? plano.slice(a.titulo.replace(/…$/, '').length).trim()
    : plano;
  return semTitulo || plano;
}

async function excluir(id) {
  await api.excluir(id);
  avisos = avisos.filter((x) => x.id !== id);
  if (selecionadoId === id) {
    selecionadoId = null;
    renderVazio();
  }
  renderLista();
}

function renderLista() {
  elLista.replaceChildren();

  if (avisos.length === 0) {
    elLista.appendChild(el('li', 'lista-vazia', 'Nenhum aviso ainda'));
  }

  for (const a of avisos) {
    const li = el('li', 'item');
    if (!a.lido) li.classList.add('nao-lido');
    if (a.id === selecionadoId) li.classList.add('ativo');

    const topo = el('div', 'item-topo');
    topo.append(el('span', 'item-titulo', a.titulo), el('span', 'item-hora', horaCurta(a.recebidoEm)));
    li.append(topo, el('div', 'item-previa', previa(a) || ' '));

    const btnX = el('button', 'item-excluir', '×');
    btnX.type = 'button';
    btnX.title = 'Excluir aviso';
    btnX.addEventListener('click', (e) => {
      e.stopPropagation();
      excluir(a.id);
    });
    li.appendChild(btnX);

    li.addEventListener('click', () => selecionar(a.id));
    elLista.appendChild(li);
  }

  const naoLidos = avisos.filter((a) => !a.lido).length;
  elContador.textContent = naoLidos ? `${naoLidos} novo${naoLidos > 1 ? 's' : ''}` : '';
}

function renderVazio() {
  const box = el('div', 'vazio');
  box.append(
    el('p', null, 'Nenhum aviso selecionado'),
    el('p', 'vazio-sub', 'Os avisos recebidos aparecem na barra lateral.')
  );
  elDetalhe.replaceChildren(box);
}

function renderDetalhe() {
  const a = avisos.find((x) => x.id === selecionadoId);
  if (!a) return renderVazio();

  const conteudo = el('article', 'markdown');
  // DOMPurify remove scripts e HTML perigoso que venha no aviso.
  conteudo.innerHTML = DOMPurify.sanitize(marked.parse(a.mensagem || ''));

  elDetalhe.replaceChildren(conteudo);
  elDetalhe.scrollTop = 0;
}

function selecionar(id) {
  selecionadoId = id;
  const a = avisos.find((x) => x.id === id);
  if (a && !a.lido) {
    a.lido = true;
    api.marcarLido(id);
  }
  renderLista();
  renderDetalhe();
}

elLimpar.addEventListener('click', async () => {
  if (!avisos.length) return;
  await api.limpar();
  avisos = [];
  selecionadoId = null;
  renderLista();
  renderVazio();
});

api.aoReceber((aviso) => {
  avisos.unshift(aviso);
  renderLista();
  if (!selecionadoId) selecionar(aviso.id);
});

api.aoSelecionar((id) => selecionar(id));

// ---------- Tema ----------
const elTema = document.getElementById('tema');
const ORDEM_TEMAS = ['claro', 'escuro', 'sistema'];
const NOMES_TEMAS = { sistema: 'Tema: sistema', claro: 'Tema: claro', escuro: 'Tema: escuro' };

function mostrarTema(t) {
  elTema.textContent = NOMES_TEMAS[t];
  elTema.dataset.tema = t;
}

elTema.addEventListener('click', async () => {
  const atual = elTema.dataset.tema || 'claro';
  const proximo = ORDEM_TEMAS[(ORDEM_TEMAS.indexOf(atual) + 1) % ORDEM_TEMAS.length];
  mostrarTema(await api.definirTema(proximo));
});

api.obterTema().then(mostrarTema);

// ---------- Status do servidor (rodapé) ----------
let portaLocal = 5055;
const TEXTO_STATUS = {
  conectado: 'Servidor conectado',
  conectando: 'Conectando ao servidor…',
  offline: 'Servidor offline, tentando de novo…',
};

function mostrarStatusServidor(s) {
  elEndereco.className = `endereco status-${s}`;
  elEndereco.textContent = TEXTO_STATUS[s] || `Local: 127.0.0.1:${portaLocal}/aviso`;
}
api.aoStatusServidor(mostrarStatusServidor);

// ---------- Popup de atualização (canto inferior esquerdo) ----------
const elUpdate = document.getElementById('update');
let updateDispensado = false;

function mostrarUpdate(s) {
  if (!s || updateDispensado) {
    elUpdate.hidden = true;
    return;
  }
  const corpo = [];
  if (s.estado === 'baixando') {
    corpo.push(el('div', 'update-titulo', `Atualização ${s.versao || ''} disponível`));
    corpo.push(el('div', 'update-texto', `Baixando… ${s.pct || 0}%`));
    const barra = el('div', 'update-barra');
    const progresso = el('div', 'update-progresso');
    progresso.style.width = `${s.pct || 0}%`;
    barra.appendChild(progresso);
    corpo.push(barra);
  } else if (s.estado === 'pronta') {
    corpo.push(el('div', 'update-titulo', `Versão ${s.versao} pronta`));
    corpo.push(el('div', 'update-texto', 'Reinicie para atualizar. Leva poucos segundos.'));
    const acoes = el('div', 'update-acoes');
    const depois = el('button', 'btn btn-link', 'Depois');
    depois.type = 'button';
    depois.addEventListener('click', () => {
      updateDispensado = true;
      elUpdate.hidden = true;
    });
    const agora = el('button', 'btn', 'Reiniciar agora');
    agora.type = 'button';
    agora.addEventListener('click', () => api.instalarAtualizacao());
    acoes.append(depois, agora);
    corpo.push(acoes);
  } else {
    elUpdate.hidden = true;
    return;
  }
  elUpdate.replaceChildren(...corpo);
  elUpdate.hidden = false;
}
api.aoStatusUpdate(mostrarUpdate);

(async () => {
  avisos = await api.listar();
  const info = await api.info();
  portaLocal = info.porta;
  mostrarStatusServidor(info.servidor);
  mostrarUpdate(info.update);
  document.querySelector('.barra-nome').textContent = `Monitor de Avisos ${info.versao}`;
  renderLista();
  if (avisos.length) selecionar(avisos[0].id);
})();
