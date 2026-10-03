// Fundação apenas: arrays numéricos legados intactos + mapa paralelo de novas
// identidades. Testamos o script real, a edição real e a fila persistida/reload.
'use strict';
const assert = require('assert');
const { loadApp } = require('./lib/loadApp');
const { makeFirestoreMock } = require('./lib/firestoreMock');
const DAY = '2026-10-02';

async function until(fn) {
  const deadline = performance.now() + 3000;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error('Frame aguardado não foi atingido.');
    await new Promise(resolve => setImmediate(resolve));
  }
}
function setup(options = {}) {
  let id = 0;
  const frames = [];
  const timers = { setInterval() { return ++id; }, clearInterval(){}, setTimeout() { return ++id; } };
  const h = loadApp({ sharedIdb: options.sharedIdb || new Map(), timers, requestAnimationFrame: fn => frames.push(fn) });
  h.frames = frames;
  h.doc.getElementById('data-exame').value = options.day || DAY;
  h.doc.getElementById('timer-servico').value = 'hbj';
  h.checkboxes = (options.segments || ['cranio']).map(value => ({ value, checked: true, closest() { return null; } }));
  h.doc.querySelectorAll = selector => {
    if (selector === '#timer-segmentos-container input:checked') return h.checkboxes.filter(cb => cb.checked);
    if (selector === '#timer-segmentos-container input[type="checkbox"]') return h.checkboxes;
    return [];
  };
  h.api.setTimerState({ currentSeconds: options.duration === undefined ? 120 : options.duration, totalSeconds: 30, isCurrentRunning: true });
  return h;
}
async function finish(h) {
  const p = h.api.finalizarLaudo();
  await until(() => h.frames.length);
  assert.strictEqual(h.api.getFilaInterna().find(op => op.tipo === 'laudo').evento.effectsSnapshot, h.api.getHistoricoLaudos()[0].effectsSnapshot);
  const atFrame = JSON.parse(JSON.stringify(h.api.getFilaInterna()));
  assert.equal(h.api.getTimerState().currentSeconds, 0);
  h.frames.shift()(performance.now());
  await p;
  return atFrame;
}
async function edit(h) {
  h.api.editarLog(0);
  for (const [id, value] of Object.entries({
    'edit-log-data': '2026-01-01', 'edit-log-horario': '11:30', 'edit-log-empresa': 'VX',
    'edit-log-segmentos': 'PELVE', 'edit-log-tempo': '999', 'edit-log-tipo': 'manual'
  })) h.doc.getElementById(id).value = value;
  await h.doc.getElementById('form-editar-log')._listeners.submit[0]({ preventDefault(){} });
}

