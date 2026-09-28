// Cenário 13: pagamento separado por serviço — controles_pagamentos/{mes},
// atualizado por merge, sem depender de reescrever o mês inteiro de exames.
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  const { api } = loadApp();
  const db = makeFirestoreMock();

  const r1 = await api.tomoAplicarPagamento(db, 'op-pag-1', '2026-04', 'hbj', true);
  check('13a. pagamento aplicado cria controles_pagamentos/{mes}', r1.ok && !r1.jaAplicado);

  const doc1 = await db.collection('controles_pagamentos').doc('2026-04').get();
  check('13b. documento de pagamento contém só o serviço marcado', doc1.exists && doc1.data().hbj === true);

  // Marcar outro serviço no mesmo mês não apaga o primeiro (merge, não
  // reescrita do documento inteiro).
  await api.tomoAplicarPagamento(db, 'op-pag-2', '2026-04', 'vx', true);
  const doc2 = await db.collection('controles_pagamentos').doc('2026-04').get();
  check('13c. merge preserva pagamentos de outros serviços no mesmo mês', doc2.data().hbj === true && doc2.data().vx === true, JSON.stringify(doc2.data()));

  // Idempotência: reaplicar a MESMA operationId não alterna o valor de novo.
  const r2 = await api.tomoAplicarPagamento(db, 'op-pag-1', '2026-04', 'hbj', true);
  check('13d. reaplicar a mesma operationId de pagamento é idempotente', r2.jaAplicado === true);

  // Não depende de reescrever o documento mensal de exames: nenhuma escrita
  // em controles/examesTomografia_2026-04 acontece aqui.
  const mesExames = await db.collection('controles').doc('examesTomografia_2026-04').get();
  check('13e. pagamento não reescreve o documento mensal de exames', mesExames.exists === false);
}

module.exports = { run };
