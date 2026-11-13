const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avisosApi', {
  listar: () => ipcRenderer.invoke('avisos:listar'),
  info: () => ipcRenderer.invoke('app:info'),
  marcarLido: (id) => ipcRenderer.invoke('avisos:marcarLido', id),
  excluir: (id) => ipcRenderer.invoke('avisos:excluir', id),
  limpar: () => ipcRenderer.invoke('avisos:limpar'),
  instalarAtualizacao: () => ipcRenderer.invoke('update:instalar'),
  obterTema: () => ipcRenderer.invoke('tema:obter'),
  definirTema: (t) => ipcRenderer.invoke('tema:definir', t),
  aoReceber: (fn) => ipcRenderer.on('aviso:novo', (_e, aviso) => fn(aviso)),
  aoSelecionar: (fn) => ipcRenderer.on('aviso:selecionar', (_e, id) => fn(id)),
  aoStatusServidor: (fn) => ipcRenderer.on('servidor:status', (_e, s) => fn(s)),
  aoStatusUpdate: (fn) => ipcRenderer.on('update:status', (_e, s) => fn(s)),
});
