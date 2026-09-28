// Cenários 6-10, 16-18: sem sucesso falso em falha de escrita, documento
// diário autoritativo, fallback mensal legado, dual-write legado, mês novo
// descoberto sem depender de metadata, merge local/remoto seguro (proteção
// contra o incidente de R$2000), dia local desatualizado vs. remoto, e
// metadata principal faltante.
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  // 6. Falha de escrita não pode aparecer como sucesso.
  {
    const { api } = loadApp();
    const db = makeFirestoreMock({ failPaths: ['controles/examesTomografia_2026-04'] });
    const r = await api.tomoExecutarEscritasFirestore(
      db, ['2026-04'],
      () => ({ exames: { '2026-04-01': { torax: { hbj: 1 } } }, tempos: {}, pagamentos: {} }),
      () => ({ ultimaAtualizacao: 'x', mesesDisponiveis: ['2026-04'], totalDias: 1 })
    );
    check('6. mês que falha nunca reporta cloudOk=true (sem sucesso falso)', !r.cloudOk && r.failedMonths.includes('2026-04'));
  }

  // 7 / 17. Documento diário autoritativo: um dia com controles_dias/{dia}
  // substitui o valor LOCAL desatualizado daquele dia ao carregar (mesmo
  // que o dia já existisse localmente antes de outro PC atualizar a nuvem).
  {
    const { api } = loadApp();
    const db = makeFirestoreMock();
    api.setDb(db);
    await db.collection('controles').doc('examesTomografia').set({ ultimaAtualizacao: 'x', mesesDisponiveis: [], totalDias: 0 });
    await db.collection('controles_dias').doc('2026-05-10').set({ data: '2026-05-10', exames: { torax: { hbj: 5 } } });
    await api.idbLocalStorage.setItemAsync('examesTomografia', JSON.stringify({
      exames: { '2026-05-10': { torax: { hbj: 1 } } }, tempos: {}, pagamentos: {}
    }));
    await api.carregarDados();
    const dia = api.getDadosApp().exames['2026-05-10'];
    check('7/17. documento diário autoritativo prevalece sobre valor local desatualizado', dia && dia.torax && dia.torax.hbj === 5, JSON.stringify(dia));
  }

  // 8. Fallback legado: dia SEM controles_dias, mas presente no mensal
  // antigo — ainda aparece (merge-if-missing).
  {
    const { api } = loadApp();
    const db = makeFirestoreMock();
    api.setDb(db);
    await db.collection('controles').doc('examesTomografia').set({ ultimaAtualizacao: 'x', mesesDisponiveis: ['2026-06'], totalDias: 1 });
    await db.collection('controles').doc('examesTomografia_2026-06').set({ exames: { '2026-06-15': { pelve: { vx: 2 } } }, tempos: {}, pagamentos: {} });
    await api.carregarDados();
    const dia = api.getDadosApp().exames['2026-06-15'];
    check('8. fallback legado: dia sem doc diário ainda aparece via mensal antigo', dia && dia.pelve && dia.pelve.vx === 2, JSON.stringify(dia));
  }

  // 9. Dual-write legado: uma operação nova (contador atômico) TAMBÉM
  // resulta em escrita no documento mensal legado (compatibilidade).
  {
    const { api } = loadApp();
    const db = makeFirestoreMock();
    api.setDb(db);
    api.getDadosApp().exames = {};
    api.getDadosApp().tempos = {};
    // dataExameInput não existe no DOM fake com valor de data; simula direto via alterarContador,
    // que lê dataExameInput.value — usamos a data padrão definida na carga do script (hoje).
    await api.alterarContador('torax', 'hbj', 1);
    await api.tomoProcessarFila();
    const hoje = Object.keys(api.getDadosApp().exames)[0];
    const diaNovo = await db.collection('controles_dias').doc(hoje).get();
    const mesLegado = await db.collection('controles').doc(`examesTomografia_${hoje.substring(0,7)}`).get();
    check('9. dual-write: contador novo grava em controles_dias', diaNovo.exists && diaNovo.data().exames.torax.hbj === 1);
    check('9b. dual-write: legado mensal também recebe a escrita (compatibilidade)', mesLegado.exists && mesLegado.data().exames[hoje].torax.hbj === 1);
  }

  // 10. Mês novo descoberto mesmo sem metadata legado apontar para ele.
  {
    const { api } = loadApp();
    const db = makeFirestoreMock();
    api.setDb(db);
    await db.collection('controles').doc('examesTomografia').set({ ultimaAtualizacao: 'x', mesesDisponiveis: [], totalDias: 0 });
    await db.collection('controles_dias').doc('2026-09-01').set({ data: '2026-09-01', exames: { cranio: { hbj: 3 } } });
    await api.carregarDados();
    const dia = api.getDadosApp().exames['2026-09-01'];
    check('10. mês novo (2026-09) aparece via controles_dias mesmo fora da metadata legada', dia && dia.cranio && dia.cranio.hbj === 3);
  }

  // 16. Merge local/remoto seguro (proteção contra o incidente de R$2000):
  // o merge do LEGADO nunca sobrescreve um dia que já existe localmente.
  {
    const { api } = loadApp();
    const db = makeFirestoreMock();
    api.setDb(db);
    await db.collection('controles').doc('examesTomografia').set({ ultimaAtualizacao: 'x', mesesDisponiveis: ['2026-07'], totalDias: 1 });
    await db.collection('controles').doc('examesTomografia_2026-07').set({ exames: { '2026-07-01': { torax: { hbj: 99 } } }, tempos: {}, pagamentos: {} });
    await api.idbLocalStorage.setItemAsync('examesTomografia', JSON.stringify({
      exames: { '2026-07-01': { torax: { hbj: 1 } } }, tempos: {}, pagamentos: {}
    }));
    await api.carregarDados();
    const dia = api.getDadosApp().exames['2026-07-01'];
    check('16. merge legado nunca sobrescreve dia que já existe localmente', dia.torax.hbj === 1, JSON.stringify(dia));
  }

  // 18. Metadata principal faltante: mesmo sem controles/examesTomografia
  // existir, os documentos diários ainda são descobertos.
  {
    const { api } = loadApp();
    const db = makeFirestoreMock();
    api.setDb(db);
    await db.collection('controles_dias').doc('2026-08-20').set({ data: '2026-08-20', exames: { lombar: { hbj: 7 } } });
    await api.carregarDados();
    const dia = api.getDadosApp().exames['2026-08-20'];
    check('18. metadata principal faltante não bloqueia descoberta via controles_dias', dia && dia.lombar && dia.lombar.hbj === 7, JSON.stringify(dia));
  }
}

module.exports = { run };
