# Checklist: lançamento manual no Extrato — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin lança, pela linha do Extrato (Central de Resultados › Ranking › Extrato), um checklist feito no papel num dia em que a loja não enviou, e o dia passa a pontuar como envio normal, marcado como manual.

**Architecture:** Função pura `montarResultadoManual` em `lib/resultados-core.js` monta o documento no mesmo formato do envio pelo app. `app.js` ganha o botão "＋ Lançar" na linha do Extrato, o modal (`index.html`) e a função `salvarLancamentoManual` que grava em `resultados` e atualiza o cache local. Etiqueta "manual" aparece no tooltip do Extrato, na tabela da Central e no detalhe do envio.

**Tech Stack:** Vanilla JS (ES5 style, sem módulos no browser), Firebase Firestore (`db`), testes com `node:test` em `tests/`. Spec: `docs/superpowers/specs/2026-09-24-checklist-lancamento-manual-design.md`.

## Global Constraints

- Estilo ES5 no `app.js` e `lib/` (funções `function`, `var`, sem arrow/const) — o app roda em navegador fraco das lojas.
- Só `admin` vê o botão e grava (`S.role === 'admin'`).
- Nunca varrer `S.resultadosCache` dentro do `.then()` de uma escrita pra decidir reset de outros docs (latency compensation traz o próprio doc).
- Publicar só no Fluxo (`origin/main`); NUNCA `git push economico`. Deploy no Econômico é do Tiago.
- Ao alterar `lib/resultados-core.js`, subir o `?v=` dele no `index.html` (hoje `?v=1`) e o BUILD em `index.html` (`app.js?v=NNN`), `sw.js` (`CACHE_NAME` e `./app.js?v=NNN`) e `version.json`. BUILD atual: 419 → este trabalho vira **420**.
- Testes existentes em `tests/inventario.test.js` têm 2 falhas pré-existentes (campo `venda`, BUILD 412) — não são regressão deste plano.

---

### Task 1: `montarResultadoManual` em `lib/resultados-core.js` (TDD)

**Files:**
- Modify: `lib/resultados-core.js` (bloco `return {` na linha ~156)
- Test: `tests/resultados-core.test.js` (append no fim)

**Interfaces:**
- Produces: `ResultadosCore.montarResultadoManual(opts)` com
  `opts = { cl, marcados, operador, perfil, loja, clienteId, dateISO, autor, agora, genId }`
  - `cl`: `{ id, nome, setor, itens: [{ t, obs, foto, tipo, critico, prazoPlano }] }`
  - `marcados`: array alinhado a `cl.itens`; `true|false` para itens comuns, `'sim'|'nao'|null` para `tipo === 'simNao'`
  - `agora`: `Date`; `genId`: `function() -> string`
  - retorna o doc no formato do `res` de `enviarChecklist` (app.js ~3730) mais `manual: true, lancadoPor, lancadoEm`.

- [ ] **Step 1: Escrever os testes que falham**

Append em `tests/resultados-core.test.js`:

