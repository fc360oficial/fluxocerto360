# Inventário — aviso de código já coletado com opção de somar

**Data:** 2026-09-18 · **Pedido:** Tiago · **Escopo:** coleta por endereço (`registrarBipagem`), só no Fluxo.

## Problema
No balanço, o mesmo produto pode voltar a ser bipado depois de outros itens (esquecimento, produto espalhado). Hoje cada bip vira uma linha nova sem aviso; o coletor não sabe que já contou aquele item.

## Regra
1. Ao resolver o código (catálogo ou EAN cru), o app consulta `inv_bipagens` do inventário inteiro pelo mesmo produto (`codigo` quando resolvido, senão `ean`).
2. **Sequencial não pergunta:** se a última bipagem do coletor (`_bipsLocais[0]`) é o mesmo produto, grava direto como hoje. Contar unidade a unidade não pode travar.
3. Se já existe em qualquer endereço e não foi a última, abre o aviso com bip de alerta.
4. Consulta com limite de 1,5 s: sem resposta (rede ruim) grava direto, sem aviso. Contagem nunca fica bloqueada pela rede.

## Aviso (modal inferior, mesmo estilo do picker de EAN duplicado)
- Produto (código · descrição) e "Já coletado: **N un**".
- Lista de onde foi contado: endereço, coletor, quantidade (até 5 linhas e "mais N").
- Campo **Quantidade nova** com foco e teclado numérico, pré-preenchido com a Qtd da tela.
- Botões **Somar** (grava bipagem normal neste endereço; toast "Total agora: N+nova un") e **Cancelar** (descarta, volta pro campo de código).
- Enquanto aberto, leitor/câmera/teclado ficam bloqueados como nas outras decisões; só o campo de quantidade do modal aceita teclas. Enter nele = Somar, ignorando Enter nos primeiros 400 ms (sufixo do leitor).

## Fora do escopo
Substituir contagem, apagar bipagens de outro coletor, coleta avulsa, exportação (a soma já acontece no "Agrupar").

## Teste manual
Bipar A, A, A → 3 linhas sem aviso. Bipar A, B, A → aviso mostrando 2 de A, Somar 5 → toast "Total agora: 7 un"; Cancelar não grava. Modo avião: A, B, A → grava direto após 1,5 s.
