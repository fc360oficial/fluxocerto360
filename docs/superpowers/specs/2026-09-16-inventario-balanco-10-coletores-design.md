# Inventário FC360 — preparação pra balanço com 10 coletores

Data: 2026-09-16. Prazo: segunda 2026-09-21.
Cliente alvo: loja de bazar (pratos, baldes, copos), itens com código interno do ERP e/ou EAN.
Coletores: celular Android, câmera (ZXing) e leitor Bluetooth (keyboard wedge, envia Enter).
Login: um único usuário compartilhado com perfil `coletor`; a pessoa se distingue pelo ID de Coletor gravado no aparelho. Inventário sempre em Modo Fila.

## Arquivo real do cliente

Template de mercadorias do ERP (xlsx, 4.395 itens): código interno numérico de 1 a 4 dígitos, 526 itens sem EAN, 21 com referência no lugar do EAN, 1 EAN repetido em 2 códigos, coluna estoque com 3 decimais. TXT gerado em `Downloads/catalogo_bazar_fc360.txt` no formato `CODIGO;EAN;DESCRICAO;UN;ESTOQUE`. O importador precisa aceitar exatamente esse arquivo.

## Contexto (o que motivou)

Auditoria de 2026-09-16 do módulo (app.js ~12440–15790) e leitura do Firestore de produção:

- O módulo nunca rodou um balanço real: 29 bipagens na vida toda, pico de 4/min.
- `registrarBipagem()` espera o ack do servidor antes de limpar o campo e liberar a próxima leitura; offline trava depois da 1ª bipagem; leitura rápida durante o pendente é descartada (`_bipRegistrando`) ou cai no campo Qtd.
- Cada bipagem faz `increment(1)` em `inv_inventarios/{id}` — mesmo doc que guarda a fila. Com 10 coletores passa do limite de 1 escrita/s por documento.
- Catálogo é 1 doc por item (`inv_catalogo`), baixado inteiro em cada aparelho a cada abertura. Chave só por EAN, sem código interno; EAN repetido colapsa.
- Tela de escolher endereço baixa todas as bipagens do inventário a cada troca.
- Lookup usa código cru, mas o mapa é gravado com `_normEan` (zero à esquerda removido): produto com EAN iniciado em 0 dá "não está na base".
- Regex de coluna de código no importador só aceita 8 ou 13 dígitos; pulo automático pra Qtd e aviso "fora da base" idem.

## Escopo

1. Bipagem local-first com bip sonoro.
2. Contador de bipagens fora do documento do inventário.
3. Catálogo com código interno + EAN, gravado em blocos, importador com mapeamento de colunas, item fora da base registrado com marcação.
4. Seleção de endereço sem baixar bipagens.
5. Página de teste de carga: 10 coletores simulados, 50 mil bipagens no total, painel ao vivo.

Fora do escopo: regras do Firestore (vivem no Console), quantidade decimal, layout final de exportação do ERP do cliente (aguarda arquivo), modo por atribuição (sem fila).

## 1. Bipagem local-first + bip

### Comportamento
- `registrarBipagem()` monta o doc, chama `db.collection('inv_bipagens').doc(idGeradoNoCliente).set(doc)` **sem esperar** o resultado pra atualizar a UI. Limpa EAN e Qtd, foca EAN, toca bip de sucesso, adiciona a linha no topo de "Minhas bipagens" imediatamente.
- Persistência offline do Firestore (já ligada, `enablePersistence`) garante que a escrita fica em IndexedDB e sobe quando a rede volta, inclusive após F5.
- `_bipRegistrando` deixa de existir. Leituras em sequência rápida são todas aceitas.
- Contador de pendentes: `_offlinePending++` no registro, `--` no `.then` do set. O banner existente já mostra "Sincronizando N". Falha no `.catch` (ex.: permission-denied) toca bip de erro, mostra toast com o código lido e mantém a linha marcada em vermelho na lista local.
- Sequencial: `_nextSeq` é lido uma vez ao entrar no endereço (query do endereço, já existe em `_carregarUltimasBipagens`) e depois incrementado só em memória. Só um coletor por endereço no Modo Fila, então não colide.
- "Minhas bipagens": array em memória `_bipsLocais` (últimas 20 do endereço) alimentado pela query inicial e pelos registros locais. Sem reconsulta por bipagem.
- Mesma regra em `_confirmarSemEAN()` e `registrarBipagemAvulsa()`.