```js
// ── montarResultadoManual (spec 2026-09-24-checklist-lancamento-manual) ──
function clExemplo() {
  return {
    id: 'cl9', nome: 'Abertura', setor: 'Loja',
    itens: [
      { t: 'Ligar luzes', obs: '', foto: false, tipo: 'checkbox', critico: false, prazoPlano: 72 },
      { t: 'Foto da fachada', obs: 'frente', foto: 'antes_depois', tipo: 'checkbox', critico: false, prazoPlano: 72 },
      { t: 'Gondola ok?', obs: '', foto: false, tipo: 'simNao', critico: true, prazoPlano: 48 },
      { t: 'Conferir troco', obs: '', foto: false, tipo: 'checkbox', critico: false, prazoPlano: 72 }
    ]
  };
}
function optsManual(marcados) {
  return {
    cl: clExemplo(), marcados: marcados,
    operador: 'Maria', perfil: 'operator', loja: 'Cahu', clienteId: 'economico',
    dateISO: '2026-09-07', autor: 'Tiago',
    agora: new Date(2026, 8, 24, 9, 5), genId: function () { return 'id_manual_1'; }
  };
}

test('montarResultadoManual: 3 de 4 feitos -> pct 75, marcado como manual', () => {
  const doc = RC.montarResultadoManual(optsManual([true, true, 'sim', false]));
  assert.equal(doc.id, 'id_manual_1');
  assert.equal(doc.checklistId, 'cl9');
  assert.equal(doc.checklistNome, 'Abertura');
  assert.equal(doc.setor, 'Loja');
  assert.equal(doc.operador, 'Maria');
  assert.equal(doc.perfil, 'operator');
  assert.equal(doc.loja, 'Cahu');
  assert.equal(doc.clienteId, 'economico');
  assert.equal(doc.dateISO, '2026-09-07');
  assert.equal(doc.dataHora, '07/09/2026 00:00');
  assert.equal(doc.feitos, 3);
  assert.equal(doc.total, 4);
  assert.equal(doc.pct, 75);
  assert.equal(doc.reprovado, false);
  assert.equal(doc.assinatura, null);
  assert.equal(doc.manual, true);
  assert.equal(doc.lancadoPor, 'Tiago');
  assert.equal(doc.lancadoEm, '24/09/2026 09:05');
  assert.equal(doc.itens.length, 4);
});

test('montarResultadoManual: simNao conta feito só no sim', () => {
  assert.equal(RC.montarResultadoManual(optsManual([false, false, 'sim', false])).feitos, 1);
  assert.equal(RC.montarResultadoManual(optsManual([false, false, 'nao', false])).feitos, 0);
  assert.equal(RC.montarResultadoManual(optsManual([false, false, null, false])).feitos, 0);
  const d = RC.montarResultadoManual(optsManual([false, false, 'nao', false]));
  assert.equal(d.itens[2].resposta, 'nao');
  assert.equal(d.itens[0].resposta, null);
});

test('montarResultadoManual: crítico não feito reprova', () => {
  assert.equal(RC.montarResultadoManual(optsManual([true, true, 'nao', true])).reprovado, true);
  assert.equal(RC.montarResultadoManual(optsManual([true, true, null, true])).reprovado, true);
  assert.equal(RC.montarResultadoManual(optsManual([true, true, 'sim', true])).reprovado, false);
});

test('montarResultadoManual: nada marcado e checklist vazio', () => {
  const zero = RC.montarResultadoManual(optsManual([false, false, null, false]));
  assert.equal(zero.pct, 0);
  assert.equal(zero.feitos, 0);
  const o = optsManual([]); o.cl.itens = [];
  const vazio = RC.montarResultadoManual(o);
  assert.equal(vazio.total, 0);
  assert.equal(vazio.pct, 0);
  assert.equal(vazio.reprovado, false);
});

test('montarResultadoManual: itens sem foto e no formato do envio', () => {
  const doc = RC.montarResultadoManual(optsManual([true, true, 'sim', true]));
  doc.itens.forEach(function (it) {
    assert.equal(it.fotoAntes, null);
    assert.equal(it.fotoDepois, null);
    assert.equal(it.fotosMulti, null);
    assert.equal(it.produtos, null);
    assert.equal(it.emPlano, false);
    assert.equal(it.justificativa, '');
  });
  assert.deepEqual(Object.keys(doc.itens[1]).sort(),
    ['critico','emPlano','feito','foto','fotoAntes','fotoDepois','fotosMulti','justificativa','obs','prazoPlano','produtos','resposta','texto','tipo']);
  assert.equal(doc.itens[1].foto, 'antes_depois');
  assert.equal(doc.itens[1].feito, true);
  assert.equal(doc.itens[2].critico, true);
  assert.equal(doc.itens[2].prazoPlano, 48);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/resultados-core.test.js 2>&1 | grep -E "^ℹ (pass|fail)|not a function"`
