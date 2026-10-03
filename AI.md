# AI.md — instruções para assistentes de IA (Claude, DeepSeek, ChatGPT, etc.)

Este projeto já causou uma perda real de dados (R$ 2.000 em laudos de um
dia) e dois estouros de cota do Firestore, ambos por edições feitas sem
contexto do histórico. Leia isto ANTES de propor ou aplicar qualquer
mudança — principalmente antes de "reescrever do zero" qualquer função de
salvamento/sincronização.

## Regra de ouro

Se uma parte do código parecer redundante ou "ineficiente" à primeira
vista, **desconfie antes de simplificar** — várias decisões aqui existem
por causa de um bug real que já aconteceu. Pergunte antes de remover.

## Armazenamento local: IndexedDB, não localStorage

Igual ao Atlas Radiológico (outro projeto do mesmo usuário, mesmo
domínio `leopaggi.github.io`): `localStorage` tem cota fixa (~5 MB)
**compartilhada entre todos os projetos do mesmo domínio**. Isso já
causou `QuotaExceededError` real (o outro projeto tinha um backup de
~4,2 MB ocupando quase toda a cota, sobrando quase nada pra esse).

A camada `idbLocalStorage.getItem/setItem/removeItem` substitui
`localStorage` diretamente — **nunca volte a usar `localStorage.*` puro
neste projeto.**

### Ao migrar: filtre pelas chaves do PRÓPRIO app

A migração inicial (`tomoInitStorage`) tinha um bug: pegava *todas* as
chaves do `localStorage` sem filtro, e "roubou" a flag de migração do
Atlas por engano (moveu ela pro banco IndexedDB desta Tomografia). Não
causou perda de dados, mas fez o Atlas repetir uma checagem à toa.
Corrigido com uma lista explícita (`TOMO_OWN_KEYS` +
`TOMO_OWN_PREFIXES`). **Se migrar outro projeto do mesmo domínio, use o
mesmo padrão de filtro explícito — nunca "migre tudo que encontrar".**

## Sincronização com o Firestore: só escreva o que mudou

Isso é o ponto mais importante deste arquivo, porque já causou dois
incidentes reais de estouro de cota (Firestore Spark/gratuito: 20.000
escritas/dia).

### Incidente 1: salvamento automático incondicional

Existia um `setInterval` que rodava `salvarDadosFirebaseSilencioso()` a
cada 15 segundos **sempre**, mesmo sem nenhuma mudança. Com a aba aberta
24h (o usuário deixa o navegador ligado o dia todo), isso sozinho gerava
dezenas de milhares de escritas por dia, à toa.

**Corrigido com a flag `dadosSujos`**: o `setInterval` só chama
`salvarDadosFirebaseSilencioso()` se `dadosSujos === true`. Toda função
que de fato muda `dadosApp` precisa marcar `dadosSujos = true`. A flag é
zerada depois de um save bem-sucedido.

### Incidente 2: reescrever todos os meses a cada ação

Mesmo com a flag de sujeira, `salvarDadosFirebase()` reescrevia **todos os
meses** de histórico no Firestore a cada laudo — com 12 meses acumulados
(308 dias), 1 laudo virava 12 escritas quando só 1 mês tinha mudado de
verdade. Isso sozinho já é suficiente pra estourar a cota num dia de uso
normal.

**Corrigido com `mesesSujos` (um `Set` de "AAAA-MM" alterados)**:
- `marcarMesSujo(dataStr)` — marca só o mês daquela data
- `marcarTudoSujo()` — marca todos os meses existentes (usado quando o
  dataset inteiro é trocado: restaurar backup, importar JSON, etc.)
- `salvarDadosFirebaseSilencioso()` só escreve os meses em `mesesSujos`
- `salvarDadosFirebase(forcarTudo)` só escreve tudo se `forcarTudo=true`
  (botão "Sincronizar" explícito) ou se `mesesSujos` estiver vazio
  (bootstrap/primeira gravação)

**Ao adicionar qualquer nova função que mude `dadosApp.exames` ou
`dadosApp.tempos`, chame `marcarMesSujo(data)` (ou `marcarTudoSujo()` se
o dataset inteiro mudar) logo depois.** Esquecer isso faz a mudança nunca
chegar no Firestore via auto-save (só vai na próxima vez que alguém clicar
em "Sincronizar" manualmente).

### Caso especial: `pagamentos`

O objeto `pagamentos` é duplicado **inteiro** dentro de cada documento de
mês no Firestore (não é dividido por mês). Por isso,
`togglePagamentoUnificado()` chama `marcarTudoSujo()` — mudar um
pagamento precisa atualizar a cópia de `pagamentos` em todos os meses,
não só no mês exibido no relatório.

### Se a cota estourar mesmo assim