### Bip sonoro
- Função `_bipSom(tipo)` com WebAudio (sem asset): `ok` = 1 tom curto 1200 Hz 80 ms; `alerta` (fora da base) = 2 tons 600 Hz; `erro` = tom grave 300 Hz 250 ms.
- Chamada em: registro local OK, leitura da câmera (ZXing result) com tipo `ok`, item fora da base com `alerta`, falha de gravação com `erro`.
- AudioContext é criado no primeiro toque do usuário (política de autoplay do Android). Se falhar, silencioso.

### Foco e leitor Bluetooth
- Leitor envia código + Enter no campo EAN. `_eanEnterKey()`: se o código está na base → preenche descrição, foca Qtd. Enter na Qtd → registra. Enter direto no EAN com Qtd = 1 continua valendo (fluxo "1 item por leitura": opção "Qtd fixa 1" já coberta pelo comportamento atual de focar Qtd; manter).
- Enquanto a Qtd está focada e chega uma nova leitura (≥ 4 caracteres digitados em < 100 ms), o app trata como novo código: registra a anterior com a Qtd atual e coloca o novo código no EAN. Implementado por detector de rajada no `keydown` da Qtd.

## 2. Contador de bipagens

- Remover os 3 `update({totalBipagens: increment(1)})`.
- `renderInvList()` / `renderInvHistorico()`: contagem por `db.collection('inv_bipagens').where('invId','==',id).count().get()` (SDK 10.12 compat suporta). Lista mostra "…" até chegar. Cache em `S.invBipCount[id]` por 30 s.
- Dashboard realtime já conta a partir do listener; `encerrarInventario` já carrega as bipagens. Campo `totalBipagens` fica no doc só como legado (não é mais escrito).

## 3. Catálogo com código interno + EAN

### Modelo
- Coleção nova `inv_catalogo_blocos/{invId}_{n}`: `{invId, clienteId, n, itens: [{c, e, d, u}]}` com até 1.000 itens por doc (c = código interno, e = EAN, d = descrição, u = unidade, q = estoque do sistema, opcional). ~60–150 KB por doc, abaixo do limite de 1 MB.
- `inv_catalogo` (1 doc/item) deixa de ser escrita. Leitura mantém fallback: se não há blocos, lê a coleção antiga (inventários já criados). `_limparSubcolecoes` e a exclusão de cliente passam a apagar as duas.
- Mapa em memória por inventário: `_catCache[invId] = {porCodigo: {}, porEan: {}, total}`. `porEan` usa `_normEan`. Cache também em `localStorage`? Não: 50 mil itens × ~40 bytes = 2 MB, cabe, mas a persistência do Firestore já guarda os 50 docs em IndexedDB; a leitura seguinte com rede vai ao servidor (50 leituras, rápido). Sem cache extra.

### Resolução do código lido
`_resolverCodigo(invId, lido)`:
1. `porCodigo[lido]` exato.
2. `porEan[_normEan(lido)]`.
3. Se `lido` tem 12 dígitos, tenta `porEan['0'+lido]` normalizado (UPC-A).
Retorna `{codigo, ean, desc, un}` ou `null`. Se o EAN resolve pra mais de um código (caso real: 7898604340230 → 325 e 3246), abre um picker com os códigos e descrições e o coletor escolhe; a bipagem grava o código escolhido.

Bipagem grava `codigo` (interno, resolvido), `ean` (o que foi lido) e `naoCadastrado: true` quando não resolveu. Descrição do catálogo não é copiada na bipagem (resolve na leitura), exceto sem-EAN.

### Importador
- Lê TXT/CSV (`;`, `|`, tab ou `,` detectado na 1ª linha), ISO-8859-1 com fallback UTF-8 se aparecer `�`.
- Modal de mapeamento: 5 selects (Código interno, EAN, Descrição, Unidade, Estoque do sistema — opcional) pré-preenchidos por heurística: cabeçalho contendo `cod`, `ean`/`barra`, `desc`, `un`; sem cabeçalho, coluna com 8/13/14 dígitos = EAN, coluna numérica curta = código. Mostra 3 linhas de prévia. Só Código ou EAN é obrigatório (pelo menos um).
- Grava em lotes de blocos com pausa/retry (reaproveita `_commitComRetry`). Reenviar apaga blocos anteriores antes.
- Status mostra "N produtos · X com EAN · Y só código".

