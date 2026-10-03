// DOM/browser mínimo o suficiente para o script inline de index.html rodar
// em Node sem lançar (getElementById/querySelectorAll/addEventListener/etc.
// são todos no-op ou baseados em Map). O objetivo NÃO é simular um browser
// de verdade — é deixar o código de produção real (Firestore/IndexedDB/fila
// offline/migração/auditoria) executar e ser testado sem precisar de um
// navegador.
'use strict';

function fakeElement(){
  const el = {
    value: '', textContent: '', innerHTML: '', disabled: false,
    dataset: {}, style: {}, children: [],
    _classes: new Set(),
    _listeners: {},
    addEventListener(type, fn){ if (!el._listeners[type]) el._listeners[type] = []; el._listeners[type].push(fn); },
    removeEventListener(type, fn){ if (el._listeners[type]) el._listeners[type] = el._listeners[type].filter(listener => listener !== fn); },
    appendChild(child){ el.children.push(child); return child; },
    querySelectorAll(){ return []; },
    querySelector(){ return null; },
    closest(){ return null; },
    click(){},
    remove(){},
    getContext(){ return null; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._classes.add(x)),
    remove: (...c) => c.forEach(x => el._classes.delete(x)),
    contains: (c) => el._classes.has(c),
    toggle: (c) => { if (el._classes.has(c)) el._classes.delete(c); else el._classes.add(c); },
  };
  return el;
}

function fakeDocument(){
  const elements = new Map();
  const doc = {
    readyState: 'loading',
    documentElement: {
      _attributes: new Map([['data-theme', 'light']]),
      getAttribute(name){ return this._attributes.get(name); },
      setAttribute(name, value){ this._attributes.set(name, value); },
    },
    getElementById(id){
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    querySelectorAll(){ return []; },
    querySelector(){ return null; },
    createElement(){ return fakeElement(); },
    createTextNode(text){ return { textContent: text, nodeType: 3 }; },
    addEventListener(){},
    removeEventListener(){},
    body: fakeElement(),
    _elements: elements,
  };
  return doc;
}

// IndexedDB mock (padrão herdado do harness anterior do projeto): grava tudo
// num Map compartilhado; `mode` permite simular falha de abertura ou de put,
// para exercitar o fallback real para localStorage.
function makeIndexedDbMock(sharedMap, mode = 'ok'){
  const db = {
    _map: sharedMap,
    objectStoreNames: { contains: () => true },
    createObjectStore(){},
    transaction(){
      const tx = { _ops: [], oncomplete: null, onerror: null, error: null };
      tx.objectStore = () => ({
        put(value, key){ tx._ops.push(['put', key, value]); },
        delete(key){ tx._ops.push(['del', key]); },
        getAllKeys(){
          const req = {};
          setTimeout(() => { req.result = Array.from(sharedMap.keys()); if (req.onsuccess) req.onsuccess(); }, 0);
          return req;
        },
        getAll(){
          const req = {};
          setTimeout(() => { req.result = Array.from(sharedMap.values()); if (req.onsuccess) req.onsuccess(); }, 0);
          return req;
        },
      });
      setTimeout(() => {
        if (mode === 'open-fail-put') {
          tx.error = new Error('IDB put rejeitado');
          if (tx.onerror) tx.onerror();
          return;
        }
        for (const [op, k, v] of tx._ops) {
          if (op === 'put') sharedMap.set(k, v);
          else sharedMap.delete(k);
        }
        if (tx.oncomplete) tx.oncomplete();
      }, 0);
      return tx;
    },
  };
  return {
    open(){
      const req = { result: db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        if (mode === 'open-fail' || mode === 'open-fail-put') {
          req.error = new Error('IDB aberto falhou');
          if (req.onerror) req.onerror();
          return;
        }
        if (req.onupgradeneeded) req.onupgradeneeded();
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
}

function makeLocalStorageMock(seed = []){
  const map = new Map(seed);
  return {
    _map: map,
    getItem(k){ return map.has(k) ? map.get(k) : null; },
    setItem(k, v){ map.set(k, String(v)); },
    removeItem(k){ map.delete(k); },
    key(i){ return Array.from(map.keys())[i] || null; },
    get length(){ return map.size; },
  };
}

module.exports = { fakeElement, fakeDocument, makeIndexedDbMock, makeLocalStorageMock };
