// Carrega o script inline REAL de index.html (não uma cópia/reimplementação)
// e o executa em Node com DOM/IndexedDB/localStorage mockados, para que os
// testes exercitem exatamente o código que roda no navegador. `db` (Firestore)
// começa null (offline) — os testes chamam `api.setDb(mock)` quando quiserem
// simular conexão com a nuvem.
'use strict';
const fs = require('fs');
const path = require('path');
const { fakeDocument, makeIndexedDbMock, makeLocalStorageMock } = require('./domMock');

const HTML_PATH = path.join(__dirname, '..', '..', 'index.html');

function extractInlineScript(){
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error(`esperado 1 script inline em index.html, achado ${scripts.length}`);
  return { html, code: scripts[0][1] };
}

// Nomes expostos do escopo do script para os testes poderem chamar/inspecionar.
const EPILOGUE = `
return {
  // núcleo multi-PC (dependency-injected, testável isoladamente)
  tomoAplicarIncrementoAtomico, tomoAplicarPagamento, tomoGravarEventoLaudo,
  tomoAplicarDocsDiarios, tomoBuscarLaudosCrossPC, montarHistoricoVisual,
  tomoMigrarLegado, tomoFormatarRelatorioMigracao,
  tomoAuditar, tomoFormatarRelatorioAuditoria,
  tomoIncrementValue, tomoNovoOperationId, tomoDeviceId,
  // fila offline
  tomoEnfileirar, tomoProcessarFila, tomoStatusFila, tomoCarregarFila, tomoPersistirFila,
  // sincronização legada (mutex + resultado estruturado)
  tomoExecutarEscritasFirestore, tomoClassificarLeitura,
  salvarDadosFirebase, salvarDadosFirebaseSilencioso, carregarDados,
  // storage local
  tomoInitStorage, tomoEnsureStorage, tomoStorageMode, tomoIsStorageReady, tomoLastLocalOk, idbLocalStorage,
  // backup/restore
  validateBackupPayload, normalizarBackupPayload, mesclarBackupPorData, resumirConteudoBackup,
  montarSnapshotPreRestore, tomoSnapshotPreRestore, restaurarBackup, restaurarBackupAutomatico,
  // fluxo principal
  finalizarLaudo, alterarContador, togglePagamentoUnificado,
  adicionarAoLog, atualizarLog, tomoRenderizarHistorico, tomoAtualizarHistoricoCrossPC,
  // acesso/controle de estado interno para os testes
  getDb: () => db, setDb: (v) => { db = v; },
  getDadosApp: () => dadosApp, setDadosApp: (v) => { dadosApp = v; },
  getHistoricoLaudos: () => historicoLaudos, setHistoricoLaudos: (v) => { historicoLaudos = v; },
  getFilaInterna: () => _tomoFila, setFilaInterna: (v) => { _tomoFila = v; }, setFilaCarregada: (v) => { _tomoFilaCarregada = v; },
  getMesesSujos: () => mesesSujos, getDadosSujos: () => dadosSujos,
};
`;

// setInterval/setTimeout "unref'd": o script de produção usa vários
// setInterval (auto-save a cada 15s, backup automático a cada 5min,
// processamento de fila a cada 20s, cronômetro a cada 1s) que, num teste em
// Node, ficariam rodando pra sempre e impediriam o processo de terminar.
// Aqui eles continuam funcionando de verdade (não são fakes) mas não
// seguram o event loop.
function makeUnrefTimers(){
  const wrappedSetInterval = (fn, ms, ...args) => {
    const t = setInterval(fn, ms, ...args);
    if (t && t.unref) t.unref();
    return t;
  };
  const wrappedSetTimeout = (fn, ms, ...args) => {
    const t = setTimeout(fn, ms, ...args);
    if (t && t.unref) t.unref();
    return t;
  };
  return { setInterval: wrappedSetInterval, setTimeout: wrappedSetTimeout };
}

function loadApp(options = {}){
  const { idbMode = 'ok', sharedIdb = new Map(), lsSeed = [] } = options;
  const { code } = extractInlineScript();

  const doc = fakeDocument();
  const localStorageMock = makeLocalStorageMock(lsSeed);
  const win = { localStorage: localStorageMock, addEventListener(){}, removeEventListener(){} };
  const idb = makeIndexedDbMock(sharedIdb, idbMode);
  const cryptoShim = { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) + Date.now().toString(36) };
  // Caixa mutável para os testes controlarem a resposta de confirm() sem
  // precisar tocar no escopo interno do script avaliado.
  const confirmBox = { value: true };
  const confirmFn = () => confirmBox.value;
  const timers = makeUnrefTimers();
  // Chart.js só é usado para desenhar gráficos (efeito colateral de UI, não
  // faz parte da lógica sob teste) — um construtor fake com destroy() no-op
  // basta pra atualizarGraficos()/atualizarGraficoProjecao() não lançarem.
  function FakeChart(){ this.destroy = () => {}; }

  const factory = new Function(
    'document', 'window', 'indexedDB', 'crypto', 'confirm', 'alert', 'setInterval', 'setTimeout', 'Chart',
    code + EPILOGUE
  );
  const api = factory(doc, win, idb, cryptoShim, confirmFn, () => {}, timers.setInterval, timers.setTimeout, FakeChart);
  api.setConfirmAnswer = (v) => { confirmBox.value = v; };
  return { api, doc, window: win, sharedIdb };
}

module.exports = { loadApp, extractInlineScript };
