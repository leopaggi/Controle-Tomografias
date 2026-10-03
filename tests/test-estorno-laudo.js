'use strict';
const assert = require('assert');
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');
const DAY = '2026-10-02';
async function until(fn){
  const deadline = performance.now() + 3000;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error('Frame não solicitado.');
    await new Promise(resolve => setImmediate(resolve));
  }
}
function app(options = {}){
  const frames = [];
  const h = loadApp({ sharedIdb: options.sharedIdb || new Map(), requestAnimationFrame: cb => frames.push(cb) });
  h.frames = frames;
  h.doc.getElementById('data-exame').value = DAY;
  h.doc.getElementById('timer-servico').value = 'hbj';
  h.doc.getElementById('relatorio').classList.remove('active');
  h.doc.getElementById('projecao').classList.remove('active');
  const checked = (options.segments || ['cranio']).map(value => ({value, checked:true, closest(){return null;}}));
  h.checkboxes = checked;
  h.doc.querySelectorAll = s => s === '#timer-segmentos-container input:checked' ? checked.filter(c => c.checked)
    : s === '#timer-segmentos-container input[type="checkbox"]' ? checked : [];
  h.api.setTimerState({currentSeconds: options.seconds === undefined ? 120 : options.seconds, totalSeconds: 30, isCurrentRunning:true});
  return h;
}
async function finish(h){
  const p = h.api.finalizarLaudo();
  await until(() => h.frames.length);
  h.frames.shift()(performance.now());
  await p;
  return h.api.getHistoricoLaudos()[0];
}
async function reverse(h, id){
  const p = h.api.estornarLaudo(id);
  await until(() => h.frames.length);
  h.frames.shift()(performance.now());
  await p;
}
function notice(h){ return h.doc.body.children.map(x => x.textContent).join('\n'); }
async function run(check){
  let count = 0;
  const verify = (label, fn) => { fn(); count++; check('estorno: ' + label, true); };
  for (const [label, segments, seconds] of [
    ['um segmento', ['cranio'], 120], ['dois segmentos', ['torax', 'abd-superior'], 120],
    ['duração zero', ['cranio'], 0]
  ]) {
    const h = app({segments, seconds}), db = makeFirestoreMock(); h.api.setDb(db);
    const original = await finish(h), s = original.effectsSnapshot;
    const eventBefore = JSON.parse(JSON.stringify(db._store.get(`controles_dias/${DAY}/laudos/${s.operationId}`)));
    verify(label + ': ação disponível sem exclusão destrutiva', () => {
      const html = h.doc.getElementById('log-lista').innerHTML;
      assert(html.includes('Estornar laudo'));
      assert(!html.includes('excluirLog('));
      assert.equal(s.segmentos.length, segments.length);
    });
    h.api.setConfirmAnswer(false);
    await h.api.estornarLaudo(s.operationId);
    verify(label + ': cancelamento não altera dados/fila', () => {
      assert.equal(h.api.getHistoricoLaudos()[0].reversal, undefined);
      assert.equal(h.api.getDadosApp().exames[DAY][segments[0]].hbj, 1);
    });
    h.api.setConfirmAnswer(true);
    await reverse(h, s.operationId);
    const id = h.api.tomoReversalId(s.operationId);
    const marker = db._store.get(`controles_dias/${DAY}/laudos/${id}`);
    verify(label + ': contador, tempo e total revertidos sem amostra negativa', () => {
      for (const segment of segments) {
        assert.equal(h.api.getDadosApp().exames[DAY][segment].hbj, 0);
        assert.equal(db._store.get('controles_dias/' + DAY).exames[segment].hbj, 0);
        const samples = h.api.getDadosApp().tempos[DAY]['hbj_' + segment] || [];
        assert.equal(samples.length, 0);
        assert(samples.every(x => x >= 0));
        const effect = s.segmentos.find(e => e.segmentoId === segment);
        assert.equal(h.api.getDadosApp().timeContributions[DAY][effect.timeContributionId], undefined);
      }
      assert.equal(h.api.getTimerState().totalSeconds, 30);
      assert.equal(h.sharedIdb.get('totalAcumulado_' + DAY), '30');
      assert.equal(JSON.parse(h.sharedIdb.get('examesTomografia')).exames[DAY][segments[0]].hbj, 0);
      assert.equal(h.doc.getElementById('total-exames-dia').textContent, '0 exames');
      assert.equal(h.doc.getElementById('total-valor-dia').textContent, 'R$ 0.00');
    });
    verify(label + ': original preservado e marcador/ledger determinísticos', () => {
      assert.equal(h.api.getHistoricoLaudos().length, 1);
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status, 'confirmed');
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.reversalId, id);
      assert.equal(h.doc.getElementById('log-lista').innerHTML.includes('ESTORNADO'), true);
      assert.equal(h.doc.getElementById('log-lista').innerHTML.includes('Estornar laudo'), false);
      assert.equal(marker.reversesOperationId, s.operationId);
      assert.equal(db._store.get('controles_operacoes/' + id).tipo, 'estorno');
      assert.deepEqual(db._store.get(`controles_dias/${DAY}/laudos/${s.operationId}`), eventBefore);
    });
    await h.api.estornarLaudo(s.operationId);
    const replay = await h.api.tomoAplicarEstornoAtomico(db, { operationId:id, tipo:'estorno', data:DAY,
      reversesOperationId:s.operationId, effectsVersion:1, effectsSnapshot:s });
    verify(label + ': segundo clique/retry não aplicam delta outra vez', () => {
      assert.equal(replay.ok, true); assert.equal(replay.jaAplicado, true);
      assert.equal(db._store.get('controles_dias/' + DAY).exames[segments[0]].hbj, 0);
      assert.equal(h.api.getDadosApp().exames[DAY][segments[0]].hbj, 0);
    });
    await h.api.tomoGravarEventoLaudo(db, s.operationId, DAY, eventBefore);
    verify(label + ': retry original não apaga marcador separado', () => {
      assert.deepEqual(db._store.get(`controles_dias/${DAY}/laudos/${id}`), marker);
      const events = [...db._store.keys()].filter(x => x.includes('/laudos/'));
      assert.equal(events.length, 2);
    });
    h.api.editarLog(0);
    for (const [key, value] of Object.entries({
      'edit-log-data':'2026-01-01', 'edit-log-horario':'10:00', 'edit-log-empresa':'VX',
      'edit-log-segmentos':'PELVE', 'edit-log-tempo':'999', 'edit-log-tipo':'manual'
    })) h.doc.getElementById(key).value=value;
    await h.doc.getElementById('form-editar-log')._listeners.submit[0]({preventDefault(){}});
    verify(label + ': edição posterior preserva estorno confirmado e comprovante original',()=>{
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status,'confirmed');
      assert.equal(h.api.getHistoricoLaudos()[0].effectsSnapshot.operationId,s.operationId);
      assert.equal(JSON.parse(h.sharedIdb.get('historicoLaudos'))[0].reversal.status,'confirmed');
    });
    const reloaded = app({ sharedIdb: h.sharedIdb });
    await reloaded.api.carregarDados();
    verify(label + ': reload não reaplica estorno', () => {
      assert.equal(reloaded.api.getHistoricoLaudos()[0].reversal.status, 'confirmed');
      assert.equal(reloaded.api.getDadosApp().exames[DAY][segments[0]].hbj, 0);
      assert.equal(reloaded.api.tomoStatusFila().total, 0);
    });
  }
  {
    const h = app(), db = makeFirestoreMock(); h.api.setDb(db);
    h.api.getDadosApp().tempos[DAY] = { hbj_cranio:[17,120] };
    await finish(h);
    const first = h.api.getHistoricoLaudos()[0].effectsSnapshot;
    h.checkboxes[0].checked = true;
    h.api.setTimerState({currentSeconds:30,totalSeconds:150,isCurrentRunning:true});
    await finish(h);
    const second = h.api.getHistoricoLaudos()[0].effectsSnapshot;
    await reverse(h, first.operationId);
    verify('remove amostra exata e desloca índice de contribuição posterior', () => {
      assert.deepEqual(h.api.getDadosApp().tempos[DAY].hbj_cranio, [17,120,30]);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][first.segmentos[0].timeContributionId], undefined);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][second.segmentos[0].timeContributionId].sampleIndex, 2);
      assert.equal(h.api.tomoLocalizarContribuicaoTempo(h.api.getDadosApp(), DAY, second.segmentos[0].timeContributionId).sampleIndex, 2);
      assert.equal(h.api.getTimerState().totalSeconds, 60);
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj, 1);
    });
    await reverse(h, second.operationId);
    verify('estorno posterior não colide com identidade da amostra anterior removida', () => {
      assert.deepEqual(h.api.getDadosApp().tempos[DAY].hbj_cranio, [17,120]);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][first.segmentos[0].timeContributionId], undefined);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][second.segmentos[0].timeContributionId], undefined);
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj, 0);
    });
  }
  {
    const h = app(), db = makeFirestoreMock(); h.api.setDb(db);
    const a = await finish(h);
    h.checkboxes[0].checked = true;
    h.api.setTimerState({currentSeconds:120,totalSeconds:150,isCurrentRunning:true});
    const b = await finish(h);
    const aId = a.effectsSnapshot.segmentos[0].timeContributionId;
    const bId = b.effectsSnapshot.segmentos[0].timeContributionId;
    verify('A/B começam nas posições 0 e 1 do mesmo array, mesmo com valores iguais', () => {
      assert.deepEqual(h.api.getDadosApp().tempos[DAY].hbj_cranio, [120,120]);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][aId].sampleIndex, 0);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][bId].sampleIndex, 1);
    });
    await reverse(h, a.operationId);
    verify('estornar A elimina a identidade A e move somente B para índice 0', () => {
      assert.deepEqual(h.api.getDadosApp().tempos[DAY].hbj_cranio, [120]);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][aId], undefined);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][bId].sampleIndex, 0);
      assert.equal(h.api.tomoLocalizarContribuicaoTempo(h.api.getDadosApp(), DAY, bId).sampleIndex, 0);
    });
    const reloaded = app({sharedIdb:h.sharedIdb}); reloaded.api.setDb(db);
    await reloaded.api.carregarDados();
    const retry = await reloaded.api.tomoAplicarEstornoAtomico(db, {
      operationId:h.api.tomoReversalId(a.operationId),tipo:'estorno',data:DAY,
      reversesOperationId:a.operationId,effectsVersion:1,effectsSnapshot:a.effectsSnapshot
    });
    verify('reload/retry de A não recria identidade, amostra nem decremento', () => {
      assert.equal(retry.ok, true); assert.equal(retry.jaAplicado, true);
      assert.deepEqual(reloaded.api.getDadosApp().tempos[DAY].hbj_cranio, [120]);
      assert.equal(reloaded.api.getDadosApp().timeContributions[DAY][aId], undefined);
      assert.equal(reloaded.api.getDadosApp().timeContributions[DAY][bId].sampleIndex, 0);
      assert.equal(reloaded.api.getDadosApp().exames[DAY].cranio.hbj, 1);
    });
    await reloaded.api.estornarLaudo(a.operationId);
    verify('segundo clique em A permanece bloqueado após reload', () => {
      assert.equal(reloaded.api.getHistoricoLaudos().find(x=>x.operationId===a.operationId).reversal.status,'confirmed');
      assert.deepEqual(reloaded.api.getDadosApp().tempos[DAY].hbj_cranio, [120]);
    });
    await reverse(reloaded, b.operationId);
    verify('estornar B depois de A funciona sem falsa colisão', () => {
      assert.deepEqual(reloaded.api.getDadosApp().tempos[DAY].hbj_cranio, []);
      assert.equal(reloaded.api.getDadosApp().timeContributions[DAY][aId], undefined);
      assert.equal(reloaded.api.getDadosApp().timeContributions[DAY][bId], undefined);
      assert.equal(reloaded.api.getDadosApp().exames[DAY].cranio.hbj, 0);
      assert.equal(reloaded.api.getTimerState().totalSeconds, 30);
    });
  }
  {
    const h = app(), db = makeFirestoreMock(); h.api.setDb(db);
    const a = await finish(h);
    h.checkboxes[0].checked = true;
    h.api.setTimerState({currentSeconds:120,totalSeconds:150,isCurrentRunning:true});
    const b = await finish(h);
    h.checkboxes[0].checked = true;
    h.api.setTimerState({currentSeconds:120,totalSeconds:270,isCurrentRunning:true});
    const c = await finish(h);
    const aId = a.effectsSnapshot.segmentos[0].timeContributionId;
    const bId = b.effectsSnapshot.segmentos[0].timeContributionId;
    const cId = c.effectsSnapshot.segmentos[0].timeContributionId;
    await reverse(h, b.operationId);
    verify('A/B/C: estornar B preserva A em 0, remove B e move C de 2 para 1', () => {
      assert.deepEqual(h.api.getDadosApp().tempos[DAY].hbj_cranio, [120,120]);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][aId].sampleIndex, 0);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][bId], undefined);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][cId].sampleIndex, 1);
    });
    await reverse(h, c.operationId);
    verify('A/B/C: estornar C depois funciona e mantém somente A', () => {
      assert.deepEqual(h.api.getDadosApp().tempos[DAY].hbj_cranio, [120]);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][aId].sampleIndex, 0);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][bId], undefined);
      assert.equal(h.api.getDadosApp().timeContributions[DAY][cId], undefined);
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj, 1);
      assert.equal(h.api.getTimerState().totalSeconds, 150);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const first=await finish(h);
    h.checkboxes[0].checked=true;
    h.api.setTimerState({currentSeconds:30,totalSeconds:150,isCurrentRunning:true});
    const second=await finish(h);
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    let started=false;
    h.api.setDb({collection:name=>db.collection(name),async runTransaction(fn){started=true; await gate; return db.runTransaction(fn);}});
    const p=h.api.estornarLaudo(first.operationId);
    await until(()=>h.frames.length);
    h.frames.shift()(performance.now());
    await until(()=>started);
    await h.api.estornarLaudo(second.operationId);
    verify('dois laudos diferentes não disputam fila/cache durante estorno em andamento',()=>{
      assert.equal(h.api.getFilaInterna().filter(op=>op.tipo==='estorno').length,1);
      assert.equal(h.api.getHistoricoLaudos().find(item=>item.operationId===second.operationId).reversal,undefined);
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj,1);
    });
    release(); await p;
  }
  for (const [label, corrupt] of [
    ['identidade inexistente', (h,s) => { delete h.api.getDadosApp().timeContributions[DAY][s.segmentos[0].timeContributionId]; }],
    ['empresa divergente', (h,s) => { h.api.getDadosApp().timeContributions[DAY][s.segmentos[0].timeContributionId] = { ...h.api.getDadosApp().timeContributions[DAY][s.segmentos[0].timeContributionId], empresaId:'vx' }; }],
    ['segmento divergente', (h,s) => { h.api.getDadosApp().timeContributions[DAY][s.segmentos[0].timeContributionId] = { ...h.api.getDadosApp().timeContributions[DAY][s.segmentos[0].timeContributionId], segmentoId:'torax' }; }],
    ['tempo divergente', (h,s) => { h.api.getDadosApp().timeContributions[DAY][s.segmentos[0].timeContributionId] = { ...h.api.getDadosApp().timeContributions[DAY][s.segmentos[0].timeContributionId], timeSeconds:999 }; }],
    ['posição divergente', (h,s) => { h.api.getDadosApp().tempos[DAY].hbj_cranio[0] = 999; }],
    ['duas identidades na mesma posição', (h,s) => { h.api.getDadosApp().timeContributions[DAY]['fake:time:cranio'] = { operationId:'fake', empresaId:'hbj', segmentoId:'cranio', timeSeconds:120, sampleIndex:0 }; }],
    ['total insuficiente', h => { h.api.idbLocalStorage.setItem('totalAcumulado_' + DAY, '0'); h.api.setTimerState({currentSeconds:0,totalSeconds:0,isCurrentRunning:true}); }],
    ['contagem insuficiente', h => { h.api.getDadosApp().exames[DAY].cranio.hbj = 0; }]
  ]) {
    const h = app(), db=makeFirestoreMock(); h.api.setDb(db);
    const item = await finish(h), s = item.effectsSnapshot;
    corrupt(h,s);
    const before = JSON.stringify(h.api.getDadosApp()), queue=JSON.stringify(h.api.getFilaInterna()), log=JSON.stringify(h.api.getHistoricoLaudos());
    await h.api.estornarLaudo(s.operationId);
    verify(label + ': bloqueia tudo sem alteração parcial', () => {
      assert.equal(JSON.stringify(h.api.getDadosApp()), before);
      assert.equal(JSON.stringify(h.api.getFilaInterna()), queue);
      assert.equal(JSON.stringify(h.api.getHistoricoLaudos()), log);
      assert.equal(db._store.has('controles_operacoes/' + h.api.tomoReversalId(s.operationId)), false);
      assert.equal(notice(h).includes('Estorno bloqueado'), true);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const original=await finish(h), id=original.operationId;
    h.api.setDb(null);
    await reverse(h, id);
    verify('offline mantém pedido com mesmo ID e todos os efeitos locais', () => {
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status, 'pending');
      assert(h.doc.getElementById('log-lista').innerHTML.includes('Estorno pendente'));
      assert(!h.doc.getElementById('log-lista').innerHTML.includes('Estornar laudo'));
      assert.equal(h.api.getFilaInterna().filter(op=>op.tipo==='estorno').length, 1);
      assert.equal(h.api.getFilaInterna()[0].operationId, h.api.tomoReversalId(id));
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj, 0);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj, 1);
    });
    const reloaded=app({sharedIdb:h.sharedIdb}); reloaded.api.setDb(db);
    await reloaded.api.carregarDados();
    verify('loader conserva estorno local ainda pendente contra documento diário antigo', () => {
      assert.equal(reloaded.api.getDadosApp().exames[DAY].cranio.hbj, 0);
      assert.equal(reloaded.api.getTimerState().totalSeconds, 30);
    });
    await reloaded.api.tomoProcessarFila();
    await reloaded.api.salvarDadosFirebaseSilencioso();
    verify('retry após reload confirma com o mesmo reversalId, sem novo efeito local', () => {
      assert.equal(reloaded.api.tomoStatusFila().total, 0);
      assert.equal(reloaded.api.getHistoricoLaudos()[0].reversal.status, 'confirmed');
      assert.equal(reloaded.api.getDadosApp().exames[DAY].cranio.hbj, 0);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj, 0);
      assert.equal(db._store.get('controles_operacoes/'+h.api.tomoReversalId(id)).reversesOperationId, id);
      assert.equal(db._store.get('controles/examesTomografia_2026-10').exames[DAY].cranio.hbj,0);
      assert.deepEqual(db._store.get('controles/examesTomografia_2026-10').tempos[DAY].hbj_cranio,[]);
    });
    const view=reloaded.api.montarHistoricoVisual([], await reloaded.api.tomoBuscarLaudosCrossPC(db,100));
    reloaded.api.tomoRenderizarHistorico(view);
    verify('outro PC renderiza marcador remoto sem apagar evento original', () => {
      assert.equal(view.length, 1);
      assert.equal(view[0].reversal.status,'confirmed');
      assert(reloaded.doc.getElementById('log-lista').innerHTML.includes('ESTORNADO'));
      assert.equal(db._store.has(`controles_dias/${DAY}/laudos/${id}`), true);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const first=await finish(h), original=JSON.parse(JSON.stringify(h.api.getDadosApp()));
    const before=h.sharedIdb.get('tomoFilaOperacoes');
    await h.api.tomoEnsureStorage();
    const realTx=h.api.getIdbHandle().transaction;
    h.api.getIdbHandle().transaction=function(store, mode){
      if(mode==='readwrite') throw new Error('Falha atômica IDB simulada');
      return realTx.call(this,store,mode);
    };
    await h.api.estornarLaudo(first.operationId);
    verify('falha na transação local não altera memória/fila/total/DOM',()=>{
      assert.deepEqual(h.api.getDadosApp(),original);
      assert.equal(h.api.getHistoricoLaudos()[0].reversal,undefined);
      assert.equal(h.api.getTimerState().totalSeconds,150);
      assert.equal(h.sharedIdb.get('tomoFilaOperacoes'),before);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,1);
      assert(notice(h).includes('Estorno bloqueado'));
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const original=await finish(h), id=original.operationId;
    let release; const gate=new Promise(resolve=>{release=resolve;});
    let started=false;
    h.api.setDb({collection:name=>db.collection(name),async runTransaction(fn){started=true; await gate; return db.runTransaction(fn);}});
    const p=h.api.estornarLaudo(id);
    await until(()=>h.frames.length);
    h.frames.shift()(performance.now());
    await until(()=>started);
    await h.api.estornarLaudo(id);
    await h.api.alterarContador('cranio','hbj',1);
    verify('duplo clique enquanto transação remota aguarda não cria segunda fila',()=>{
      assert.equal(h.api.getFilaInterna().filter(op=>op.tipo==='estorno').length,1);
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status,'pending');
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj,0);
    });
    release(); await p;
    verify('operação remota pendente completa uma única vez',()=>{
      assert.equal(h.api.getHistoricoLaudos().find(item=>item.operationId===id).reversal.status,'confirmed');
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,0);
    });
    await h.api.alterarContador('cranio','hbj',1);
    await h.api.alterarContador('cranio','hbj',-1);
    verify('botão manual +/- mantém contrato independente do estorno',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj,0);
      assert.equal(h.api.getDadosApp().tempos[DAY].hbj_cranio.length,0);
      assert.equal(h.api.getHistoricoLaudos().find(item=>item.operationId===id).reversal.status,'confirmed');
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,0);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    await h.api.adicionarAoLog('HBJ',['CRÂNIO'],30,'cronometro',DAY);
    const before = JSON.stringify(h.api.getDadosApp());
    await h.api.estornarLaudo(h.api.getHistoricoLaudos()[0].operationId);
    verify('registro legado não oferece estorno e não sofre alteração', () => {
      assert.equal(h.doc.getElementById('log-lista').innerHTML.includes('Estornar laudo'), false);
      assert.equal(JSON.stringify(h.api.getDadosApp()), before);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    await h.api.tomoEnsureStorage();
    h.api.getDadosApp().exames[DAY]={cranio:{hbj:2}};
    h.api.getDadosApp().tempos[DAY]={hbj_cranio:[30]};
    h.api.setTimerState({currentSeconds:0,totalSeconds:30,isCurrentRunning:true});
    await h.api.idbLocalStorage.setItemAsync('totalAcumulado_'+DAY,'30');
    await h.api.adicionarAoLog('HBJ',['CRÂNIO'],30,'cronometro',DAY,'legado-local');
    await h.api.tomoGravarEventoLaudo(db,'legado-local',DAY,{empresa:'HBJ',segmentos:['CRÂNIO'],tempo:30});
    const view=h.api.montarHistoricoVisual(h.api.getHistoricoLaudos().slice(0,10),[]);
    verify('timer legado local mantém Editar/Remover somente do histórico sem Estornar',()=>{
      assert.equal(view[0]._localIndex,0);
      const html=h.doc.getElementById('log-lista').innerHTML;
      assert(html.includes('editarLog(0)') && html.includes('excluirLog(0)'));
      assert(html.includes('Remover somente do histórico'));
      assert(!html.includes('Estornar laudo'));
    });
    const prior=JSON.stringify(h.api.getDadosApp()), total=h.api.getTimerState().totalSeconds;
    const totalPersistido=h.sharedIdb.get('totalAcumulado_'+DAY), logRemoto=db._log.length;
    const eventoRemoto=JSON.stringify(db._store.get(`controles_dias/${DAY}/laudos/legado-local`));
    await h.api.excluirLog(0);
    verify('remover legado afeta só historicoLaudos, não contador, tempo, total ou nuvem',()=>{
      assert.equal(h.api.getHistoricoLaudos().length,0);
      assert.deepEqual(JSON.parse(h.sharedIdb.get('historicoLaudos')),[]);
      assert.equal(JSON.stringify(h.api.getDadosApp()),prior);
      assert.equal(h.api.getTimerState().totalSeconds,total);
      assert.equal(h.sharedIdb.get('totalAcumulado_'+DAY),totalPersistido);
      assert.equal(db._log.length,logRemoto);
      assert.equal(JSON.stringify(db._store.get(`controles_dias/${DAY}/laudos/legado-local`)),eventoRemoto);
      assert(notice(h).includes('Removido apenas do histórico'));
      assert(notice(h).includes('dados remotos não foram alterados'));
    });
  }
  {
    const h=app(); await h.api.tomoEnsureStorage();
    await h.api.adicionarAoLog('HBJ',['CRÂNIO'],0,'manual',DAY);
    verify('legado manual mantém Editar/Remover somente do histórico sem estorno técnico',()=>{
      const html=h.doc.getElementById('log-lista').innerHTML;
      assert(html.includes('editarLog(0)') && html.includes('excluirLog(0)'));
      assert(html.includes('Remover somente do histórico') && !html.includes('Estornar laudo'));
      assert(!html.includes('estornar'));
      assert(html.includes('Esta ação remove apenas este registro da lista de histórico'));
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    await h.api.alterarContador('torax','mobilemed',1);
    const item=h.api.getHistoricoLaudos()[0], s=item.effectsSnapshot;
    verify('A. novo manual + MOBILEMED TÓRAX tem identidade, snapshot válido e sem tempo',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].torax.mobilemed,1);
      assert.equal(h.doc.getElementById('total-exames-dia').textContent,'1 exames');
      assert.equal(h.doc.getElementById('total-valor-dia').textContent,'R$ 25.00');
      assert.equal(h.api.getHistoricoLaudos().length,1);
      assert.equal(item.empresa,'MOBILEMED');
      assert.deepEqual(item.segmentos,['TORAX']);
      assert.equal(item.tipo,'manual');
      assert(typeof item.operationId==='string' && item.operationId.length>0);
      assert.equal(item.effectsVersion,1);
      assert(h.api.tomoComprovanteValido(item));
      assert.equal(s.operationId,item.operationId);
      assert.equal(s.data,DAY);
      assert.equal(s.empresaId,'mobilemed');
      assert.equal(s.totalDailyDeltaSeconds,0);
      assert.equal(s.segmentos.length,1);
      assert.equal(s.segmentos[0].segmentoId,'torax');
      assert.equal(s.segmentos[0].counterOperationId,`${s.operationId}:torax`);
      assert.equal(s.segmentos[0].counterDelta,1);
      assert.equal(s.segmentos[0].timeContributionId,undefined);
      assert.equal(s.segmentos[0].timeSeconds,undefined);
      assert.equal(h.api.getDadosApp().tempos[DAY]?.['mobilemed_torax'],undefined);
      assert.equal(h.api.getDadosApp().timeContributions?.[DAY]?.[`${s.operationId}:time:torax`],undefined);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.torax.mobilemed,1);
      assert(db._store.has('controles_operacoes/'+s.segmentos[0].counterOperationId));
      const html=h.doc.getElementById('log-lista').innerHTML;
      assert(html.includes('Estornar laudo') && !html.includes('excluirLog('));
    });
    const opId=item.operationId, revId=h.api.tomoReversalId(opId);
    await reverse(h,opId);
    verify('B. estorno do manual reverte contagem/valor e mantém ESTORNADO',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].torax.mobilemed,0);
      assert.equal(h.doc.getElementById('total-exames-dia').textContent,'0 exames');
      assert.equal(h.doc.getElementById('total-valor-dia').textContent,'R$ 0.00');
      assert.equal(h.api.getHistoricoLaudos().length,1);
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.reversalId,revId);
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status,'confirmed');
      assert.equal(h.api.getTimerState().totalSeconds,30);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.torax.mobilemed,0);
      assert.equal(db._store.get('controles_operacoes/'+revId).tipo,'estorno');
      assert.equal(db._store.get('controles_operacoes/'+revId).reversesOperationId,opId);
      assert(db._store.has(`controles_dias/${DAY}/laudos/${revId}`));
      assert.equal(db._store.get(`controles_dias/${DAY}/laudos/${revId}`).reversesOperationId,opId);
      const html=h.doc.getElementById('log-lista').innerHTML;
      assert(html.includes('ESTORNADO') && !html.includes('Estornar laudo'));
    });
    await h.api.estornarLaudo(opId);
    verify('C. segundo estorno do mesmo manual é bloqueado e idempotente',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].torax.mobilemed,0);
      assert.equal(h.doc.getElementById('total-valor-dia').textContent,'R$ 0.00');
      assert.equal(db._store.get('controles_dias/'+DAY).exames.torax.mobilemed,0);
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status,'confirmed');
      assert(notice(h).includes('Estorno bloqueado'));
    });
    await h.api.excluirLog(0);
    verify('manual novo estornado não pode ser excluído do histórico',()=>{
      assert.equal(h.api.getHistoricoLaudos().length,1);
      assert(notice(h).includes('deve ser estornado'));
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    await h.api.alterarContador('torax','mobilemed',1);
    const opId=h.api.getHistoricoLaudos()[0].operationId;
    const reloaded=app({sharedIdb:h.sharedIdb}); reloaded.api.setDb(db);
    await reloaded.api.carregarDados();
    verify('D. reload preserva manual novo com snapshot e contagem',()=>{
      assert.equal(reloaded.api.getHistoricoLaudos().length,1);
      assert.equal(reloaded.api.getHistoricoLaudos()[0].operationId,opId);
      assert(reloaded.api.tomoComprovanteValido(reloaded.api.getHistoricoLaudos()[0]));
      assert.equal(reloaded.api.getDadosApp().exames[DAY].torax.mobilemed,1);
      assert(reloaded.doc.getElementById('log-lista').innerHTML.includes('Estornar laudo'));
    });
    await reverse(reloaded,opId);
    verify('D. estorno após reload continua correto e confirmado',()=>{
      assert.equal(reloaded.api.getDadosApp().exames[DAY].torax.mobilemed,0);
      assert.equal(reloaded.api.getHistoricoLaudos()[0].reversal.status,'confirmed');
      assert.equal(db._store.get('controles_dias/'+DAY).exames.torax.mobilemed,0);
      assert(reloaded.doc.getElementById('log-lista').innerHTML.includes('ESTORNADO'));
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    await h.api.alterarContador('torax','mobilemed',1);
    await h.api.alterarContador('face-atm','mobilemed',1);
    const torax=h.api.getHistoricoLaudos().find(x=>x.segmentos[0]==='TORAX');
    const face=h.api.getHistoricoLaudos().find(x=>x.segmentos[0]==='FACE/ATM');
    verify('E. dois manuais TÓRAX e FACE/ATM somam 2 exames e R$ 50',()=>{
      assert.equal(h.api.getHistoricoLaudos().length,2);
      assert(torax.operationId!==face.operationId);
      assert.equal(h.api.getDadosApp().exames[DAY].torax.mobilemed,1);
      assert.equal(h.api.getDadosApp().exames[DAY]['face-atm'].mobilemed,1);
      assert.equal(h.doc.getElementById('total-valor-dia').textContent,'R$ 50.00');
    });
    await reverse(h,torax.operationId);
    verify('E. estornar só TÓRAX preserva FACE/ATM',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].torax.mobilemed,0);
      assert.equal(h.api.getDadosApp().exames[DAY]['face-atm'].mobilemed,1);
      assert.equal(h.doc.getElementById('total-valor-dia').textContent,'R$ 25.00');
      assert.equal(h.api.getHistoricoLaudos().find(x=>x.operationId===torax.operationId).reversal.status,'confirmed');
      assert.equal(h.api.getHistoricoLaudos().find(x=>x.operationId===face.operationId).reversal,undefined);
    });
    await reverse(h,face.operationId);
    verify('E. estornar FACE/ATM depois zera ambos sem colisão',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].torax.mobilemed,0);
      assert.equal(h.api.getDadosApp().exames[DAY]['face-atm'].mobilemed,0);
      assert.equal(h.doc.getElementById('total-valor-dia').textContent,'R$ 0.00');
      assert.equal(db._store.get('controles_dias/'+DAY).exames.torax.mobilemed,0);
      assert.equal(db._store.get('controles_dias/'+DAY).exames['face-atm'].mobilemed,0);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    await h.api.tomoEnsureStorage();
    h.api.getDadosApp().exames[DAY]={torax:{mobilemed:1}};
    await h.api.adicionarAoLog('MOBILEMED',['TORAX'],0,'manual',DAY);
    const before=JSON.stringify(h.api.getDadosApp());
    const writes=db._log.length;
    await h.api.excluirLog(0);
    verify('F. legado manual só remove do histórico, sem alterar contagem/valor/nuvem',()=>{
      assert.equal(h.api.getHistoricoLaudos().length,0);
      assert.equal(JSON.stringify(h.api.getDadosApp()),before);
      assert.equal(h.api.getDadosApp().exames[DAY].torax.mobilemed,1);
      assert.equal(db._log.length,writes);
      assert(notice(h).includes('Removido apenas do histórico'));
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    h.doc.getElementById('timer-servico').value='mobilemed';
    const original=await finish(h), id=original.operationId;
    verify('Timer MOBILEMED: comprovante habilita Estornar laudo',()=>{
      assert(original.effectsSnapshot && original.effectsSnapshot.empresaId==='mobilemed');
      assert(h.doc.getElementById('log-lista').innerHTML.includes('Estornar laudo'));
    });
    await reverse(h,id);
    const events=await h.api.tomoBuscarLaudosCrossPC(db,100);
    const view=h.api.montarHistoricoVisual(h.api.getHistoricoLaudos().slice(0,10),events);
    h.api.tomoRenderizarHistorico(view);
    verify('Timer MOBILEMED: estorno reverte efeitos e mantém original ESTORNADO no merge',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.mobilemed,0);
      assert.deepEqual(h.api.getDadosApp().tempos[DAY].mobilemed_cranio,[]);
      assert.equal(h.api.getTimerState().totalSeconds,30);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.mobilemed,0);
      assert.equal(h.doc.getElementById('total-valor-dia').textContent,'R$ 0.00');
      assert.equal(view.length,1);
      assert.equal(view[0].operationId,id);
      assert.equal(view[0].reversal.status,'confirmed');
      assert(h.doc.getElementById('log-lista').innerHTML.includes('ESTORNADO'));
      assert(db._store.has(`controles_dias/${DAY}/laudos/${id}`));
      assert(db._store.has(`controles_dias/${DAY}/laudos/${h.api.tomoReversalId(id)}`));
    });
  }
  {
    const h=app(); await h.api.tomoEnsureStorage();
    await h.api.adicionarAoLog('HBJ',['CRÂNIO'],30,'cronometro',DAY,'incompleto');
    h.api.getHistoricoLaudos()[0].effectsVersion=1;
    h.api.getHistoricoLaudos()[0].effectsSnapshot={operationId:'incompleto'};
    h.api.atualizarLog();
    verify('comprovante novo incompleto não ganha Estornar nem remoção visual enganosa',()=>{
      const html=h.doc.getElementById('log-lista').innerHTML;
      assert(!html.includes('Estornar laudo') && !html.includes('excluirLog(0)'));
      assert(html.includes('Comprovante técnico inválido'));
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const original=await finish(h);
    const another=app(); another.api.setDb(db);
    const events=await another.api.tomoBuscarLaudosCrossPC(db,100);
    const view=another.api.montarHistoricoVisual([],events);
    another.api.tomoRenderizarHistorico(view);
    verify('evento apenas remoto continua sem índice local e sem Editar/Remover',()=>{
      assert.equal(view[0].operationId,original.operationId);
      assert.equal(view[0]._localIndex,undefined);
      const html=another.doc.getElementById('log-lista').innerHTML;
      assert(!html.includes('excluirLog(') && !html.includes('editarLog('));
      assert(!html.includes('data-reversal-id='));
      assert(html.includes('Evento remoto sem registro local'));
    });
    const merged=h.api.montarHistoricoVisual(h.api.getHistoricoLaudos().slice(0,10),events);
    verify('merge por operationId preserva o índice local quando registro existe',()=>{
      assert.equal(merged.length,1);
      assert.equal(merged[0]._localIndex,0);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const original=await finish(h), id=h.api.tomoReversalId(original.operationId);
    const pedido={ operationId:id, tipo:'estorno', data:DAY, reversesOperationId:original.operationId,
      effectsVersion:1, effectsSnapshot:original.effectsSnapshot };
    // Mock não implementa contenção Firestore; serializar transações aqui
    // simula a ordem de commit do servidor para dois PCs simultâneos.
    let chain=Promise.resolve();
    const db2={ collection(name){return db.collection(name);}, runTransaction(fn){
      const result=chain.then(()=>db.runTransaction(fn)); chain=result.catch(()=>{}); return result;
    }};
    const [a,b]=await Promise.all([h.api.tomoAplicarEstornoAtomico(db2,pedido),h.api.tomoAplicarEstornoAtomico(db2,pedido)]);
    verify('dois PCs com mesmo reversalId confirmam um único decremento remoto',()=>{
      assert(a.ok && b.ok);
      assert.equal([a,b].filter(r=>r.jaAplicado).length,1);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,0);
      assert.equal(db._store.get('controles_operacoes/'+id).reversesOperationId,original.operationId);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const original=await finish(h), s=original.effectsSnapshot;
    const path=`controles_dias/${DAY}/laudos/${s.operationId}`;
    const event=db._store.get(path);
    db._store.set(path, { ...event, effectsSnapshot: {
      totalDailyDeltaSeconds:s.totalDailyDeltaSeconds, segmentos:s.segmentos.map(e=>({
        timeSeconds:e.timeSeconds,timeContributionId:e.timeContributionId,counterDelta:e.counterDelta,
        counterOperationId:e.counterOperationId,segmentoId:e.segmentoId
      })), empresaId:s.empresaId,data:s.data,operationId:s.operationId
    } });
    const result=await h.api.tomoAplicarEstornoAtomico(db,{operationId:h.api.tomoReversalId(s.operationId),
      reversesOperationId:s.operationId, data:DAY, effectsVersion:1, effectsSnapshot:s});
    verify('Firestore pode reordenar campos do comprovante sem invalidar identidade técnica',()=>{
      assert.equal(result.ok,true);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,0);
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const original=await finish(h);
    await h.api.alterarContador('cranio','hbj',-1);
    await h.api.estornarLaudo(original.operationId);
    verify('ajuste manual prévio que zera contador bloqueia estorno sem duplicar desconto',()=>{
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj,0);
      assert.equal(h.api.getHistoricoLaudos().find(item=>item.operationId===original.operationId).reversal,undefined);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,0);
      assert(notice(h).includes('Contagem insuficiente'));
    });
  }
  {
    const h=app(), db=makeFirestoreMock(); h.api.setDb(db);
    const original=await finish(h), id=original.operationId;
    const key='controles_operacoes/'+original.effectsSnapshot.segmentos[0].counterOperationId;
    const ledger=db._store.get(key); db._store.delete(key);
    await reverse(h,id);
    verify('ledger original ausente mantém estorno local pendente sem decremento remoto',()=>{
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status,'pending');
      assert.equal(h.api.tomoStatusFila().comErro,1);
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,1);
      assert.equal(db._store.has('controles_operacoes/'+h.api.tomoReversalId(id)),false);
    });
    db._store.set(key,ledger);
    await h.api.tomoProcessarFila();
    verify('retry com ledger original confirmado usa mesmo ID sem reaplicar efeito local',()=>{
      assert.equal(h.api.getHistoricoLaudos()[0].reversal.status,'confirmed');
      assert.equal(db._store.get('controles_dias/'+DAY).exames.cranio.hbj,0);
      assert.equal(h.api.getDadosApp().exames[DAY].cranio.hbj,0);
    });
  }
  return count;
}
module.exports = { run };
if (require.main === module) run((name, ok)=>{assert.equal(ok,true);console.log('PASS '+name);})
  .then(n=>console.log(n+'/'+n+' checks ok'))
  .catch(e=>{console.error(e);process.exitCode=1;});
