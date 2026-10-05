// Corrige e prova determinismo do fallback legado de `pagamentos` em
// carregarDados(). Cada doc controles/examesTomografia_{mes} carrega uma
// cópia GLOBAL de dadosApp.pagamentos (todos os meses, não só o seu), como
// efeito colateral de montarDadosMes() em _salvarDadosFirebaseExec. O merge
// antigo fazia Object.assign(dadosNuvem.pagamentos, dadosMes.pagamentos) —
// ou seja, misturava a cópia global de QUALQUER doc processado, e o último
// doc da iteração "ganhava" para TODAS as chaves, não só a sua própria.
// Isso tornava o fallback dependente da ordem de `mesesDisponiveis`.
//
// Correção: cada doc só é fonte do seu PRÓPRIO mês
// (dadosNuvem.pagamentos[mes] = dadosMes.pagamentos[mes]), nunca das demais
// chaves que ele arrasta por carregar a cópia global. Resultado:
// determinístico, independente de ordem, e a verdade de cada mês vem do
// doc que mais recentemente teve ESSE mês tocado (exame ou pagamento) —
// nunca de um doc não relacionado que por acaso foi processado depois.
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

const MESES = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);

// Semeia 12 docs mensais com cópias GLOBAIS divergentes/contraditórias de
// pagamentos: a chave "verdadeira" de cada doc (a do seu próprio mês) é
// `verdade[mes]`; todas as OUTRAS chaves dentro do seu snapshot global
// recebem lixo propositalmente contraditório (o oposto da verdade), só
// para provar que esse lixo nunca é usado para resolver outro mês.
async function semearDocsDivergentes(db, verdade, ordemEscrita) {
  for (const mes of ordemEscrita) {
    const snapshotGlobalContaminado = {};
    MESES.forEach(m => { snapshotGlobalContaminado[m] = { hbj: m === mes ? verdade[mes] : !verdade[m] }; });
    await db.collection('controles').doc(`examesTomografia_${mes}`).set({
      exames: { [`${mes}-05`]: { cranio: { hbj: 1 } } },
      tempos: {},
      pagamentos: snapshotGlobalContaminado,
    });
  }
}
async function escreverPrincipal(db, ordemListada) {
  await db.collection('controles').doc('examesTomografia').set({ ultimaAtualizacao: new Date().toISOString(), mesesDisponiveis: ordemListada, totalDias: MESES.length });
}
function embaralhar(arr, seed) {
  const a = arr.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function run(check) {
  const VERDADE = {}; MESES.forEach((m, i) => { VERDADE[m] = i % 2 === 0; }); // alterna true/false, cobre os dois valores

  // 1-2-7. 12 docs com cópias divergentes/contaminadas, ordem embaralhada
  // de duas formas diferentes: o resultado do fallback tem que ser
  // IDÊNTICO nos dois casos (determinístico, independente de ordem).
  const ordemA = embaralhar(MESES, 7);
  const ordemB = embaralhar(MESES, 42);
  check('1. premissa: as duas ordens embaralhadas são de fato diferentes', JSON.stringify(ordemA) !== JSON.stringify(ordemB));

  const dbA = makeFirestoreMock();
  await semearDocsDivergentes(dbA, VERDADE, ordemA);
  await escreverPrincipal(dbA, ordemA);
  const hA = loadApp(); hA.api.setDb(dbA);
  await hA.api.carregarDados();

  const dbB = makeFirestoreMock();
  await semearDocsDivergentes(dbB, VERDADE, ordemB);
  await escreverPrincipal(dbB, ordemB);
  const hB = loadApp(); hB.api.setDb(dbB);
  await hB.api.carregarDados();

  check('7a. fallback legado dá o mesmo resultado independente da ordem dos docs (dispositivo A)',
    MESES.every(m => hA.api.getDadosApp().pagamentos[m].hbj === VERDADE[m]), JSON.stringify(hA.api.getDadosApp().pagamentos));
  check('7b. fallback legado dá o mesmo resultado independente da ordem dos docs (dispositivo B)',
    MESES.every(m => hB.api.getDadosApp().pagamentos[m].hbj === VERDADE[m]), JSON.stringify(hB.api.getDadosApp().pagamentos));
  const normalizar = (pag) => JSON.stringify(Object.keys(pag).sort().map(m => [m, pag[m].hbj]));
  check('7c. os dois dispositivos (ordens diferentes) convergem EXATAMENTE para o mesmo estado',
    normalizar(hA.api.getDadosApp().pagamentos) === normalizar(hB.api.getDadosApp().pagamentos),
    normalizar(hA.api.getDadosApp().pagamentos) + ' vs ' + normalizar(hB.api.getDadosApp().pagamentos));
  check('2. nenhum doc "contaminado" (lixo contraditório nas demais chaves) corrompeu outro mês',
    MESES.every(m => hA.api.getDadosApp().pagamentos[m].hbj === VERDADE[m]));

  // 5. Dispositivo novo sem cache algum (já é o caso de hA/hB acima — local
  // vazio, só a nuvem). Confirmado pelos checks 7a/7b.
  check('5. dispositivo novo sem cache resolve todos os 12 meses corretamente só com o fallback', MESES.every(m => hA.api.getDadosApp().pagamentos[m].hbj === VERDADE[m]));

  // 6. Dispositivo com cache PARCIAL: já tem localmente alguns meses (com
  // um valor PRÓPRIO, que pode até ser diferente do que a nuvem diria) —
  // o fallback não pode sobrescrever o que já existe local (gap-fill-only,
  // comportamento pré-existente e preservado).
  {
    const dbC = makeFirestoreMock();
    await semearDocsDivergentes(dbC, VERDADE, ordemA);
    await escreverPrincipal(dbC, ordemA);
    const hC = loadApp();
    await hC.api.tomoEnsureStorage();
    const dadosApp = hC.api.getDadosApp();
    dadosApp.pagamentos['2026-01'] = { hbj: 'valor-local-proprio' }; // valor local deliberadamente diferente de qualquer coisa na nuvem
    hC.api.setDadosApp(dadosApp);
    hC.api.setDb(dbC);
    await hC.api.carregarDados();
    check('6a. cache parcial preservado: mês já presente localmente NÃO é sobrescrito pelo fallback', hC.api.getDadosApp().pagamentos['2026-01'].hbj === 'valor-local-proprio');
    check('6b. meses ausentes do cache parcial continuam sendo preenchidos corretamente pelo fallback', MESES.slice(1).every(m => hC.api.getDadosApp().pagamentos[m].hbj === VERDADE[m]));
  }

  // 3-8. Pull autoritativo funcionando: continua sobrescrevendo o
  // fallback, mesmo quando o fallback (agora corrigido) já estaria certo.
  {
    const dbD = makeFirestoreMock();
    await semearDocsDivergentes(dbD, VERDADE, ordemA); // fallback diria VERDADE['2026-03'] = true (índice 2, par)
    await escreverPrincipal(dbD, ordemA);
    await dbD.collection('controles_pagamentos').doc('2026-03').set({ hbj: false, ultimaAtualizacao: new Date().toISOString() }); // autoritativo diverge de propósito
    const hD = loadApp(); hD.api.setDb(dbD);
    await hD.api.carregarDados();
    check('8. pull autoritativo sobrescreve o fallback mesmo quando os dois divergem', hD.api.getDadosApp().pagamentos['2026-03'].hbj === false);
  }

  // 4. Pull de controles_pagamentos FALHANDO: o fallback (corrigido) sozinho
  // já resolve corretamente cada mês, sem precisar do corretivo autoritativo.
  {
    const dbE = makeFirestoreMock();
    await semearDocsDivergentes(dbE, VERDADE, ordemB);
    await escreverPrincipal(dbE, ordemB);
    const origCollection = dbE.collection.bind(dbE);
    dbE.collection = (name) => { if (name === 'controles_pagamentos') throw new Error('falha de rede simulada'); return origCollection(name); };
    const hE = loadApp(); hE.api.setDb(dbE);
    await hE.api.carregarDados();
    check('4. sem o pull autoritativo, o fallback corrigido AINDA resolve todos os meses corretamente (gap fechado)',
      MESES.every(m => hE.api.getDadosApp().pagamentos[m].hbj === VERDADE[m]), JSON.stringify(hE.api.getDadosApp().pagamentos));
  }

  // 9. Nenhuma leitura/merge de docs legados provoca escrita remota.
  {
    const dbF = makeFirestoreMock();
    await semearDocsDivergentes(dbF, VERDADE, ordemA);
    await escreverPrincipal(dbF, ordemA);
    const escritasRemotas = [];
    const origCollection = dbF.collection.bind(dbF);
    dbF.collection = (name) => {
      const coll = origCollection(name);
      const origDoc = coll.doc.bind(coll);
      coll.doc = (id) => {
        const ref = origDoc(id);
        const origSet = ref.set.bind(ref);
        ref.set = async (...a) => { escritasRemotas.push(`${name}/${id}`); return origSet(...a); };
        return ref;
      };
      return coll;
    };
    const hF = loadApp(); hF.api.setDb(dbF);
    await hF.api.carregarDados();
    check('9. carregarDados() não escreve em NENHUM doc legado nem em controles_pagamentos (puramente leitura)', escritasRemotas.length === 0, JSON.stringify(escritasRemotas));
  }

  // 10. Abrir relatório de um mês antigo continua sem alterar pagamentos
  // nem gerar qualquer escrita (já coberto em test-pagamento-consistencia-
  // multimes.js C3/C5; reconfirmado aqui com o novo merge).
  {
    const dbG = makeFirestoreMock();
    await semearDocsDivergentes(dbG, VERDADE, ordemA);
    await escreverPrincipal(dbG, ordemA);
    const hG = loadApp(); hG.api.setDb(dbG);
    await hG.api.carregarDados();
    const antes = JSON.stringify(hG.api.getDadosApp().pagamentos);
    hG.doc.getElementById('mes-relatorio').value = '2026-04';
    check('10. abrir relatório de mês antigo não altera pagamentos', JSON.stringify(hG.api.getDadosApp().pagamentos) === antes);
  }
}

module.exports = { run };
