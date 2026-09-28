// Mock de Firestore (compat-like) o suficiente para exercitar o núcleo
// multi-PC real de index.html: collection/doc/get/set/update, subcoleções
// (controles_dias/{dia}/laudos/{id}), runTransaction (get -> set/update
// aplicados após a função da transação terminar, sem contention real — o
// próprio processo Node é single-thread e o código sob teste sempre faz
// todos os tx.get() antes de qualquer tx.set()/tx.update()), collectionGroup
// com orderBy/limit, e o sentinela `tomoIncrementValue` (delta relativo ao
// valor atual) usado quando o SDK real do Firebase não está carregado.
'use strict';

function deepClone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function resolveValue(current, val){
  if (val && typeof val === 'object' && !Array.isArray(val) && Object.prototype.hasOwnProperty.call(val, '__tomoIncrement')) {
    const base = typeof current === 'number' ? current : 0;
    return base + val.__tomoIncrement;
  }
  return val;
}

// Aplica cada chave de `data` em `existing`, andando/criando o caminho
// aninhado quando a chave usa dot-notation (ex.: "exames.torax.hbj").
// Usada tanto por update() (exige doc existente) quanto por set(...,
// {merge:true}) (cria o doc se preciso) — mesma semântica do Firestore real
// para chaves em dot-notation.
function applyFieldPaths(existing, data){
  const out = deepClone(existing) || {};
  for (const key of Object.keys(data)) {
    const parts = key.split('.');
    let obj = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    obj[lastKey] = resolveValue(obj[lastKey], data[key]);
  }
  return out;
}

function makeFirestoreMock(opts = {}){
  const store = new Map(); // "coll/doc[/subcoll/doc...]" -> plain object
  const failPaths = new Set(opts.failPaths || []); // caminhos que sempre lançam erro em get/set/update
  const log = opts.log || [];

  function checkFail(path, op){
    if (failPaths.has(path)) {
      log.push([op, path, 'fail']);
      throw new Error(`firestore indisponível (mock): ${op} ${path}`);
    }
    log.push([op, path, 'ok']);
  }

  function makeDocRef(path){
    return {
      id: path.split('/').pop(),
      path,
      async get(){
        checkFail(path, 'get');
        const data = store.get(path);
        return { exists: data !== undefined, id: path.split('/').pop(), data: () => deepClone(data) };
      },
      async set(data, opts2){
        checkFail(path, 'set');
        if (opts2 && opts2.merge) store.set(path, applyFieldPaths(store.get(path), data));
        else store.set(path, deepClone(data));
      },
      async update(data){
        checkFail(path, 'update');
        if (!store.has(path)) throw new Error('NOT_FOUND: ' + path);
        store.set(path, applyFieldPaths(store.get(path), data));
      },
      collection(sub){ return makeCollectionRef(path + '/' + sub); },
    };
  }

  function makeCollectionRef(path){
    return {
      doc(id){ return makeDocRef(path + '/' + id); },
      async get(){
        const prefix = path + '/';
        const docs = [];
        for (const [p, data] of store.entries()) {
          if (p.startsWith(prefix) && p.slice(prefix.length).indexOf('/') === -1) {
            docs.push({ id: p.slice(prefix.length), data: () => deepClone(data) });
          }
        }
        return { forEach(fn){ docs.forEach(fn); }, size: docs.length };
      },
    };
  }

  function makeCollectionGroupRef(name){
    let orderField = null, orderDir = 'asc', limitN = null;
    const api = {
      orderBy(field, dir){ orderField = field; orderDir = dir || 'asc'; return api; },
      limit(n){ limitN = n; return api; },
      async get(){
        const docs = [];
        for (const [p, data] of store.entries()) {
          const parts = p.split('/');
          if (parts.length >= 2 && parts[parts.length - 2] === name) {
            docs.push({ id: parts[parts.length - 1], data: () => deepClone(data) });
          }
        }
        if (orderField) {
          docs.sort((a, b) => {
            const av = a.data()[orderField] || 0, bv = b.data()[orderField] || 0;
            return orderDir === 'desc' ? bv - av : av - bv;
          });
        }
        const limited = limitN ? docs.slice(0, limitN) : docs;
        return { forEach(fn){ limited.forEach(fn); }, size: limited.length };
      },
    };
    return api;
  }

  return {
    _store: store,
    _log: log,
    collection(name){ return makeCollectionRef(name); },
    collectionGroup(name){ return makeCollectionGroupRef(name); },
    async runTransaction(fn){
      const pendingOps = [];
      const tx = {
        async get(ref){ return ref.get(); },
        set(ref, data, opts2){ pendingOps.push(() => ref.set(data, opts2)); },
        update(ref, data){ pendingOps.push(() => ref.update(data)); },
      };
      const result = await fn(tx);
      for (const op of pendingOps) await op();
      return result;
    },
  };
}

module.exports = { makeFirestoreMock, deepClone };
