// Prova de integridade para a troca de marcarTudoSujo() por
// marcarMesSujo(mesAno) em togglePagamentoUnificado: a cópia legada de
// `pagamentos` dentro de cada doc mensal (controles/examesTomografia_{mes})
// NUNCA é fonte autoritativa. A fonte real é controles_pagamentos/{mes},
// escrita por tomoAplicarPagamento a cada toggle, independente de quais
// meses estão "sujos". Este teste prova que deixar 11 de 12 docs mensais
// com uma cópia antiga de `pagamentos` não ressuscita estado antigo em
// nenhum caminho: reload, novo dispositivo, reconciliação ou abertura de
// mês antigo.
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

const MESES = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const MES_ATUAL = '2026-12';

// Semeia 12 meses, todos com o MESMO estado antigo de pagamentos
// (hbj: false), tanto localmente quanto nos docs mensais legados E na
// coleção autoritativa — representa um histórico já sincronizado antes do
// clique que o teste vai disparar.
async function semearEstadoAntigo(db) {
  const pagamentosAntigos = {};
  MESES.forEach(m => { pagamentosAntigos[m] = { hbj: false }; });
  for (const mes of MESES) {
    await db.collection('controles').doc(`examesTomografia_${mes}`).set({
      exames: { [`${mes}-05`]: { cranio: { hbj: 1 } } },
      tempos: {},
      pagamentos: pagamentosAntigos, // snapshot legado do histórico TODO, igual em todos os docs
    });
    await db.collection('controles_pagamentos').doc(mes).set({ hbj: false, ultimaAtualizacao: new Date().toISOString() });
  }
  await db.collection('controles').doc('examesTomografia').set({ ultimaAtualizacao: new Date().toISOString(), mesesDisponiveis: MESES, totalDias: MESES.length });
  return pagamentosAntigos;
}

function montarAppComEstadoAntigo(sharedIdb, pagamentosAntigos) {
  const { api, doc } = loadApp(sharedIdb ? { sharedIdb } : {});
  const dadosApp = api.getDadosApp();
  MESES.forEach(m => { dadosApp.exames[`${m}-05`] = { cranio: { hbj: 1 } }; });
  dadosApp.pagamentos = JSON.parse(JSON.stringify(pagamentosAntigos));
  api.setDadosApp(dadosApp);
  return { api, doc };
}

