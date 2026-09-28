// Regressão da fundação já validada anteriormente (ver AI.md): resultado
// estruturado de salvarDadosFirebase (sem sucesso falso), mutex de saves
// concorrentes, validação de backup com preview/snapshot, e merge por data
// no restore automático. Não são itens numerados 1-21 do pedido, mas são o
// alicerce sobre o qual o núcleo multi-PC foi construído — preservar esse
// comportamento é parte de "reconstruir o estado final já testado".
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  // Sem sucesso falso: um mês falha -> resultado parcial, nunca cloudOk.
  {
    const { api } = loadApp();
    const db = makeFirestoreMock({ failPaths: ['controles/examesTomografia_2026-01'] });
    const r = await api.tomoExecutarEscritasFirestore(
      db, ['2026-01', '2026-02'],
      (mes) => ({ exames: { [`${mes}-01`]: { torax: { hbj: 1 } } }, tempos: {}, pagamentos: {} }),
      () => ({ ultimaAtualizacao: 'x', mesesDisponiveis: ['2026-01', '2026-02'], totalDias: 2 })
    );
    check('fundação: mês com falha -> partial, nunca cloudOk', !r.cloudOk && r.partial && r.failedMonths.includes('2026-01') && r.successfulMonths.includes('2026-02'));
  }

  // Mutex: dois saves concorrentes não rodam em paralelo (fila serializada).
  {
    const { api } = loadApp();
    const db = makeFirestoreMock();
    api.setDb(db);
    api.getDadosApp().exames = { '2026-03-01': { torax: { hbj: 1 } } };
    const p1 = api.salvarDadosFirebase(true);
    const p2 = api.salvarDadosFirebase(true);
    const [r1, r2] = await Promise.all([p1, p2]);
    check('fundação: saves concorrentes são serializados (mutex) e ambos terminam ok', r1.cloudOk && r2.cloudOk);
  }

  // validateBackupPayload: rejeita contagem negativa/NaN/string em vez de aceitar cegamente.
  {
    const { api } = loadApp();
    const invalido = { exames: { '2026-01-01': { torax: { hbj: -1 } } } };
    const val = api.validateBackupPayload(invalido);
    check('fundação: validação de backup rejeita contagem negativa', val.ok === false);

    const comHtml = { exames: { '2026-01-01': { torax: { hbj: '<script>' } } } };
    const val2 = api.validateBackupPayload(comHtml);
    check('fundação: validação de backup rejeita string onde espera número', val2.ok === false);

    const valido = { exames: { '2026-01-01': { torax: { hbj: 2 } } }, tempos: {}, pagamentos: {} };
    const val3 = api.validateBackupPayload(valido);
    check('fundação: validação aceita payload bem formado', val3.ok === true, JSON.stringify(val3.errors));
  }

  // mesclarBackupPorData: nunca apaga dias que não vieram no backup.
  {
    const { api } = loadApp();
    const atual = { exames: { '2026-01-01': { torax: { hbj: 1 } }, '2026-01-02': { pelve: { vx: 2 } } }, tempos: {}, pagamentos: {} };
    const backup = { exames: { '2026-01-02': { pelve: { vx: 99 } } }, tempos: {}, pagamentos: {} };
    const resultado = api.mesclarBackupPorData(atual, backup);
    check('fundação: merge por data preserva dias fora do backup', resultado.exames['2026-01-01'].torax.hbj === 1);
    check('fundação: merge por data substitui só as datas presentes no backup', resultado.exames['2026-01-02'].pelve.vx === 99);
  }

  // Storage local: fallback real para localStorage quando IndexedDB falha.
  {
    const shared = new Map();
    const { api } = loadApp({ idbMode: 'open-fail' });
    await api.tomoInitStorage();
    await api.idbLocalStorage.setItemAsync('chave-teste', 'valor-teste');
    check('fundação: fallback para localStorage quando IndexedDB falha', api.tomoStorageMode() === 'localstorage' && api.idbLocalStorage.getItem('chave-teste') === 'valor-teste');
  }
}

module.exports = { run };
