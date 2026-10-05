#!/usr/bin/env node
// Runner da suíte de testes locais do Controle de Tomografia.
// Uso: node tests/run-all.js  (exit 0 = tudo ok, 1 = alguma falha)
'use strict';

const suites = [
  './test-idempotencia',
  './test-fila-offline',
  './test-sync-legado',
  './test-migracao',
  './test-pagamento',
  './test-pagamento-responsivo',
  './test-pagamento-consistencia-multimes',
  './test-pagamento-merge-legado-deterministico',
  './test-laudo-eventos',
  './test-historico-crosspc',
  './test-auditoria',
  './test-integracao-multipc',
  './test-fundacao-legado',
  './test-loader-docs-diarios',
  './test-finalizacao-responsiva',
  './test-comprovante-efeitos',
  './test-estorno-laudo',
];

const results = [];
function check(name, cond, extra){
  const ok = !!cond;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

(async () => {
  for (const suiteName of suites) {
    console.log(`\n=== ${suiteName.replace('./', '')} ===`);
    const suite = require(suiteName);
    try {
      await suite.run(check);
    } catch (e) {
      check(`${suiteName}: execução da suíte não lançou exceção`, false, (e && e.stack) || String(e));
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks ok`);
  if (failed.length) {
    console.log('FALHAS:\n - ' + failed.map((f) => f.name).join('\n - '));
    process.exitCode = 1;
  }
})();