### UI de coleta
- Aviso e pulo pra Qtd disparam em qualquer código que resolva no catálogo, não só 8/13 dígitos. Preview mostra `código · descrição · un`.
- Fora da base: preview vermelho "Não cadastrado — vai ser registrado com marcação", bip `alerta`, registro permitido. Linha na lista com badge NC.
- Aba admin "Bipagens" ganha filtro "Só não cadastrados". Aba "Não Coletados" compara por código interno (ou EAN quando não há código).
- Exportação: campo novo `codigo` ("Código interno") em `_ERP_CAMPOS`, incluído no preset FC360 Padrão. Agrupamento (`agrupa`) passa a chavear por `codigo||ean`.

## 4. Seleção de endereço leve

- `renderColeta()` (picker) e `_renderSelecaoEndereco()` deixam de chamar `loadBipagensByInv`. A linha mostra só o estado do slot da `fila` (disponível / em andamento por X / finalizado por X). Contagem de bipagens por endereço sai da tela do coletor (continua no dashboard admin).
- Entrar no endereço faz a única query pequena: bipagens daquele endereço (para `_nextSeq` e últimas 20).

## 5. Teste de carga

- Arquivo `teste-carga.html` na raiz (mesmo Firebase config, carrega `app.js` não; usa o SDK direto pra não depender da UI). Acessível só digitando a URL; exige login com usuário do tenant `fluxocerto` (dev). Bloqueia se `clienteId !== 'fluxocerto'`.
- Passos na tela: (1) Criar inventário de teste (`nome: "CARGA <data>"`, 100 endereços, Modo Fila, clienteId fluxocerto) e catálogo sintético de 50.000 itens em blocos (código `C000001..`, EAN válido gerado, 70 % com EAN); (2) Rodar: 10 workers em `Promise` paralelas, cada um pega um endereço da fila, faz 500 bipagens, finaliza, pega o próximo, até 5.000; ritmo configurável (máximo ou 1 bipagem a cada N ms); (3) Limpar: apaga bipagens, blocos e o inventário.
- Cada worker usa a mesma função de gravação da coleta real (`set` sem await, id gerado no cliente) — extraída pra `lib/inv-bip-core.js` e incluída tanto no `app.js` (via `<script>` no index) quanto na página de teste, pra garantir que o caminho testado é o real.
- Painel ao vivo (atualiza 2×/s): por coletor — enviadas, confirmadas, pendentes, erros, bip/s, latência média e p95 do ack; total geral; tempo decorrido; estimativa de término. Log de erros com código Firestore.
- Critério de aprovação: 50.000 confirmadas, 0 erros, p95 de ack < 3 s com ritmo máximo, painel admin do inventário abrindo em < 10 s com as 50 mil.
- Custo estimado: ~50 mil escritas (~R$ 0,50) + leituras do painel admin.

## Erros e limites

- `permission-denied` na bipagem: bip erro + toast + linha vermelha; não trava a fila.
- `resource-exhausted` no import: já tem retry com backoff, mantido.
- Bloco > 1 MB: impossível com 1.000 itens (limite 1.000 é fixo, descrição truncada em 120 chars).
- `count()` falhando (rede): lista mostra "—".

## Testes

- Unitários (Node, sem Firebase): `_normEan`, `_resolverCodigo` com catálogo fake, heurística de mapeamento de colunas, parser de linhas, detector de rajada do leitor, montagem de blocos (tamanho e ordem), `_erp_buildLinhas` com campo `codigo` e agrupamento por código. Arquivo `tests/inventario.test.js` rodando com `node --test`.
- Manual: 2 celulares reais no tenant fluxocerto com leitor Bluetooth, bip audível, avião ligado → 20 bipagens → avião desligado → tudo sobe.
- Carga: página do bloco 5, critério acima, com o Tiago assistindo.

## Entrega

- Tudo publicado só no Fluxo (`origin/main`), BUILD incrementado nos 4 lugares. Deploy pro cliente é do Tiago.
