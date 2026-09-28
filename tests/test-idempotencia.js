// Cenários 1-3: operationId idempotente, retry após resposta de rede
// perdida, e incremento concorrente de "2 PCs" (duas operationId distintas
// aplicadas sobre o mesmo dia/segmento/serviço).
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function totalDoDia(db, dia, seg, serv){
  const snap = await db.collection('controles_dias').doc(dia).get();
  if (!snap.exists) return 0;
  return ((snap.data().exames || {})[seg] || {})[serv] || 0;
}

async function run(check){
  const { api } = loadApp();
  const db = makeFirestoreMock();

  // 1. operationId idempotente: aplicar a MESMA operação duas vezes só conta uma vez.
  {
    const r1 = await api.tomoAplicarIncrementoAtomico(db, 'op-A', '2026-02-01', 'torax', 'hbj', 1);
    const r2 = await api.tomoAplicarIncrementoAtomico(db, 'op-A', '2026-02-01', 'torax', 'hbj', 1);
    const total = await totalDoDia(db, '2026-02-01', 'torax', 'hbj');
    check('1. operationId idempotente: retry não duplica contagem', r1.ok && !r1.jaAplicado && r2.ok && r2.jaAplicado && total === 1, `total=${total}`);
  }

  // 2. Retry após resposta perdida: servidor já confirmou (ledger gravado),
  // cliente acha que falhou (ex.: rede caiu na volta) e reenvia a MESMA
  // operationId. Resultado: incrementa só uma vez.
  {
    const dbLocal = makeFirestoreMock();
    const opId = 'op-perdido-1';
    const primeira = await api.tomoAplicarIncrementoAtomico(dbLocal, opId, '2026-02-02', 'cranio', 'vx', 1);
    // Simula "resposta perdida": o app não soube que deu certo e tenta de novo.
    const retry = await api.tomoAplicarIncrementoAtomico(dbLocal, opId, '2026-02-02', 'cranio', 'vx', 1);
    const total = await totalDoDia(dbLocal, '2026-02-02', 'cranio', 'vx');
    check('2. retry após resposta perdida: incrementa uma única vez', primeira.ok && retry.ok && retry.jaAplicado && total === 1, `total=${total}`);
  }

  // 3. Incremento concorrente de 2 PCs: operationIds DIFERENTES sobre o
  // mesmo dia/segmento/serviço devem somar (+1 e +1 = +2), mesmo que ambos
  // tenham partido de um estado local desatualizado.
  {
    const dbLocal = makeFirestoreMock();
    const pcA = api.tomoAplicarIncrementoAtomico(dbLocal, 'op-pcA', '2026-02-03', 'torax', 'mobilemed', 1);
    const pcB = api.tomoAplicarIncrementoAtomico(dbLocal, 'op-pcB', '2026-02-03', 'torax', 'mobilemed', 1);
    const [ra, rb] = await Promise.all([pcA, pcB]);
    const total = await totalDoDia(dbLocal, '2026-02-03', 'torax', 'mobilemed');
    check('3. incremento concorrente de 2 PCs soma corretamente (+1 e +1 = +2)', ra.ok && rb.ok && total === 2, `total=${total}`);
  }
}

module.exports = { run };
