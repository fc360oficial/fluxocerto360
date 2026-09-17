# Inventário FC360 — balanço com 10 coletores — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o módulo Inventário do FC360 pronto pra um balanço real com 10 coletores (celular + leitor Bluetooth), sem travar em rede ruim, com catálogo por código interno, e provar com teste de carga de 50 mil bipagens.

**Architecture:** Lógica pura (normalização, resolução de código, blocos de catálogo, mapeamento de colunas, parser) sai do `app.js` pra `lib/inv-bip-core.js` (UMD simples, roda em Node e no browser) com testes `node --test`. `app.js` passa a usar essas funções; bipagem vira local-first (Firestore offline queue). `teste-carga.html` reaproveita o mesmo core.

**Tech Stack:** Vanilla JS (ES5 no app.js, sem build), Firebase compat 10.12.0 (Firestore + Auth), ZXing 0.20 (câmera), WebAudio, `node --test` (Node 24).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-16-inventario-balanco-10-coletores-design.md`.
- `app.js` é ES5 (`var`, `function`), sem módulos. `lib/inv-bip-core.js` pode ser ES5 também e expõe `window.InvCore` no browser e `module.exports` em Node.
- Publicar só no Fluxo (`origin/main`). Nunca dar push pros remotes de cliente. Ver memória `feedback_fc360-deploy-separado`.
- BUILD: incrementar nos 4 lugares (`app.js` linha 2, `sw.js` linha 3 `CACHE_NAME`, `index.html` `app.js?v=`, `version.json`). Fazer só uma vez, na Task 9. BUILD atual 358 → 359.
- Toda leitura/escrita de `inv_*` grava `clienteId` (multi-tenant).
- Não usar `BarcodeDetector` nativo (constraint já existente no projeto).
- Não mexer em `firestore.rules`.
- Commits com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Pasta do projeto: `C:\Users\tiago\OneDrive\Documentos\claude_code_`. Testes: `node --test tests/`.

## File Structure

- Create `lib/inv-bip-core.js` — funções puras: `normEan`, `criarCatalogo`, `resolverCodigo`, `montarBlocos`, `mapearColunas`, `parseCatalogoTexto`, `criarDetectorRajada`.
- Create `tests/inventario.test.js` — testes do core.
- Create `teste-carga.html` — página de carga (dev).
- Modify `index.html` — `<script src="lib/inv-bip-core.js">` antes de `app.js`; modal de mapeamento de colunas; filtro NC na aba Bipagens.
- Modify `app.js` — Inventário (linhas ~12440–15790): som, registrarBipagem, catálogo em blocos, importador, resolução, contador, picker leve, export.

---

### Task 1: Core puro + testes

**Files:**
- Create: `lib/inv-bip-core.js`
- Create: `tests/inventario.test.js`
- Modify: `index.html` (adicionar script antes de `app.js`)

**Interfaces (Produces):**
```js
InvCore.normEan(s) -> string                     // tira zeros à esquerda, '' -> '0'
InvCore.criarCatalogo(itens) -> {porCodigo:{}, porEan:{}, total:n}   // itens: [{c,e,d,u,q}]
InvCore.resolverCodigo(cat, lido) -> null | {codigo,ean,desc,un,estoque} | {multiplos:[item,...]}
InvCore.montarBlocos(itens, tam) -> [[...],[...]]  // tam default 1000, desc truncada 120
InvCore.mapearColunas(header, linhas) -> {codigo:i|-1, ean:i|-1, desc:i|-1, un:i|-1, estoque:i|-1, temHeader:bool}
InvCore.parseCatalogoTexto(texto) -> {delim, linhas:[[col,...]]}
InvCore.criarDetectorRajada(limiarMs, minChars) -> {tecla(char, agoraMs) -> string|null}
```

- [ ] **Step 1: Escrever os testes**

```js
// tests/inventario.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/inv-bip-core.js');

test('normEan tira zeros à esquerda', () => {
  assert.equal(C.normEan('0041334001005'), '41334001005');
  assert.equal(C.normEan(' 7899335409663 '), '7899335409663');
  assert.equal(C.normEan('000'), '0');
  assert.equal(C.normEan(''), '0');
});

const itens = [
  { c: '1', e: '7812081100004', d: 'MOUSE', u: 'UN', q: 0 },
  { c: '56', e: '', d: 'PANO DE CHAO', u: 'UN', q: 3 },
  { c: '94', e: 'MO-A148-11', d: 'ALICATE', u: 'UN', q: 1 },
  { c: '325', e: '7898604340230', d: 'ITEM A', u: 'UN', q: 2 },
  { c: '3246', e: '7898604340230', d: 'ITEM B', u: 'UN', q: 5 },
  { c: '9', e: '0041334001005', d: 'ZERO', u: 'UN', q: 0 },
];
const cat = C.criarCatalogo(itens);

test('criarCatalogo indexa por código e EAN normalizado', () => {
  assert.equal(cat.total, 6);
  assert.equal(cat.porCodigo['56'].d, 'PANO DE CHAO');
  assert.equal(cat.porEan['41334001005'][0].c, '9');
  assert.equal(cat.porEan['7898604340230'].length, 2);
  assert.equal(cat.porEan['MO-A148-11'][0].c, '94');
});

test('resolverCodigo: código interno exato tem prioridade', () => {
  assert.deepEqual(C.resolverCodigo(cat, '1'), { codigo: '1', ean: '7812081100004', desc: 'MOUSE', un: 'UN', estoque: 0 });
});
test('resolverCodigo: EAN com e sem zero à esquerda', () => {
  assert.equal(C.resolverCodigo(cat, '0041334001005').codigo, '9');
  assert.equal(C.resolverCodigo(cat, '41334001005').codigo, '9');
});
test('resolverCodigo: referência no lugar do EAN', () => {
  assert.equal(C.resolverCodigo(cat, 'MO-A148-11').codigo, '94');
});
test('resolverCodigo: EAN repetido devolve múltiplos', () => {
  const r = C.resolverCodigo(cat, '7898604340230');
  assert.equal(r.multiplos.length, 2);
  assert.equal(r.multiplos[1].codigo, '3246');
});
test('resolverCodigo: desconhecido é null', () => {
  assert.equal(C.resolverCodigo(cat, '999999'), null);
  assert.equal(C.resolverCodigo(cat, ''), null);
});

test('montarBlocos: 1000 por bloco, ordem preservada, desc truncada', () => {
  const muitos = [];
  for (let i = 0; i < 2500; i++) muitos.push({ c: String(i), e: '', d: 'X'.repeat(200), u: 'UN', q: 0 });
  const b = C.montarBlocos(muitos);
  assert.equal(b.length, 3);
  assert.equal(b[0].length, 1000);
  assert.equal(b[2].length, 500);
  assert.equal(b[2][0].c, '2000');
  assert.equal(b[0][0].d.length, 120);
});

