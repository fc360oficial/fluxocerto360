# Checklist: envio confiável e carga leve — design

**Data:** 2026-09-23
**Problema:** desde 18/09 dois a três checklists gerenciais por dia não chegam na retaguarda, mesmo com a tela da loja dizendo "Checklist já enviado hoje!".

## Diagnóstico (evidência do servidor, 23/09)

- Coleção `resultados`: 534 docs, 165 MB. Cada envio grava 14 fotos + assinatura em base64 dentro do próprio doc (250 a 660 KB por doc). Cresce ~1,5 MB/dia.
- Todo login baixa a coleção inteira duas vezes (`get({source:'server'})` + `onSnapshot` sem filtro), de todos os clientes, e persiste tudo no IndexedDB (180 MB medidos num PC; 29 s até aparecer resultado numa conexão boa).
- O listener alimenta o cache com escritas ainda pendentes (latency compensation). `jaEnviouHoje()` lê esse cache, então a tela trava em "já enviado" antes do servidor confirmar. Se o envio nunca sai (app fechado, fila presa, IndexedDB cheio), o fantasma fica no localStorage e nunca é limpo.
- Nenhum deploy entre 14/09 e 22/09 mexeu no caminho de envio. O que passou do limite foi o volume.

## Decisões (Tiago, 23/09)

1. Fotos e assinatura saem do doc e vão para uma coleção separada `resultados_fotos` no Firestore (Storage não existe no projeto; não ativar).
2. Janela de carga no login: 7 dias (era 30; Tiago reduziu em 23/09 pra aliviar o celular). Meses anteriores buscados sob demanda.
3. Docs antigos não são migrados. Continuam abrindo normal e saem da janela com o tempo.
4. Nada é publicado no cliente sem autorização; código fica na main local com BUILD novo.

## Design

### 1. Modelo de dados

`resultados/{id}` — igual ao atual, **sem** base64:

- cada item pode ter `fotoAntesRef`, `fotoDepoisRef` (string, id em `resultados_fotos`) e `fotosMultiRef` (array de ids). Os campos `fotoAntes`, `fotoDepois`, `fotosMulti` ficam ausentes em docs novos.
- `assinaturaRef` (string) no lugar de `assinatura`.

`resultados_fotos/{resultadoId}_{slot}` — um doc por imagem:

```
{ resultadoId, clienteId, loja, dateISO, slot, data }   // data = dataURL jpeg/png
```

`slot` = `"{itemIdx}_antes"`, `"{itemIdx}_depois"`, `"{itemIdx}_m{n}"` ou `"assinatura"`.

Regras do Console: a regra geral (`request.auth != null` não anônimo) já cobre a coleção nova. Nenhuma regra ou índice novo (consultas usam um campo só).

### 2. Envio (`confirmarEnviar`)

- `lib/resultados-core.js` → `separarFotos(res)` devolve `{doc, fotos[]}`: `doc` é o resultado com refs e sem base64; `fotos` são os docs de `resultados_fotos`.
- Um único `db.batch()`: todos os docs de foto + o doc do resultado. `commit()` é atômico (limite 10 MiB, máximo real ~700 KB).
- Só depois do `commit().then()`: marca envios anteriores do dia como resetado (mantendo a guarda `r.id !== res.id`), atualiza cache/localStorage e chama `_finalizarEnvioCL`.
- No `.catch`: toast vermelho, tela continua editável, nada gravado no cache.

### 3. Listener e cache só com dado confirmado

- `iniciarResultadosRealtime` e `loadResultadosFromFirebase` consultam `where('dateISO','>=', janelaISO(30))`. Filtro de `clienteId` continua no código.
- O listener ignora `doc.metadata.hasPendingWrites` (função pura `filtrarConfirmados`). Quando o servidor confirma, o snapshot dispara de novo e o doc entra.
- Docs antigos dentro da janela que ainda têm base64 são guardados no cache com `_semFotos: true` e sem `fotoAntes/fotoDepois/fotosMulti/assinatura` (função `enxugar(res)`).
- `jaEnviouHoje` continua lendo o cache; como o cache só tem confirmados, "já enviado" = confirmado.

### 4. Meses anteriores sob demanda

- `_resCarregadoDesde` (ISO) guarda o início da janela em memória.
- `garantirResultadosDesde(deISO, cb)`: se `deISO < _resCarregadoDesde`, consulta `dateISO >= deISO && dateISO < _resCarregadoDesde` no servidor, enxuga, mescla por id no cache, atualiza `_resCarregadoDesde`, chama `cb`. Se não precisar, chama `cb` na hora. Toast "Carregando mês anterior..." enquanto busca.
- Pontos de chamada: `setCentralMesDrop` e filtro de datas da Central, `setRelMesDrop`, selects `corp-mes`/`corp-ano`, `setTendPeriod` (90 dias).
- Docs sem `dateISO` (anteriores a junho/2026) ficam fora dessas buscas por definição.

### 5. Detalhe e PDF com fotos sob demanda

- `hidratarFotos(r, cb)`: se `r._semFotos` (doc antigo enxugado) relê `resultados/{id}` inteiro; se tiver refs, consulta `resultados_fotos where resultadoId == r.id` e preenche `fotoAntes/fotoDepois/fotosMulti/assinatura` no objeto usado pela tela. Resultado fica em cache de memória (`_fotosCache[id]`).
- `verDetalhe` chama `hidratarFotos` antes de montar o modal (mostra "Carregando fotos..."). `exportarDetalhePDF` usa `window._detAtual`, já hidratado.
- Contadores de foto (`fotoCount` do detalhe, total de fotos do resumo executivo, "sem foto" do ranking de lojas) passam por `itemTemFoto(item, tipo)` que aceita ref ou base64.

### 6. Testes

`tests/resultados-core.test.js` (node:test, mesmo padrão do inventário):

- `separarFotos`: gera refs/slots corretos, doc sem base64, assinatura vira doc próprio, item sem foto não gera doc.
- `enxugar`: remove base64 e marca `_semFotos`; não marca doc já com refs.
- `filtrarConfirmados`: descarta pendentes.
- `janelaISO(30)` e `precisaCarregar(deISO, carregadoDesde)`.
- `itemTemFoto` com ref, base64 e nada.
- `montarFotosHidratadas` (refs + docs de foto → objeto de tela).

Validação manual no tenant Fluxo (navegador): envio com fotos, retaguarda mostra na hora, detalhe abre fotos, PDF, mês anterior carrega, doc antigo abre com fotos.

## Fora de escopo

Migração dos docs antigos; Firebase Storage; limpeza do IndexedDB já inchado nos celulares (a GC do Firestore libera os docs que saírem do listener); blindagem de regras por cliente.