O Firebase Console mostra o uso real: Firestore Database → aba "Uso"
(Usage). O aviso "Seu projeto ultrapassou os limites sem custo
financeiro" confirma que é cota, não bug. Ela reseta 1x/dia (meia-noite
Pacífico/EUA, ~4h-5h da manhã no Brasil). Enquanto isso, o app continua
funcionando 100% local (IndexedDB) — nada se perde, só não sincroniza até
resetar. Se isso virar recorrente com uso normal (não mais bug), a saída é
upgrade pro plano Blaze (remove o teto rígido diário).

## O conflito PC ↔ notebook (causa do incidente de R$ 2.000)

Já aconteceu de: usar o PC, os dados ficarem só localmente sem sincronizar
a tempo, abrir no notebook, e o notebook (com cache desatualizado)
acabar prevalecendo — perdendo o que só existia no PC. A proteção contra
isso está na função `carregarDados()`: ela busca a nuvem e faz **merge**
(`Object.assign` preenchendo só o que falta local, nunca sobrescrevendo
dia que já existe local) antes de deixar o auto-save começar a rodar.

**Não troque essa lógica de merge por uma sobrescrita direta** (`dadosApp
= dadosNuvem`) — isso reintroduziria exatamente o bug que causou a perda
de R$ 2.000. Se precisar mudar essa função, mantenha a propriedade "nunca
sobrescreve um dia que já existe localmente com o que veio da nuvem sem
antes checar".

## Testes manuais (não há suite formal ainda)

Os scripts abaixo foram usados pra validar as correções de storage/cota
durante o desenvolvimento (não estão no repositório, mas o padrão vale a
pena replicar se mexer nessas áreas de novo):
- Simular IndexedDB com `fake-indexeddb` (pacote npm) pra testar
  `idbLocalStorage` isoladamente, sem precisar de navegador
- Simular um `db` do Firestore que só conta chamadas de `.set()`, pra
  confirmar quantas escritas uma ação realmente dispara (crucial pra
  validar a correção de `mesesSujos`)

Se for mexer na lógica de storage ou de sincronização, vale recriar esse
tipo de teste antes de considerar a mudança pronta — validação manual no
navegador não pega regressão de "quantas escritas por ação" com
confiabilidade.

## Arquitetura multi-PC (branch `rebuild-controle-tomografias`)

A partir desta reconstrução, os CONTADORES (exames por segmento/serviço) e
PAGAMENTOS têm uma fonte autoritativa nova, além da coleção mensal legada:

- `controles_dias/{AAAA-MM-DD}` — documento diário autoritativo. Reflete a
  soma de operações de TODOS os PCs (não é "o que este PC viu por último").
- `controles_operacoes/{operationId}` — ledger de idempotência. Cada
  incremento de contador ou pagamento tem um `operationId` estável; a
  transação que aplica o incremento primeiro CONSULTA esse ledger e só
  aplica se ainda não tiver sido aplicado. Isso é o que permite reenviar
  (retry) uma operação com segurança sem contar duas vezes.
- `controles_dias/{dia}/laudos/{eventId}` — evento de laudo (cronômetro),
  `eventId = operationId` do laudo inteiro. Usado por
  `tomoBuscarLaudosCrossPC()` (via `collectionGroup('laudos')`) para montar
  o histórico "outro PC" em `montarHistoricoVisual()`.
- `controles_pagamentos/{AAAA-MM}` — pagamento por serviço, atualizado por
  merge (nunca reescreve o documento mensal inteiro).

**Nunca "conserte" um incremento de contador fazendo `.get()` + soma manual
+ `.set()` fora de uma transação com o ledger.** Isso reintroduz exatamente
o problema que a arquitetura multi-PC resolve (duas escritas concorrentes
pisando uma na outra). Use `tomoAplicarIncrementoAtomico()` /
`tomoAplicarPagamento()`.

A coleção mensal legada (`controles/examesTomografia_AAAA-MM` +
`controles/examesTomografia`) CONTINUA recebendo dual-write (compatibilidade
com qualquer ferramenta/relatório antigo que dependa dela), mas não é mais
autoritativa: ao carregar (`carregarDados()`), um dia com documento em
`controles_dias` sempre prevalece sobre o valor legado ou local desatualizado.

**Fila offline** (`tomoEnfileirar`/`tomoProcessarFila`, persistida em
`idbLocalStorage` sob a chave `tomoFilaOperacoes`): toda operação nova
(contador/pagamento/laudo) passa pela fila antes de ir ao Firestore. Isso é
o que permite usar o app sem internet e sincronizar depois sem duplicar.
**Não chame `tomoProcessarFila()` de dentro de `tomoEnfileirar()`** — isso já
causou uma corrida real (a chamada "dispara e esquece" corria em paralelo com
uma chamada explícita logo depois, e a segunda simplesmente reaproveitava a
promise já resolvida da primeira, sem reprocessar nada). Em vez disso, cada
fluxo que enfileira uma operação chama `await tomoProcessarFila()` explicitamente
logo depois.