test('parseCatalogoTexto detecta ; e ignora linhas vazias', () => {
  const r = C.parseCatalogoTexto('CODIGO;EAN;DESCRICAO;UN;ESTOQUE\r\n1;7812081100004;MOUSE;UN;0\r\n\r\n56;;PANO;UN;3\r\n');
  assert.equal(r.delim, ';');
  assert.equal(r.linhas.length, 3);
  assert.deepEqual(r.linhas[2], ['56', '', 'PANO', 'UN', '3']);
});
test('parseCatalogoTexto detecta tab e pipe', () => {
  assert.equal(C.parseCatalogoTexto('a\tb\n1\t2').delim, '\t');
  assert.equal(C.parseCatalogoTexto('a|b\n1|2').delim, '|');
});

test('mapearColunas pelo cabeçalho do TXT do bazar', () => {
  const m = C.mapearColunas(['CODIGO', 'EAN', 'DESCRICAO', 'UN', 'ESTOQUE'], [['1', '7812081100004', 'MOUSE', 'UN', '0']]);
  assert.deepEqual(m, { codigo: 0, ean: 1, desc: 2, un: 3, estoque: 4, temHeader: true });
});
test('mapearColunas sem cabeçalho usa heurística', () => {
  const m = C.mapearColunas(['7899335409663', 'BACIA 17L', 'UN'], [['7899335402978', 'BALDE 15L', 'UN']]);
  assert.equal(m.temHeader, false);
  assert.equal(m.ean, 0);
  assert.equal(m.desc, 1);
  assert.equal(m.un, 2);
  assert.equal(m.codigo, -1);
});

