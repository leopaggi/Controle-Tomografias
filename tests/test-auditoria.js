// Cenário 19: auditoria somente-leitura — compara local x diário x legado
// mensal x fila pendente, sinaliza divergência, e NUNCA escreve nada.
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  const { api } = loadApp();
  const db = makeFirestoreMock();

  // Dia com valores DIVERGENTES entre local e documento diário.
  await db.collection('controles_dias').doc('2026-07-01').set({ exames: { torax: { hbj: 5 } } });
  const dadosLocais = { exames: { '2026-07-01': { torax: { hbj: 2 } } }, tempos: {}, pagamentos: {} };

  const snapshotAntes = JSON.stringify(Array.from(db._store.entries()));
  const rel = await api.tomoAuditar(db, dadosLocais);
  const snapshotDepois = JSON.stringify(Array.from(db._store.entries()));

  check('19a. auditoria não escreve nada no Firestore (somente leitura)', snapshotAntes === snapshotDepois);
  check('19b. auditoria detecta a divergência entre local e documento diário', rel.dias['2026-07-01'] && rel.dias['2026-07-01'].divergente === true, JSON.stringify(rel.dias['2026-07-01']));
  check('19c. auditoria reporta o total de cada fonte separadamente', rel.dias['2026-07-01'].totais.local === 2 && rel.dias['2026-07-01'].totais.diario === 5);
  check('19d. auditoria inclui o status da fila pendente', typeof rel.filaPendente.pendentes === 'number');

  // Dia SEM divergência (mesmo total local e diário).
  await db.collection('controles_dias').doc('2026-07-02').set({ exames: { pelve: { vx: 3 } } });
  dadosLocais.exames['2026-07-02'] = { pelve: { vx: 3 } };
  const rel2 = await api.tomoAuditar(db, dadosLocais);
  check('19e. dia sem divergência não é sinalizado', rel2.dias['2026-07-02'].divergente === false);

  const texto = api.tomoFormatarRelatorioAuditoria(rel);
  check('19f. relatório formatado é uma string legível e sinaliza a divergência', typeof texto === 'string' && texto.includes('DIVERGENTE'));
}

module.exports = { run };
