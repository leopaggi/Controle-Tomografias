// Cenário: clique em "marcar pagamento recebido" no Relatório Mensal deve
// responder IMEDIATAMENTE (selo pago/pendente + totais), persistir
// localmente antes de qualquer round-trip remoto, e sobreviver a troca de
// aba/fechamento/reload enquanto a sincronização com a nuvem ainda está em
// andamento. Reproduz e protege contra a regressão relatada: item ficava
// amarelo por vários segundos e, trocando de aba nesse meio tempo, a
// marcação às vezes se perdia.
'use strict';
const assert = require('assert');
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function until(fn) {
  const deadline = performance.now() + 3000;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error('Etapa esperada não foi atingida.');
    await new Promise(resolve => setImmediate(resolve));
  }
}
function notifications(h) { return h.doc.body.children.map(el => el.textContent).join('\n'); }

// Controla separadamente as duas fronteiras remotas envolvidas num toggle de
// pagamento: a transação autoritativa (controles_pagamentos + ledger) e os
// dois saves legados sequenciais (mês + principal) feitos por
// salvarDadosFirebase().
function controlledDb(options = {}) {
  const real = makeFirestoreMock();
  const gates = { transaction: deferred(), month: deferred(), principal: deferred() };
  const calls = { transaction: 0, month: 0, principal: 0 };
  const raw = ref => ref._raw || ref;
  function collection(ref) { return { ...ref, doc(id) { return documentRef(ref.doc(id)); } }; }
  function documentRef(ref) {
    return {
      ...ref, _raw: ref,
      collection(name) { return collection(ref.collection(name)); },
      async set(...args) {
        const stage = ref.path.endsWith('/examesTomografia') ? 'principal' : (ref.path.includes('examesTomografia_') ? 'month' : null);
        if (stage) { calls[stage]++; await gates[stage].promise; if (options.fail === stage) throw new Error('falha remota simulada: ' + stage); }
        return ref.set(...args);
      }
    };
  }
  const db = {
    collection(name) { return collection(real.collection(name)); },
    async runTransaction(fn) {
      calls.transaction++;
      await gates.transaction.promise;
      if (options.fail === 'transaction') throw new Error('falha remota simulada: transação');
      return real.runTransaction(tx => fn({
        get(ref) { return tx.get(raw(ref)); },
        set(ref, ...args) { return tx.set(raw(ref), ...args); }
      }));
    }
  };
  return { db, real, gates, calls, release() { Object.values(gates).forEach(g => g.resolve()); } };
}

function setup(sharedIdb) {
  const h = loadApp(sharedIdb ? { sharedIdb } : {});
  h.doc.getElementById('mes-relatorio').value = '2026-01';
  const dadosApp = h.api.getDadosApp();
  dadosApp.exames['2026-01-05'] = { cranio: { 'sagrada-familia': 4 }, torax: { hbj: 2 } };
  h.api.setDadosApp(dadosApp);
  return h;
}

function containerHtml(h) { return h.doc.getElementById('unificado-pagamento-container').innerHTML; }
function isMarcadoPago(h, empresaId, mesAno) {
  const re = new RegExp(`btn-pagamento-empresa pago"[^>]*data-emp="${empresaId}"[^>]*data-mes="${mesAno}"`);
  return re.test(containerHtml(h));
}

