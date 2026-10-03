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
  por dia (`AAAA-MM-DD`) e por mês (`AAAA-MM`) pro lado do Firestore. Novos
  laudos acrescentam o mapa opcional `timeContributions`, sem converter os
  arrays numéricos de `tempos` nem atribuir IDs aos valores antigos.
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
- Lançamento manual por contador: `+` cria registro novo com comprovante
  reversível; `-` continua ajuste genérico sem vínculo
- Log dos últimos 10 laudos, editável; somente legado sem comprovante pode
  ser removido somente do histórico, sem alterar contagem/valor
- Estorno auditável para Timer novo e para manual novo com comprovante válido
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

`node tests/test-comprovante-efeitos.js` — verifica comprovantes de novos
laudos, IDs técnicos/estáveis, edição real do histórico, retry após reload,
arrays legados, estatísticas e transporte dos metadados em save/backup/loader.

`node tests/test-estorno-laudo.js` — exercita estorno de 1/2 segmentos,
tempo zero, amostra/índice, total diário, ledger, histórico, offline/reload,
falhas/inconsistências e ajustes manuais, sempre com mocks.

## Fundação de efeitos para novos laudos (local, em revisão)

Cada nova finalização pelo cronômetro guarda `effectsVersion: 1` e
`effectsSnapshot` no histórico e no evento remoto. A captura contém o ID
principal, data, empresa técnica, segmentos técnicos, IDs/deltas dos
incrementos, IDs/valores das contribuições de tempo e delta do total diário.
Cada novo `+` manual guarda `effectsVersion: 1` e snapshot só de contagem
(`counterOperationId`, `counterDelta: 1`, `totalDailyDeltaSeconds: 0`), sem
tempo. Não há snapshot retroativo para manual antigo.
O evento também recebe `data` explicitamente. O mesmo objeto capturado é
usado no histórico e no evento da fila, e nenhum ID é regenerado no retry.

IDs dos contadores continuam `<operationId>:<segmentoId>`; IDs de tempo são
`<operationId>:time:<segmentoId>`. `dadosApp.timeContributions[data][id]`
registra `operationId`, `empresaId`, `segmentoId`, `timeSeconds` e `sampleIndex`.
O índice aponta a amostra nova exata no array numérico. Para duração zero,
fica `null` e nenhuma amostra é inserida: somas, quantidades e médias mantêm
a regra anterior. `tomoLocalizarContribuicaoTempo` somente localiza/valida,
não remove nada.

A edição do histórico preserva comprovante e ID principal, protegidos contra
escrita e com snapshot profundamente congelado; a proteção é reaplicada na
leitura dos dados existentes. Os campos de apresentação continuam editáveis.
Save mensal e backups transportam o mapa junto dos arrays correspondentes;
o loader mantém o merge legado e não associa índices remotos a arrays locais
que não foram carregados. Não há backfill nem migração de registros antigos.

Os índices pressupõem os arrays correspondentes. O estorno agora valida a
identidade antes de remover uma amostra e ajusta índices posteriores; o
comprovante não substitui a verificação de sincronização/ledger.

## Estornar laudo (implementação local, em revisão)

Somente Timer novo e manual novo com `effectsVersion: 1` e comprovante válido
oferecem **Estornar laudo** em Últimos 10 Laudos. O registro original
permanece visível e recebe `reversal` com ID `reversal:<operationId>` e status
`pending` ou `confirmed`. O botão some após o pedido. Manual novo estorna só a
contagem, sem tempo negativo e sem mudar o total diário. Registros legados
permanecem sem estorno automático; linhas vindas de outro PC exigem o
comprovante e as contribuições locais correspondentes, ou a ação é bloqueada.
Registros legados/manuais antigos **locais** continuam com Editar e **Remover
somente do histórico**. Essa remoção afeta apenas a lista local: não corrige
contagens, valores, tempos, total diário nem eventos remotos. Eventos somente
remotos não têm índice local para essas ações.

Antes da alteração, todos os contadores, contribuições identificadas, posições
e total diário são validados. O estado, histórico, fila e chave de total são
gravados juntos numa transação IndexedDB; sem IndexedDB disponível o estorno
é bloqueado (fallback localStorage não oferece transação equivalente).
Depois da gravação, o app recalcula UI/relatório/gráficos pelas funções
existentes, aguarda o processamento da fila e o save mensal. Falha remota
mantém `pending` para retry, sem repetir a reversão local.

Uma transação Firestore verifica o ledger original e o ID determinístico do
estorno, aplica os deltas negativos, grava o ledger e um evento **separado**
de estorno. Reenvio do evento original não apaga o marcador separado. Outras
instalações enxergam o marcador; seus tempos/totais locais já existentes não
são reescritos automaticamente por esse evento.

O botão `-` continua ajuste genérico e não estorna tempo/total. Ajustes
manuais antigos não possuem vínculo com laudos e não são reconstruídos. Se
uma compensação anterior zerou a célula, a validação bloqueia o estorno; se
outras operações mantiverem o agregado positivo, ele não prova qual laudo
foi compensado. Revisar esses casos antes de usar estorno automático.
Nenhuma operação sobre dados de produção foi executada nesta entrega;
sem commit/push, aguardando revisão e teste real antes de publicação.

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
temporária foi removida após a aprovação. Correção publicada em
`bdc728124e1d2efa15854274d0327a54cb45f521`.

Ver `AI.md` — esse projeto já passou por um incidente real de perda de
dados (R$ 2.000 em laudos de um dia) e duas rodadas de estouro de cota do
Firestore. As correções aplicadas por causa disso são o motivo de várias
decisões de design que podem parecer não óbvias à primeira vista.
