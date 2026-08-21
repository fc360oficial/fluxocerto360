# Etiquetas em Lote — Redesign — Design

**Status: pendente, NÃO implementado ainda.** Spec recebida do Tiago em 2026-08-20 (mesmo dia do redesign em hub — ver `2026-08-20-etiquetas-hub-redesign-design.md`), na sequência da simplificação da Etiqueta Avulsa (bipar → imprimir direto, sem preview, ver `feat: simplifica Etiqueta Avulsa` no histórico do `app.js`). Decisão do Tiago: salvar o spec e implementar numa sessão futura — a sessão atual já estava com custo/duração muito acima do normal.

**Contexto técnico ao salvar este spec (2026-08-20, BUILD 328):**
- `renderEtcLotes`, `renderEtcMontarLote`, `_etcRenderListaLote`, `_etcToggleLoteItem`, `_etcAtualizarQtdLoteItem`, `_etcAtualizarBarraLote`, `_etcGerarLoteMock` (app.js) — construtor atual de lote mobile (busca/filtro/checkbox), já resolve preço real via API antes de imprimir (mesmo padrão de `abrirLoteParaImpressao`).
- `abrirLoteParaImpressao`, `renderFilaLote`, `_avancarFilaLoteAposImpressao`, `imprimirProximoDaFila`, `imprimirTudoDaFila` — motor de impressão em fila já existente, com tratamento de erro/desconexão (não reimprime o que já saiu — a fila só contém o que resta, itens impressos são removidos com `.shift()`). Já cobre boa parte do requisito de "não reimprimir automaticamente as etiquetas já impressas" (seção 10 do spec abaixo) — reaproveitar, não recriar.
- `ETC_MOCK_PRODUTOS` — catálogo mockado (6 itens, `codigoBarras/nome/preco/departamento/setor/marca/estoque/precoAnterior`) usado só pra busca/filtro/checkbox no picker — nunca pro que é impresso/logado (isso sempre resolve via API real). Spec pede filtros novos (Categoria, Promoção) que não existem nesses campos — precisa decidir se adiciona campos fictícios ao mock ou se omite esses dois filtros específicos.
- "Últimas impressões" no hub (`renderEtcHub`) já agrupa entradas de `etiquetas_log` por produto+origem+loteId com contagem — o "Histórico" pedido na seção 13 pode reaproveitar essa mesma query/agrupamento, filtrado só pra `origem==='lote'`, em vez de construir do zero.
- Etiqueta Avulsa (não mexer, spec abaixo é só de Lote) já tem "Modo sequencial" implementado (toggle persistido em localStorage, imprime sozinho ao achar o produto) — a seção 11 do spec abaixo pede um "Modo Sequencial" *diferente* pro Lote (adiciona ao lote em vez de imprimir direto). Não confundir os dois — são toggles/comportamentos separados, cada um no seu módulo.

**Fora de escopo explícito (do próprio spec do Tiago):** não alterar Etiqueta Avulsa nem Consulta de Preços nessa rodada — só Etiquetas em Lote.

---

## Spec original (verbatim, mensagem do Tiago em 2026-08-20)

### Prompt para implementação — Etiquetas em Lote

Crie/ajuste a funcionalidade **Etiquetas em Lote** do para ser uma ferramenta profissional de operação de supermercado, inspirada na lógica dos grandes ERPs de varejo, porém com uma interface mais moderna, simples e rápida.

A função deve permitir que o operador **selecione vários produtos, defina a quantidade de etiquetas de cada produto, revise o lote e envie tudo para a impressora portátil Urovo K329**.

---

### 1. Objetivo do módulo

O fluxo principal deve ser:

**BIPAR/PESQUISAR → ADICIONAR PRODUTOS → DEFINIR QUANTIDADES → REVISAR → IMPRIMIR LOTE**

Diferentemente da **Etiqueta Avulsa**, aqui o operador precisa conseguir trabalhar com vários produtos ao mesmo tempo.

---

### 2. Tela inicial

Título:

**Etiquetas em Lote**

Subtítulo:

**Monte um lote com vários produtos para impressão.**

No topo, disponibilizar:

**📷 Bipar produto**

e abaixo:

**🔎 Buscar por código ou nome do produto**