Expected: `fail 5` e mensagem `RC.montarResultadoManual is not a function`.

- [ ] **Step 3: Implementar**

Em `lib/resultados-core.js`, logo ANTES do bloco `  return {` (linha ~156), inserir:

```js
  // ── Lançamento manual (spec 2026-09-24-checklist-lancamento-manual) ──
  // Monta um doc de `resultados` no mesmo formato do envio pelo app
  // (app.js enviarChecklist), para um checklist feito no papel. Sem fotos,
  // sem assinatura, hora fixa 00:00, e marcado com manual/lancadoPor/lancadoEm.
  function _pad2(n) { return String(n).padStart(2, '0'); }
  function _brDeISO(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso || '');
  }
  function montarResultadoManual(opts) {
    var cl = opts.cl || {};
    var marcados = opts.marcados || [];
    var itensCl = cl.itens || [];
    var itens = itensCl.map(function (item, idx) {
      var tipo = item.tipo || 'checkbox';
      var m = marcados[idx];
      var feito, resposta = null;
      if (tipo === 'simNao') {
        resposta = (m === 'sim' || m === 'nao') ? m : null;
        feito = resposta === 'sim';
      } else {
        feito = m === true;
      }
      return {
        texto: item.t, obs: item.obs || '', foto: item.foto || false, tipo: tipo,
        resposta: resposta, justificativa: '',
        fotoAntes: null, fotoDepois: null, fotosMulti: null,
        feito: feito, critico: !!item.critico,
        prazoPlano: item.prazoPlano || 72,
        produtos: null, emPlano: false
      };
    });
    var feitos = itens.filter(function (i) { return i.feito; }).length;
    var total = itens.length;
    var pct = total ? Math.round(feitos / total * 100) : 0;
    var reprovado = itens.some(function (i) { return i.critico && !i.feito; });
    var agora = opts.agora || new Date();
    var lancadoEm = _pad2(agora.getDate()) + '/' + _pad2(agora.getMonth() + 1) + '/' + agora.getFullYear()
      + ' ' + _pad2(agora.getHours()) + ':' + _pad2(agora.getMinutes());
    return {
      id: opts.genId(), checklistId: cl.id, checklistNome: cl.nome, setor: cl.setor || 'Geral',
      operador: opts.operador, perfil: opts.perfil || 'operator',
      loja: opts.loja || '', clienteId: opts.clienteId || '',
      dataHora: _brDeISO(opts.dateISO) + ' 00:00', dateISO: opts.dateISO,
      itens: itens, feitos: feitos, total: total, pct: pct,
      reprovado: reprovado, assinatura: null,
      manual: true, lancadoPor: opts.autor || null, lancadoEm: lancadoEm
    };
  }

```

E no bloco `return {`, trocar a última linha `mesclarPorId: mesclarPorId` por:

```js
    mesclarPorId: mesclarPorId,
    montarResultadoManual: montarResultadoManual
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/resultados-core.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/resultados-core.js tests/resultados-core.test.js
git commit -m "feat(checklist): montarResultadoManual no resultados-core (doc de lançamento manual)"
```

---

### Task 2: Modal no `index.html` + botão "＋ Lançar" e funções no `app.js`

**Files:**
- Modify: `index.html` — inserir o modal logo ANTES da linha `<div class="modal-bg" id="modal-visita-manual" style="display:none">` (linha ~715); subir `lib/resultados-core.js?v=1` → `?v=2` (linha ~2155)
- Modify: `app.js` — `renderRelRankExtrato()` (linha ~9563 tooltip, ~9596 `rows.push`, ~9661 botão ×); novas funções após `excluirResultadoDia` (linha ~9695)

