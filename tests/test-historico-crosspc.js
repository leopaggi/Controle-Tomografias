// Cenários 15 e 20: histórico cross-PC via collectionGroup('laudos'), e a
// regressão do bug antigo de montarHistoricoVisual() que exibia
// `segmento: null` em registros manuais — o nome do segmento informado
// precisa ser sempre preservado.
'use strict';
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

async function run(check){
  const { api } = loadApp();

  // 15. collectionGroup/histórico cross-PC: eventos de laudo gravados em
  // dias diferentes são todos recuperados via collectionGroup('laudos'),
  // ordenados do mais recente para o mais antigo.
  {
    const db = makeFirestoreMock();
    await api.tomoGravarEventoLaudo(db, 'ev-1', '2026-06-01', { empresa: 'HBJ', segmentos: ['TORAX'], tempo: 10, timestamp: 1000, operationId: 'ev-1' });
    await api.tomoGravarEventoLaudo(db, 'ev-2', '2026-06-02', { empresa: 'VX', segmentos: ['PELVE'], tempo: 20, timestamp: 2000, operationId: 'ev-2' });
    const eventos = await api.tomoBuscarLaudosCrossPC(db, 10);
    check('15a. collectionGroup recupera eventos de todos os dias', eventos.length === 2);
    check('15b. eventos vêm ordenados do mais recente para o mais antigo', eventos[0].operationId === 'ev-2' && eventos[1].operationId === 'ev-1');
  }

  // 20. Regressão do bug do segmento nulo: um evento remoto de origem
  // "manual" que só carregava um campo `segmento` singular (formato antigo,
  // sem array `segmentos`) precisa aparecer com o nome do segmento, nunca
  // como null/vazio.
  {
    const eventoAntigoFormato = {
      operationId: 'manual-antigo-1', data: '2026-06-10', empresa: 'HBJ',
      segmento: 'TORAX', // formato antigo (bug): só campo singular, sem array
      tempo: 0, timestamp: 5000, tipo: 'manual', origem: 'outro-pc'
    };
    const combinado = api.montarHistoricoVisual([], [eventoAntigoFormato]);
    const item = combinado.find(x => x.id === 'manual-antigo-1');
    check('20a. evento com só `segmento` singular preserva o nome (nunca null)', !!item && Array.isArray(item.segmentos) && item.segmentos.length === 1 && item.segmentos[0] === 'TORAX', JSON.stringify(item));

    // Também não pode quebrar quando NEM segmento nem segmentos vêm
    // preenchidos: cai em array vazio, nunca null.
    const eventoSemNada = { operationId: 'sem-segmento', data: '2026-06-11', empresa: 'VX', tempo: 0, timestamp: 6000, tipo: 'manual' };
    const combinado2 = api.montarHistoricoVisual([], [eventoSemNada]);
    const item2 = combinado2.find(x => x.id === 'sem-segmento');
    check('20b. sem segmento nem segmentos: cai em array vazio, nunca null', Array.isArray(item2.segmentos) && item2.segmentos.length === 0, JSON.stringify(item2));
  }

  // Local + remoto mesclados por operationId não duplicam a mesma entrada
  // (o mesmo laudo, visto localmente e confirmado na nuvem, aparece 1 vez).
  {
    const local = [{ operationId: 'op-dup', data: '2026-06-15', dataFormatada: '15/06/26', horario: '09:00', timestamp: 7000, empresa: 'HBJ', segmentos: ['LOMBAR'], tempo: 30, tempoFormatado: '30s', tipo: 'cronometro', origem: 'este-pc' }];
    const remoto = [{ operationId: 'op-dup', data: '2026-06-15', empresa: 'HBJ', segmentos: ['LOMBAR'], tempo: 30, timestamp: 7000, tipo: 'cronometro', origem: 'este-pc' }];
    const combinado = api.montarHistoricoVisual(local, remoto);
    check('local+remoto com o mesmo operationId não duplica', combinado.length === 1);
    check('entrada mesclada preserva _localIndex (mantém botões editar/excluir)', combinado[0]._localIndex === 0);
  }
}

module.exports = { run };
