// Correção multi-PC "operações locais não podem ficar silenciosamente
// presas": outbox durável + status honesto + retry idempotente + mensal
// anti-stale. Cada cenário usa o script REAL de index.html (via loadApp) e
// mocks de Firestore/IndexedDB — sem navegador e sem rede.
//
// Legenda: A..O seguem a numeração do pedido de correção.
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

const DAY = '2026-10-02';
const MES = '2026-10';

function app(sharedIdb) {
  const h = loadApp(sharedIdb ? { sharedIdb } : {});
  h.doc.getElementById('data-exame').value = DAY;
  h.doc.getElementById('mes-relatorio').value = MES;
  return h;
}
function syncText(h) {
  const el = h.doc._elements.get('sync-status');
  return el ? el.textContent : '';
}
function badgeText(h) {
  const el = h.doc._elements.get('fila-status');
  return el ? el.textContent : '';
}
function cloudVal(db, dia, seg, serv) {
  const snap = db._store.get('controles_dias/' + dia);
  if (!snap) return undefined;
  return snap.exames && snap.exames[seg] ? snap.exames[seg][serv] : undefined;
}

async function run(check) {
  // A. Firestore indisponível: lançamento permanece local e na fila
  // (outbox durável — local persistido ANTES de qualquer round-trip).
  {
    const sharedIdb = new Map();
    const h = app(sharedIdb);
    h.api.setDb(null); // ERR_BLOCKED_BY_CLIENT do hospital
    await h.api.tomoEnsureStorage();
    await h.api.alterarContador('torax', 'hbj', 1);
    check('A1. contador aparece localmente mesmo com Firestore bloqueado',
      h.api.getDadosApp().exames[DAY].torax.hbj === 1);
    const raw = sharedIdb.get('examesTomografia');
    check('A2. estado local já está em IndexedDB (sobrevive a fechar a aba)',
      !!raw && JSON.parse(raw).exames[DAY].torax.hbj === 1);
    const st = h.api.tomoStatusFila();
    check('A3. operação ficou na fila (não se perdeu, não fingiu sucesso)',
      st.total === 1 && st.pendentes === 1, JSON.stringify(st));
    check('A4. há pendência de sync reconhecida', h.api.tomoTemPendenciasSync() === true);
  }

  // B. Reload: a fila continua presente (mesmo operationId).
  {
    const sharedIdb = new Map();
    const h1 = app(sharedIdb);
    h1.api.setDb(null);
    await h1.api.tomoEnsureStorage();
    await h1.api.alterarContador('torax', 'hbj', 1);
    const idAntes = h1.api.getFilaInterna()[0].operationId;

    const h2 = app(sharedIdb); // "reload": nova instância, mesmo IndexedDB
    h2.api.setDb(null);
    await h2.api.tomoEnsureStorage();
    await h2.api.tomoCarregarFila();
    const fila2 = h2.api.getFilaInterna();
    check('B1. reload mantém a operação na fila', fila2.length === 1, JSON.stringify(fila2.length));
    check('B2. reload preserva o MESMO operationId (sem duplicar identidade)',
      fila2[0] && fila2[0].operationId === idAntes);
    check('B3. reload mantém o estado local da contagem',
      JSON.parse(sharedIdb.get('examesTomografia')).exames[DAY].torax.hbj === 1);
  }

  // C. Firestore volta: retry aplica exatamente 1 vez.
  {
    const sharedIdb = new Map();
    const h = app(sharedIdb);
    h.api.setDb(null);
    await h.api.tomoEnsureStorage();
    await h.api.alterarContador('pelve', 'vx', 1);
    const db = makeFirestoreMock();
    h.api.setDb(db);
    await h.api.tomoProcessarFila();
    check('C1. retry esvazia a fila', h.api.tomoStatusFila().total === 0);
    check('C2. retry aplicou exatamente 1 vez', cloudVal(db, DAY, 'pelve', 'vx') === 1);
    await h.api.tomoProcessarFila();
    check('C3. reprocessar não reaplica', cloudVal(db, DAY, 'pelve', 'vx') === 1);
  }

  // D. Mesmo operationId reenviado: contador não duplica (ledger).
  {
    const h = app();
    const db = makeFirestoreMock();
    h.api.setDb(db);
    const r1 = await h.api.tomoAplicarIncrementoAtomico(db, 'op-dup-1', DAY, 'cranio', 'hbj', 1);
    const r2 = await h.api.tomoAplicarIncrementoAtomico(db, 'op-dup-1', DAY, 'cranio', 'hbj', 1);
    check('D1. primeira aplicação conta', r1.ok === true && r1.jaAplicado === false);
    check('D2. reenvio do mesmo ID é detectado como já aplicado',
      r2.ok === true && r2.jaAplicado === true);
    check('D3. valor final é 1 (sem duplicação)', cloudVal(db, DAY, 'cranio', 'hbj') === 1);
  }

  // E. Outro PC lê controles_dias e vê o lançamento depois do retry.
  {
    const h1 = app();
    const db = makeFirestoreMock(); // "nuvem" compartilhada
    h1.api.setDb(null);
    await h1.api.tomoEnsureStorage();
    await h1.api.alterarContador('torax', 'hbj', 1);
    const antes = (() => {
      const snap = db._store.get('controles_dias/' + DAY);
      return snap ? snap.exames : undefined;
    })();
    check('E1. antes do retry, a nuvem ainda não tem o lançamento', antes === undefined);
    h1.api.setDb(db);
    await h1.api.tomoProcessarFila();
    // PC2: instância limpa que só lê a nuvem (extração + merge oficiais).
    const h2 = app();
    const diaSnap = await db.collection('controles_dias').doc(DAY).get();
    const diario = h2.api.tomoExtrairExamesDocDiario(diaSnap.data());
    const visaoPC2 = h2.api.tomoAplicarDocsDiarios({}, { [DAY]: diario });
    check('E2. após o retry, outro PC enxerga o lançamento via controles_dias',
      visaoPC2[DAY] && visaoPC2[DAY].torax && visaoPC2[DAY].torax.hbj === 1);
  }

  // F. Erro não é descartado (status=erro preserva op + mesmo ID); retry
  // explícito posterior — mesmo dentro do backoff — reaproveita o ID.
  {
    const h = app();
    const dbRuim = makeFirestoreMock({ failPaths: ['controles_operacoes/op-erro-f'] });
    h.api.setDb(dbRuim);
    await h.api.tomoEnsureStorage();
    await h.api.tomoEnfileirar({ operationId: 'op-erro-f', tipo: 'contador', data: DAY, seg: 'bacia', serv: 'hbj', delta: 1 });
    await h.api.tomoProcessarFila();
    const st = h.api.tomoStatusFila();
    check('F1. falha real vira erro na fila (não some, não conclui)',
      st.comErro === 1 && st.total === 1, JSON.stringify(st));
    check('F2. tentativa foi contabilizada', h.api.getFilaInterna()[0].tentativas >= 1);
    const dbBom = makeFirestoreMock();
    h.api.setDb(dbBom);
    await h.api.tomoProcessarFila(); // explícito: ignora backoff, mesmo ID
    check('F3. retry explícito esvazia sem gerar novo ID',
      h.api.tomoStatusFila().total === 0);
    check('F4. nuvem recebeu exatamente 1 com o ID original',
      cloudVal(dbBom, DAY, 'bacia', 'hbj') === 1 && dbBom._store.has('controles_operacoes/op-erro-f'));
  }

  // G. Save mensal bem-sucedido + fila pendente: UI NÃO mostra sincronização total.
  {
    const h = app();
    const db = makeFirestoreMock();
    h.api.setDb(null);
    await h.api.tomoEnsureStorage();
    await h.api.alterarContador('torax', 'hbj', 1); // fila pendente offline
    h.api.setDb(db); // nuvem "ok" para o mensal, mas SEM processar a fila
    const res = await h.api.salvarDadosFirebase(true);
    check('G1. mensal legado foi gravado', res.cloudOk === true || res.ok === true, JSON.stringify({ cloudOk: res.cloudOk }));
    check('G2. fila continua pendente', h.api.tomoTemPendenciasSync() === true);
    const txt = syncText(h);
    check('G3. status global NÃO finge "Salvo na nuvem"/"Sincronizado" puro',
      !/✅ Salvo na nuvem/.test(txt) && !/^✅ Sincronizado$/.test(txt), txt);
    check('G4. status avisa explicitamente a pendência neste dispositivo',
      /aguardando sincronização/.test(txt), txt);
    h.api.tomoAtualizarBadgeFila();
    check('G5. badge indica operações não sincronizadas (sobrevive a reload via fila)',
      /não sincronizada/.test(badgeText(h)), badgeText(h));
  }

  // H. Botão Sincronizar com fila: processa a fila ANTES do mensal.
  {
    const sharedIdb = new Map();
    const h = app(sharedIdb);
    h.api.setDb(null);
    await h.api.tomoEnsureStorage();
    await h.api.alterarContador('cranio', 'hbj', 1); // pendente offline
    const log = [];
    const db = makeFirestoreMock({ log });
    h.api.setDb(db);
    const btn = h.doc.getElementById('btn-sincronizar');
    const handlers = btn._listeners.click || [];
    check('H0. botão Sincronizar possui handler', handlers.length >= 1);
    await handlers[0]();
    const idxFila = log.findIndex(([op, path]) =>
      (path === 'controles_operacoes/' + h.api.getFilaInterna()[0]?.operationId) ||
      (op === 'set' && (path.startsWith('controles_dias/') || path.startsWith('controles_operacoes/'))));
    const idxMensal = log.findIndex(([op, path]) =>
      op === 'set' && path.startsWith('controles/examesTomografia_'));
    check('H1. fila esvaziou pelo botão', h.api.tomoStatusFila().total === 0);
    check('H2. escrita autoritativa (fila) veio antes do mensal legado',
      idxFila !== -1 && idxMensal !== -1 && idxFila < idxMensal, JSON.stringify(log.map(([, p]) => p)));
    check('H3. mensal contém o lançamento', (() => {
      const doc = db._store.get('controles/examesTomografia_' + MES);
      return !!(doc && doc.exames && doc.exames[DAY] && doc.exames[DAY].cranio && doc.exames[DAY].cranio.hbj === 1);
    })());
  }

  // I. Gatilhos disparam retry seguro (sem API paralela).
  {
    const h = app();
    check('I1. retry oportunista (online/focus/visible) existe e é função',
      typeof h.api.tomoAgendarRetryFila === 'function');
    const db = makeFirestoreMock();
    h.api.setDb(db);
    await h.api.tomoEnsureStorage();
    await h.api.tomoEnfileirar({ operationId: 'op-retry-agendado', tipo: 'contador', data: DAY, seg: 'torax', serv: 'vx', delta: 1 });
    await h.api.tomoAgendarRetryFila();
    // tomoAgendarRetryFila dispara sem await interno; aguarda convergência.
    const t0 = Date.now();
    while (h.api.tomoStatusFila().total !== 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setImmediate(r));
    }
    check('I2. gatilho oportunista esvazia a fila', h.api.tomoStatusFila().total === 0);
  }

  // J. Múltiplos gatilhos simultâneos não processam em paralelo (mutex).
  {
    const h = app();
    const real = makeFirestoreMock();
    let txCount = 0;
    const db = {
      collection(name) { return real.collection(name); },
      collectionGroup(name) { return real.collectionGroup(name); },
      async runTransaction(fn) { txCount++; return real.runTransaction(fn); },
    };
    h.api.setDb(db);
    await h.api.tomoEnsureStorage();
    await h.api.tomoEnfileirar({ operationId: 'op-mutex-1', tipo: 'contador', data: DAY, seg: 'cranio', serv: 'vx', delta: 1 });
    await Promise.all([
      h.api.tomoProcessarFila(), h.api.tomoProcessarFila(), h.api.tomoProcessarFila(),
      h.api.tomoProcessarFila(), h.api.tomoProcessarFila(),
    ]);
    check('J1. fila esvaziou', h.api.tomoStatusFila().total === 0);
    check('J2. valor aplicado uma única vez', cloudVal(real, DAY, 'cranio', 'vx') === 1);
    check('J3. chamadas concorrentes se juntaram a uma execução (1 transação)',
      txCount === 1, `txCount=${txCount}`);
  }

  // K. beforeunload só alerta se houver pendências.
  {
    const h = app();
    await h.api.tomoEnsureStorage();
    h.api.setFilaInterna([]);
    h.api.setFilaCarregada(true);
    const livre = {};
    const r1 = h.api.tomoBeforeUnloadHandler(livre);
    check('K1. fila vazia: navegação livre (sem aviso)',
      r1 === undefined && livre.returnValue === undefined);
    h.api.setFilaInterna([{ operationId: 'op-k', tipo: 'contador', status: 'pendente', tentativas: 0 }]);
    let prevented = false;
    const evt = { preventDefault() { prevented = true; }, returnValue: undefined };
    const r2 = h.api.tomoBeforeUnloadHandler(evt);
    check('K2. fila pendente: alerta com mensagem', prevented === true && typeof r2 === 'string' && /não sincronizadas/.test(r2), String(r2));
    h.api.setFilaInterna([{ operationId: 'op-k2', tipo: 'contador', status: 'erro', tentativas: 3, ultimoErro: 'x' }]);
    const evt2 = { preventDefault() {}, returnValue: undefined };
    const r3 = h.api.tomoBeforeUnloadHandler(evt2);
    check('K3. status erro também alerta (erro ≠ concluído)', typeof r3 === 'string');
  }

  // L. Dois PCs incrementando o mesmo contador convergem.
  {
    const db = makeFirestoreMock();
    const hA = app(); hA.api.setDb(db);
    const hB = app(); hB.api.setDb(db);
    await hA.api.tomoEnsureStorage();
    await hB.api.tomoEnsureStorage();
    await hA.api.tomoEnfileirar({ operationId: 'op-pcA-1', tipo: 'contador', data: DAY, seg: 'torax', serv: 'hbj', delta: 1 });
    await hB.api.tomoEnfileirar({ operationId: 'op-pcB-1', tipo: 'contador', data: DAY, seg: 'torax', serv: 'hbj', delta: 1 });
    await hA.api.tomoProcessarFila();
    await hB.api.tomoProcessarFila();
    check('L1. nuvem somou os dois incrementos', cloudVal(db, DAY, 'torax', 'hbj') === 2);
    const diaSnap = await db.collection('controles_dias').doc(DAY).get();
    const diario = hA.api.tomoExtrairExamesDocDiario(diaSnap.data());
    const visaoA = hA.api.tomoAplicarDocsDiarios(hA.api.getDadosApp().exames, { [DAY]: diario });
    const visaoB = hB.api.tomoAplicarDocsDiarios(hB.api.getDadosApp().exames, { [DAY]: diario });
    check('L2. PC-A converge para 2', visaoA[DAY].torax.hbj === 2);
    check('L3. PC-B converge para 2', visaoB[DAY].torax.hbj === 2);
  }

  // M. Documento mensal stale não apaga contagem autoritativa.
  {
    const db = makeFirestoreMock();
    // Nuvem autoritativa em 10 (ex.: outro PC já sincronizou 10).
    for (let i = 0; i < 10; i++) {
      await db.runTransaction(async (tx) => {
        const opRef = db.collection('controles_operacoes').doc('op-seed-' + i);
        const diaRef = db.collection('controles_dias').doc(DAY);
        const s = await tx.get(opRef);
        if (!s.exists) {
          tx.set(diaRef, { data: DAY, ['exames.cranio.hbj']: { __tomoIncrement: 1 } }, { merge: true });
          tx.set(opRef, { tipo: 'contador' });
        }
      });
    }
    const h = app(); // PC com estado STALE (7, de antes)
    h.api.setDb(db);
    await h.api.tomoEnsureStorage();
    h.api.setDadosApp({ exames: { [DAY]: { cranio: { hbj: 7 } } }, tempos: {}, pagamentos: {} });
    const antes = JSON.stringify(h.api.getDadosApp().exames);
    await h.api.salvarDadosFirebase(true);
    const mensal = db._store.get('controles/examesTomografia_' + MES);
    const gravado = mensal && mensal.exames && mensal.exames[DAY] && mensal.exames[DAY].cranio
      && mensal.exames[DAY].cranio.hbj;
    check('M1. mensal gravado levou o valor autoritativo (10), não o stale (7)', gravado === 10, `gravado=${gravado}`);
    check('M2. memória local não foi deformada pela reconciliação', JSON.stringify(h.api.getDadosApp().exames) === antes);
    check('M3. documento diário segue intacto', cloudVal(db, DAY, 'cranio', 'hbj') === 10);
  }

  // N. Pagamentos e estornos continuam funcionando (via fila idempotente).
  {
    const h = app();
    h.doc.getElementById('mes-relatorio').value = MES;
    const dados = h.api.getDadosApp();
    dados.exames[DAY] = { cranio: { 'sagrada-familia': 4 } };
    h.api.setDadosApp(dados);
    const db = makeFirestoreMock();
    h.api.setDb(db);
    await h.api.tomoEnsureStorage();
    await h.api.togglePagamentoUnificado('sagrada-familia', MES);
    check('N1. pagamento marcou local', h.api.getDadosApp().pagamentos[MES]['sagrada-familia'] === true);
    const pagDoc = await db.collection('controles_pagamentos').doc(MES).get();
    check('N2. pagamento chegou à nuvem autoritativa', pagDoc.data()['sagrada-familia'] === true);
    check('N3. fila de pagamento esvaziou', h.api.tomoStatusFila().total === 0);
    check('N4. núcleo de estorno preservado', typeof h.api.tomoAplicarEstornoAtomico === 'function');
  }

  // Backoff: progressão limitada (sem martelar) e retry explícito garantido.
  {
    const h = app();
    const w0 = h.api.tomoBackoffMs(0), w1 = h.api.tomoBackoffMs(1), w99 = h.api.tomoBackoffMs(99);
    check('BO1. backoff progride sem agredir (15s, 30s, teto ≤ 5min)',
      w0 === 15000 && w1 === 30000 && w99 <= 5 * 60 * 1000 && w99 >= w1, `${w0}/${w1}/${w99}`);
  }

  // Telemetria local (sem PII): diagnóstico acessível.
  {
    const h = app();
    await h.api.tomoEnsureStorage();
    h.api.setFilaInterna([{ operationId: 'op-t', tipo: 'contador', status: 'erro', tentativas: 2, ultimoErro: 'boom' }]);
    h.api.setFilaCarregada(true);
    const d = h.api.tomoDiagnosticoFila();
    check('T1. diagnóstico expõe tamanho/pendentes/erros/último erro',
      d.tamanho === 1 && d.pendentes === 0 && d.comErro === 1 && d.ultimoErro === 'boom', JSON.stringify(d));
  }
}

module.exports = { run };
