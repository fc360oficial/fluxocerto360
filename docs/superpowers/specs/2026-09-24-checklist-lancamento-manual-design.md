# Checklist: lançamento manual no Extrato — design

**Data:** 2026-09-24
**Pedido:** Tiago quer lançar, pela retaguarda, um checklist que a loja fez no papel num dia em que o envio pelo app não aconteceu (linha vermelha, −10 no Extrato da Central de Resultados). Hoje o admin só consegue excluir (×), nunca acrescentar.

## Decisões tomadas com o Tiago

| Pergunta | Decisão |
|---|---|
| O que registrar | Checklist feito no papel: qual checklist, quem fez e os itens marcados. Pontos pela regra normal (`calcPontos`). |
| Quem pode | Só `admin` (mesma regra do botão × de excluir). |
| Como informar o resultado | Marcar os itens do checklist; a % sai da contagem, igual ao envio pelo app. |
| Onde aparece | Em tudo (Extrato, ranking, Central de Resultados, relatórios), sempre com etiqueta "manual" e quem lançou. |

## Abordagem escolhida

Modal próprio aberto a partir da linha do Extrato, que grava direto em `resultados` um documento no mesmo formato de um envio normal. Alternativa descartada: reaproveitar a tela do Checklist em "modo retroativo" — reusaria a interface de itens/fotos, mas mexe no envio (`jaEnviouHoje`, data, fotos, trava de tela), que é o fluxo mais frágil e usado todo dia pelas lojas.

## Ponto de entrada (Extrato)

Em `renderRelRankExtrato()` (app.js ~9505), a coluna Status de cada linha com `clPerdidos > 0` ganha o botão **"＋ Lançar"** ao lado do status, com as condições:

- `S.role === 'admin'`;
- dia ≤ hoje (dias futuros não mostram);
- linha com ao menos um checklist esperado não enviado.

O botão chama `abrirModalLancamentoManual(anoSel, mesSel, dia, lojaSel, idsPerdidos)`.

## Modal `modal-cl-manual` (index.html)

Segue o padrão do `modal-visita-manual` (classes `modal-bg`, `modal-box`, `fg`, `btn-row`).

Campos, de cima pra baixo:

1. **Data** — preenchida (DD/MM/AAAA), somente leitura.
2. **Loja** — preenchida, somente leitura.
3. **Checklist** — `<select>` com só os checklists perdidos naquele dia (`clEsp` sem envio). Se for um só, já vem selecionado. Trocar o checklist re-renderiza a lista de itens.
4. **Operador** — `<select>` com os usuários **ativos** cuja `loja` é a da linha (`getUsers()`), ordenados por nome. Obrigatório.
5. **Itens** — lista dos `itens` do checklist selecionado:
   - item `checkbox`, `planilha`, `qty` ou qualquer tipo sem resposta própria → caixa "feito";
   - item `simNao` → dois botões-rádio Sim / Não; conta como feito só no "Sim";
   - item com foto (`foto` ≠ `none`) → caixa "feito" normal, com legenda "sem foto (papel)". Feito no papel não tem foto.
6. **Rodapé** — texto vivo "Concluído: X de Y itens · N% · +P pontos", recalculado a cada clique, usando a mesma regra de `enviarChecklist` (itens em plano de ação aberto não entram no total; `calcPontos(pct)`).
7. Botões: **Lançar** (`btn-p`) e **Cancelar** (`btn-s`).

## Documento gravado

Função pura `ResultadosCore.montarResultadoManual(opts)` em `lib/resultados-core.js` recebe:

```
{ cl, marcados, operador, loja, clienteId, dateISO, autor, agora }
```

- `cl`: o checklist (id, nome, setor, itens).
- `marcados`: array alinhado a `cl.itens`; cada posição é `true|false` (checkbox) ou `'sim'|'nao'|null` (simNao).
- `agora`: `Date` (injetado, pra teste).

E devolve o objeto no formato do `res` de `enviarChecklist` (app.js ~3730):

