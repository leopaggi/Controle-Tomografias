// Cenário 20: correção do loader de controles_dias — o Firestore real grava
// os campos escritos por tomoAplicarIncrementoAtomico como propriedades de
// TOPO em dot-notation ("exames.segmento.servico"), não como um mapa
// aninhado "exames". O loader antigo (doc.data().exames) lia `undefined`
// nesse formato e zerava o dia inteiro. Cobre tomoExtrairExamesDocDiario
// (reconstrução flat->aninhado) e tomoAplicarDocsDiarios (merge por
// segmento/serviço, nunca substituição do dia inteiro).
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  const { api } = loadApp();

  // TESTE A — formato flat real do Firestore.
  {
    const docData = {
      'exames.cranio.sagrada-familia': 6,
      'exames.torax.sagrada-familia': 11,
      data: '2026-09-27',
      ultimaAtualizacao: 'x'
    };
    const out = api.tomoExtrairExamesDocDiario(docData);
    check('20a. flat real: reconstrói segmento/serviço a partir de chaves "exames.seg.serv"',
      out.cranio && out.cranio['sagrada-familia'] === 6 && out.torax && out.torax['sagrada-familia'] === 11,
      JSON.stringify(out));
  }

  // TESTE B — formato aninhado (docData.exames já é um mapa).
  {
    const docData = { exames: { cranio: { clinimage: 2 } }, data: '2026-09-28' };
    const out = api.tomoExtrairExamesDocDiario(docData);
    check('20b. formato aninhado: docData.exames continua funcionando',
      out.cranio && out.cranio.clinimage === 2, JSON.stringify(out));
  }

  // TESTE C — merge parcial: doc diário só tem 1 segmento; o outro segmento
  // (só local) e o outro serviço do mesmo segmento (só local) são preservados.
  {
    const local = { '2026-01-01': { cranio: { clinimage: 5 }, torax: { clinimage: 2 } } };
    const diasDocs = { '2026-01-01': { cranio: { 'sagrada-familia': 3 } } };
    const out = api.tomoAplicarDocsDiarios(local, diasDocs);
    const dia = out['2026-01-01'];
    check('20c. merge parcial: valor diário entra sem apagar o que só existe localmente',
      dia.cranio.clinimage === 5 && dia.cranio['sagrada-familia'] === 3 && dia.torax.clinimage === 2,
      JSON.stringify(dia));
  }

  // TESTE D — doc diário vazio não pode zerar um dia local existente.
  {
    const local = { '2026-01-02': { torax: { hbj: 4 } } };
    const diasDocs = { '2026-01-02': {} }; // doc existe mas tomoExtrairExamesDocDiario não achou nada nele
    const out = api.tomoAplicarDocsDiarios(local, diasDocs);
    check('20d. doc diário vazio não zera dia local existente',
      out['2026-01-02'].torax.hbj === 4, JSON.stringify(out['2026-01-02']));
  }

  // TESTE E — reproduz especificamente 27/09 e 28/09 com o formato REAL
  // observado em produção, através do fluxo completo de carregarDados().
  {
    const db = makeFirestoreMock();
    api.setDb(db);
    api.getDadosApp().exames = {};
    // Simula a estrutura FLAT real (o que o Firestore de produção realmente
    // tem): .set() SEM {merge:true} grava o objeto literalmente como dado
    // (o mock só re-aninha chaves em dot-notation quando merge:true é
    // passado), então os nomes de campo com ponto ficam como estão — igual
    // ao doc real observado em produção.
    await db.collection('controles_dias').doc('2026-09-27').set({
      data: '2026-09-27',
      'exames.cranio.sagrada-familia': 6,
      'exames.pelve.sagrada-familia': 7,
      'exames.abd-superior.sagrada-familia': 7,
      'exames.torax.sagrada-familia': 11
    });
    await db.collection('controles_dias').doc('2026-09-28').set({
      data: '2026-09-28',
      'exames.abd-superior.sagrada-familia': 1,
      'exames.abd-superior.clinimage': 1,
      'exames.torax.sagrada-familia': 1,
      'exames.torax.clinimage': 3,
      'exames.cranio.sagrada-familia': 3,
      'exames.cranio.clinimage': 4,
      'exames.abdomen-total.clinimage': 3,
      'exames.articulacao.clinimage': 1,
      'exames.articulacao.sagrada-familia': 1,
      'exames.lombar.clinimage': 2,
      'exames.bacia.clinimage': 1
    });
    await api.carregarDados();
    const dia27 = api.getDadosApp().exames['2026-09-27'];
    const dia28 = api.getDadosApp().exames['2026-09-28'];
    check('20e. reprodução real 27/09: dia não fica {} e traz os valores corretos',
      dia27 && dia27.cranio && dia27.cranio['sagrada-familia'] === 6
        && dia27.pelve && dia27.pelve['sagrada-familia'] === 7
        && dia27.torax && dia27.torax['sagrada-familia'] === 11,
      JSON.stringify(dia27));
    check('20e. reprodução real 28/09: dia não fica {} e traz os valores corretos',
      dia28 && dia28.cranio && dia28.cranio.clinimage === 4
        && dia28.lombar && dia28.lombar.clinimage === 2
        && dia28.bacia && dia28.bacia.clinimage === 1,
      JSON.stringify(dia28));
  }
}

module.exports = { run };
