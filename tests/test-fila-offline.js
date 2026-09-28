// Cenários 4-5: fila offline de operações pendentes e retry da fila quando
// a conexão volta. Também cobre "UI não mostra sucesso falso" para a fila
// (tomoStatusFila reflete pendência real).
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  // 4. Fila offline: sem conexão (db=null), a operação enfileirada fica
  // pendente e NÃO é perdida.
  {
    const { api } = loadApp();
    api.setDb(null);
    await api.tomoEnfileirar({ operationId: 'op-offline-1', tipo: 'contador', data: '2026-03-01', seg: 'torax', serv: 'hbj', delta: 1 });
    const status = api.tomoStatusFila();
    check('4. operação enfileirada offline fica pendente (não se perde)', status.pendentes === 1 && status.total === 1, JSON.stringify(status));
  }

  // 5. Retry da fila: operação enfileirada offline; ao "reconectar"
  // (setDb + tomoProcessarFila), ela é aplicada exatamente uma vez e sai da
  // fila.
  {
    const { api } = loadApp();
    api.setDb(null);
    await api.tomoEnfileirar({ operationId: 'op-retry-fila', tipo: 'contador', data: '2026-03-02', seg: 'pelve', serv: 'vx', delta: 1 });
    check('5a. antes de reconectar, fila ainda tem 1 pendente', api.tomoStatusFila().pendentes === 1);

    const db = makeFirestoreMock();
    api.setDb(db);
    await api.tomoProcessarFila();
    const statusDepois = api.tomoStatusFila();
    const diaSnap = await db.collection('controles_dias').doc('2026-03-02').get();
    const valor = diaSnap.exists ? (diaSnap.data().exames.pelve || {}).vx : undefined;
    check('5b. reconectar processa a fila e ela esvazia', statusDepois.total === 0, JSON.stringify(statusDepois));
    check('5c. a operação da fila foi aplicada exatamente uma vez', valor === 1, `valor=${valor}`);

    // Reprocessar de novo (ex.: segunda chamada do intervalo de 20s) não
    // deve reaplicar nada, pois a fila já está vazia.
    await api.tomoProcessarFila();
    const diaSnap2 = await db.collection('controles_dias').doc('2026-03-02').get();
    const valor2 = (diaSnap2.data().exames.pelve || {}).vx;
    check('5d. reprocessar fila vazia não duplica nada', valor2 === 1, `valor2=${valor2}`);
  }

  // Bônus: operação com erro (não-offline) fica marcada como erro na fila,
  // sem ficar escondida como se tivesse dado certo.
  {
    const { api } = loadApp();
    const db = makeFirestoreMock({ failPaths: ['controles_operacoes/op-com-erro'] });
    api.setDb(db);
    await api.tomoEnfileirar({ operationId: 'op-com-erro', tipo: 'contador', data: '2026-03-03', seg: 'bacia', serv: 'hbj', delta: 1 });
    await api.tomoProcessarFila();
    const status = api.tomoStatusFila();
    check('5e. falha real (não offline) fica marcada como erro na fila, não desaparece em silêncio', status.comErro === 1 && status.total === 1, JSON.stringify(status));
  }
}

module.exports = { run };