test('detector de rajada: leitor manda rápido, humano não', () => {
  const d = C.criarDetectorRajada(100, 4);
  let t = 1000;
  ['7', '8', '9', '9'].forEach(ch => { assert.equal(d.tecla(ch, t), null); t += 10; });
  assert.equal(d.tecla('3', t), '78993');           // 5º char em rajada devolve o buffer
  const h = C.criarDetectorRajada(100, 4);
  assert.equal(h.tecla('1', 0), null);
  assert.equal(h.tecla('2', 500), null);           // lento: reinicia buffer
  assert.equal(h.tecla('3', 510), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/` — Expected: falha com "Cannot find module '../lib/inv-bip-core.js'".

- [ ] **Step 3: Implementar o core**

```js
// lib/inv-bip-core.js — lógica pura do Inventário (Node + browser)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normEan(s) {
    s = String(s == null ? '' : s).trim();
    var st = s.replace(/^0+/, '');
    return st || '0';
  }

  function criarCatalogo(itens) {
    var porCodigo = {}, porEan = {}, total = 0;
    (itens || []).forEach(function (it) {
      var c = String(it.c == null ? '' : it.c).trim();
      var e = String(it.e == null ? '' : it.e).trim();
      if (!c && !e) return;
      total++;
      var item = { c: c, e: e, d: it.d || '', u: it.u || '', q: (it.q == null ? null : Number(it.q)) };
      if (c && !porCodigo[c]) porCodigo[c] = item;
      if (e) {
        var k = normEan(e);
        if (!porEan[k]) porEan[k] = [];
        porEan[k].push(item);
      }
    });
    return { porCodigo: porCodigo, porEan: porEan, total: total };
  }

  function _fmt(it) { return { codigo: it.c, ean: it.e, desc: it.d, un: it.u, estoque: it.q }; }

  function resolverCodigo(cat, lido) {
    lido = String(lido == null ? '' : lido).trim();
    if (!cat || !lido) return null;
    var c = cat.porCodigo[lido];
    if (c) return _fmt(c);
    var lst = cat.porEan[normEan(lido)];
    if (!lst && /^\d{12}$/.test(lido)) lst = cat.porEan[normEan('0' + lido)];
    if (!lst || !lst.length) return null;
    if (lst.length === 1) return _fmt(lst[0]);
    return { multiplos: lst.map(_fmt) };
  }

  function montarBlocos(itens, tam) {
    tam = tam || 1000;
    var out = [];
    for (var i = 0; i < itens.length; i += tam) {
      out.push(itens.slice(i, i + tam).map(function (it) {
        return { c: it.c || '', e: it.e || '', d: String(it.d || '').slice(0, 120), u: it.u || '', q: (it.q == null ? null : it.q) };
      }));
    }
    return out;
  }

  function parseCatalogoTexto(texto) {
    var lines = String(texto || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ''); }).filter(function (l) { return l.trim().length; });
    var first = lines[0] || '';
    var delim = first.indexOf(';') >= 0 ? ';' : first.indexOf('\t') >= 0 ? '\t' : first.indexOf('|') >= 0 ? '|' : ',';
    return { delim: delim, linhas: lines.map(function (l) { return l.split(delim).map(function (c) { return c.trim(); }); }) };
  }

  function mapearColunas(header, linhas) {
    var h = (header || []).map(function (x) { return String(x).toLowerCase(); });
    var idx = function (re) { for (var i = 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; };
    var ean = idx(/ean|gtin|barra/), codigo = idx(/^cod|codigo|código|sku/), desc = idx(/desc|nome|produto/), un = idx(/^un|unid|emb/), estoque = idx(/estoq|saldo|qtd/);
    var temHeader = (ean >= 0 || codigo >= 0 || desc >= 0);
    if (!temHeader) {
      var amostra = [header].concat(linhas || []).slice(0, 5);
      var ncol = header.length;
      var score = function (i, re) { var n = 0; amostra.forEach(function (r) { if (re.test(String(r[i] || ''))) n++; }); return n; };
      ean = codigo = desc = un = estoque = -1;
      for (var i = 0; i < ncol; i++) {
        if (ean < 0 && score(i, /^\d{8}$|^\d{12,14}$/) >= amostra.length) { ean = i; continue; }
        if (codigo < 0 && score(i, /^\d{1,7}$/) >= amostra.length) { codigo = i; continue; }
        if (un < 0 && score(i, /^[A-Za-z]{1,6}$/) >= amostra.length) { un = i; continue; }
        if (desc < 0 && score(i, /[A-Za-z]{3,}/) >= amostra.length) { desc = i; continue; }
      }
    }
    return { codigo: codigo, ean: ean, desc: desc, un: un, estoque: estoque, temHeader: temHeader };
  }

  function criarDetectorRajada(limiarMs, minChars) {
    limiarMs = limiarMs || 100; minChars = minChars || 4;
    var buf = '', last = 0;
    return {
      tecla: function (ch, agora) {
        if (agora - last > limiarMs) buf = '';
        last = agora; buf += ch;
        return buf.length > minChars ? buf : null;
      }
    };
  }

  return { normEan: normEan, criarCatalogo: criarCatalogo, resolverCodigo: resolverCodigo, montarBlocos: montarBlocos, parseCatalogoTexto: parseCatalogoTexto, mapearColunas: mapearColunas, criarDetectorRajada: criarDetectorRajada };
});
```

- [ ] **Step 4: Rodar testes** — `node --test tests/` — Expected: todos PASS (12 testes).

- [ ] **Step 5: Incluir no index.html** — antes da linha `<script src="app.js?v=358" defer>` (buscar `app.js?v=`), adicionar `<script src="lib/inv-bip-core.js?v=1"></script>`. Verificar no browser que `window.InvCore` existe.

- [ ] **Step 6: Commit** — `git add lib/inv-bip-core.js tests/inventario.test.js index.html && git commit -m "feat(inventario): core puro (normEan, catálogo, resolução, blocos, parser, rajada) + testes"`

---

### Task 2: Bip sonoro

**Files:** Modify `app.js` — inserir logo após `function _getModoPallet()` (~linha 14240); modificar `iniciarScanEAN` (~14102, dentro do callback `if (result && _eanCodeReader === reader)`).

- [ ] **Step 1: Adicionar `_bipSom`**

```js
// ── Bip sonoro (WebAudio, sem asset). AudioContext nasce no 1º toque. ──
var _bipCtx = null;
function _bipCtxGet(){ try{ if(!_bipCtx) _bipCtx=new (window.AudioContext||window.webkitAudioContext)(); if(_bipCtx.state==='suspended') _bipCtx.resume(); return _bipCtx; }catch(e){ return null; } }
document.addEventListener('touchstart', function(){ _bipCtxGet(); }, {once:true, passive:true});
document.addEventListener('click', function(){ _bipCtxGet(); }, {once:true});
function _bipSom(tipo) {
  var ctx=_bipCtxGet(); if(!ctx) return;
  var seq = tipo==='erro' ? [[300,250]] : tipo==='alerta' ? [[600,90],[600,90]] : [[1200,80]];
  var t=ctx.currentTime;
  seq.forEach(function(p){
    var o=ctx.createOscillator(), g=ctx.createGain();
    o.type='square'; o.frequency.value=p[0]; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.25,t); g.gain.exponentialRampToValueAtTime(0.001,t+p[1]/1000);
    o.start(t); o.stop(t+p[1]/1000); t+=p[1]/1000+0.05;
  });
}
```

- [ ] **Step 2: Chamar na câmera** — em `iniciarScanEAN`, dentro de `if (result && _eanCodeReader === reader) {` adicionar `_bipSom('ok');` como primeira linha.

- [ ] **Step 3: Testar manual** — abrir coleta no celular (tenant fluxocerto), ler um código com a câmera, ouvir o bip. Abrir console e rodar `_bipSom('alerta'); _bipSom('erro')`.

- [ ] **Step 4: Commit** — `git commit -am "feat(inventario): bip sonoro WebAudio (ok/alerta/erro) e bip na leitura da câmera"`

---

### Task 3: Bipagem local-first

**Files:** Modify `app.js`: `registrarBipagem` (~15327), `_carregarUltimasBipagens` (~13224), `_renderUltimasBipagens` (~12988), `_confirmarSemEAN` (~15700), `registrarBipagemAvulsa` (~15551), input de Qtd em `renderColeta` (~14415), `_eanEnterKey` (~15310).

**Interfaces (Produces):** `_gravarBipagemLocal(bipData) -> {id, promise}` — usada pela Task 8.

- [ ] **Step 1: Função de gravação local-first + lista em memória** (inserir antes de `function registrarBipagem`)

```js
var _bipsLocais = [];   // últimas bipagens do endereço atual (mais nova primeiro)
function _gravarBipagemLocal(bipData) {
  var ref = db.collection('inv_bipagens').doc();
  bipData.clienteId = bipData.clienteId || (S.currentUser && S.currentUser.clienteId) || '';
  bipData._pend = true;
  _offlinePending++; if(window._atualizarOfflineBanner) window._atualizarOfflineBanner();
  var p = ref.set(bipData).then(function(){
    _offlinePending=Math.max(0,_offlinePending-1); if(window._atualizarOfflineBanner) window._atualizarOfflineBanner();
    bipData._pend=false;
  }).catch(function(e){
    _offlinePending=Math.max(0,_offlinePending-1); if(window._atualizarOfflineBanner) window._atualizarOfflineBanner();
    bipData._pend=false; bipData._erro=(e&&e.code)||'erro';
    _bipSom('erro'); showToast('❌ Falha ao gravar '+bipData.ean+': '+(e&&e.message||e), 6000);
    _renderUltimasBipagens(_bipsLocais.slice(0,20), bipData.invId);
  });
  return { id: ref.id, promise: p };
}
```

- [ ] **Step 2: Reescrever `registrarBipagem`** (substituir a função inteira)

```js
function registrarBipagem() {
  if (!_invColetaAtual) return;
  if (_invColetaAtual.concluido){ alert('Você já finalizou sua contagem.'); return; }
  var ei=document.getElementById('inv-ean-input'), qi=document.getElementById('inv-qty-input');
  if (!ei||!qi) return;
  var fi=document.getElementById('inv-fator-input');
  var lido=ei.value.trim(), qty=parseInt(qi.value)||1, fator=fi?Math.max(1,parseInt(fi.value)||1):1;
  if (!lido){ ei.focus(); return; }
  if (qty<1) qty=1;
  var coletorId=_getIdColetor();
  if (!coletorId){ _editarIdColetor(); return; }
  var inv=_invColetaAtual.inv;
  if (inv.status!=='aberto'){ alert('Inventário encerrado.'); return; }
  var cat=_catCache[inv.id]||null;
  var res=cat&&cat.total?InvCore.resolverCodigo(cat,lido):null;
  if (res&&res.multiplos){ _abrirPickerMultiplos(res.multiplos, lido); return; }
  _registrarResolvido(lido, res, qty*fator, fator);
}
function _registrarResolvido(lido, res, qtyTotal, fator) {
  var inv=_invColetaAtual.inv, end=_invColetaAtual.endereco, rodada=_invColetaAtual.rodada||1, modo=_invColetaAtual.modo||'colaboracao';
  var cat=_catCache[inv.id]||null, hasCat=!!(cat&&cat.total);
  var bip={invId:inv.id,loja:inv.loja||'',endereco:end,seq:_nextSeq,ean:lido,codigo:res?res.codigo:'',qty:qtyTotal,rodada:rodada,modo:modo,
    setor:(_filaEndAtual&&_filaEndAtual.setor)||'',coletorId:_getIdColetor(),coletorNome:_getNomeColetor()||_getIdColetor(),ts:firebase.firestore.FieldValue.serverTimestamp()};
  if(fator>1) bip.fator=fator;
  if(hasCat&&!res) bip.naoCadastrado=true;
  _nextSeq++;
  _gravarBipagemLocal(bip);
  _bipsLocais.unshift(bip); if(_bipsLocais.length>50) _bipsLocais.length=50;
  _bipSom(bip.naoCadastrado?'alerta':'ok');
  var ei=document.getElementById('inv-ean-input'), qi=document.getElementById('inv-qty-input'), fi=document.getElementById('inv-fator-input');
  if(ei) ei.value=''; if(qi) qi.value='1'; if(fi) fi.value='1';
  var pr=document.getElementById('inv-desc-preview'); if(pr) pr.textContent='';
  var sl=document.getElementById('inv-seq-label'); if(sl) sl.textContent='Próx. seq: '+_nextSeq;
  _renderUltimasBipagens(_bipsLocais.slice(0,20), inv.id);
  if(ei) ei.focus();
}
function _abrirPickerMultiplos(lista, lido) {
  var html='<div id="modal-multi" onclick="if(event.target===this)this.remove()" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2300;display:flex;align-items:flex-end;justify-content:center">'+
    '<div style="background:#fff;border-radius:20px 20px 0 0;padding:20px;width:100%;max-width:480px">'+
    '<div style="font-weight:800;font-size:16px;margin-bottom:4px">Mesmo código de barras em '+lista.length+' produtos</div>'+
    '<div style="font-size:12px;color:var(--t3);margin-bottom:12px">Toque no produto certo.</div>'+
    lista.map(function(p,i){ return '<button onclick="_escolherMultiplo('+i+')" style="width:100%;text-align:left;padding:12px;margin-bottom:8px;border:1.5px solid var(--gray2);border-radius:10px;background:#fff;font-family:inherit;cursor:pointer"><b style="font-family:monospace">'+p.codigo+'</b> · '+p.desc+'</button>'; }).join('')+
    '<button onclick="document.getElementById(\'modal-multi\').remove()" style="width:100%;padding:11px;border:1.5px solid var(--gray2);border-radius:10px;background:#fff;font-family:inherit">Cancelar</button></div></div>';
  window._multiLista=lista; window._multiLido=lido;
  document.body.insertAdjacentHTML('beforeend',html);
}
function _escolherMultiplo(i) {
  var m=document.getElementById('modal-multi'); if(m) m.remove();
  var qi=document.getElementById('inv-qty-input'), fi=document.getElementById('inv-fator-input');
  var qty=parseInt(qi&&qi.value)||1, fator=fi?Math.max(1,parseInt(fi.value)||1):1;
  _registrarResolvido(window._multiLido, window._multiLista[i], qty*fator, fator);
}
```
Remover a variável `_bipRegistrando` (declaração e usos) do arquivo: `grep -n _bipRegistrando app.js` deve retornar zero linhas ao final.

- [ ] **Step 3: `_carregarUltimasBipagens` alimenta `_bipsLocais`** — substituir o corpo:

```js
function _carregarUltimasBipagens(invId,endereco,rodada,modo) {
  db.collection('inv_bipagens').where('invId','==',invId).where('endereco','==',endereco).get().then(function(snap){
    var bips=snap.docs.map(function(d){ return d.data(); });
    if (modo==='auditoria'&&rodada) bips=bips.filter(function(b){ return (b.rodada||1)===rodada; });
    bips.sort(function(a,b){ return (b.seq||0)-(a.seq||0); });
    _nextSeq=(bips.length?bips[0].seq:0)+1;
    _bipsLocais=bips.slice(0,50);
    var sl=document.getElementById('inv-seq-label'); if(sl) sl.textContent='Próx. seq: '+_nextSeq;
    _renderUltimasBipagens(_bipsLocais.slice(0,20),invId);
  }).catch(function(e){ console.error('_carregarUltimasBipagens',e); _nextSeq=1; _bipsLocais=[]; _renderUltimasBipagens([],invId); });
}
```

- [ ] **Step 4: `_renderUltimasBipagens` mostra estado** — na linha da tabela (`bips.map`), calcular descrição com `var it=_catItem(invId,b.codigo||b.ean)` (helper da Task 5; até lá usar `cat[b.ean]||{}`) e prefixar o `<tr>` com `style="'+(b._erro?'background:#fdecea':b._pend?'opacity:.6':'')+'"`; após a descrição, se `b.naoCadastrado` acrescentar `<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;background:#fff3e0;color:#e65100;margin-left:4px">NC</span>`.

- [ ] **Step 5: Sem-EAN e Avulsa** — em `_confirmarSemEAN`, trocar o bloco `_offlinePending++ ... db.collection('inv_bipagens').add(bipData).then(...)...catch(...)` por:
```js
  _nextSeq++;
  _gravarBipagemLocal(bipData);
  _bipsLocais.unshift(bipData); _bipSom('ok');
  showToast('📝 "'+desc+'" × '+qty+' registrado.');
  _renderUltimasBipagens(_bipsLocais.slice(0,20), inv.id);
  var ei=document.getElementById('inv-ean-input'); if(ei) ei.focus();
```
Em `registrarBipagemAvulsa`, trocar `db.collection('inv_bipagens').add({...}).then(...)` por `_gravarBipagemLocal({...mesmo objeto...}); _bipSom('ok'); ei.value=''; qi.value='1'; ei.focus(); _carregarAvulsaLista();` e remover `_avulsaRegistrando`. Remover as 3 linhas `update({totalBipagens: increment(1)})`.

- [ ] **Step 6: Detector de rajada na Qtd** — no `onkeydown` do `inv-qty-input` (dentro de `renderColeta`), trocar por `onkeydown="return _qtyKeydown(event)"` e adicionar:
```js
var _rajadaQty = InvCore.criarDetectorRajada(100, 4);
function _qtyKeydown(ev) {
  if (ev.key==='Enter') { ev.preventDefault(); if(_getModoPallet()){ var fi=document.getElementById('inv-fator-input'); if(fi){fi.focus();fi.select();} } else registrarBipagem(); return false; }
  if (ev.key.length===1) {
    var buf=_rajadaQty.tecla(ev.key, Date.now());
    if (buf) { // leitor Bluetooth mandou um código novo enquanto a Qtd estava focada
      ev.preventDefault();
      var qi=ev.target, ei=document.getElementById('inv-ean-input');
      qi.value=String(qi.value).slice(0, -(buf.length-1)) || '1';
      registrarBipagem();
      if(ei){ ei.value=buf; ei.focus(); ei.dispatchEvent(new Event('input')); }
      return false;
    }
  }
  return true;
}
```

- [ ] **Step 7: Teste manual** — celular em modo avião: 5 bipagens seguidas → todas aparecem na lista com opacidade, banner "Sincronizando 5"; desligar avião → banner some. Leitor Bluetooth: 10 leituras rápidas seguidas, nenhuma perdida (conferir na aba Bipagens do admin).

- [ ] **Step 8: Commit** — `git commit -am "feat(inventario): bipagem local-first (sem esperar servidor), lista em memória, picker de EAN repetido, rajada do leitor, fim do increment no doc do inventário"`

---

### Task 4: Contador por consulta

**Files:** Modify `app.js` — `renderInvList` (~13683), `renderInvHistorico` (~13728).

- [ ] **Step 1:** Adicionar antes de `renderInvList`:
```js
var _invBipCount = {};
function _contarBipagens(invId, cb) {
  var c=_invBipCount[invId];
  if (c && Date.now()-c.t<30000) { cb(c.n); return; }
  db.collection('inv_bipagens').where('invId','==',invId).count().get().then(function(s){
    _invBipCount[invId]={n:s.data().count,t:Date.now()}; cb(_invBipCount[invId].n);
  }).catch(function(){ cb(null); });
}
```
- [ ] **Step 2:** Em `renderInvList` e `renderInvHistorico`, trocar `(inv.totalBipagens||0)+' bipagens'` por `'<span id="invcnt-'+inv.id+'">…</span> bipagens'` e, após montar o `innerHTML`, rodar `invs.forEach(function(inv){ _contarBipagens(inv.id,function(n){ var e=document.getElementById('invcnt-'+inv.id); if(e) e.textContent=n==null?'—':n.toLocaleString('pt-BR'); }); });`
- [ ] **Step 3:** Testar: lista mostra contagem correta do inventário "Inv 001" (12).
- [ ] **Step 4: Commit** — `git commit -am "feat(inventario): contagem de bipagens por count() em vez de campo incrementado"`

---

### Task 5: Catálogo em blocos com código interno

**Files:** Modify `app.js` — `loadCatalogoByInv` (~12481), `_renderImportCatStatus`/`importarCatalogo` (~12558–12665), `_limparSubcolecoes` (~14976), `excluirClienteCompleto` (~10374), todos os usos de `cat[...]` (13 ocorrências: `grep -n "cat\[" app.js`). Modify `index.html` — modal de mapeamento.

**Interfaces (Produces):** `_catCache[invId] = {porCodigo, porEan, total}`; `_catItem(invId, chave) -> {codigo,ean,desc,un,estoque}|null` (nunca devolve múltiplos: pega o 1º).

- [ ] **Step 1: Helper + load com fallback**
```js
function _catItem(invId, chave) {
  var cat=_catCache[invId]; if(!cat||!cat.total) return null;
  var r=InvCore.resolverCodigo(cat, chave);
  return r ? (r.multiplos ? r.multiplos[0] : r) : null;
}
function loadCatalogoByInv(invId, cb) {
  if (_catCache[invId]) { if (cb) cb(_catCache[invId]); return; }
  db.collection('inv_catalogo_blocos').where('invId','==',invId).get().then(function(snap){
    if (!snap.empty) {
      var itens=[]; snap.docs.sort(function(a,b){ return (a.data().n||0)-(b.data().n||0); }).forEach(function(d){ itens=itens.concat(d.data().itens||[]); });
      _catCache[invId]=InvCore.criarCatalogo(itens); if(cb) cb(_catCache[invId]); return;
    }
    // fallback: inventários antigos (1 doc por item)
    return db.collection('inv_catalogo').where('invId','==',invId).get().then(function(s2){
      var itens=s2.docs.map(function(d){ var p=d.data(); return {c:'',e:p.ean,d:p.desc,u:p.un}; });
      _catCache[invId]=InvCore.criarCatalogo(itens); if(cb) cb(_catCache[invId]);
    });
  }).catch(function(){ _catCache[invId]=InvCore.criarCatalogo([]); if(cb) cb(_catCache[invId]); });
}
```
- [ ] **Step 2: Substituir os 13 usos de `cat[x]`** — cada `var p=cat[b.ean]||{}` (ou `cat[ean]`, `cat[val]`) vira `var p=_catItem(invId, b.codigo||b.ean)||{}` (usar `_invAtivo.id`, `inv.id` ou `invId` conforme o escopo); onde o código lia `p.desc`/`p.un` continua igual. `Object.keys(cat).length` vira `cat.total`. Em `mostrarItensNaoColetados`: `var eans=Object.keys(cat)` vira iterar `Object.keys(cat.porCodigo)` ∪ chaves de `cat.porEan` sem código, e `bipados[d.data().codigo||d.data().ean]`. Em `_exibirModalFinalizar`, `_erp_buildLinhas`, `verDivergencias`, `buscarEanCorrecao`, `renderInvBipagens`, `_renderUltimasBipagens`: mesmo padrão. No listener de `input` do EAN em `renderColeta` e em `_eanEnterKey`: usar `InvCore.resolverCodigo(cat,val)`; se resolveu (objeto sem `multiplos`) → preview verde `codigo · desc · un` e foca Qtd; se `multiplos` → preview "EAN em N produtos, escolha ao registrar"; se `null` e `cat.total>0` → preview vermelho "Não cadastrado — será registrado com marcação" (sem bloquear). Remover o `if (hasCat&&!cat[val]) {...return;}` de `_eanEnterKey`.
- [ ] **Step 3: Modal de mapeamento no index.html** (antes de `<div class="modal-bg" id="modal-inv">`):
```html
<div class="modal-bg" id="modal-cat-map" style="display:none">
  <div class="modal" style="max-width:560px">
    <div class="modal-h">Importar catálogo — confirme as colunas</div>
    <div id="cat-map-prev" style="font-family:monospace;font-size:11px;background:var(--gray);padding:8px;border-radius:8px;margin-bottom:12px;overflow-x:auto;white-space:pre"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label>Código interno <select id="cat-map-codigo"></select></label>
      <label>EAN <select id="cat-map-ean"></select></label>
      <label>Descrição <select id="cat-map-desc"></select></label>
      <label>Unidade <select id="cat-map-un"></select></label>
      <label>Estoque do sistema (opcional) <select id="cat-map-estoque"></select></label>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cat-map-header"> 1ª linha é cabeçalho</label>
    </div>
    <div class="modal-err" id="cat-map-err"></div>
    <div class="modal-f"><button class="btn" onclick="document.getElementById('modal-cat-map').style.display='none'">Cancelar</button><button class="btn btn-p" onclick="_confirmarImportCat()">Importar</button></div>
  </div>
</div>
```
- [ ] **Step 4: Reescrever `importarCatalogo` + `_confirmarImportCat`**
```js
var _catImport=null;
function importarCatalogo(event) {
  var file=event.target.files[0]; if(!file||!_invAtivo) return;
  var reader=new FileReader();
  reader.onload=function(e){
    var text=e.target.result; if(text.indexOf('\uFFFD')>=0){ var r2=new FileReader(); r2.onload=function(ev){ _abrirMapCat(ev.target.result); }; r2.readAsText(file,'UTF-8'); return; }
    _abrirMapCat(text);
  };
  reader.readAsText(file,'ISO-8859-1'); event.target.value='';
}
function _abrirMapCat(text) {
  var parsed=InvCore.parseCatalogoTexto(text); if(!parsed.linhas.length){ alert('Arquivo vazio.'); return; }
  var map=InvCore.mapearColunas(parsed.linhas[0], parsed.linhas.slice(1,6));
  _catImport={linhas:parsed.linhas};
  var ncol=parsed.linhas[0].length;
  var opts=function(sel){ return '<option value="-1">—</option>'+parsed.linhas[0].map(function(h,i){ return '<option value="'+i+'"'+(sel===i?' selected':'')+'>'+(i+1)+': '+String(h).slice(0,18)+'</option>'; }).join(''); };
  ['codigo','ean','desc','un','estoque'].forEach(function(k){ document.getElementById('cat-map-'+k).innerHTML=opts(map[k]); });
  document.getElementById('cat-map-header').checked=map.temHeader;
  document.getElementById('cat-map-prev').textContent=parsed.linhas.slice(0,3).map(function(l){ return l.join(' | '); }).join('\n');
  document.getElementById('cat-map-err').textContent='';
  document.getElementById('modal-cat-map').style.display='flex';
}
function _confirmarImportCat() {
  var g=function(k){ return parseInt(document.getElementById('cat-map-'+k).value); };
  var m={codigo:g('codigo'),ean:g('ean'),desc:g('desc'),un:g('un'),estoque:g('estoque')};
  var err=document.getElementById('cat-map-err');
  if(m.codigo<0&&m.ean<0){ err.textContent='Escolha ao menos Código interno ou EAN.'; return; }
  var header=document.getElementById('cat-map-header').checked;
  var linhas=_catImport.linhas.slice(header?1:0);
  var itens=linhas.map(function(l){ return {c:m.codigo>=0?(l[m.codigo]||''):'', e:m.ean>=0?(l[m.ean]||'').replace(/\s/g,''):'', d:m.desc>=0?(l[m.desc]||''):'', u:m.un>=0?(l[m.un]||'').toUpperCase():'', q:m.estoque>=0?(parseFloat(String(l[m.estoque]).replace(',','.'))||0):null}; })
    .filter(function(it){ return it.c||it.e; });
  document.getElementById('modal-cat-map').style.display='none';
  _gravarBlocosCatalogo(_invAtivo.id, itens);
}
function _gravarBlocosCatalogo(invId, itens) {
  var blocos=InvCore.montarBlocos(itens,1000), statusEl=document.getElementById('inv-cat-status');
  var clienteId=(S.currentUser&&S.currentUser.clienteId)||'';
  function _delay(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  // apaga blocos anteriores (reenvio)
  db.collection('inv_catalogo_blocos').where('invId','==',invId).get().then(function(snap){
    var b=db.batch(); snap.docs.forEach(function(d){ b.delete(d.ref); }); return b.commit();
  }).then(function(){
    var p=Promise.resolve();
    blocos.forEach(function(itensBloco,n){
      p=p.then(function(){
        if(statusEl) statusEl.innerHTML='<div style="padding:8px 12px;color:#856404">Importando... bloco '+(n+1)+'/'+blocos.length+'</div>';
        var tent=0; function tenta(){ return db.collection('inv_catalogo_blocos').doc(invId+'_'+n).set({invId:invId,clienteId:clienteId,n:n,itens:itensBloco}).catch(function(e){ if(++tent>5) throw e; return _delay(800*Math.pow(2,tent)).then(tenta); }); }
        return tenta();
      }).then(function(){ return _delay(150); });
    });
    return p;
  }).then(function(){ delete _catCache[invId]; _renderImportCatStatus(invId,true); })
    .catch(function(e){ alert('Erro ao importar: '+(e.message||e)); });
}
```
Em `_renderImportCatStatus`, trocar `var n=Object.keys(cat).length` por `var n=cat.total; var comEan=Object.keys(cat.porEan).length;` e o texto por `'✓ Catálogo: '+n+' produtos · '+comEan+' com EAN'`.
- [ ] **Step 5: Limpeza** — em `_limparSubcolecoes` (14976) e `excluirClienteCompleto` (10374) incluir `'inv_catalogo_blocos'` ao lado de `'inv_catalogo'`.
- [ ] **Step 6: Testar** — importar `C:\Users\tiago\Downloads\catalogo_bazar_fc360.txt` num inventário novo do tenant fluxocerto: modal pré-preenche 5 colunas e cabeçalho; status "4395 produtos · 3848 com EAN"; Firestore mostra 5 docs em `inv_catalogo_blocos`. Na coleta: bipar `1` → MOUSE; `7898604340230` → picker com 325/3246; `999999` → NC registrado com bip de alerta.
- [ ] **Step 7:** `node --test tests/` PASS. Commit — `git commit -am "feat(inventario): catálogo em blocos com código interno+EAN, importador com mapeamento de colunas, item fora da base registrado como NC"`

---

### Task 6: Admin — filtro NC, não coletados, exportação com código

**Files:** Modify `app.js` — `renderInvBipagens` (~12761), `mostrarItensNaoColetados` (~15371), `_ERP_CAMPOS`/`_ERP_PRESETS`/`_erp_buildLinhas` (~13238–13520). Modify `index.html` — checkbox ao lado de `inv-bip-setor-filter`.

- [ ] **Step 1:** index.html: após o select `inv-bip-setor-filter`, adicionar `<label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="inv-bip-nc" onchange="renderInvBipagens(document.getElementById('inv-bip-filter').value,null,document.getElementById('inv-bip-setor-filter').value)"> Só não cadastrados</label>`. Em `renderInvBipagens`, no `filtrados`, adicionar `if (document.getElementById('inv-bip-nc')&&document.getElementById('inv-bip-nc').checked&&!b.naoCadastrado) return false;`. Na coluna EAN da tabela mostrar `(b.codigo?'<b>'+b.codigo+'</b> · ':'')+b.ean+(b.naoCadastrado?' <span style="color:#e65100;font-weight:700;font-size:10px">NC</span>':'')`.
- [ ] **Step 2:** `_ERP_CAMPOS`: inserir `{id:'codigo', label:'Código interno'}` como primeiro item. Preset `fc360.campos` vira `['endereco','codigo','ean','qty','desc','un','setor','rodada']`. Em `_erp_buildLinhas`: `var k=b.codigo||b.ean` na chave do `mapa`, guardar `codigo:b.codigo||''` no objeto agrupado, e no `row` adicionar `if (id==='codigo') return b.codigo||'';`.
- [ ] **Step 3:** `mostrarItensNaoColetados`: chaves = `Object.keys(cat.porCodigo)` mais, para cada `k` em `cat.porEan` cujos itens não têm `c`, o próprio EAN; `bipados` indexado por `codigo||ean`; tabela com colunas Código, EAN, Descrição, Un; CSV `CODIGO;EAN;DESCRICAO;UNIDADE`.
- [ ] **Step 4:** Testar exportação no preset FC360 com um inventário que tem NC e código: arquivo abre com a coluna Código interno. Commit — `git commit -am "feat(inventario): filtro NC, não coletados por código interno, exportação com coluna Código interno"`

---

### Task 7: Seleção de endereço leve

**Files:** Modify `app.js` — `renderColeta` (~14342, bloco `loadBipagensByInv(fresh.id, function(bips){...})`), `_renderSelecaoEndereco` (~13891).

- [ ] **Step 1:** Em `renderColeta`, substituir o bloco `loadBipagensByInv(fresh.id, function(bips){ var cnt={}; ... wrap.innerHTML=...; setTimeout(...); });` por o mesmo `wrap.innerHTML=...+_renderSelecaoEndereco(fresh, {})+'</div>'; setTimeout(...)` sem a query.
- [ ] **Step 2:** Em `_renderSelecaoEndereco`, o ramo `else if (cnt.total>0)` some (com `cnt` vazio nunca entra); manter os textos "disponível", "em andamento", "finalizado".
- [ ] **Step 3:** Testar: trocar de endereço no celular abre a lista instantaneamente. `grep -n "loadBipagensByInv" app.js` não deve aparecer dentro de `renderColeta`.
- [ ] **Step 4: Commit** — `git commit -am "perf(inventario): seleção de endereço não baixa mais as bipagens do inventário"`

---

### Task 8: Página de teste de carga

**Files:** Create `teste-carga.html`.

- [ ] **Step 1: Criar a página** (SDK compat 10.12 + `lib/inv-bip-core.js`; login por e-mail/senha; bloqueia se `usuarios/{uid}.clienteId !== 'fluxocerto'`)

Estrutura (código completo a escrever no arquivo, ES5 não é necessário aqui):
```html
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>FC360 — Teste de carga Inventário</title>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
<script src="lib/inv-bip-core.js"></script>
<style>body{font-family:system-ui;padding:16px;max-width:1100px;margin:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:4px 8px;font-size:13px;text-align:right}th:first-child,td:first-child{text-align:left}.ok{color:#1a5c34}.err{color:#c0392b}#log{font-family:monospace;font-size:12px;background:#111;color:#eee;padding:8px;height:160px;overflow:auto}</style></head><body>
<h2>Teste de carga — Inventário (tenant fluxocerto)</h2>
<div id="login"><input id="em" placeholder="e-mail"> <input id="pw" type="password" placeholder="senha"> <button onclick="login()">Entrar</button></div>
<div id="painel" style="display:none">
  <p>Coletores <input id="nCol" type="number" value="10" style="width:60px"> · Bipagens por coletor <input id="nBip" type="number" value="5000" style="width:80px"> · Catálogo <input id="nCat" type="number" value="50000" style="width:80px"> · Ritmo: <select id="ritmo"><option value="0">máximo</option><option value="3000">1 a cada 3 s (real)</option><option value="1000">1 a cada 1 s</option></select></p>
  <button onclick="criar()">1. Criar inventário + catálogo</button> <button onclick="rodar()">2. Rodar carga</button> <button onclick="parar()">Parar</button> <button onclick="limpar()" style="color:#c0392b">3. Limpar tudo</button>
  <p id="resumo"></p><table id="tab"></table><div id="log"></div>
</div>
<script>
firebase.initializeApp({ /* copiar o firebaseConfig do app.js linhas 24-33 */ });
var db=firebase.firestore(), auth=firebase.auth(), invId=null, workers=[], rodando=false, t0=0;
function log(m){ var l=document.getElementById('log'); l.textContent+=new Date().toLocaleTimeString()+' '+m+'\n'; l.scrollTop=l.scrollHeight; }
function login(){ auth.signInWithEmailAndPassword(em.value,pw.value).then(function(u){ return db.collection('usuarios').where('email','==',em.value).get(); }).then(function(s){ var d=s.docs[0]&&s.docs[0].data(); if(!d||d.clienteId!=='fluxocerto'){ alert('Só tenant fluxocerto'); auth.signOut(); return; } window._me=d; login.style.display='none'; painel.style.display=''; db.collection('inv_inventarios').where('clienteId','==','fluxocerto').where('status','==','aberto').get().then(function(s2){ s2.docs.forEach(function(x){ if((x.data().nome||'').indexOf('CARGA')===0){ invId=x.id; log('Inventário de carga existente: '+x.id); } }); }); }).catch(function(e){ alert(e.message); }); }
function ean13(n){ var s=('789'+String(n).padStart(9,'0')); var sum=0; for(var i=0;i<12;i++) sum+=(+s[i])*(i%2?3:1); return s+((10-sum%10)%10); }
function criar(){
  var nCat=+document.getElementById('nCat').value, ends=[]; for(var i=1;i<=100;i++) ends.push(String(i));
  db.collection('inv_inventarios').add({nome:'CARGA '+new Date().toLocaleString('pt-BR'),loja:'',status:'aberto',tipo:'geral',clienteId:'fluxocerto',criadoEm:firebase.firestore.FieldValue.serverTimestamp(),criadoPor:_me.id||'',enderecos:ends,atribuicoes:{},modoFila:true,fila:{},totalBipagens:0,setores:['ESTOQUE','LOJA'],modoOrganizacao:'setores_end',meta:98})
  .then(function(ref){ invId=ref.id; log('Inventário criado '+invId);
    var itens=[]; for(var i=1;i<=nCat;i++) itens.push({c:'C'+String(i).padStart(6,'0'),e:(i%10<7)?ean13(i):'',d:'PRODUTO TESTE '+i,u:'UN',q:i%50});
    var blocos=InvCore.montarBlocos(itens,1000), p=Promise.resolve();
    blocos.forEach(function(b,n){ p=p.then(function(){ return db.collection('inv_catalogo_blocos').doc(invId+'_'+n).set({invId:invId,clienteId:'fluxocerto',n:n,itens:b}); }).then(function(){ log('bloco '+(n+1)+'/'+blocos.length); return new Promise(function(r){ setTimeout(r,150); }); }); });
    return p;
  }).then(function(){ log('Catálogo pronto. Abra o inventário no FC360 (tenant fluxocerto) pra acompanhar o dashboard.'); });
}
function worker(id, nBip, ritmo, cat, ends){
  var st={id:id,env:0,conf:0,pend:0,err:0,lat:[],end:null,seq:0}; workers.push(st);
  function proximoEnd(){ var e=ends.shift(); if(!e) return Promise.resolve(null); st.end=e; st.seq=1;
    return db.collection('inv_inventarios').doc(invId).update(new firebase.firestore.FieldPath('fila',e),{userId:_me.id||'',coletorId:'T'+id,nome:'T'+id+' - Robô',setor:'ESTOQUE',desde:firebase.firestore.FieldValue.serverTimestamp(),concluido:false}).then(function(){ return e; }); }
  function fecharEnd(){ if(!st.end) return Promise.resolve(); var e=st.end; return db.collection('inv_inventarios').doc(invId).update(new firebase.firestore.FieldPath('fila',e),{userId:_me.id||'',coletorId:'T'+id,nome:'T'+id+' - Robô',setor:'ESTOQUE',concluido:true,concluidoEm:firebase.firestore.FieldValue.serverTimestamp()}); }
  function bip(){ if(!rodando||st.env>=nBip) return fecharEnd();
    if(st.seq>500) return fecharEnd().then(proximoEnd).then(function(e){ return e?bip():null; });
    var k=Math.floor(Math.random()*cat.length), it=cat[k], lido=it.e||it.c, res=InvCore.resolverCodigo(catIdx,lido); if(res&&res.multiplos) res=res.multiplos[0];
    var doc={invId:invId,loja:'',clienteId:'fluxocerto',endereco:st.end,seq:st.seq++,ean:lido,codigo:res?res.codigo:'',qty:1+Math.floor(Math.random()*5),rodada:1,modo:'colaboracao',setor:'ESTOQUE',coletorId:'T'+id,coletorNome:'T'+id+' - Robô',ts:firebase.firestore.FieldValue.serverTimestamp()};
    if(!res) doc.naoCadastrado=true;
    var t=performance.now(); st.env++; st.pend++;
    db.collection('inv_bipagens').doc().set(doc).then(function(){ st.conf++; st.pend--; st.lat.push(performance.now()-t); }).catch(function(e){ st.err++; st.pend--; log('T'+id+' ERRO '+(e.code||e.message)); });
    return new Promise(function(r){ setTimeout(r, ritmo||0); }).then(bip);
  }
  return proximoEnd().then(bip);
}
var catIdx=null;
function rodar(){ if(!invId){ alert('Crie o inventário primeiro'); return; }
  var nCol=+nCol_.value, nBip=+document.getElementById('nBip').value, ritmo=+document.getElementById('ritmo').value;
  db.collection('inv_catalogo_blocos').where('invId','==',invId).get().then(function(s){ var itens=[]; s.docs.sort(function(a,b){return a.data().n-b.data().n;}).forEach(function(d){ itens=itens.concat(d.data().itens); }); catIdx=InvCore.criarCatalogo(itens); return itens; })
  .then(function(itens){ workers=[]; rodando=true; t0=Date.now(); var ends=[]; for(var i=1;i<=100;i++) ends.push(String(i)); var ps=[]; for(var w=1;w<=nCol;w++) ps.push(worker(w,nBip,ritmo,itens,ends)); setInterval(render,500); return Promise.all(ps); })
  .then(function(){ log('Todos os workers terminaram de ENVIAR. Aguardando confirmações...'); });
}
var nCol_=document.getElementById('nCol');
function parar(){ rodando=false; }
function p95(a){ if(!a.length) return 0; var s=a.slice().sort(function(x,y){return x-y;}); return s[Math.floor(s.length*0.95)]; }
function render(){ var el=Date.now()-t0, tot={env:0,conf:0,pend:0,err:0,lat:[]};
  var rows=workers.map(function(w){ tot.env+=w.env;tot.conf+=w.conf;tot.pend+=w.pend;tot.err+=w.err;tot.lat=tot.lat.concat(w.lat.slice(-200)); var avg=w.lat.length?w.lat.reduce(function(a,b){return a+b;},0)/w.lat.length:0; return '<tr><td>T'+w.id+' (end '+w.end+')</td><td>'+w.env+'</td><td class="ok">'+w.conf+'</td><td>'+w.pend+'</td><td class="err">'+w.err+'</td><td>'+(w.env/(el/1000)).toFixed(1)+'</td><td>'+avg.toFixed(0)+'</td><td>'+p95(w.lat).toFixed(0)+'</td></tr>'; }).join('');
  document.getElementById('tab').innerHTML='<tr><th>Coletor</th><th>Enviadas</th><th>Confirmadas</th><th>Pendentes</th><th>Erros</th><th>bip/s</th><th>lat média ms</th><th>lat p95 ms</th></tr>'+rows;
  var avg=tot.lat.length?tot.lat.reduce(function(a,b){return a+b;},0)/tot.lat.length:0;
  document.getElementById('resumo').innerHTML='<b>'+tot.conf.toLocaleString('pt-BR')+'</b> confirmadas de '+tot.env.toLocaleString('pt-BR')+' enviadas · pendentes '+tot.pend+' · erros <span class="err">'+tot.err+'</span> · '+(tot.env/(el/1000)).toFixed(1)+' bip/s no total · '+Math.round(el/1000)+' s · p95 ack '+p95(tot.lat).toFixed(0)+' ms (média '+avg.toFixed(0)+')';
}
function limpar(){ if(!invId||!confirm('Apagar inventário de carga, bipagens e catálogo?')) return; rodando=false;
  function delQ(col){ return db.collection(col).where('invId','==',invId).limit(400).get().then(function(s){ if(s.empty) return; var b=db.batch(); s.docs.forEach(function(d){ b.delete(d.ref); }); return b.commit().then(function(){ log(col+' -'+s.size); return delQ(col); }); }); }
  delQ('inv_bipagens').then(function(){ return delQ('inv_catalogo_blocos'); }).then(function(){ return db.collection('inv_inventarios').doc(invId).delete(); }).then(function(){ log('Limpo.'); invId=null; });
}
</script></body></html>
```
Substituir o comentário `/* copiar o firebaseConfig ... */` pelo objeto real de `app.js` (linhas 24–33).

- [ ] **Step 2: Rodar com o Tiago assistindo** — `https://fc360oficial.github.io/fluxocerto360/teste-carga.html` (ou local via `iniciar-servidor.bat`). Login `admin@fluxocerto.com`. Criar (50.000 itens → 50 blocos), Rodar (10 × 5.000, ritmo máximo). Em paralelo, abrir o FC360 no tenant fluxocerto → Inventário → CARGA → dashboard.
- [ ] **Step 3: Critério** — 50.000 confirmadas, 0 erros, p95 < 3.000 ms, dashboard admin abre em < 10 s. Anotar os números reais no fim do plano (seção "Resultado do teste de carga").
- [ ] **Step 4: Limpar** e commit — `git add teste-carga.html && git commit -m "test(inventario): página de teste de carga (10 coletores × 5000 bipagens) no tenant dev"`

---

### Task 9: BUILD, revisão e publicação no Fluxo

- [ ] **Step 1:** `node --test tests/` PASS. `grep -n "_bipRegistrando\|totalBipagens:firebase" app.js` → vazio.
- [ ] **Step 2:** Bump BUILD 358 → 359 nos 4 lugares (`app.js` linha 2, `sw.js` linha 3, `index.html` `app.js?v=359`, `version.json`).
- [ ] **Step 3:** Teste manual final em 2 celulares reais (câmera + leitor Bluetooth) no tenant fluxocerto com o catálogo do bazar: bip sonoro, NC, picker de EAN repetido, avião liga/desliga.
- [ ] **Step 4:** `git commit -am "chore: BUILD 359 — Inventário pronto pra balanço com 10 coletores" && git push origin main`. Atualizar memória `project_fc360-pwa` com o resultado (BUILD, o que mudou, resultado da carga). Não publicar no cliente.

## Resultado do teste de carga

Rodado em 2026-09-16 22:44–22:58, tenant fluxocerto, uma aba do Chrome no PC (servidor local), plano Blaze.

| Medida | Resultado |
|---|---|
| Catálogo sintético | 50.000 itens gravados em 50 blocos em 29 s |
| Catálogo carregado no cliente | 50.000 itens em 1,6 s (50 leituras) |
| Bipagens | 50.000 enviadas, 50.000 confirmadas, 0 erros |
| Contagem no servidor (agregação REST) | 50.000 (bate) |
| Vazão de uma aba só | ~65 a 70 bipagens/s sustentado (278/s no pico inicial) |
| Ack p95 / média | 67 s / 35 s — fila do SDK numa aba só no ritmo máximo, não latência do servidor |
| Slots da fila (100 endereços, entrar/finalizar) | 0 erros de contenção |
| Lista de inventários com contagem | ok, ao vivo |
| Dashboard admin: conectar | 0,7 s |
| Dashboard admin: receber as 50.000 bipagens no listener | 61 s (meta era < 10 s) — 50k docs ≈ 12 MB; num balanço real de 10–20 mil fica em 15–25 s, e só na primeira abertura |

Achado no caminho: o SDK compat 10.12 não expõe `Query.count()`; a contagem passou a usar `runAggregationQuery` via REST com o token do usuário (commit cb403d3).

Ressalva: o teste mede o servidor e o caminho de gravação. Não reproduz 10 aparelhos com Wi-Fi ruim — cada celular tem seu próprio pipeline, então a vazão real por aparelho é bem maior que 1/10 disso. O teste em 2 celulares reais com leitor Bluetooth (Task 9, Step 3) fica com o Tiago.

Pendência aberta: dashboard admin com dezenas de milhares de bipagens demora na primeira carga. Opção futura: agregados por endereço/coletor mantidos por Cloud Function ou resumo periódico, fora deste escopo.

Screenshot: `docs/superpowers/plans/2026-09-16-teste-carga-resultado.png`.
