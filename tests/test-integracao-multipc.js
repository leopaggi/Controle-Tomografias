// Cenário 21: fluxo crítico integrado multi-PC. Dois "PCs" (duas instâncias
// independentes do app, cada uma com seu próprio estado local e fila
// offline) compartilhando o MESMO Firestore. Cada um faz +1 TC tórax/HBJ
// partindo de um estado local desatualizado (sem saber do outro). O
// resultado no servidor deve ser +2 — nunca +1 (perda) nem +3/4 (duplicação).
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  const db = makeFirestoreMock();

  const pcA = loadApp();
  const pcB = loadApp();
  pcA.api.setDb(db);
  pcB.api.setDb(db);

  // Ambos partem de dadosApp vazio (estado local "antigo", sem o incremento
  // que o outro PC está prestes a fazer).
  const dia = pcA.doc.getElementById('data-exame').value;

  await pcA.api.alterarContador('torax', 'hbj', 1);
  await pcB.api.alterarContador('torax', 'hbj', 1);

  // Garante que a fila de cada PC foi esvaziada (contador atômico aplicado).
  await pcA.api.tomoProcessarFila();
  await pcB.api.tomoProcessarFila();

  const diaDoc = await db.collection('controles_dias').doc(dia).get();
  const totalServidor = (diaDoc.exists && diaDoc.data().exames.torax && diaDoc.data().exames.torax.hbj) || 0;
  check('21a. servidor consolida +1 de cada PC em +2 (nunca perde, nunca duplica)', totalServidor === 2, `total=${totalServidor}`);

  // Um TERCEIRO PC, que nunca tinha aberto o app antes (estado local vazio,
  // metadata legada também vazia), ao carregar os dados deve enxergar o
  // total AUTORITATIVO de 2 — não 0, não 1.
  const pcC = loadApp();
  pcC.api.setDb(db);
  await pcC.api.carregarDados();
  const totalPcC = (pcC.api.getDadosApp().exames[dia] && pcC.api.getDadosApp().exames[dia].torax && pcC.api.getDadosApp().exames[dia].torax.hbj) || 0;
  check('21b. um terceiro PC que nunca abriu o app enxerga o total consolidado (2)', totalPcC === 2, `total=${totalPcC}`);

  // Retry: PC A perde a resposta de uma operação já aplicada e tenta de
  // novo com a MESMA operationId — não pode incrementar de novo.
  const filaA = pcA.api.getFilaInterna();
  // Simula uma operação confirmada no servidor mas cujo status local ficou
  // "erro" por causa de uma falha de rede transitória (resposta perdida).
  const opIdRetry = 'op-retry-cenario21';
  const r1 = await pcA.api.tomoAplicarIncrementoAtomico(db, opIdRetry, dia, 'torax', 'hbj', 1);
  const r2 = await pcA.api.tomoAplicarIncrementoAtomico(db, opIdRetry, dia, 'torax', 'hbj', 1);
  const diaDoc2 = await db.collection('controles_dias').doc(dia).get();
  const totalFinal = diaDoc2.data().exames.torax.hbj;
  check('21c. retry de uma operação já confirmada não incrementa de novo (total=3, não 4)', r1.ok && r2.jaAplicado && totalFinal === 3, `total=${totalFinal}`);
}

module.exports = { run };