**Interfaces:**
- Consumes: `ResultadosCore.montarResultadoManual` (Task 1); `getCustomCLs()`, `getUsers()`, `getResultados()`, `genId()`, `showToast()`, `_escHtml()`, `calcPontos()`, `RESKEY`, `S`, `db`, `renderRelRankExtrato()`.
- Produces: `abrirModalLancamentoManual(ano, mes, dia, loja, idsPerdidosStr)`, `_lmRenderItens()`, `_lmAtualizarRodape()`, `salvarLancamentoManual()`; ids DOM `modal-cl-manual`, `lm-data`, `lm-loja`, `lm-checklist`, `lm-operador`, `lm-itens`, `lm-rodape`.

- [ ] **Step 1: Modal no `index.html`**

Inserir antes do `modal-visita-manual`:

```html
      <div class="modal-bg" id="modal-cl-manual" style="display:none">
        <div class="modal-box" style="width:520px;max-width:95vw;max-height:92vh;overflow-y:auto">
          <div class="modal-title">Lançar checklist feito no papel</div>
          <div style="font-size:12px;color:var(--t3);margin:-10px 0 14px">Use quando a loja fez o checklist mas não enviou pelo app. Fica registrado como lançamento manual no seu nome.</div>
          <div style="display:flex;gap:10px;margin-bottom:12px">
            <div class="fg" style="flex:1"><label>Data</label><input id="lm-data" readonly style="background:#f3f4f6"></div>
            <div class="fg" style="flex:1"><label>Loja</label><input id="lm-loja" readonly style="background:#f3f4f6"></div>
          </div>
          <div class="fg" style="margin-bottom:12px"><label>Checklist</label><select id="lm-checklist" onchange="_lmRenderItens()"></select></div>
          <div class="fg" style="margin-bottom:12px"><label>Operador (quem fez)</label><select id="lm-operador"></select></div>
          <div class="fg" style="margin-bottom:4px"><label>Itens feitos</label>
            <div id="lm-itens" style="border:1px solid var(--gray2);border-radius:8px;max-height:40vh;overflow-y:auto"></div>
          </div>
          <div id="lm-rodape" style="font-size:13px;font-weight:700;margin:10px 0 14px;color:var(--t2)"></div>
          <div class="btn-row">
            <button class="btn btn-p" onclick="salvarLancamentoManual()">Lançar</button>
            <button class="btn btn-s" onclick="document.getElementById('modal-cl-manual').style.display='none'">Cancelar</button>
          </div>
        </div>
      </div>

```

Subir a versão do core: `<script src="lib/resultados-core.js?v=2"></script>`.

- [ ] **Step 2: Botão na linha do Extrato (`app.js`)**

Em `renderRelRankExtrato()`, no `rows.push({...})` (linha ~9596), trocar a linha final

```js
               resultIds:resDia.map(function(ri){return ri.id;}).filter(Boolean)});
```
por
```js
               resultIds:resDia.map(function(ri){return ri.id;}).filter(Boolean),
               idsPerdidos:clEsp.filter(function(cl){ return !resDia.some(function(r){ return r.checklistId===cl.id; }); }).map(function(cl){ return cl.id; }),
               passado:dataDia <= new Date()});
```

No tooltip (linha ~9563, dentro do `if (sent)`), trocar:

```js
        detalhe.push({nome:cl.nome, pct:sent.pct, pts:pts, ok:true});
```
por
```js
        detalhe.push({nome:cl.nome+(sent.manual?' (manual)':''), pct:sent.pct, pts:pts, ok:true});
```

Na célula Status (linha ~9661), logo DEPOIS do botão × existente e ANTES do `+'</td>'`, acrescentar uma linha:

```js
      +(S.role==='admin'&&r.passado&&r.idsPerdidos&&r.idsPerdidos.length?' <button onclick="abrirModalLancamentoManual('+anoSel+','+mesSel+','+r.d+',\''+lojaSel.replace(/'/g,"\\'")+'\',\''+r.idsPerdidos.join(',')+'\')" style="font-size:10px;padding:1px 6px;border:1px solid var(--g);color:var(--g);background:transparent;border-radius:4px;cursor:pointer;vertical-align:middle;margin-left:3px" title="Lançar checklist feito no papel">＋ Lançar</button>':'')
```

