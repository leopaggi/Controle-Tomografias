# Registro de desenvolvimento

## 02/10/2026 — Resposta visual ao finalizar um laudo

A medição real fornecida pelo usuário mostrou que a tela esperava cerca de
2,1 segundos pela fila de sincronização antes de zerar o cronômetro. Tabela,
cards e gráficos eram rápidos; a demora vinha da ordem das operações.

Correção local autorizada: o aplicativo guarda a duração, a empresa, a data,
os segmentos e os identificadores; para o cronômetro; confirma a gravação
local do registro, da fila e do estado antes de limpar a tela. Em seguida,
zera o cronômetro e atualiza os números, enquanto continua **aguardando** a
fila remota e o salvamento. O botão Finalizar fica bloqueado para impedir um
segundo clique. A data também fica bloqueada para o total não ir a outro dia.
Ambos são liberados no fim, inclusive em falha, quando o intervalo é retomado.

Falha remota não recria o laudo: as operações pendentes continuam com seus
identificadores originais, para reenvio pela sincronização existente. Falha
local antes da confirmação não limpa o cronômetro nem as seleções.

No sandbox, com a mesma demora remota simulada, o reset passou de cerca de
2596 ms para 93 ms e a tabela de 5130 ms para 93 ms. O tempo total continuou
em cerca de cinco segundos, pois a gravação continua sendo aguardada.
Os testes permanentes cobrem clique repetido, duração preservada, cronômetro,
frame/UI antes da rede, falhas, fila/reenvio e os botões +/−.
Resultado final: **105 de 105 verificações passaram**, incluindo 42 novas.

A instrumentação temporária foi mantida durante a comparação real antes/depois.
O teste real pós-correção foi aprovado pelo usuário, na mesma origem publicada
usando Chrome Local Overrides. Valores aproximados informados:

| Etapa pós-correção | Tempo |
|---|---:|
| Clique até reset do cronômetro | 20,3 ms |
| Clique até atualização da tabela | 20,4 ms |
| Primeiro frame com UI atualizada | 48,4 ms |
| Fila remota | 3004,1 ms |
| Transação de incremento | 2396 ms |
| Leitura do ledger na transação | 1918,7 ms |
| Escrita do evento | 606,1 ms |
| Salvamento final | 627,5 ms |
| Escrita mensal | 274,9 ms |
| Escrita principal | 346,5 ms |
| Finalização completa | 3682,6 ms |

A tela respondeu em dezenas de milissegundos, enquanto a operação continuou
aguardando toda a persistência. Tempos de etapas internas estão incluídos nas
etapas maiores; não devem ser somados em duplicidade.

### Limpeza final para revisão pré-publicação

Removidos os helpers, marcadores e wrappers da medição temporária do HTML,
o script `tests/audit-delay-local.js` e o relatório `AUDITORIA_DELAY_LAUDO.md`.
Os resultados e decisões relevantes foram consolidados neste registro.
Os testes permanentes passaram a observar os cards pelo DOM mock, sem depender
da API temporária. Mantidos snapshot local, trava, parada do intervalo, UI/frame
antes da rede, os dois awaits remotos, fila em erro e liberação no finally.

**Teste real aprovado; publicação pendente de revisão final. Nada staged,
commitado ou publicado nesta entrega.**
O backup físico e o pacote de recuperação não foram alterados.

## 03/10/2026 — Fundação dos comprovantes para laudos novos

Estado inicial conferido: branch main, HEAD e origin/main em
`bdc728124e1d2efa15854274d0327a54cb45f521`, com somente o pacote de recuperação
untracked. Antes de editar, criado ZIP adicional do projeto versionado em
`%TEMP%\opencode\Controle-Tomografias_PRE_FUNDACAO_EFEITOS_bdc7281_2026-10-03.zip`.
Esse backup é do código/documentação/testes; não é exportação dos dados do
navegador. O pacote existente não foi lido nem incluído no ZIP.

Cada laudo novo do cronômetro passa a guardar um comprovante versionado dos
efeitos originais: data, empresa e segmentos técnicos, IDs dos incrementos,
quantidades, contribuições de tempo identificadas e delta do tempo diário.
O mesmo comprovante segue no histórico e no evento da fila/Firestore. O
evento agora também contém a data, mantendo leitura de eventos antigos.
Editar o texto/data/tempo exibidos no histórico preserva a captura original.
Os campos protegidos e o snapshot são congelados também após a leitura local.

Os tempos antigos continuam números nos mesmos arrays. Um mapa paralelo
opcional aponta a posição exata de cada amostra nova por um ID estável.
Isso distingue contribuições mesmo quando os números são iguais. Duração
zero tem identidade reservada com posição null e não adiciona uma amostra.
As estatísticas não foram reescritas: soma, quantidade e média permanecem
iguais. Loader mensal, saves e backups preservam o mapa junto dos arrays;
restaurar arrays legados não herda posições de um estado diferente.