async function run(check) {
  let count = 0;
  function verify(name, fn) { fn(); count++; check('comprovante: ' + name, true); }

  for (const [name, segments, duration] of [
    ['um segmento', ['cranio'], 120],
    ['dois segmentos', ['torax', 'abd-superior'], 120],
    ['fração sem arredondar', ['cranio', 'torax', 'pelve'], 10],
    ['duração zero', ['cranio', 'torax'], 0]
  ]) {
    const h = setup({ segments, duration });
    const db = makeFirestoreMock(); h.api.setDb(db);
    const queued = await finish(h);
    const item = h.api.getHistoricoLaudos()[0];
    const s = item.effectsSnapshot;
    const evento = queued.find(op => op.tipo === 'laudo').evento;
    verify(name + ': schema versionado, IDs/data/empresa técnica originais', () => {
      assert.equal(item.effectsVersion, 1);
      assert.deepEqual(Object.keys(s).sort(), ['operationId', 'data', 'empresaId', 'segmentos', 'totalDailyDeltaSeconds'].sort());
      assert.equal(s.operationId, item.operationId);
      assert.equal(s.data, DAY);
      assert.equal(s.empresaId, 'hbj');
      assert.deepEqual(s.segmentos.map(e => e.segmentoId), segments);
      assert.equal(s.totalDailyDeltaSeconds, duration);
    });
    verify(name + ': delta de tempo/contagem coincide com estado e fila/ledger', () => {
      for (const e of s.segmentos) {
        assert.equal(e.counterDelta, 1);
        assert.equal(e.counterOperationId, `${item.operationId}:${e.segmentoId}`);
        assert.equal(e.timeContributionId, `${item.operationId}:time:${e.segmentoId}`);
        assert.equal(e.timeSeconds, duration / segments.length);
        const op = queued.find(op => op.operationId === e.counterOperationId);
        assert.equal(op.delta, e.counterDelta);
        assert.equal(op.seg, e.segmentoId); assert.equal(op.serv, s.empresaId);
        assert.equal(db._store.get('controles_operacoes/' + e.counterOperationId).delta, 1);
        assert.equal(h.api.getDadosApp().exames[DAY][e.segmentoId].hbj, 1);
        const tempos = h.api.getDadosApp().tempos[DAY]['hbj_' + e.segmentoId];
        if (duration) assert.deepEqual(tempos, [e.timeSeconds]);
        else assert.equal(tempos, undefined); // não inserir zero muda quantidade/média
      }
      assert.equal(h.api.getTimerState().totalSeconds, 30 + duration);
      assert.equal(h.sharedIdb.get('totalAcumulado_' + DAY), String(30 + duration));
    });
    verify(name + ': snapshot profundamente congelado e campos do histórico protegidos', () => {
      assert.equal(Object.isFrozen(s), true);
      assert.equal(Object.isFrozen(s.segmentos), true);
      assert.equal(Object.isFrozen(s.segmentos[0]), true);
      assert.equal(Reflect.set(s, 'empresaId', 'vx'), false);
      assert.equal(Reflect.set(s.segmentos[0], 'timeSeconds', 999), false);
      for (const field of ['operationId', 'effectsVersion', 'effectsSnapshot']) assert.equal(Reflect.set(item, field, null), false);
    });
    verify(name + ': snapshot completo/data no evento e persistência local/mensal', () => {
      assert.equal(evento.data, DAY);
      assert.deepEqual(evento.effectsSnapshot, s);
      assert.equal(evento.effectsVersion, 1);
      assert.deepEqual(db._store.get(`controles_dias/${DAY}/laudos/${item.operationId}`).effectsSnapshot, s);
      assert.deepEqual(JSON.parse(h.sharedIdb.get('historicoLaudos'))[0].effectsSnapshot, s);
      const salvo = JSON.parse(h.sharedIdb.get('examesTomografia'));
      assert.deepEqual(salvo.timeContributions, h.api.getDadosApp().timeContributions);
      assert.deepEqual(db._store.get('controles/examesTomografia_2026-10').timeContributions, salvo.timeContributions);
      assert.equal(h.api.tomoStatusFila().total, 0);
    });
    verify(name + ': identidade local permite localização exata ou ausência de amostra zero', () => {
      for (const e of s.segmentos) {
        const c = h.api.getDadosApp().timeContributions[DAY][e.timeContributionId];
        assert.equal(c.operationId, s.operationId);
        assert.equal(c.sampleIndex, duration ? 0 : null);
        const pos = h.api.tomoLocalizarContribuicaoTempo(h.api.getDadosApp(), DAY, e.timeContributionId);
        if (duration) assert.deepEqual(pos, { key: 'hbj_' + e.segmentoId, sampleIndex: 0, timeSeconds: e.timeSeconds, operationId: s.operationId });
        else assert.equal(pos, null);
      }
    });
    const before = JSON.stringify(s);
    await edit(h);
    verify(name + ': submit real edita apresentação sem modificar capture/IDs/contribuições', () => {
      const edited = h.api.getHistoricoLaudos()[0];
      assert.equal(edited.empresa, 'VX'); assert.equal(edited.tempo, 999); assert.equal(edited.tipo, 'manual');
      assert.deepEqual(edited.segmentos, ['PELVE']); assert.equal(edited.data, '2026-01-01');
      assert.equal(edited.operationId, s.operationId);
      assert.strictEqual(edited.effectsSnapshot, s);
      assert.equal(JSON.stringify(edited.effectsSnapshot), before);
      assert.equal(Object.getOwnPropertyDescriptor(edited, 'effectsSnapshot').writable, false);
      assert.deepEqual(JSON.parse(h.sharedIdb.get('historicoLaudos'))[0].effectsSnapshot, s);
      assert.deepEqual(h.api.getDadosApp().timeContributions[DAY], JSON.parse(h.sharedIdb.get('examesTomografia')).timeContributions[DAY]);
    });
  }

  // Valores iguais no legado: o ID aponta a NOVA posição, não o primeiro 60 encontrado.
  {
    const h = setup({ duration: 60 });
    h.api.getDadosApp().tempos[DAY] = { hbj_cranio: [60, 20, 60] };
    h.api.setDb(makeFirestoreMock());
    await finish(h);
    const data = h.api.getDadosApp(); const s = h.api.getHistoricoLaudos()[0].effectsSnapshot;
    const e = s.segmentos[0];
    verify('legado mantido e nova contribuição identificada pelo índice exato', () => {
      assert.deepEqual(data.tempos[DAY].hbj_cranio, [60, 20, 60, 60]);
      assert.equal(data.tempos[DAY].hbj_cranio.every(v => typeof v === 'number'), true);
      assert.equal(Object.keys(data.timeContributions[DAY]).length, 1);
      assert.equal(h.api.tomoLocalizarContribuicaoTempo(data, DAY, e.timeContributionId).sampleIndex, 3);
    });
    verify('mesma identidade não adiciona segunda amostra', () => {
      h.api.tomoAdicionarContribuicaoTempo(data, s, e);
      assert.deepEqual(data.tempos[DAY].hbj_cranio, [60, 20, 60, 60]);
    });
    verify('quantidade/soma/média e estatísticas permanecem exatamente numéricas', () => {
      const arr = data.tempos[DAY].hbj_cranio;
      assert.equal(arr.length, 4);
      assert.equal(arr.reduce((a, b) => a + b, 0), 200);
      assert.equal(arr.reduce((a, b) => a + b, 0) / arr.length, 50);
      const date = new Date(DAY + 'T12:00:00');
      const stats = h.api.getStatsByService(date, date);
      assert.equal(stats.hbj.totalTempo, 200);
      assert.equal(stats.hbj.totalValor, 100); // 4 amostras x R$25 (regra existente)
      h.api.atualizarGraficos();
    });
    verify('locator não adivinha amostra quando o índice deixa de ser válido', () => {
      const quebrado = JSON.parse(JSON.stringify(data));
      quebrado.tempos[DAY].hbj_cranio[3] = 123;
      assert.equal(h.api.tomoLocalizarContribuicaoTempo(quebrado, DAY, e.timeContributionId), null);
      assert.equal(h.api.tomoLocalizarContribuicaoTempo(data, DAY, 'sem-identidade'), null);
    });
  }

  // Falha remota + reload: fila de verdade, snapshot serializado, nenhum ID novo.
  {
    const h = setup({ segments: ['cranio', 'torax'] });
    const db = makeFirestoreMock();
    let firstTransaction = true;
    function coll(ref) { return { ...ref, doc(id) { return doc(ref.doc(id)); } }; }
    function doc(ref) { return { ...ref, _raw: ref, collection(name) { return coll(ref.collection(name)); }, async set(...args) {
      if (ref.path.includes('/laudos/')) throw new Error('evento offline simulado');
      return ref.set(...args);
    } }; }
    h.api.setDb({ collection(name) { return coll(db.collection(name)); }, async runTransaction(fn) {
      if (firstTransaction) { firstTransaction = false; throw new Error('transação offline simulada'); }
      return db.runTransaction(tx => fn({ get(ref) { return tx.get(ref._raw || ref); }, set(ref, ...args) { return tx.set(ref._raw || ref, ...args); } }));
    } });
    await finish(h);
    const item = h.api.getHistoricoLaudos()[0];
    const savedQueue = JSON.parse(h.sharedIdb.get('tomoFilaOperacoes'));
    const snapshot = JSON.parse(JSON.stringify(item.effectsSnapshot));
    verify('falha conserva contador/evento pendentes e comprovante original', () => {
      assert.equal(savedQueue.length, 2);
      assert.equal(savedQueue.find(op => op.tipo === 'contador').operationId, snapshot.segmentos[0].counterOperationId);
      assert.deepEqual(savedQueue.find(op => op.tipo === 'laudo').evento.effectsSnapshot, snapshot);
    });
    const reloaded = setup({ sharedIdb: h.sharedIdb });
    await reloaded.api.carregarDados(); // offline: somente dados locais/fila, nada migrado
    const loadedItem = reloaded.api.getHistoricoLaudos()[0];
    verify('reload protege novamente comprovante e mantém localização numérica', () => {
      assert.deepEqual(loadedItem.effectsSnapshot, snapshot);
      assert.equal(Object.isFrozen(loadedItem.effectsSnapshot.segmentos[0]), true);
      assert.equal(Reflect.set(loadedItem, 'operationId', 'novo-id'), false);
      assert.equal(Object.isFrozen(reloaded.api.getFilaInterna().find(op => op.tipo === 'laudo').evento.effectsSnapshot), true);
      for (const e of snapshot.segmentos) assert.equal(reloaded.api.tomoLocalizarContribuicaoTempo(reloaded.api.getDadosApp(), DAY, e.timeContributionId).sampleIndex, 0);
    });
    reloaded.api.setDb(db);
    await reloaded.api.tomoProcessarFila();
    await reloaded.api.tomoProcessarFila();
    verify('retry após reload reusa IDs/snapshot, sem duplicar tempo/contagem/evento', () => {
      assert.equal(reloaded.api.tomoStatusFila().total, 0);
      assert.deepEqual(db._store.get(`controles_dias/${DAY}/laudos/${snapshot.operationId}`).effectsSnapshot, snapshot);
      assert.equal(db._store.get(`controles_dias/${DAY}/laudos/${snapshot.operationId}`).data, DAY);
      assert.equal(db._store.get('controles_dias/' + DAY).exames.cranio.hbj, 1);
      assert.equal(db._store.get('controles_dias/' + DAY).exames.torax.hbj, 1);
      assert.equal([...db._store.keys()].filter(key => key.includes('/laudos/')).length, 1);
      assert.equal([...db._store.keys()].filter(key => key.startsWith('controles_operacoes/')).length, 2);
      assert.deepEqual(reloaded.api.getDadosApp().tempos[DAY].hbj_cranio, [60]);
      assert.deepEqual(reloaded.api.getDadosApp().tempos[DAY].hbj_torax, [60]);
    });
    await edit(reloaded);
    verify('edição depois do reload não altera efeitos persistidos', () => {
      assert.deepEqual(reloaded.api.getHistoricoLaudos()[0].effectsSnapshot, snapshot);
      assert.equal(Reflect.set(reloaded.api.getHistoricoLaudos()[0], 'effectsVersion', 99), false);
    });
    const eventos = await reloaded.api.tomoBuscarLaudosCrossPC(db, 100);
    const view = reloaded.api.montarHistoricoVisual(reloaded.api.getHistoricoLaudos(), eventos);
    verify('histórico cross-PC transporta comprovante sem expor payload na tela', () => {
      assert.deepEqual(view[0].effectsSnapshot, snapshot);
      assert.equal(view[0].effectsVersion, 1);
      reloaded.api.tomoRenderizarHistorico(view);
      const html = reloaded.doc.getElementById('log-lista').innerHTML;
      assert.equal(html.includes('Estornar laudo'), true);
      assert.equal(html.includes('effectsSnapshot'), false);
    });
    delete db._store.get('controles/examesTomografia_2026-10').timeContributions;
    reloaded.api.getMesesSujos().add('2026-10');
    await reloaded.api.salvarDadosFirebaseSilencioso();
    verify('save silencioso preserva mapa paralelo no mês', () => {
      assert.deepEqual(db._store.get('controles/examesTomografia_2026-10').timeContributions, reloaded.api.getDadosApp().timeContributions);
    });
    // PC sem estado: loader mensal copia mapa SOMENTE com os arrays desse dia.
    const other = setup(); other.api.setDb(db); await other.api.carregarDados();
    verify('loader mensal carrega números e suas identidades sem regenerar', () => {
      assert.deepEqual(other.api.getDadosApp().timeContributions, reloaded.api.getDadosApp().timeContributions);
      assert.deepEqual(other.api.getDadosApp().tempos[DAY].hbj_cranio, [60]);
    });
    const legacyPc = setup();
    legacyPc.api.getDadosApp().tempos[DAY] = { hbj_cranio: [999] };
    await legacyPc.api.tomoEnsureStorage();
    await legacyPc.api.idbLocalStorage.setItemAsync('examesTomografia', JSON.stringify(legacyPc.api.getDadosApp()));
    legacyPc.api.setDb(db); await legacyPc.api.carregarDados();
    verify('merge não associa índice remoto a um array local diferente', () => {
      assert.deepEqual(legacyPc.api.getDadosApp().tempos[DAY].hbj_cranio, [999]);
      assert.equal(legacyPc.api.getDadosApp().timeContributions, undefined);
    });
  }

  // Legado sem snapshot/data: sem backfill, nem alteração de eventos antigos.
  {
    const h = setup(); const db = makeFirestoreMock();
    const legacyEvent = { empresa: 'HBJ', segmentos: ['TORAX'], tempo: 90, tipo: 'cronometro', operationId: 'antigo', timestamp: 1000 };
    await h.api.tomoGravarEventoLaudo(db, 'antigo', DAY, legacyEvent);
    const events = await h.api.tomoBuscarLaudosCrossPC(db, 100);
    verify('evento antigo sem data/comprovante continua carregando e renderizando sem backfill', () => {
      assert.deepEqual(events[0], legacyEvent);
      const view = h.api.montarHistoricoVisual([], events); h.api.tomoRenderizarHistorico(view);
      assert.equal(view[0].effectsSnapshot, undefined);
      assert.equal(h.doc.getElementById('log-lista').innerHTML.includes('TORAX'), true);
      assert.deepEqual(db._store.get(`controles_dias/${DAY}/laudos/antigo`), legacyEvent);
    });
    const legacyLog = [{ data: DAY, empresa: 'HBJ', segmentos: ['CRÂNIO'], tempo: 30, tipo: 'cronometro', timestamp: 1 }];
    await h.api.tomoEnsureStorage();
    await h.api.idbLocalStorage.setItemAsync('historicoLaudos', JSON.stringify(legacyLog));
    h.api.setHistoricoLaudos([]); h.api.atualizarLog();
    await edit(h);
    verify('edição de histórico antigo não inventa snapshot ou versão', () => {
      assert.equal(Object.hasOwn(h.api.getHistoricoLaudos()[0], 'effectsSnapshot'), false);
      assert.equal(Object.hasOwn(h.api.getHistoricoLaudos()[0], 'effectsVersion'), false);
    });
  }

  // Backup/normalização/restore devem transportar o mapa junto com os números.
  {
    const h = setup(); h.api.setDb(null); await finish(h);
    const data = h.api.getDadosApp(); const item = h.api.getHistoricoLaudos()[0];
    const payload = JSON.parse(JSON.stringify({ dadosApp: data, historicoLaudos: [item] }));
    const valid = h.api.validateBackupPayload(payload);
    const norm = h.api.normalizarBackupPayload(payload, valid.formato);
    verify('backup novo validado/normalizado conserva mapa e snapshot imutável', () => {
      assert.equal(valid.ok, true, valid.errors.join(', '));
      assert.deepEqual(norm.dadosApp.timeContributions, data.timeContributions);
      assert.deepEqual(norm.historicoLaudos[0].effectsSnapshot, item.effectsSnapshot);
      assert.equal(Reflect.set(norm.historicoLaudos[0], 'effectsSnapshot', null), false);
    });
    verify('backup legado continua válido, sem identidade inventada', () => {
      const old = { exames: { [DAY]: { cranio: { hbj: 1 } } }, tempos: { [DAY]: { hbj_cranio: [30, 60] } }, pagamentos: {} };
      const v = h.api.validateBackupPayload(old); assert.equal(v.ok, true);
      const n = h.api.normalizarBackupPayload(old, v.formato);
      assert.deepEqual(n.dadosApp, old);
      assert.equal(Object.hasOwn(n.dadosApp, 'timeContributions'), false);
    });
    verify('backup novo rejeita identidade/índice/comprovante inconsistentes', () => {
      const bad = JSON.parse(JSON.stringify(payload));
      bad.historicoLaudos[0].effectsSnapshot.segmentos[0].counterOperationId = 'id-errado';
      assert.equal(h.api.validateBackupPayload(bad).ok, false);
      const badIndex = JSON.parse(JSON.stringify(payload));
      Object.values(badIndex.dadosApp.timeContributions[DAY])[0].sampleIndex = 999;
      assert.equal(h.api.validateBackupPayload(badIndex).ok, false);
    });
    verify('merge de backup acompanha arrays novos e não herda índices para legado substituído', () => {
      const next = h.api.mesclarBackupPorData(data, { exames: {}, tempos: { [DAY]: { hbj_cranio: [20] } }, pagamentos: {} });
      assert.deepEqual(next.tempos[DAY].hbj_cranio, [20]);
      assert.equal(next.timeContributions, undefined);
      const restored = h.api.mesclarBackupPorData({ exames: {}, tempos: {}, pagamentos: {} }, data);
      assert.deepEqual(restored.timeContributions, data.timeContributions);
      const untouched = h.api.mesclarBackupPorData(data, { exames: {}, tempos: { '2026-01-01': { hbj_torax: [50] } }, pagamentos: {} });
      assert.deepEqual(untouched.timeContributions[DAY], data.timeContributions[DAY]);
    });
    verify('nenhum estorno/tipo novo ou delta negativo é gerado', () => {
      const queue = h.api.getFilaInterna();
      assert.deepEqual(queue.map(op => op.tipo), ['contador', 'laudo']);
      assert.equal(queue[0].delta, 1);
      assert.equal(data.exames[DAY].cranio.hbj, 1);
      assert.deepEqual(data.tempos[DAY].hbj_cranio, [120]);
    });
  }
  {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const h = setup({ day: today }); h.api.setDb(null); await finish(h);
    await h.api.criarBackupAutomatico();
    verify('backup automático inclui identidade somente com os dias de tempos copiados', () => {
      const backup = JSON.parse(h.sharedIdb.get('historico_backups_tomografia'))[0].conteudo;
      assert.deepEqual(backup.timeContributions[today], h.api.getDadosApp().timeContributions[today]);
      assert.equal(h.api.validateBackupPayload({ conteudo: backup }).ok, true);
    });
  }
  return count;
}
module.exports = { run };
if (require.main === module) run((name, ok) => { assert.equal(ok, true); console.log('PASS ' + name); })
  .then(count => console.log(count + '/' + count + ' checks ok'))
  .catch(error => { console.error(error); process.exitCode = 1; });