- [ ] **Step 3: Funções do modal (`app.js`, após `excluirResultadoDia`)**

```js
// ── Lançamento manual de checklist feito no papel (spec 2026-09-24) ──
var _lm = { ano:0, mes:0, dia:0, loja:'', dateISO:'' };

function abrirModalLancamentoManual(ano, mes, dia, loja, idsStr) {
  if (S.role !== 'admin') return;
  var ids = String(idsStr||'').split(',').filter(Boolean);
  var cls = getCustomCLs().filter(function(cl){ return ids.indexOf(cl.id) >= 0; });
  if (!cls.length) { showToast('Nenhum checklist pendente nesse dia.'); return; }
  _lm = { ano:ano, mes:mes, dia:dia, loja:loja,
          dateISO: ano+'-'+String(mes+1).padStart(2,'0')+'-'+String(dia).padStart(2,'0') };
  document.getElementById('lm-data').value = String(dia).padStart(2,'0')+'/'+String(mes+1).padStart(2,'0')+'/'+ano;
  document.getElementById('lm-loja').value = loja;
  document.getElementById('lm-checklist').innerHTML = cls.map(function(cl){
    return '<option value="'+_escHtml(cl.id)+'">'+_escHtml(cl.nome)+'</option>';
  }).join('');
  var ops = getUsers().filter(function(u){
    return u.ativo !== false && u.nome && (u.loja||'').trim().toLowerCase() === loja.toLowerCase();
  }).sort(function(a,b){ return a.nome.localeCompare(b.nome); });
  document.getElementById('lm-operador').innerHTML = '<option value="">Selecione...</option>'
    + ops.map(function(u){ return '<option value="'+_escHtml(u.id)+'">'+_escHtml(u.nome)+'</option>'; }).join('');
  _lmRenderItens();
  document.getElementById('modal-cl-manual').style.display = 'flex';
}

function _lmChecklistAtual() {
  var id = document.getElementById('lm-checklist').value;
  return getCustomCLs().find(function(cl){ return cl.id === id; }) || null;
}

function _lmRenderItens() {
  var cl = _lmChecklistAtual();
  var el = document.getElementById('lm-itens');
  if (!cl) { el.innerHTML = ''; _lmAtualizarRodape(); return; }
  el.innerHTML = (cl.itens||[]).map(function(item, idx){
    var tipo = item.tipo || 'checkbox';
    var legenda = (item.foto && item.foto !== 'none') ? '<span style="font-size:11px;color:var(--t3)"> · sem foto (papel)</span>' : '';
    var critico = item.critico ? ' <b style="color:var(--r);font-size:10px">CRÍTICO</b>' : '';
    var linha = '<div style="padding:8px 12px;border-bottom:1px solid var(--gray2);display:flex;align-items:center;gap:10px;font-size:13px">';
    if (tipo === 'simNao') {
      linha += '<span style="flex:1">'+_escHtml(item.t)+critico+legenda+'</span>'
        + '<label style="cursor:pointer"><input type="radio" name="lm-sn-'+idx+'" value="sim" onchange="_lmAtualizarRodape()"> Sim</label>'
        + '<label style="cursor:pointer"><input type="radio" name="lm-sn-'+idx+'" value="nao" onchange="_lmAtualizarRodape()"> Não</label>';
    } else {
      linha += '<label style="flex:1;cursor:pointer;display:flex;align-items:center;gap:8px"><input type="checkbox" class="lm-chk" data-idx="'+idx+'" onchange="_lmAtualizarRodape()"> <span>'+_escHtml(item.t)+critico+legenda+'</span></label>';
    }
    return linha + '</div>';
  }).join('') || '<div style="padding:12px;color:var(--t3);font-size:12px">Checklist sem itens.</div>';
  _lmAtualizarRodape();
}

function _lmLerMarcados() {
  var cl = _lmChecklistAtual();
  if (!cl) return [];
  return (cl.itens||[]).map(function(item, idx){
    if ((item.tipo||'checkbox') === 'simNao') {
      var r = document.querySelector('input[name="lm-sn-'+idx+'"]:checked');
      return r ? r.value : null;
    }
    var c = document.querySelector('.lm-chk[data-idx="'+idx+'"]');
    return !!(c && c.checked);
  });
}

function _lmMontarDoc() {
  var cl = _lmChecklistAtual();
  var opEl = document.getElementById('lm-operador');
  var op = getUsers().find(function(u){ return u.id === opEl.value; });
  return ResultadosCore.montarResultadoManual({
    cl: cl, marcados: _lmLerMarcados(),
    operador: op ? op.nome : '', perfil: op ? (op.perfil || 'operator') : 'operator',
    loja: _lm.loja, clienteId: (S.currentUser && S.currentUser.clienteId) || '',
    dateISO: _lm.dateISO, autor: (S.currentUser && S.currentUser.nome) || null,
    agora: new Date(), genId: genId
  });
}

function _lmAtualizarRodape() {
  var el = document.getElementById('lm-rodape');
  var cl = _lmChecklistAtual();
  if (!cl) { el.textContent = ''; return; }
  var d = _lmMontarDoc();
  el.textContent = 'Concluído: '+d.feitos+' de '+d.total+' itens · '+d.pct+'% · +'+calcPontos(d.pct)+' pontos'+(d.reprovado?' · REPROVADO (crítico não feito)':'');
}

function salvarLancamentoManual() {
  if (S.role !== 'admin') return;
  var cl = _lmChecklistAtual();
  if (!cl) { showToast('Selecione o checklist.'); return; }
  if (!document.getElementById('lm-operador').value) { showToast('Selecione o operador.'); return; }
  var jaTem = getResultados().some(function(r){
    return !r.resetado && r.checklistId === cl.id && r.dateISO === _lm.dateISO
      && ((r.loja||'').trim().toLowerCase() === _lm.loja.toLowerCase());
  });
  if (jaTem) { showToast('Já existe envio desse checklist nesse dia.'); return; }
  var doc = _lmMontarDoc();
  showToast('📤 Lançando...');
  db.collection('resultados').doc(doc.id).set(doc).then(function(){
    document.getElementById('modal-cl-manual').style.display = 'none';
    // O listener de 30 dias pode já ter trazido este doc (latency
    // compensation) — só adiciona se ainda não está no cache.
    if (!S.resultadosCache.some(function(r){ return r.id === doc.id; })) S.resultadosCache.push(doc);
    try {
      var semAssina = S.resultadosCache.map(function(r){ return r.assinatura ? Object.assign({},r,{assinatura:null}) : r; });
      localStorage.setItem(RESKEY, JSON.stringify(semAssina));
    } catch(e){}
    showToast('Lançado: '+cl.nome+' · '+doc.operador+' · '+doc.pct+'% (+'+calcPontos(doc.pct)+')');
    renderRelRankExtrato();
  }).catch(function(e){
    showToast('Erro ao lançar: '+(e && e.message ? e.message : e));
  });
}
```