async function run(check) {
  // FASE B — 12 meses, estado antigo idêntico em todos; usuário altera
  // pagamento SÓ do mês atual; só esse mês + principal são reescritos.
  const db = makeFirestoreMock();
  const pagamentosAntigos = await semearEstadoAntigo(db);

  const writesPorPath = new Map();
  const origCollection = db.collection.bind(db);
  db.collection = (name) => {
    const coll = origCollection(name);
    const origDoc = coll.doc.bind(coll);
    coll.doc = (id) => {
      const ref = origDoc(id);
      const origSet = ref.set.bind(ref);
      ref.set = async (...a) => { writesPorPath.set(`${name}/${id}`, (writesPorPath.get(`${name}/${id}`) || 0) + 1); return origSet(...a); };
      return ref;
    };
    return coll;
  };

  const { api } = montarAppComEstadoAntigo(null, pagamentosAntigos);
  await api.tomoEnsureStorage();
  api.setDb(db);
  await api.togglePagamentoUnificado('hbj', MES_ATUAL);

  check('B1. doc mensal do mês atual foi reescrito', writesPorPath.get(`controles/examesTomografia_${MES_ATUAL}`) === 1, JSON.stringify([...writesPorPath.entries()]));
  check('B2. documento principal foi reescrito', writesPorPath.get('controles/examesTomografia') === 1);
  check('B3. controles_pagamentos do mês atual foi atualizado (autoritativo)', (await db.collection('controles_pagamentos').doc(MES_ATUAL).get()).data().hbj === true);
  const outrosMeses = MESES.filter(m => m !== MES_ATUAL);
  const nenhumOutroMesReescrito = outrosMeses.every(m => !writesPorPath.has(`controles/examesTomografia_${m}`));
  check('B4. os outros 11 meses NÃO foram reescritos (ganho de desempenho real)', nenhumOutroMesReescrito, JSON.stringify([...writesPorPath.keys()]));
  // Confirma que os 11 docs mensais ANTIGOS continuam com a cópia velha de
  // pagamentos — isso é esperado e inofensivo, não um bug.
  const doc2026_05 = await db.collection('controles').doc('examesTomografia_2026-05').get();
  check('B5. doc mensal intocado mantém cópia antiga de pagamentos (esperado)', doc2026_05.data().pagamentos[MES_ATUAL].hbj === false);

  // Reload no MESMO dispositivo: estado local já tinha o valor novo (writer
  // local imediato), continua correto.
  await api.carregarDados();
  check('B6. reload no mesmo dispositivo mantém o valor novo', api.getDadosApp().pagamentos[MES_ATUAL].hbj === true);
  check('B7. reload não resgatou o valor antigo para os outros meses (continuam false, como deveriam)', outrosMeses.every(m => api.getDadosApp().pagamentos[m].hbj === false));

  // FASE B (continuação) — "novo dispositivo": nunca abriu o app, local
  // vazio, só a nuvem (docs mensais antigos + controles_pagamentos
  // autoritativo atualizado) para reconciliar.
  const dispositivoNovo = loadApp();
  dispositivoNovo.api.setDb(db);
  await dispositivoNovo.api.carregarDados();
  check('C1. novo dispositivo enxerga o valor NOVO no mês atual (autoritativo prevalece sobre legado antigo)', dispositivoNovo.api.getDadosApp().pagamentos[MES_ATUAL].hbj === true);
  check('C2. novo dispositivo enxerga o valor antigo correto nos demais meses (nada foi alterado neles)', outrosMeses.every(m => dispositivoNovo.api.getDadosApp().pagamentos[m].hbj === false));

  // "Abrir mês antigo" no novo dispositivo: puramente leitura de
  // dadosApp.pagamentos já reconciliado, sem round-trip extra, sem resgatar
  // nada do doc legado daquele mês.
  dispositivoNovo.doc.getElementById('mes-relatorio').value = '2026-03';
  check('C3. abrir relatório de mês antigo não lê o doc legado de novo (puramente em memória)', dispositivoNovo.api.getDadosApp().pagamentos['2026-03'].hbj === false);

  // FASE C — multidispositivo: PC A marca e sincroniza; PC B, com cache
  // local E docs mensais antigos, reconcilia e o valor novo prevalece. O
  // caminho inverso também é checado: PC B abrir um relatório antigo não
  // empurra uma cópia antiga de volta para a nuvem.
  const dbShared = makeFirestoreMock();
  const pagAntigosC = await semearEstadoAntigo(dbShared);
  const pcA = montarAppComEstadoAntigo(null, pagAntigosC);
  await pcA.api.tomoEnsureStorage();
  pcA.api.setDb(dbShared);
  await pcA.api.togglePagamentoUnificado('hbj', MES_ATUAL);

  // PC B tem cache local e docs mensais JÁ desatualizados (estado antigo,
  // como se tivesse sincronizado antes do clique do PC A).
  const pcB = montarAppComEstadoAntigo(null, pagAntigosC);
  await pcB.api.tomoEnsureStorage();
  pcB.api.setDb(dbShared);
  await pcB.api.carregarDados(); // reconcile normal ao abrir o app
  check('C4. PC B reconcilia e vê o valor novo do PC A (não ressuscita o antigo do seu próprio cache)', pcB.api.getDadosApp().pagamentos[MES_ATUAL].hbj === true);

  // Caminho inverso: PC B abre um relatório de mês ANTIGO (não altera nada)
  // — isso não deve gerar nenhuma escrita na nuvem (nem no doc mensal, nem
  // em controles_pagamentos), logo não pode empurrar uma cópia antiga de
  // volta.
  const writesDepoisDoOpen = new Map();
  const origCollectionB = dbShared.collection.bind(dbShared);
  dbShared.collection = (name) => {
    const coll = origCollectionB(name);
    const origDoc = coll.doc.bind(coll);
    coll.doc = (id) => {
      const ref = origDoc(id);
      const origSet = ref.set.bind(ref);
      ref.set = async (...a) => { writesDepoisDoOpen.set(`${name}/${id}`, true); return origSet(...a); };
      return ref;
    };
    return coll;
  };
  pcB.doc.getElementById('mes-relatorio').value = '2026-02';
  check('C5. PC B abrindo um mês antigo não dispara NENHUMA escrita remota', writesDepoisDoOpen.size === 0, JSON.stringify([...writesDepoisDoOpen.keys()]));
  const pagamentoMesAtualNaNuvem = await dbShared.collection('controles_pagamentos').doc(MES_ATUAL).get();
  check('C6. valor autoritativo do mês atual continua o novo após toda a reconciliação de PC B', pagamentoMesAtualNaNuvem.data().hbj === true);

  // FASE D — caso adversarial: o mês alterado NÃO é o último da lista
  // mesesDisponiveis. O merge legado (Object.assign por mês, carregarDados)
  // é last-write-wins na ORDEM DE ITERAÇÃO dos docs mensais — se o doc do
  // mês alterado for processado ANTES de docs mensais ainda com a cópia
  // antiga, o valor do merge legado fica temporariamente errado. Isso é
  // PRÉ-EXISTENTE (vive inteiramente na leitura de carregarDados(), que
  // marcarMesSujo não toca) — o teste prova se o pull autoritativo
  // (controles_pagamentos, bloco separado e incondicional) corrige isso.
  const MES_DO_MEIO = '2026-06';
  {
    const dbMeio = makeFirestoreMock();
    const pagAntigosMeio = await semearEstadoAntigo(dbMeio);
    const pcOrigem = montarAppComEstadoAntigo(null, pagAntigosMeio);
    await pcOrigem.api.tomoEnsureStorage();
    pcOrigem.api.setDb(dbMeio);
    await pcOrigem.api.togglePagamentoUnificado('hbj', MES_DO_MEIO);
    // Confirma a premissa: o doc do mês alterado é processado ANTES de
    // meses posteriores ainda com a cópia antiga (ordem natural 01..12).
    const docMeio = await dbMeio.collection('controles').doc(`examesTomografia_${MES_DO_MEIO}`).get();
    check('D1. premissa: doc do mês alterado tem o valor novo isoladamente', docMeio.data().pagamentos[MES_DO_MEIO].hbj === true);
    const docPosterior = await dbMeio.collection('controles').doc('examesTomografia_2026-07').get();
    check('D2. premissa: doc de um mês POSTERIOR ainda carrega a cópia antiga (não foi tocado)', docPosterior.data().pagamentos[MES_DO_MEIO].hbj === false);

    // Novo dispositivo, pull autoritativo funcionando normalmente: deve
    // prevalecer o valor novo mesmo com o merge legado processando o doc
    // correto ANTES de docs posteriores desatualizados.
    const novoDispMeio = loadApp();
    novoDispMeio.api.setDb(dbMeio);
    await novoDispMeio.api.carregarDados();
    check('D3. com pull autoritativo OK, novo dispositivo vê o valor novo mesmo no caso adversarial', novoDispMeio.api.getDadosApp().pagamentos[MES_DO_MEIO].hbj === true);

    // Caso extremo (antes, um achado pré-existente): se a leitura de
    // controles_pagamentos falhar por completo nesse carregamento, o
    // fallback legado — agora corrigido para ser determinístico por mês —
    // continua resolvendo corretamente, mesmo sem o corretivo autoritativo.
    // Cobertura completa desta correção em
    // test-pagamento-merge-legado-deterministico.js.
    const dbFalhaPull = makeFirestoreMock();
    await semearEstadoAntigo(dbFalhaPull);
    const pcOrigem2 = montarAppComEstadoAntigo(null, pagAntigosMeio);
    await pcOrigem2.api.tomoEnsureStorage();
    pcOrigem2.api.setDb(dbFalhaPull);
    await pcOrigem2.api.togglePagamentoUnificado('hbj', MES_DO_MEIO);
    const origCollection = dbFalhaPull.collection.bind(dbFalhaPull);
    dbFalhaPull.collection = (name) => {
      if (name === 'controles_pagamentos') throw new Error('falha de rede simulada: controles_pagamentos indisponível');
      return origCollection(name);
    };
    const novoDispFalha = loadApp();
    novoDispFalha.api.setDb(dbFalhaPull);
    await novoDispFalha.api.carregarDados();
    check(
      'D4. [gap fechado] sem o pull autoritativo, o fallback legado determinístico já resolve o valor correto',
      novoDispFalha.api.getDadosApp().pagamentos[MES_DO_MEIO].hbj === true
    );
  }

  // FASE E — o novo listener de visibilitychange chama tomoProcessarFila()
  // sem await, podendo coincidir com o próprio clique (que também chama
  // tomoProcessarFila()) ou com o intervalo de 20s. Prova de que isso é
  // seguro: duas chamadas concorrentes se juntam à MESMA execução (mutex
  // _tomoProcessandoFilaPromise), nunca processam a fila duas vezes em
  // paralelo.
  {
    const dbConc = makeFirestoreMock();
    const h = loadApp();
    let txEmCurso = 0, txMaxSimultaneas = 0;
    const origTx = dbConc.runTransaction.bind(dbConc);
    dbConc.runTransaction = async (fn) => {
      txEmCurso++; txMaxSimultaneas = Math.max(txMaxSimultaneas, txEmCurso);
      await new Promise(r => setTimeout(r, 30));
      try { return await origTx(fn); } finally { txEmCurso--; }
    };
    h.api.setDb(dbConc);
    await h.api.tomoEnfileirar({ operationId: 'op-concorrencia-1', tipo: 'pagamento', mesAno: '2026-09', servicoId: 'hbj', pago: true });

    // Simula o clique chamando tomoProcessarFila() e, "ao mesmo tempo", o
    // listener de visibilitychange chamando de novo, sem esperar o primeiro.
    const p1 = h.api.tomoProcessarFila();
    const p2 = h.api.tomoProcessarFila();
    await Promise.all([p1, p2]);
    check('E1. duas chamadas concorrentes a tomoProcessarFila nunca processam a fila em paralelo (mutex existente)', txMaxSimultaneas === 1, `máximo simultâneo observado: ${txMaxSimultaneas}`);
    check('E2. a operação foi aplicada exatamente uma vez (sem duplicar)', h.api.tomoStatusFila().total === 0);
    const docFinal = await dbConc.collection('controles_pagamentos').doc('2026-09').get();
    check('E3. valor final correto após as duas chamadas concorrentes', docFinal.data().hbj === true);
  }
}

module.exports = { run };