Os 105 testes anteriores passaram antes da mudança. Ao final, **149/149
verificações passaram**, incluindo 44 novas: um/múltiplos segmentos, zero,
frações sem arredondar, proteção na edição real, retry depois de reload,
persistência de IDs/snapshot, legado, estatísticas e backups. Mantidas as
garantias de UI antecipada, frame e persistência aguardada da finalização.

Limites desta entrega: não existe estorno nem remoção de contribuição; uma
implementação futura terá que manter as posições ao remover amostras e
verificar sincronização/ledger. Versões anteriores do app podem ignorar os
metadados novos ao salvar/restaurar. Não houve migração ou inferência de dados
antigos, consulta/escrita em Firestore real, commit, stage ou push.
**Fundação somente local, aguardando revisão antes de publicar.**

## 03/10/2026 — Estorno de laudo com comprovante (ainda local)

Criado antes desta mudança backup separado da árvore local (sem o pacote de
recuperação):
`C:\Users\LEONARDO\AppData\Local\Temp\opencode\Controle-Tomografias_PRE_ESTORNO_LOCAL_2026-10-03_11-21-33.zip`.
O ZIP contém código/testes/documentação, não IndexedDB/Firestore do navegador.

Laudos novos com comprovante técnico válido mostram **Estornar laudo** na
tabela Últimos 10 Laudos. O original continua visível; depois da confirmação
fica **ESTORNADO**, ou **Estorno pendente** enquanto não sincronizou. Antes de
alterar, todos os contadores, amostras identificadas, índices e total diário
são checados. O estado local, o histórico, a fila e o total são persistidos
numa só transação IndexedDB. Falha nessa transação não altera os números/UI;
sem IndexedDB a ação é bloqueada. Correção remove só a amostra identificada
e ajusta índices posteriores; valores e gráficos vêm dos cálculos existentes.

Um único pedido de fila usa o ID determinístico `reversal:<operationId>`.
Firestore, numa transação, confere o evento/ledger original, aplica os
decrementos, registra o ID do estorno no ledger e cria marcador de evento
separado. Retry ou dois computadores não repetem a escrita remota com esse
ID. O evento original permanece e seu retry não apaga o marcador. Backup,
loader legado, finalização responsiva e ajuste genérico `-` foram preservados.

Limitações: cliques antigos de `-` não podem ser vinculados retroativamente.
Se o agregado continuar positivo por outros laudos, não há como deduzir que
um `-` anterior já compensou o laudo escolhido. Outra instalação mostra o
marcador, mas não ajusta automaticamente seu tempo/total local anterior;
linhas sem amostra/total correspondentes neste dispositivo são bloqueadas.
Por isso estes casos exigem revisão, não suposições. Sem operações reais,
stage, commit, push ou publicação nesta etapa; aguardar revisão dos testes.

## 03/10/2026 — Ações dos Últimos 10 Laudos

Após publicar o estorno, registros antigos locais passaram a mostrar apenas
“—”: o botão novo substituiu a condição anterior que mostrava Editar/Excluir
sempre que o registro tinha `_localIndex`. A coluna foi corrigida para
preservar **Editar/Remover do histórico** em registros legados e manuais
locais. A confirmação e o aviso esclarecem que remover do histórico **não**
desfaz contador, tempo, total diário nem dados remotos. Laudos novos com
comprovante/efeitos locais válidos continuam com **Estornar laudo**;
`pending`/`confirmed` mostram seu status, sem novo botão. Eventos somente
remotos não recebem ação local porque não têm `_localIndex`. Testes de
regressão verificam também que a remoção visual não altera produção.
Correção apenas local para revisão, sem stage, commit ou publicação.

## 03/10/2026 — Estorno real para novo lançamento manual pelo "+"

O botão "+" criava o contador com um ID, mas o item do histórico ficava sem
identidade e sem comprovante. Por isso ele só oferecia "Remover do histórico",
que apaga o registro da lista e mantém contagem e valor. Isso podia parecer
um estorno, mas não era.

A partir desta mudança, todo "+" novo cria um comprovante só de contagem,
sem tempo inventado. Esse registro mostra "Estornar laudo" e, ao estornar,
a contagem e o valor voltam corretamente, com o registro mantido como
ESTORNADO. O "-" continua sendo apenas um ajuste simples, sem vínculo. Os
registros manuais antigos não foram alterados: continuam com "Remover somente
do histórico", com aviso claro de que contagem e valores não mudam. O Timer
continua igual, inclusive no controle de tempo.

Suíte completa com **223/223 verificações passando**. Nada foi alterado nos
dados reais de 03/10/2026; sem stage, commit ou publicação, aguardando revisão.