- [ ] **Step 4: Checagem de sintaxe**

Run: `node --check app.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js
git commit -m "feat(checklist): botão '+ Lançar' no Extrato e modal de lançamento manual"
```

---

### Task 3: Etiqueta "manual" na Central de Resultados e no detalhe

**Files:**
- Modify: `app.js` — `renderCentral()` linha ~4246 (célula Perfil); função do detalhe linha ~4576 (linha "Operador:")

- [ ] **Step 1: Pílula na tabela da Central**

Trocar (linha ~4246):

```js
      +'<td><span class="st '+(PCLS[r.perfil]||'st-ok')+'">'+(PLABEL[r.perfil]||r.perfil)+'</span></td>'
```
por
```js
      +'<td><span class="st '+(PCLS[r.perfil]||'st-ok')+'">'+(PLABEL[r.perfil]||r.perfil)+'</span>'
      +(r.manual?' <span class="st st-warn" title="Lançado por '+_escHtml(r.lancadoPor||'?')+' em '+_escHtml(r.lancadoEm||'')+'">Manual</span>':'')+'</td>'
```

- [ ] **Step 2: Linha no detalhe**

Trocar (linha ~4576):

```js
    +'<p>Operador: <strong>'+r.operador+'</strong> &nbsp;|&nbsp; '+( PLABEL[r.perfil]||r.perfil)+' &nbsp;|&nbsp; <span class="status-pill">'+statusTxt+'</span></p>'
```
por
```js
    +'<p>Operador: <strong>'+r.operador+'</strong> &nbsp;|&nbsp; '+( PLABEL[r.perfil]||r.perfil)+' &nbsp;|&nbsp; <span class="status-pill">'+statusTxt+'</span></p>'
    +(r.manual?'<p style="color:#b45309">Lançamento manual por <strong>'+(r.lancadoPor||'?')+'</strong> em '+(r.lancadoEm||'')+'</p>':'')
```

