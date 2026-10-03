# Controle de Exames de Tomografia

App de controle diário de laudos de tomografia: registra exame por
segmento (crânio, tórax, abdome, etc.) e por empresa/hospital contratante,
cronometra o tempo gasto por laudo, calcula produção em R$ por dia/mês, e
gera relatório mensal com status de pagamento por empresa.

## Como rodar

Um único arquivo `index.html` autossuficiente. Sem build, sem servidor
local — abre direto no navegador ou publica via GitHub Pages.

**Hospedagem:** GitHub Pages, no mesmo domínio de outros projetos do
usuário (`leopaggi.github.io`) — isso importa, ver `AI.md`.

## Como atualizar o site

Esse arquivo ainda é pequeno (menos de 150 KB), então o **editor web do
GitHub continua funcionando normalmente** pra ele (diferente de outros
projetos do mesmo usuário que já passaram de 2 MB):

1. Abre o `index.html` no repositório
2. Clica no lápis (editar)
3. Ctrl+A, cola o conteúdo novo
4. Commit changes
5. Espera 1-2 min, testa com Ctrl+Shift+R

Se um dia esse arquivo crescer muito (imagens embutidas, muito código
novo), pode passar a precisar do fluxo de upload — ver o README do Atlas
Radiológico como referência de como isso é tratado lá.

## Arquitetura

- **Dados** (`dadosApp`): `{ exames, tempos, pagamentos }`, organizados
  por dia (`AAAA-MM-DD`) e por mês (`AAAA-MM`) pro lado do Firestore.
- **Armazenamento local** — IndexedDB (banco `tomografia_idb`), não
  `localStorage`. Ver `AI.md` pra entender por quê.
- **Sincronização** — Firebase Firestore (projeto
  `controle-tomografias-leonardo`). Fonte autoritativa: um documento por DIA
  (`controles_dias/AAAA-MM-DD`), atualizado por incrementos atômicos
  idempotentes (ledger em `controles_operacoes/{operationId}`) — funciona
  corretamente com dois ou mais computadores usando o app ao mesmo tempo.
  Pagamentos ficam em `controles_pagamentos/AAAA-MM`, por serviço. A
  coleção mensal antiga (`examesTomografia_AAAA-MM` + documento principal
  `examesTomografia`) continua recebendo escrita (compatibilidade), mas não
  é mais a fonte da verdade. Ver `AI.md` para os detalhes da arquitetura
  multi-PC, fila offline e ferramentas de migração/auditoria (aba Backup).

## Funcionalidades principais

- Cronômetro por laudo + acumulado do dia
- Lançamento manual por contador (+/-) além do fluxo com cronômetro
- Log dos últimos 10 laudos, editável/excluível
- Relatório mensal com total por empresa e status de pagamento
- Projeção de ganhos em 24h baseada na média do mês
- Backup automático (a cada 5 min, últimos 3, só 30 dias de dados) e
  backup manual (baixar/restaurar JSON)

## Testes

`node tests/run-all.js` — roda a suíte local (Node puro, sem dependências).
Carrega o `<script>` real de `index.html` num sandbox com IndexedDB/Firestore
mockados e exercita idempotência, fila offline, migração, auditoria e
histórico cross-PC. Ver `AI.md` para o porquê da arquitetura testada.

`node tests/test-finalizacao-responsiva.js` — verifica captura de duração,
parada do intervalo, UI antes da rede, reentrada, falhas locais/remotas,
retry sem duplicação e regressão de `+/-` com promises controladas.

## Histórico relevante

Correção do encerramento aprovada em teste real (02/10/2026): ver
`LOG_DESENVOLVIMENTO.md`. A medição real anterior informou
~2081 ms até reset, principalmente na fila remota. `finalizarLaudo` agora
confirma captura/fila/estado local antes de limpar a UI, para o intervalo e
atualiza a tela antes da rede; os dois awaits remotos continuam obrigatórios.
Botão Finalizar e data ficam bloqueados durante a operação e são restaurados
no finally. Um frame é aguardado antes da rede quando a página está visível;
o intervalo retoma ao terminar a persistência. No teste real pós-correção,
reset/tabela ocorreram em ~20 ms e o primeiro frame com UI atualizada em
~48 ms; o handler aguardou ~3683 ms até a conclusão. A instrumentação
temporária foi removida após a aprovação. Publicação pendente de revisão final.

Ver `AI.md` — esse projeto já passou por um incidente real de perda de
dados (R$ 2.000 em laudos de um dia) e duas rodadas de estouro de cota do
Firestore. As correções aplicadas por causa disso são o motivo de várias
decisões de design que podem parecer não óbvias à primeira vista.
