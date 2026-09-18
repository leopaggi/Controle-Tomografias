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

## Mantendo este arquivo atualizado

Toda vez que você mexer na lógica de storage, sincronização, ou merge de
dados, atualize este arquivo e o `README.md` no mesmo commit/entrega.