- [ ] **Step 3: Sintaxe e commit**

Run: `node --check app.js && echo OK` → `OK`.

```bash
git add app.js
git commit -m "feat(checklist): etiqueta 'Manual' na Central de Resultados e no detalhe do envio"
```

---

### Task 4: BUILD 420, teste real no Fluxo e publicação

**Files:**
- Modify: `index.html` (`app.js?v=419` → `420`), `sw.js` (`cahu360-v419` → `v420`, `./app.js?v=419` → `420`), `version.json` (`{"build":"420"}`)

- [ ] **Step 1: Bump**

```bash
sed -i 's/cahu360-v419/cahu360-v420/; s/app.js?v=419/app.js?v=420/' sw.js
sed -i 's/app.js?v=419/app.js?v=420/' index.html
echo '{"build":"420"}' > version.json
grep -n "420" sw.js index.html version.json
```
Expected: 4 linhas com 420.

- [ ] **Step 2: Testes**

Run: `node --test tests/resultados-core.test.js 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 3: Commit e push só pro Fluxo**

```bash
git add index.html sw.js version.json
git commit -m "chore: BUILD 420 — lançamento manual de checklist no Extrato"
git push origin main
```

- [ ] **Step 4: Verificação manual no Fluxo (Tiago ou agente com navegador)**

No app do Fluxo (dev), logado como admin, Central de Resultados › Ranking › Extrato, escolher uma loja e um dia vermelho:
1. Botão "＋ Lançar" aparece só nas linhas com falta e só em dias até hoje.
2. Modal abre com data/loja travadas, checklist pendente já selecionado, operadores da loja.
3. Marcar itens: rodapé muda "X de Y · N% · +P".
4. Lançar → toast verde, linha vira ✅ com +P; tooltip mostra "(manual)".
5. Central de Resultados › aba Checklist: envio aparece com pílula "Manual"; Ver → linha "Lançamento manual por ...".
6. Clicar × na linha do Extrato desfaz (volta a vermelho).
7. Se o passo 4 der `permission-denied`: as regras do Console não permitem `create` retroativo em `resultados`. Entregar ao Tiago a regra pra colar no Console (o `firestore.rules` do repo não é fonte confiável): dentro de `match /resultados/{id}`, garantir `allow create: if request.auth != null;` — ajustar ao formato que já existe no Console, só acrescentando `create` se hoje só há `update`.

- [ ] **Step 5: Atualizar memória**

Em `C:\Users\tiago\.claude\projects\C--Users-tiago\memory\project_fc360-checklist-autoreset-e-lancamento-manual.md`: registrar que o caminho (1) foi implementado no BUILD 420, commit, pendência de deploy no Econômico pelo Tiago, e se as regras precisaram de ajuste. Atualizar a linha no `MEMORY.md`.
