// Cenários 11-12: migração dry-run (não grava nada) e migração idempotente
// (reexecutar não duplica nem sobrescreve dias já migrados/alterados).
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function seedLegado(db){
  await db.collection('controles').doc('examesTomografia').set({
    ultimaAtualizacao: 'x', mesesDisponiveis: ['2026-01'], totalDias: 2
  });
  await db.collection('controles').doc('examesTomografia_2026-01').set({
    exames: {
      '2026-01-01': { torax: { hbj: 2 } },
      '2026-01-02': {}, // dia vazio no legado — deve ser ignorado
    },
    tempos: {}, pagamentos: {}
  });
}

async function run(check){
  const { api } = loadApp();

  // 11. Dry-run não grava nada em controles_dias.
  {
    const db = makeFirestoreMock();
    await seedLegado(db);
    const rel = await api.tomoMigrarLegado(db, { dryRun: true });
    const diaSnap = await db.collection('controles_dias').doc('2026-01-01').get();
    check('11a. dry-run reporta o dia que seria criado', rel.criados.includes('2026-01-01'));
    check('11b. dry-run reporta dia vazio como ignorado', rel.ignoradosVazios.includes('2026-01-02'));
    check('11c. dry-run NÃO grava nada em controles_dias', diaSnap.exists === false);
  }

  // 12. Migração idempotente: executar de verdade cria o dia; reexecutar
  // não sobrescreve (relatado como "já existia").
  {
    const db = makeFirestoreMock();
    await seedLegado(db);
    const rel1 = await api.tomoMigrarLegado(db, { dryRun: false });
    const diaSnap1 = await db.collection('controles_dias').doc('2026-01-01').get();
    check('12a. execução real cria o documento diário a partir do legado', diaSnap1.exists && diaSnap1.data().exames.torax.hbj === 2);

    // Simula uma atualização real (atômica) que já aconteceu depois da
    // primeira migração — reexecutar a migração NÃO pode pisar nisso.
    await api.tomoAplicarIncrementoAtomico(db, 'op-pos-migracao', '2026-01-01', 'torax', 'hbj', 1);

    const rel2 = await api.tomoMigrarLegado(db, { dryRun: false });
    const diaSnap2 = await db.collection('controles_dias').doc('2026-01-01').get();
    check('12b. reexecução idempotente: dia já existente é ignorado, não sobrescrito', rel2.ignoradosExistentes.includes('2026-01-01') && diaSnap2.data().exames.torax.hbj === 3, JSON.stringify(diaSnap2.data()));
    check('12c. reexecução não relista o dia como "criado"', !rel2.criados.includes('2026-01-01'));
  }

  // Relatório formatado não deve lançar exceção e deve mencionar dry-run.
  {
    const db = makeFirestoreMock();
    await seedLegado(db);
    const rel = await api.tomoMigrarLegado(db, { dryRun: true });
    const texto = api.tomoFormatarRelatorioMigracao(rel);
    check('12d. relatório de migração é uma string legível com o modo dry-run', typeof texto === 'string' && texto.includes('sim'));
  }
}

module.exports = { run };
