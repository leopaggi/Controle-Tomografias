'use strict';
const assert = require('assert');
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function until(fn) {
  const deadline = performance.now() + 3000;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error('Etapa esperada não foi atingida.');
    await new Promise(resolve => setImmediate(resolve));
  }
}
function clock() {
  let sequence = 0;
  const active = new Map();
  return {
    active,
    setInterval(fn) { const id = ++sequence; active.set(id, fn); return id; },
    clearInterval(id) { active.delete(id); },
    setTimeout() { return ++sequence; },
    tick() { for (const fn of active.values()) fn(); }
  };
}
function setup(options = {}) {
  const timers = clock();
  const frames = [];
  const h = loadApp({ timers, requestAnimationFrame: fn => frames.push(fn) });
  h.timers = timers;
  h.frames = frames;
  h.doc.getElementById('data-exame').value = '2026-10-02';
  h.doc.getElementById('timer-servico').value = 'hbj';
  h.doc.getElementById('btn-finalizar-laudo').textContent = '✅ Finalizar Laudo';
  h.checkboxes = (options.segments || ['cranio', 'torax']).map(value => ({ value, checked: true, closest() { return null; } }));
  h.doc.querySelectorAll = selector => {
    if (selector === '#timer-segmentos-container input:checked') return h.checkboxes.filter(cb => cb.checked);
    if (selector === '#timer-segmentos-container input[type="checkbox"]') return h.checkboxes;
    return [];
  };
  h.api.setTimerState({ currentSeconds: 120, totalSeconds: 30, isCurrentRunning: options.running !== false });
  h.api.startCurrentTimer();
  return h;
}
function controlledDb(options = {}) {
  const real = makeFirestoreMock();
  const gates = { transaction: deferred(), event: deferred(), month: deferred(), principal: deferred() };
  const calls = { transaction: 0, event: 0, month: 0, principal: 0 };
  const raw = ref => ref._raw || ref;
  function collection(ref) { return { ...ref, doc(id) { return documentRef(ref.doc(id)); } }; }
  function documentRef(ref) {
    return {
      ...ref, _raw: ref,
      collection(name) { return collection(ref.collection(name)); },
      async set(...args) {
        const stage = ref.path.includes('/laudos/') ? 'event' : ref.path.endsWith('/examesTomografia') ? 'principal' : 'month';
        calls[stage]++;
        await gates[stage].promise;
        if (options.fail === stage) throw new Error('falha remota simulada: ' + stage);
        return ref.set(...args);
      }
    };
  }
  const db = {
    collection(name) { return collection(real.collection(name)); },
    async runTransaction(fn) {
      calls.transaction++;
      await gates.transaction.promise;
      if (options.fail === 'transaction') throw new Error('falha remota simulada: transação');
      return real.runTransaction(tx => fn({
        get(ref) { return tx.get(raw(ref)); },
        set(ref, ...args) { return tx.set(raw(ref), ...args); }
      }));
    }
  };
  return { db, real, gates, calls, release() { Object.values(gates).forEach(g => g.resolve()); } };
}
function notifications(h) { return h.doc.body.children.map(el => el.textContent).join('\n'); }
function finishFrame(h) { h.frames.shift()(performance.now()); }

