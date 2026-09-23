# Checklist: envio confiável e carga leve — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** checklist enviado da loja chega sempre na retaguarda, e o app deixa de baixar/persistir 165 MB em cada login.

**Architecture:** funções puras em `lib/resultados-core.js` (UMD, mesmo padrão de `lib/inv-bip-core.js`) testadas com `node:test`; `app.js` passa a (1) gravar fotos/assinatura em `resultados_fotos` num batch atômico junto com o resultado, (2) carregar/escutar só `dateISO >= hoje-30d` ignorando escritas pendentes, (3) buscar meses antigos e fotos sob demanda.

**Tech Stack:** vanilla JS (ES5 no app.js), Firebase compat 10.12 (Firestore), node:test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-23-checklist-envio-confiavel-design.md`.
- Nada de Storage, nada de regra/índice novo, nada de migração de docs antigos.
- Não publicar em nenhum cliente. Commit só na main local. BUILD sobe nos 4 lugares (app.js `var BUILD`, index.html `app.js?v=`, sw.js `CACHE_NAME` + lista, version.json) só no último task.
- Docs em `resultados` novos NÃO podem conter base64 (`fotoAntes/fotoDepois/fotosMulti/assinatura`).
- Consultas em `resultados`/`resultados_fotos` usam um único campo com filtro (sem índice composto).

---

### Task 1: `lib/resultados-core.js` + testes

**Files:**
- Create: `lib/resultados-core.js`
- Test: `tests/resultados-core.test.js`

**Produces:**
- `separarFotos(res) -> {doc, fotos:[{id, data:{resultadoId, clienteId, loja, dateISO, slot, data}}]}`
- `enxugar(res) -> res sem base64, `_semFotos:true` se tinha base64 e não tem refs`
- `filtrarConfirmados(docs) -> docs sem metadata.hasPendingWrites` (docs = objetos com `.metadata` e `.data()`)
- `janelaISO(dias, hoje?) -> 'YYYY-MM-DD'`
- `precisaCarregar(deISO, carregadoDesde) -> boolean`
- `itemTemFoto(item, tipo?) -> boolean` (tipo em `antes|depois|multi|qualquer`)
- `montarFotosHidratadas(doc, fotosDocs) -> cópia do doc com base64 preenchido`
- `mesclarPorId(lista, novos) -> lista`

- [ ] Escrever `tests/resultados-core.test.js` cobrindo cada função (ver spec §6).
- [ ] Rodar `node --test tests/` → falha (módulo não existe).
- [ ] Implementar `lib/resultados-core.js`.
- [ ] Rodar `node --test tests/` → passa.
- [ ] Commit `feat(checklist): core puro de resultados (fotos separadas, janela, confirmados)`.

### Task 2: envio em batch (`confirmarEnviar`)

**Files:**
- Modify: `app.js` `confirmarEnviar` (~3616-3760); `index.html` carregar `lib/resultados-core.js` antes de `app.js`.

- [ ] Depois de montar `res`, chamar `var sep = RC.separarFotos(res);`.
- [ ] `var batch = db.batch(); sep.fotos.forEach(f => batch.set(db.collection('resultados_fotos').doc(f.id), f.data)); batch.set(db.collection('resultados').doc(sep.doc.id), sep.doc); batch.commit().then(...)`.
- [ ] No `.then`, cache recebe `sep.doc` (já sem base64); manter guarda `r.id !== res.id`.
- [ ] `.catch` inalterado (toast vermelho, tela editável).
- [ ] Commit `feat(checklist): envio grava fotos em resultados_fotos num batch atomico com o resultado`.

### Task 3: carga e listener com janela de 30 dias, só confirmados

**Files:**
- Modify: `app.js` `loadResultadosFromFirebase` (~909), `iniciarResultadosRealtime` (~1024), novo `var _resCarregadoDesde`.

- [ ] `_resCarregadoDesde = RC.janelaISO(30)` no início de cada carga/listener.
- [ ] `db.collection('resultados').where('dateISO','>=',_resCarregadoDesde)` nos dois lugares.
- [ ] Listener: `RC.filtrarConfirmados(snap.docs).map(d => RC.enxugar(d.data()))`.
- [ ] Load: `snap.docs.map(d => RC.enxugar(d.data()))`.
- [ ] Ao mesclar com docs de meses antigos já carregados (`_resCarregadoDesde` anterior menor), usar `RC.mesclarPorId(antigos, novos)` pra não perder o que o usuário buscou sob demanda.
- [ ] Commit `perf(checklist): login carrega so 30 dias de resultados e cache ignora escrita pendente`.

### Task 4: meses anteriores sob demanda

**Files:**
- Modify: `app.js`: nova `garantirResultadosDesde(deISO, cb)`; chamar em `setCentralMesDrop`, no filtro de datas da Central (`cf-dt-ini`, linha ~7504 listener), `setRelMesDrop`, `renderRelCorporativoTab` (lê `corp-mes/ano`), `setTendPeriod`.

- [ ] Implementar `garantirResultadosDesde`: se `!RC.precisaCarregar(deISO, _resCarregadoDesde)` → `cb()`; senão toast "Carregando período anterior...", query `dateISO >= deISO` e `dateISO < _resCarregadoDesde`, `get({source:'server'})`, `enxugar`, `mesclarPorId`, `_resCarregadoDesde = deISO`, `cb()`; no catch toast de erro e `cb()`.
- [ ] Em cada ponto: calcular `deISO` do período (1º dia do mês, `cf-dt-ini`, `corp-ano-01-01` ou `janelaISO(dias)`) e envolver o render em `garantirResultadosDesde(deISO, function(){ render(); })`.
- [ ] Commit `feat(checklist): meses anteriores carregam sob demanda na Central e Relatorios`.

### Task 5: detalhe/PDF com fotos sob demanda + contadores

**Files:**
- Modify: `app.js` `verDetalhe` (~4183), `exportarDetalhePDF` (~4364), contadores em ~4379, ~9061, ~9350, e o loop de fotos de `verDetalhe` (~4189, 4273-4290, 4393-4395).

- [ ] Nova `hidratarFotos(r, cb)`: cache `_fotosCache[r.id]`; se `r._semFotos` → `db.collection('resultados').doc(r.id).get()` e usar `doc.data()`; senão se algum item tem ref ou `r.assinaturaRef` → `db.collection('resultados_fotos').where('resultadoId','==',r.id).get()` → `RC.montarFotosHidratadas(r, docs)`; senão `cb(r)`.
- [ ] `verDetalhe(id)`: achar `r`, mostrar modal com "Carregando fotos..." e chamar `hidratarFotos(r, function(rh){ _renderDetalhe(rh); })` (mover o corpo atual pra `_renderDetalhe(r)`).
- [ ] Contadores usam `RC.itemTemFoto`.
- [ ] Commit `feat(checklist): detalhe e PDF carregam fotos sob demanda; contadores aceitam ref`.

### Task 6: validação ponta a ponta no Fluxo + BUILD

- [ ] `node --test tests/` verde.
- [ ] No navegador (tenant Fluxo, `client.js = fluxocerto`): login como admin@fluxocerto.com; enviar um checklist com foto como operador; conferir no Firestore (REST) que `resultados/{id}` não tem base64 e `resultados_fotos` tem os docs; Central mostra o envio; detalhe abre fotos; PDF; escolher mês anterior na Central carrega; abrir um doc antigo mostra fotos.
- [ ] Medir `navigator.storage.estimate()` após login: esperado bem abaixo de 180 MB.
- [ ] Bump BUILD nos 4 lugares. Commit `chore: BUILD 413 — envio confiavel de checklist`.
- [ ] NÃO fazer push pra `economico`. Push pra `origin/main` (Fluxo) permitido.