Ao bipar ou pesquisar um produto, ele deve ser adicionado automaticamente ao lote.

---

### 3. Lista de produtos do lote

Cada produto deve aparecer em um card/linha contendo:

* Nome do produto
* Código
* Preço atual
* Status
* Quantidade de etiquetas
* Botão `−`
* Quantidade atual
* Botão `+`
* Botão para remover o produto

Exemplo:

```text
ETIQUETAS EM LOTE

8 produtos
47 etiquetas

────────────────────────────

ARROZ TIPO 1 5KG
Código: 789123456789
Preço: R$ 24,90

Quantidade de etiquetas
[ − ]   10   [ + ]

────────────────────────────

FEIJÃO CARIOCA 1KG
Código: 789123456790
Preço: R$ 8,99

Quantidade de etiquetas
[ − ]    8   [ + ]

────────────────────────────

CAFÉ EXTRA FORTE 500G
Código: 789123456791
Preço: R$ 16,90

Quantidade de etiquetas
[ − ]    5   [ + ]
```

---

### 4. Quantidade padrão

Quando um produto for adicionado pela primeira vez:

**Quantidade padrão = 1 etiqueta**

O operador pode aumentar ou diminuir a quantidade.

Não obrigar o operador a abrir uma tela separada para alterar quantidade.

---

### 5. Adição rápida por bipagem

Esse ponto é muito importante.

Se o operador estiver utilizando a câmera/leitor:

**BIPAR → PRODUTO ADICIONADO AO LOTE**

Se o produto já estiver no lote:

**não criar outro produto duplicado.**

Em vez disso, aumentar automaticamente a quantidade em 1.

Exemplo:

Primeiro bip:

> Arroz 5kg — quantidade 1

Segundo bip:

> Arroz 5kg — quantidade 2

Terceiro bip:

> Arroz 5kg — quantidade 3

Isso permite montar um lote simplesmente bipando os produtos.

---

### 6. Filtros

Disponibilizar filtros para facilitar a montagem de lotes grandes:

* Departamento
* Setor
* Categoria
* Marca
* Produtos ativos
* Produtos em promoção

Adicionar também:

**Selecionar todos**

e:

**Limpar seleção**

---

### 7. Resumo do lote

Fixar na parte inferior da tela um resumo:

```text
────────────────────────────

8 produtos selecionados
47 etiquetas

🖨 Urovo K329
🟢 Conectada

[ REVISAR LOTE ]

[ 🖨 IMPRIMIR 47 ETIQUETAS ]
```

O botão principal deve ser grande e destacado.

---

### 8. Revisão do lote

Antes da impressão, abrir uma etapa simples de revisão.

Mostrar:

**Revisão do lote**

```text
8 produtos
47 etiquetas

Arroz 5kg ........ 10
Feijão 1kg ........ 8
Café 500g .......... 5
Açúcar 1kg ........ 12
Macarrão 500g ..... 12

────────────────────

Impressora
🟢 Urovo K329

[ VOLTAR E EDITAR ]

[ 🖨 IMPRIMIR LOTE ]
```

Não criar uma etapa excessivamente complexa.

---

### 9. Impressão

Ao clicar em:

**🖨 IMPRIMIR LOTE**

enviar todas as etiquetas para a Urovo K329.

Mostrar progresso:

```text
Imprimindo etiquetas...

████████████░░░░░░

32 de 47 etiquetas

Urovo K329
🟢 Imprimindo
```

Quando finalizar:

**✓ Lote impresso com sucesso**

**47 etiquetas impressas**

---

### 10. Erro de impressão

Se a impressora desconectar durante o processo:

```text
⚠ Impressão interrompida

A impressora Urovo K329 foi desconectada.

32 de 47 etiquetas foram impressas.

[ TENTAR NOVAMENTE ]

[ CONECTAR IMPRESSORA ]
```

Importante: não reimprimir automaticamente as 32 que já foram impressas.

Permitir continuar somente com as etiquetas restantes.

---

### 11. Modo Sequencial

Adicionar uma opção:

**Modo Sequencial**

Quando ativado:

```text
🟢 Modo Sequencial ATIVO
```

Nesse modo:

**BIPAR → ADICIONAR AO LOTE → CONTINUAR BIPANDO**

Cada bip adiciona uma etiqueta ao lote.