async function run(check) {
  let assertions = 0;
  function verify(name, fn) { fn(); assertions++; check('finalização: ' + name, true); }

  // Promises remotas controladas: provar a ordem sem depender de sleeps ou
  // apenas contar awaits no texto. O timer de teste avança deterministicamente.
  {
    const h = setup();
    const remote = controlledDb();
    h.api.setDb(remote.db);
    h.api.getDadosApp().exames['2026-10-01'] = { pelve: { vx: 7 } };
    h.api.getDadosApp().tempos['2026-10-01'] = { vx_pelve: [90] };
    h.api.getDadosApp().pagamentos['2026-10'] = { vx: true };
    // Observar criação de cards no DOM mock sem instrumentar a aplicação.
    const grid = h.doc.getElementById('empresas-resumo-grid');
    const appendCard = grid.appendChild;
    let cardsCriados = 0;
    grid.appendChild = function(card) { cardsCriados++; return appendCard.call(this, card); };
    await h.api.tomoEnsureStorage();
    let settled = false;
    const p = h.api.finalizarLaudo().then(() => { settled = true; });
    verify('intervalo para imediatamente, antes do primeiro await', () => assert.equal(h.timers.active.size, 0));
    verify('botão e data bloqueados durante operação', () => {
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, true);
      assert.equal(h.doc.getElementById('data-exame').disabled, true);
      assert.equal(h.api.getFinalizacaoEmAndamento(), true);
    });
    await h.api.finalizarLaudo(); // mesmo que chamado diretamente, não só pelo botão
    await until(() => h.frames.length);
    verify('segundo clique não gera log ou operations adicionais', () => {
      assert.equal(h.api.getHistoricoLaudos().length, 1);
      assert.equal(h.api.getFilaInterna().length, 3);
      assert.equal(new Set(h.api.getFilaInterna().map(op => op.operationId)).size, 3);
    });
    verify('duração, total e seleções capturados antes do reset', () => {
      const log = h.api.getHistoricoLaudos()[0];
      assert.equal(log.tempo, 120);
      assert.deepEqual(log.segmentos, ['CRÂNIO', 'TORAX']);
      assert.equal(h.api.getTimerState().currentSeconds, 0);
      assert.equal(h.api.getTimerState().totalSeconds, 150);
      assert.equal(h.checkboxes.every(cb => !cb.checked), true);
    });
    verify('UI atualizada antes de iniciar a fila remota', () => {
      assert.equal(h.doc.getElementById('current-timer-display').textContent, '00:00:00');
      assert.equal(h.doc.getElementById('total-timer-display').textContent, '00:02:30');
      assert.equal(h.doc.getElementById('total-exames-dia').textContent, '2 exames');
      assert.equal(h.doc.getElementById('exams-body').children.length, 13);
      assert.equal(remote.calls.transaction, 0);
      assert.equal(settled, false);
    });
    verify('fila, dataset, log e total confirmados no armazenamento antes do reset', () => {
      const saved = JSON.parse(h.sharedIdb.get('examesTomografia'));
      assert.equal(saved.exames['2026-10-02'].cranio.hbj, 1);
      assert.deepEqual(saved.tempos['2026-10-02'].hbj_cranio, [60]);
      assert.deepEqual(saved.tempos['2026-10-02'].hbj_torax, [60]);
      assert.equal(JSON.parse(h.sharedIdb.get('tomoFilaOperacoes')).length, 3);
      assert.equal(JSON.parse(h.sharedIdb.get('historicoLaudos'))[0].tempo, 120);
      assert.equal(h.sharedIdb.get('totalAcumulado_2026-10-02'), '150');
    });
    verify('captura do evento e seus segmentos são imutáveis', () => {
      const evento = h.api.getFilaInterna().find(op => op.tipo === 'laudo').evento;
      assert.equal(Object.isFrozen(evento), true);
      assert.equal(Object.isFrozen(evento.segmentos), true);
    });
    verify('snapshot antecipado preserva outros dias, tempos e pagamentos', () => {
      const saved = JSON.parse(h.sharedIdb.get('examesTomografia'));
      assert.deepEqual(saved.exames['2026-10-01'], { pelve: { vx: 7 } });
      assert.deepEqual(saved.tempos['2026-10-01'], { vx_pelve: [90] });
      assert.deepEqual(saved.pagamentos['2026-10'], { vx: true });
    });
    // Simula controles visuais já diferentes para o próximo trabalho.
    h.doc.getElementById('timer-servico').value = 'vx';
    h.checkboxes[0].value = 'pelve';
    finishFrame(h);
    await until(() => remote.calls.transaction);
    h.timers.tick(); h.timers.tick();
    verify('timer não cresce durante espera remota e handler aguarda a fila', () => {
      assert.equal(h.api.getTimerState().currentSeconds, 0);
      assert.equal(settled, false);
      assert.equal(remote.calls.month, 0);
    });
    remote.gates.transaction.resolve();
    await until(() => remote.calls.event);
    verify('evento também é awaited dentro da fila', () => {
      assert.equal(settled, false);
      assert.equal(remote.calls.month, 0);
    });
    remote.gates.event.resolve();
    await until(() => remote.calls.month);
    verify('save mensal continua awaited', () => {
      assert.equal(settled, false);
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, true);
    });
    remote.gates.month.resolve();
    await until(() => remote.calls.principal);
    verify('save principal continua awaited', () => assert.equal(settled, false));
    remote.gates.principal.resolve();
    await p;
    verify('persistência usa duração/empresa/segmentos originais após limpeza visual', () => {
      const events = [...remote.real._store.entries()].filter(([key]) => key.includes('/laudos/'));
      assert.equal(events.length, 1);
      assert.equal(events[0][1].tempo, 120);
      assert.equal(events[0][1].empresa, 'HBJ');
      assert.deepEqual(events[0][1].segmentos, ['CRÂNIO', 'TORAX']);
      assert.equal(remote.real._store.get('controles_dias/2026-10-02').exames.cranio.hbj, 1);
      assert.equal(remote.real._store.get('controles_dias/2026-10-02').exames.pelve, undefined);
      assert.deepEqual(remote.real._store.get('controles/examesTomografia_2026-10').tempos['2026-10-02'].hbj_cranio, [60]);
      assert.equal(h.api.tomoStatusFila().total, 0);
    });
    verify('botão/data/trava restaurados no sucesso e somente um timer retoma', () => {
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, false);
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').textContent, '✅ Finalizar Laudo');
      assert.equal(h.doc.getElementById('data-exame').disabled, false);
      assert.equal(h.api.getFinalizacaoEmAndamento(), false);
      assert.equal(h.timers.active.size, 1);
      h.timers.tick();
      assert.equal(h.api.getTimerState().currentSeconds, 1);
    });
    verify('resumo não é renderizado duas vezes pela finalização', () => {
      assert.equal(cardsCriados, 9);
    });
    h.api.resetCurrentTimer();
    h.api.togglePauseCurrentTimer();
    h.timers.tick();
    verify('reset/pausa/retomada posteriores continuam funcionando', () => {
      assert.equal(h.api.getTimerState().currentSeconds, 0);
      h.api.togglePauseCurrentTimer(); h.timers.tick();
      assert.equal(h.api.getTimerState().currentSeconds, 1);
      h.api.startCurrentTimer();
      assert.equal(h.timers.active.size, 1);
    });
  }

  // Falhas em todas as fronteiras remotas: IDs originais ficam na fila
  // quando necessário, sem sucesso falso só porque o legado foi salvo.
  for (const stage of ['transaction', 'event', 'month', 'principal']) {
    const h = setup({ segments: ['cranio'], running: false });
    const remote = controlledDb({ fail: stage });
    remote.release(); h.api.setDb(remote.db);
    const p = h.api.finalizarLaudo();
    await until(() => h.frames.length);
    const originalIds = h.api.getFilaInterna().map(op => op.operationId);
    finishFrame(h); await p;
    verify(stage + ': falha reativa botão e mantém duração/dados locais', () => {
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, false);
      assert.equal(h.api.getFinalizacaoEmAndamento(), false);
      assert.equal(h.api.getHistoricoLaudos()[0].tempo, 120);
      assert.equal(h.api.getHistoricoLaudos().length, 1);
      assert.equal(JSON.parse(h.sharedIdb.get('examesTomografia')).exames['2026-10-02'].cranio.hbj, 1);
      assert.deepEqual(h.api.getDadosApp().tempos['2026-10-02'].hbj_cranio, [120]);
      assert.equal(notifications(h).includes('✅ Laudo finalizado!'), false);
      assert.equal(h.timers.active.size, 1);
    });
    verify(stage + ': fila ou dirty flags preservam pendência real', () => {
      if (stage === 'transaction' || stage === 'event') {
        assert.equal(h.api.tomoStatusFila().comErro, 1);
        const savedQueue = JSON.parse(h.sharedIdb.get('tomoFilaOperacoes'));
        assert.equal(savedQueue.length, 1);
        assert.equal(originalIds.includes(savedQueue[0].operationId), true);
        assert.equal(savedQueue[0].status, 'erro');
        assert.equal(notifications(h).includes('operação pendente na fila'), true);
        assert.equal(h.doc.getElementById('sync-status').classList.contains('sync-warning'), true);
      } else {
        assert.equal(h.api.tomoStatusFila().total, 0);
        assert.equal(h.api.getDadosSujos(), true);
        if (stage === 'month') assert.equal(h.api.getMesesSujos().has('2026-10'), true);
      }
    });
    // Retry pela arquitetura existente, SEM uma segunda finalizarLaudo.
    h.api.setDb(remote.real);
    await h.api.tomoProcessarFila();
    await h.api.salvarDadosFirebaseSilencioso();
    verify(stage + ': retry mantém ID, não duplica laudo/contador e esvazia pendências', () => {
      assert.equal(h.api.tomoStatusFila().total, 0);
      assert.equal(h.api.getDadosSujos(), false);
      assert.equal(remote.real._store.get('controles_dias/2026-10-02').exames.cranio.hbj, 1);
      assert.equal([...remote.real._store.keys()].filter(key => key.includes('/laudos/')).length, 1);
    });
  }

  // Falha local escondida pelo helper: confirmação direta deve barrar reset.
  for (const key of ['historicoLaudos', 'totalAcumulado_2026-10-02', 'tomoFilaOperacoes', 'examesTomografia']) {
    const h = setup({ segments: ['cranio'] });
    await h.api.tomoEnsureStorage();
    const put = h.api.idbLocalStorage.setItemAsync;
    h.api.idbLocalStorage.setItemAsync = async function(k, ...args) {
      if (k === key) throw new Error('falha local simulada: ' + key);
      return put.call(this, k, ...args);
    };
    const remote = controlledDb(); h.api.setDb(remote.db);
    await h.api.finalizarLaudo();
    verify(key + ': falha local preserva timer/seleção/fila em memória sem reset ou envio', () => {
      assert.equal(h.api.getTimerState().currentSeconds, 120);
      assert.equal(h.checkboxes[0].checked, true);
      assert.equal(h.api.getFilaInterna().length, 2);
      assert.equal(h.api.getHistoricoLaudos()[0].tempo, 120);
      assert.equal(remote.calls.transaction, 0);
      assert.equal(h.frames.length, 0);
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, false);
      assert.equal(h.api.getFinalizacaoEmAndamento(), false);
      assert.equal(notifications(h).includes('Finalização com falha'), true);
    });
  }

  // Exceção inesperada na fila: ainda aguardar o save final, preservar os IDs.
  {
    const h = setup({ segments: ['cranio'] });
    const remote = controlledDb(); h.api.setDb(remote.db);
    let settled = false;
    const p = h.api.finalizarLaudo().then(() => { settled = true; });
    await until(() => h.frames.length);
    const ids = h.api.getFilaInterna().map(op => op.operationId);
    h.api.getFilaInterna().slice = () => { throw new Error('exceção inesperada da fila simulada'); };
    finishFrame(h);
    await until(() => remote.calls.month);
    verify('exceção da fila não pula nem deixa de aguardar save final', () => {
      assert.equal(settled, false);
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, true);
      assert.deepEqual(h.api.getFilaInterna().map(op => op.operationId), ids);
    });
    remote.gates.month.resolve(); remote.gates.principal.resolve(); await p;
    verify('exceção da fila conserva snapshot e libera trava sem recriar laudo', () => {
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, false);
      assert.equal(h.api.getFinalizacaoEmAndamento(), false);
      assert.equal(h.api.getHistoricoLaudos().length, 1);
      assert.equal(JSON.parse(h.sharedIdb.get('tomoFilaOperacoes')).length, 2);
      assert.equal(notifications(h).includes('operação pendente na fila'), true);
    });
  }

  // Falha local final depois do reset: finally não deixa botão travado.
  {
    const h = setup({ segments: ['cranio'] });
    const remote = controlledDb(); remote.release(); h.api.setDb(remote.db);
    await h.api.tomoEnsureStorage();
    const p = h.api.finalizarLaudo();
    await until(() => h.frames.length);
    const put = h.api.idbLocalStorage.setItemAsync;
    h.api.idbLocalStorage.setItemAsync = async function(key, ...args) {
      if (key === 'examesTomografia') throw new Error('falha local final simulada');
      return put.call(this, key, ...args);
    };
    finishFrame(h); await p;
    verify('erro local final após UI mantém captura persistida anterior e reativa botão', () => {
      assert.equal(JSON.parse(h.sharedIdb.get('examesTomografia')).tempos['2026-10-02'].hbj_cranio[0], 120);
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, false);
      assert.equal(h.api.getFinalizacaoEmAndamento(), false);
      assert.equal(notifications(h).includes('Captura local anterior preservada'), true);
    });
  }
  {
    const h = setup({ segments: ['cranio'] });
    h.api.setDb(null);
    const p = h.api.finalizarLaudo();
    await until(() => h.frames.length); finishFrame(h); await p;
    verify('offline guarda ambas operações e não reporta sucesso remoto', () => {
      assert.equal(JSON.parse(h.sharedIdb.get('tomoFilaOperacoes')).length, 2);
      assert.equal(h.api.tomoStatusFila().pendentes, 2);
      assert.equal(notifications(h).includes('✅ Laudo finalizado!'), false);
      assert.equal(h.doc.getElementById('btn-finalizar-laudo').disabled, false);
    });
  }

  // Regression df8f91e: +/- continuam mostrando UI antes de rede e aguardando
  // incremento + save silencioso, inclusive sem criar evento de cronômetro.
  for (const delta of [1, -1]) {
    const h = setup({ segments: ['cranio'] });
    h.api.getDadosApp().exames['2026-10-02'] = { cranio: { hbj: 2 } };
    const remote = controlledDb(); h.api.setDb(remote.db);
    let settled = false;
    const p = h.api.alterarContador('cranio', 'hbj', delta).then(() => { settled = true; });
    await until(() => remote.calls.transaction);
    verify('+/- ' + delta + ': UI/estado local antecedem transação remota', () => {
      assert.equal(h.api.getDadosApp().exames['2026-10-02'].cranio.hbj, 2 + delta);
      assert.equal(h.doc.getElementById('total-exames-dia').textContent, (2 + delta) + ' exames');
      assert.equal(settled, false);
    });
    remote.gates.transaction.resolve();
    await until(() => remote.calls.month);
    verify('+/- ' + delta + ': save silencioso permanece awaited', () => assert.equal(settled, false));
    remote.gates.month.resolve(); await p;
    verify('+/- ' + delta + ': exatamente uma transação, sem evento de cronômetro', () => {
      assert.equal(remote.calls.transaction, 1);
      assert.equal(remote.calls.event, 0);
      assert.equal(h.api.tomoStatusFila().total, 0);
    });
  }
  return assertions;
}

module.exports = { run };
if (require.main === module) {
  run((name, ok) => { assert.equal(ok, true); console.log('PASS ' + name); })
    .then(count => console.log(count + '/' + count + ' checks ok'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
