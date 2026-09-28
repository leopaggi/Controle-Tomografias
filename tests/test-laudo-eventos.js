// Cenário 14: evento de laudo por operationId — controles_dias/{dia}/laudos/{eventId},
// eventId = operationId do laudo inteiro; gravar de novo com o mesmo id é
// idempotente (sobrescreve com os mesmos dados, não duplica documento).
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  const { api } = loadApp();
  const db = makeFirestoreMock();

  const evento = {
    empresa: 'HBJ', segmentos: ['TORAX', 'CRÂNIO'], tempo: 120, tempoFormatado: '2m',
    tipo: 'cronometro', horario: '10:00', timestamp: 1000, origem: 'pc-teste', operationId: 'laudo-1'
  };
  const r1 = await api.tomoGravarEventoLaudo(db, 'laudo-1', '2026-05-01', evento);
  check('14a. evento de laudo gravado com sucesso', r1.ok);

  const snap = await db.collection('controles_dias').doc('2026-05-01').collection('laudos').doc('laudo-1').get();
  check('14b. evento fica em controles_dias/{dia}/laudos/{eventId}', snap.exists && snap.data().empresa === 'HBJ');

  // Regravar com o MESMO eventId (retry) não cria um segundo documento —
  // é a mesma operação idempotente.
  await api.tomoGravarEventoLaudo(db, 'laudo-1', '2026-05-01', evento);
  const colSnap = await db.collection('controles_dias').doc('2026-05-01').collection('laudos').get();
  check('14c. retry com o mesmo eventId não duplica o documento', colSnap.size === 1, `size=${colSnap.size}`);

  // finalizarLaudo real: 1 laudo com 2 segmentos gera 2 incrementos
  // atômicos (um por segmento) + exatamente 1 evento de laudo cross-PC.
  const { api: api3, doc } = loadApp();
  const db3 = makeFirestoreMock();
  api3.setDb(db3);
  doc.getElementById('timer-servico').value = 'hbj';
  const cbTorax = doc.getElementById('cb-torax'); cbTorax.checked = true; cbTorax.value = 'torax';
  const cbCranio = doc.getElementById('cb-cranio'); cbCranio.checked = true; cbCranio.value = 'cranio';
  doc.querySelectorAll = (sel) => (sel === '#timer-segmentos-container input:checked' ? [cbTorax, cbCranio] : []);
  const dia = doc.getElementById('data-exame').value;
  await api3.finalizarLaudo();
  await api3.tomoProcessarFila();
  const diaDoc = await db3.collection('controles_dias').doc(dia).get();
  const laudosSnap = await db3.collection('controles_dias').doc(dia).collection('laudos').get();
  check('14d. finalizarLaudo com 2 segmentos incrementa os 2 contadores', diaDoc.exists && diaDoc.data().exames.torax.hbj === 1 && diaDoc.data().exames.cranio.hbj === 1, JSON.stringify(diaDoc.data()));
  check('14e. finalizarLaudo gera exatamente 1 evento de laudo cross-PC (não 1 por segmento)', laudosSnap.size === 1, `size=${laudosSnap.size}`);
}

module.exports = { run };