Exemplo:

Bipou Arroz → 1 etiqueta

Bipou Feijão → 1 etiqueta

Bipou Café → 1 etiqueta

Bipou Arroz novamente → Arroz passa para 2 etiquetas

No final:

**[ IMPRIMIR LOTE ]**

O modo sequencial deve facilitar operações em que o funcionário precisa percorrer uma área da loja e identificar vários produtos rapidamente.

---

### 12. Impressora

A impressora deve ser integrada diretamente ao módulo.

Exibir:

**🖨 Urovo K329**

**🟢 Conectada**

Se não estiver conectada:

**🔴 Desconectada**

com botão:

**Conectar impressora**

Não obrigar o operador a entrar nas configurações toda vez que quiser imprimir.

---

### 13. Histórico

Registrar cada lote impresso.

Mostrar:

* Data
* Horário
* Usuário
* Quantidade de produtos
* Quantidade de etiquetas
* Impressora utilizada
* Status da impressão

Exemplo:

```text
HISTÓRICO

Hoje — 15:42
8 produtos • 47 etiquetas
✓ Impresso

Hoje — 14:18
5 produtos • 21 etiquetas
✓ Impresso
```

---

### 14. Layout e identidade visual

Manter o padrão visual atual do Fluxo:

* fundo branco;
* amarelo da identidade visual nos elementos de destaque;
* verde apenas para status positivo/conectado;
* cards modernos;
* bordas arredondadas;
* sombras muito suaves;
* tipografia limpa;
* bastante espaço entre elementos;
* botões grandes para facilitar o uso no supermercado;
* interface otimizada para celular;
* visual profissional de ERP/SaaS.

Não deixar a tela carregada.

A prioridade é:

**VELOCIDADE + CLAREZA + OPERAÇÃO**

---

### Regra de diferenciação entre os módulos

**Etiqueta Avulsa**

> BIPAR → IMPRIMIR

Sempre 1 etiqueta.

**Etiqueta Avulsa — Modo Sequencial**

> BIPAR → BIPAR → BIPAR → IMPRIMIR LOTE

**Etiquetas em Lote**

> ADICIONAR PRODUTOS → DEFINIR QUANTIDADES → REVISAR → IMPRIMIR

Não misturar os fluxos.

O módulo deve parecer parte de um ERP profissional de supermercado, mas ser muito mais simples e rápido de operar do que sistemas tradicionais.

---

## Notas pra quando for implementar

- **Preservar sem quebrar:** o fluxo de lotes pré-montados na retaguarda (desktop, `abrirLoteParaImpressao`) precisa continuar funcionando — não é mencionado no spec acima, mas é o único jeito de montar lote fora do celular hoje.
- **Filtros "Categoria" e "Produtos em promoção" (seção 6):** não existem no `ETC_MOCK_PRODUTOS` atual nem na API real. Decidir com o Tiago (ou decidir e registrar a decisão) se adiciona campos fictícios ao mock pra esses dois filtros funcionarem, ou se ficam de fora até existir dado real.
- **"Modo Sequencial" (seção 11) parece sobrepor a seção 5** (adição por bipagem já incrementa automaticamente, sem precisar de toggle) — os dois exemplos do spec são idênticos. Ao implementar, esclarecer com o Tiago se "Modo Sequencial" é só um indicador visual de que a bipagem-adiciona-ao-lote está ativa, ou se é uma tela/comportamento genuinamente diferente do fluxo padrão de busca+filtro+checkbox.
- **Barra de progresso visual** (seção 9): hoje `renderFilaLote`/`imprimirProximoDaFila` só mostram texto ("Imprimindo N de M...") — precisa de uma barra de fato (CSS simples, sem lib nova).
- **Tela de erro de desconexão dedicada** (seção 10): hoje uma desconexão durante "Imprimir tudo" já para o loop e preserva a fila corretamente (não reimprime o que já saiu) — só falta o visual dedicado (cards "⚠ Impressão interrompida" com os dois botões específicos) em vez de só reaproveitar a tela normal da fila.
- **Histórico** (seção 13): reaproveitar a query/agrupamento que já existe em `renderEtcHub` pras "Últimas impressões", filtrado só pra `origem==='lote'`, em vez de construir do zero.