```
id, checklistId, checklistNome, setor,
operador, perfil: <perfil do usuário selecionado, ou 'operator'>, loja, clienteId,
dataHora: 'DD/MM/AAAA 00:00', dateISO,
itens: [{texto, obs, foto, tipo, resposta, justificativa:'', fotoAntes:null, fotoDepois:null, fotosMulti:null, feito, critico, prazoPlano, produtos:null, emPlano:false}],
feitos, total, pct, reprovado, assinatura: null,
manual: true, lancadoPor: autor, lancadoEm: 'DD/MM/AAAA HH:MM'
```

Regras:

- `feito` = caixa marcada, ou `resposta === 'sim'` no simNao.
- `reprovado` = algum item `critico` não feito (ou simNao respondido "nao").
- `pct = Math.round(feitos/total*100)`, `total` = quantidade de itens (nenhum item é excluído por plano de ação no lançamento manual — o admin marca o que foi feito no papel; `emPlano` fica `false`).
- Hora fixa `00:00` na `dataHora`. Consequência aceita: relatórios de atraso por `horaLimite` tratam o manual como no horário.
- `id` gerado com `genId()` da aplicação (passado em `opts.genId` pra manter a função pura).

## Gravação e cache (app.js)

`salvarLancamentoManual()`:

1. Valida: checklist e operador selecionados; nenhum resultado não-resetado já existe pra (`checklistId`, `loja`, `dateISO`) — se existir, toast "Já existe envio desse checklist nesse dia" e não grava.
2. Monta o doc com `montarResultadoManual`.
3. `db.collection('resultados').doc(doc.id).set(doc)`.
4. No `.then()`: fecha o modal, `S.resultadosCache.push(doc)` se ainda não estiver lá (o listener de 30 dias pode já ter trazido por latency compensation — por isso o `push` checa o `id` antes), regrava o `localStorage` como `excluirResultadoDia` faz, toast "Lançado: <checklist> · <operador> · N% (+P)", e `renderRelRanking()`.
5. **Nunca** varrer o cache dentro do `.then()` pra decidir reset de outros docs (armadilha registrada em `project_fc360-pwa`).
6. `.catch()`: toast com a mensagem do erro, modal continua aberto.

Não passa por `ResultadosCore.separarFotos` (não há fotos); o doc já nasce sem base64.

## Etiqueta "manual"

- **Extrato:** no tooltip da linha, o item ganha sufixo ` (manual)`.
- **Central de Resultados** (tabela `renderCentral`, app.js ~4246): pílula `Manual` ao lado do perfil, com `title="Lançado por <lancadoPor> em <lancadoEm>"`.
- **Detalhe do envio** (app.js ~4576): linha "Lançamento manual por <lancadoPor> em <lancadoEm>" abaixo do operador.

Nada mais muda: ranking, dias completos e relatórios por item passam a contar o doc como qualquer outro.

## Desfazer

O × "Excluir do ranking" que já existe na linha (marca `resetado: true`) cobre o lançamento manual. Nenhum botão novo.

## Permissões do Firestore (verificar na implementação)

As regras publicadas no Console podem só permitir `update` em `resultados` pelo usuário logado, não `create` de doc com `dateISO` no passado ou com `operador` diferente do usuário. O `firestore.rules` do repo **não** reflete o publicado (ver `feedback_fc360-firestore-rules-local-desatualizado`). Passo obrigatório: testar um lançamento real no Fluxo (dev) antes de dar por pronto; se der `permission-denied`, entregar ao Tiago a regra pra colar no Console.

## Testes

`tests/resultados-core.test.js` ganha casos para `montarResultadoManual`:

1. 3 de 4 caixas marcadas → `feitos 3`, `total 4`, `pct 75`, `manual true`, `lancadoPor` preenchido, `dataHora` termina em ` 00:00`.
2. Item simNao: "sim" conta como feito, "nao" e `null` não.
3. Item crítico não feito → `reprovado true`; todos feitos → `false`.
4. Nenhum item marcado → `pct 0`, sem divisão por zero com `itens` vazio (`pct 0`).
5. `itens` do doc não carregam campos de foto com conteúdo (todos `null`).

Verificação manual no Fluxo: lançar no dia com falta, ver a linha virar ✅ com +pontos, pílula na Central, e o × desfazer.

## Fora de escopo

- Abonar falta sem pontos (loja fechada) — opção descartada nesta rodada.
- Pontos avulsos de bônus/penalidade.
- Editar um lançamento manual depois de gravado (usa × e lança de novo).
- Fotos no lançamento manual.