**Migração** (`tomoMigrarLegado`) e **auditoria** (`tomoAuditar`) são
manuais (sempre disparadas por botão na aba Backup, nunca automáticas) e
puras o suficiente para serem testadas sem Firestore real — ver `tests/`.

## Mantendo este arquivo atualizado

### Estorno vinculado ao comprovante — local, aguardando revisão

Para laudos com `effectsVersion:1`, `estornarLaudo` usa apenas chaves técnicas
e IDs do `effectsSnapshot`. Nunca subtrair um agregado por nome de exibição,
nem associar cliques antigos do `-` ao laudo. Antes de mutar, validar todos
os contadores, identidade/posição/valor das amostras e total diário. Colisão
de `sampleIndex` ou resultado negativo aborta o estorno inteiro. Depois do
splice ajustar os índices posteriores no mesmo array; não inserir tempos
negativos. Não remover o registro histórico original.

Persistir `examesTomografia`, `historicoLaudos`, fila e total diário numa só
transação IndexedDB antes da UI. Bloquear estorno no fallback localStorage,
que não oferece atomicidade multi-chave. A fila tem um pedido `estorno` com
ID fixo `reversal:<operationId>`; a transação Firestore verifica evento e
ledgers originais, decrementa todos os segmentos e cria marcador SEPARADO
do evento original, além do ledger de estorno. O `.set(evento)` original não
pode apagar o marcador. Marcar status `pending` até confirmação; retries não
aplicam o mesmo delta duas vezes. Não remover awaits do fluxo de finalização.
O merge diário deve preservar valores locais de estornos ainda na fila.

Limite conhecido: ajuste manual `-` permanece genérico e sem associação;
agregado positivo não prova que certo laudo não foi compensado antes. Um
registro/PC sem amostras e total local correspondente não pode executar
estorno automático. Outros PCs recebem o marcador remoto, mas tempos e
totais locais antigos de outros dispositivos não são reconciliados por ele.
Não executar correção automática de registros antigos ou em massa.

### Comprovantes de efeitos — fundação local de 03/10/2026

Somente novos laudos de cronômetro recebem `effectsVersion: 1` e
`effectsSnapshot`, construído uma vez a partir da captura técnica original.
Preservar `operationId`, IDs `<P>:<segmentoId>` e `<P>:time:<segmentoId>`,
deltas/valores exatos e data no evento. Histórico/fila/evento reutilizam essa
captura; edição visual não pode alterá-la. Reaplicar proteção de escrita e
congelamento ao desserializar um comprovante presente, sem criar um para legado.

`tempos` continua array de números. A identidade fica no mapa opcional
`timeContributions[data][timeContributionId]` com `sampleIndex` (null para
duração zero, sem inserir amostra), IDs técnicos e valor. Não buscar uma
amostra pelo primeiro número igual nem renumerar/rotular tempos antigos.
Copiar identidades somente junto dos arrays/dias realmente copiados no
loader/save/backup/restore; nunca herdar índices novos ao substituir por um
array legado. Futuras remoções devem manter índices/associações consistentes.
No estágio inicial desta fundação não havia estorno nem novo tipo de fila;
o snapshot por si só não é confirmação de aplicação remota do ledger.
149/149 checks locais passaram; 105 verificações anteriores preservadas.
Nenhum commit/push desta etapa; aguardar revisão do usuário.

Correção de finalização aprovada em teste real em 02/10/2026:
`LOG_DESENVOLVIMENTO.md` registra os resultados e as decisões. Em
`finalizarLaudo`, capturar duração/empresa/data/segmentos/IDs antes de awaits e
reset; parar o intervalo imediatamente; confirmar a fila e snapshot do estado
via `setItemAsync` antes de limpar UI (o helper da fila registra falha sem
rejeitar). Essas confirmações locais adicionais são intencionais.
Preservar `await tomoProcessarFila()` e `await salvarDadosFirebase()`; nunca
anunciar sucesso se IDs desse laudo ainda estiverem na fila. Guardar a trava de
reentrada até os dois terminarem e restaurar botão/data/intervalo no finally.
A data fica bloqueada porque o save legado também lê a data selecionada para
gravar o total; não trocar isso por leitura de controles limpos. Falha local
antes de confirmar captura não limpa duração/seleções e não recria operação.
Os helpers de fila/save, ledger, dual-write, loader e `alterarContador` foram
preservados nesta correção. Manter o frame aguardado antes da rede quando
disponível e página visível. O harness suporta o tema no head e o script do
app no body; testes permanentes usam timers/promises e DOM mock controlados,
sem instrumentação de produção. A medição real aprovada mostrou reset/tabela
em ~20 ms, primeiro frame em ~48 ms e handler total ~3683 ms, com persistência
remota aguardada. Instrumentação e arquivos temporários removidos após teste;
correção publicada em `bdc728124e1d2efa15854274d0327a54cb45f521`.

Toda vez que você mexer na lógica de storage, sincronização, ou merge de
dados, atualize este arquivo e o `README.md` no mesmo commit/entrega.