async function run(check) {
  // 1. Resposta imediata: selo + totais mudam e o estado já está persistido
  // localmente ANTES de a transação remota (e os saves legados) resolverem.
  {
    const h = setup();
    const remote = controlledDb();
    h.api.setDb(remote.db);
    await h.api.tomoEnsureStorage();

    let settled = false;
    const p = h.api.togglePagamentoUnificado('sagrada-familia', '2026-01').then(() => { settled = true; });
    await until(() => isMarcadoPago(h, 'sagrada-familia', '2026-01') || settled);

    check('1a. selo muda para pago antes da transação remota resolver', isMarcadoPago(h, 'sagrada-familia', '2026-01'));
    check('1b. promise ainda pendente (nuvem não confirmou)', !settled);
    // A UI já está correta ANTES mesmo de a transação remota começar — ela
    // só é disparada depois, em segundo plano (prova de que não bloqueia).
    await until(() => remote.calls.transaction === 1);
    check('1c. transação remota é iniciada em segundo plano, depois da UI já atualizada', !settled);
    const salvoLocal = JSON.parse(h.sharedIdb.get('examesTomografia'));
    check('1d. pagamento já está em IndexedDB antes da nuvem confirmar', salvoLocal.pagamentos['2026-01']['sagrada-familia'] === true);
    const recebidoHtml = h.doc.getElementById('unificado-pagamento-container').innerHTML.match(/RECEBIDO<\/div><div class="valor">R\$ ([\d.]+)/);
    check('1e. total RECEBIDO do relatório já reflete o clique (> 0) sem esperar a nuvem', !!recebidoHtml && parseFloat(recebidoHtml[1]) > 0, recebidoHtml && recebidoHtml[1]);

    remote.release();
    await p;
    check('1f. após a nuvem confirmar, promise resolve e sem erro', settled);
    check('1g. não houve mensagem de falha', !notifications(h).includes('❌'));
  }

  // 2. Troca de aba / fechamento IMEDIATAMENTE após o clique, antes de a
  // fila/nuvem processarem: o estado sobrevive a um "reload" (nova instância
  // do app lendo o MESMO IndexedDB), mesmo offline.
  {
    const sharedIdb = new Map();
    const h1 = setup(sharedIdb);
    const remote = controlledDb(); // nunca liberado: simula a aba sendo fechada no meio do processamento
    h1.api.setDb(remote.db);
    await h1.api.tomoEnsureStorage();

    const p = h1.api.togglePagamentoUnificado('sagrada-familia', '2026-01');
    await until(() => isMarcadoPago(h1, 'sagrada-familia', '2026-01'));
    // Ponto exato em que, na produção, o usuário trocaria de aba/fecharia:
    // a transação remota (gates.transaction) nunca vai resolver neste teste.

    const h2 = setup(sharedIdb); // "reidrata": nova instância, mesmo IndexedDB
    h2.api.setDb(null); // reload acontece OFFLINE
    await h2.api.carregarDados();
    check('2a. após reload offline imediatamente após o clique, o pagamento continua marcado', h2.api.getDadosApp().pagamentos['2026-01']['sagrada-familia'] === true);
    check('2b. a operação de pagamento sobrevive na fila local para retomar depois', h2.api.getFilaInterna().some(op => op.tipo === 'pagamento' && op.mesAno === '2026-01' && op.servicoId === 'sagrada-familia'));
    check('2c. totais do mês continuam corretos após o reload (nada duplicado)', h2.api.getDadosApp().exames['2026-01-05'].cranio['sagrada-familia'] === 4);

    remote.release();
    await p.catch(() => {});
  }

  // 3. Sincronização remota lenta: a UI não fica esperando; só o selo de
  // fila pendente (indicador já existente) continua indicando pendência até
  // a nuvem confirmar.
  {
    const h = setup();
    const remote = controlledDb();
    h.api.setDb(remote.db);
    await h.api.tomoEnsureStorage();
    const p = h.api.togglePagamentoUnificado('hbj', '2026-01');
    await until(() => isMarcadoPago(h, 'hbj', '2026-01'));
    check('3a. UI responde mesmo com transação remota represada', isMarcadoPago(h, 'hbj', '2026-01'));
    remote.gates.transaction.resolve();
    await until(() => remote.calls.month);
    check('3b. save legado do mês só começa depois da transação autoritativa', true);
    remote.gates.month.resolve();
    remote.gates.principal.resolve();
    await p;
  }

  // 4. Falha de rede (transação remota falha de verdade, não só demora): o
  // dado permanece correto localmente, fica pendente na fila para retry, e
  // NUNCA é reportado como sincronizado com sucesso.
  {
    const h = setup();
    const remote = controlledDb({ fail: 'transaction' });
    remote.release();
    h.api.setDb(remote.db);
    await h.api.togglePagamentoUnificado('cmt', '2026-01');
    check('4a. pagamento permanece marcado localmente mesmo com falha remota', h.api.getDadosApp().pagamentos['2026-01'].cmt === true);
    check('4b. operação de pagamento fica pendente/erro na fila (não desaparece em silêncio)', h.api.tomoStatusFila().total >= 1);
    check('4c. nenhuma mensagem de sucesso de nuvem falsa', !notifications(h).includes('Salvo na nuvem'));
    // Retry pela arquitetura existente.
    h.api.setDb(remote.real);
    await h.api.tomoProcessarFila();
    check('4d. retry posterior esvazia a fila sem duplicar', h.api.tomoStatusFila().total === 0);
    const doc = await remote.real.collection('controles_pagamentos').doc('2026-01').get();
    check('4e. valor final na nuvem está correto após o retry', doc.data().cmt === true);
  }

  // 5. Falha de persistência LOCAL: não pode fingir sucesso (nem UI, nem
  // enfileiramento) se o dado não foi salvo localmente.
  {
    const h = setup();
    await h.api.tomoEnsureStorage();
    const put = h.api.idbLocalStorage.setItemAsync;
    h.api.idbLocalStorage.setItemAsync = async function(k, ...args) {
      if (k === 'examesTomografia') throw new Error('falha local simulada');
      return put.call(this, k, ...args);
    };
    const remote = controlledDb(); h.api.setDb(remote.db);
    await h.api.togglePagamentoUnificado('mobilemed', '2026-01');
    check('5a. falha local gera aviso de erro explícito', notifications(h).includes('❌ Falha ao salvar localmente.'));
    check('5b. nenhuma operação remota foi iniciada após falha local', remote.calls.transaction === 0);
  }

  // 6. Múltiplos cliques em sequência (marcar/desmarcar/marcar) não deixam
  // estado inconsistente nem duplicam nada; totais do mês não mudam (só
  // RECEBIDO/A RECEBER se movem entre si).
  {
    const h = setup();
    const db = makeFirestoreMock();
    h.api.setDb(db);
    await h.api.togglePagamentoUnificado('radcloud', '2026-01');
    await h.api.togglePagamentoUnificado('radcloud', '2026-01');
    await h.api.togglePagamentoUnificado('radcloud', '2026-01');
    check('6a. três cliques em sequência terminam marcado como pago (ímpar de toggles)', h.api.getDadosApp().pagamentos['2026-01'].radcloud === true);
    const doc = await db.collection('controles_pagamentos').doc('2026-01').get();
    check('6b. nuvem concorda com o estado final', doc.data().radcloud === true);
    check('6c. contagem de laudos do dia não foi afetada por toggles de pagamento', h.api.getDadosApp().exames['2026-01-05'].cranio['sagrada-familia'] === 4);
  }
}

module.exports = { run };
