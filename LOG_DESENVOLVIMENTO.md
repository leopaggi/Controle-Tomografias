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
