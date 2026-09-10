# Módulo Promotores v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o módulo Promotores v1 (CRUD simples de duas abas + check-in via página pública `checkin.html`, pronto mas nunca ativado) por uma réplica completa do painel "Gestão de Promotores" do Fluxo Radar — KPIs, agendamento recorrente, filtros, agenda semanal, drawer de fornecedor, rankings e QR check-in — com o check-in do promotor rodando como convidado dentro do próprio PWA em vez de uma página separada.

**Architecture:** Duas coleções Firestore já existentes (`clientes/{clienteId}/fornecedores` e `.../promotor_visitas`) ganham campos novos (contato do fornecedor, agendamento, status ampliado). O painel principal é uma reescrita de `panel-promotores` em `index.html`/`app.js`, seguindo os padrões visuais já usados no app (`.tabs`/`.tab`, `.kpi`/`.kpis`, `.st`/`.st-*`, `.modal-bg`/`.modal-box`). O check-in do promotor vira um "modo convidado" detectado no boot de `app.js` (parâmetro `?checkin=1` na URL), autenticado numa instância secundária do Firebase (`_getSecondaryAuth()`-like, isolada da sessão logada real) e renderizado como overlay fullscreen — mesmo padrão já usado pelo aviso de "Modo Privado Detectado" no topo de `app.js`. `public/checkin.html` é removido ao final.

**Tech Stack:** Vanilla JS (sem bundler), Firebase 10.x compat SDK já carregado em `index.html` (`firebase.firestore()`, `firebase.auth()`), `qrcode-generator.min.js` já vendorizado.

Não existe test runner neste projeto (SPA vanilla JS servida como arquivo estático, sem build step). Os passos de "teste" abaixo são verificação manual no navegador (console + Firestore Console), não testes automatizados — não introduzir um framework de teste novo.

## Global Constraints

- Toda leitura/escrita das duas coleções passa por `clientes/{clienteId}/...` — nunca criar coleção solta no root do Firestore (regra da Fase 1).
- O modo convidado (`?checkin=1`) nunca pode exigir login real do promotor — só `signInAnonymously()`, e sempre numa instância Firebase **secundária**, nunca na instância principal usada pela sessão logada (para não derrubar/misturar a sessão de quem já está logado no mesmo navegador, ex.: tablet da loja).
- GPS pode ser negado pelo navegador — nunca bloquear o check-in/check-out por causa disso, só gravar `null` no campo geo.
- Sempre que `app.js`, `style.css` ou `index.html` mudarem de conteúdo, incrementar `BUILD`/`?v=` nos 4 lugares de costume (`app.js` linha 2, `sw.js` `CACHE_NAME`, `index.html` `app.js?v=`/`style.css?v=`, `version.json`) — só na Task final, depois de todas as outras mudanças, para não gerar 9 bumps de build no meio do caminho.
- Seguir os padrões de código já usados no arquivo: `var`, funções `function(){}` (sem arrow functions/const/let), strings concatenadas com `+` para HTML dinâmico, `showToast(msg)` para feedback de erro/sucesso simples.
- O card "Promotores" na capa/sidebar só vira `desenvolvido:true` na última task (Task 10) — nenhuma task anterior deve deixar o módulo acessível pela metade.

---

### Task 1: Firestore Security Rules v2 — agendamento e status ampliado

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Produces: regras que aceitam (a) Admin/Supervisor criando uma visita `agendada` sem `sessionUid`, (b) convidado anônimo criando uma visita `na_loja` direto (sem agendamento prévio), (c) convidado anônimo "assumindo" uma visita `agendada` existente (preenchendo `sessionUid` e virando `na_loja`), (d) o mesmo convidado fechando o check-out (`realizada`), (e) Admin/Supervisor editando/fechando/excluindo qualquer visita manualmente.

Hoje o arquivo só cobre o modelo v1 (visita sempre nasce do check-in, nunca agendada antes). Isso muda em v2.

- [ ] **Step 1: Substituir o bloco `match /clientes/{clienteId}/promotor_visitas/{visitaId}`**

Trocar o bloco atual (linhas 14-30 de `firestore.rules`) por:

```
    match /clientes/{clienteId}/promotor_visitas/{visitaId} {
      allow read: if request.auth != null;

      // Create #1: Admin/Supervisor agenda uma visita com antecedência
      // (não anônimo, ainda sem check-in).
      allow create: if request.auth != null
        && request.auth.token.firebase.sign_in_provider != 'anonymous'
        && request.resource.data.status == 'agendada'
        && request.resource.data.sessionUid == null
        && request.resource.data.checkInEm == null
        && request.resource.data.checkOutEm == null;

      // Create #2: promotor convidado chega sem agendamento prévio e já
      // faz check-in direto (comportamento v1, mantido).
      allow create: if request.auth != null
        && request.resource.data.sessionUid == request.auth.uid
        && request.resource.data.status == 'na_loja'
        && request.resource.data.checkOutEm == null;

      // Update #1: promotor convidado "assume" uma visita agendada
      // existente e faz check-in (sessionUid ainda não preenchido).
      allow update: if request.auth != null
        && resource.data.status == 'agendada'
        && resource.data.sessionUid == null
        && request.resource.data.sessionUid == request.auth.uid
        && request.resource.data.status == 'na_loja'
        && request.resource.data.fornecedorId == resource.data.fornecedorId
        && request.resource.data.lojaId == resource.data.lojaId;

      // Update #2: o mesmo convidado que fez o check-in fecha o check-out.
      allow update: if request.auth != null
        && resource.data.sessionUid == request.auth.uid
        && resource.data.checkOutEm == null
        && request.resource.data.status == 'realizada'
        && request.resource.data.fornecedorId == resource.data.fornecedorId
        && request.resource.data.lojaId == resource.data.lojaId
        && request.resource.data.checkInEm == resource.data.checkInEm;

      // Update #3: Admin/Supervisor edita/fecha manualmente (ex: marcar
      // "não compareceu", fechar visita travada por troca de celular).
      allow update: if request.auth != null
        && request.auth.token.firebase.sign_in_provider != 'anonymous';

      allow delete: if request.auth != null
        && request.auth.token.firebase.sign_in_provider != 'anonymous';
    }
```

O bloco `match /clientes/{clienteId}/fornecedores/{fornecedorId}` (linhas 5-12) não muda — os campos novos (`telefone`, `email`, `periodicidade`, `diasSemana`) não precisam de regra própria, já cobertos por `allow write: if request.auth != null && ... != 'anonymous'`.

- [ ] **Step 2: Colar no Console do Firebase**

Abrir `https://console.firebase.google.com/project/economico-gestao/firestore/rules`, substituir só o bloco `match /clientes/{clienteId}/promotor_visitas/{visitaId}` (mantendo os outros blocos intactos). Publicar.

- [ ] **Step 3: Verificar manualmente no Rules Playground**

Aba "Regras" → "Simulador":
- `create` em `/clientes/fluxocerto/promotor_visitas/x`, autenticado não-anônimo, payload `{status:'agendada', sessionUid:null, checkInEm:null, checkOutEm:null}` → **Allow**.
- `create` do mesmo jeito mas anônimo → **Deny** (Create #1 exige não-anônimo).
- `create` anônimo (uid `abc123`) com payload `{sessionUid:'abc123', status:'na_loja', checkOutEm:null}` → **Allow** (Create #2).
- `update` em documento existente simulado com `{status:'agendada', sessionUid:null, fornecedorId:'f1', lojaId:'l1'}`, anônimo uid `abc123`, novo payload `{status:'na_loja', sessionUid:'abc123', fornecedorId:'f1', lojaId:'l1'}` → **Allow** (Update #1).
- Mesmo update, mas com `sessionUid:'outro-uid'` no payload novo → **Deny**.
- `delete` em qualquer documento, não autenticado → **Deny**.

- [ ] **Step 4: Commit**

```bash
git add firestore.rules
git commit -m "feat: regras Firestore v2 pra agendamento e status ampliado de promotor_visitas"
```

---

### Task 2: Camada de dados — coleções, status e pontualidade

**Files:**
- Modify: `app.js` (perto de `fornecedoresCol()`, linha ~4268)

**Interfaces:**
- Produces: `visitasCol()`, `STATUS_VISITA` (map), `labelStatusVisita(status)`, `calcPontualidade(visita)`, `getLojasUnicas()`.
- Consumes: `S.clienteConfig.id`, `db`.

- [ ] **Step 1: Adicionar `visitasCol()`, mapa de status e helpers, logo abaixo de `fornecedoresCol()`**

```js
function visitasCol() {
  return db.collection('clientes').doc(S.clienteConfig.id).collection('promotor_visitas');
}

var STATUS_VISITA = {
  agendada:       {label: 'Agendada',          cls: 'st-warn'},
  na_loja:        {label: 'Na Loja',            cls: 'st-ok'},
  realizada:      {label: 'Realizada',          cls: 'st-info'},
  nao_compareceu: {label: 'Não Compareceu',     cls: 'st-err'},
  fim_de_semana:  {label: 'Fim de Semana',      cls: 'st-info'}
};

function labelStatusVisita(status) {
  var s = STATUS_VISITA[status];
  return s ? s.label : status;
}

// Compara horaAgendada (HH:MM) com o horário real de checkInEm.
// >15min de atraso = 'atrasado', <=-10min (chegou adiantado) = 'antecipado', senão 'pontual'.
// Sem horaAgendada ou sem checkInEm ainda: retorna null (sem badge).
function calcPontualidade(visita) {
  if (!visita.horaAgendada || !visita.checkInEm) return null;
  var checkInDate = visita.checkInEm.toDate ? visita.checkInEm.toDate() : new Date(visita.checkInEm);
  var partes = visita.horaAgendada.split(':');
  var agendado = new Date(checkInDate);
  agendado.setHours(parseInt(partes[0], 10), parseInt(partes[1], 10), 0, 0);
  var diffMin = (checkInDate - agendado) / 60000;
  if (diffMin > 15) return 'atrasado';
  if (diffMin <= -10) return 'antecipado';
  return 'pontual';
}

// Sem lista canônica de lojas no FC360 (cada módulo gerencia lojas por
// texto livre) — deriva o conjunto de lojas a partir dos fornecedores
// cadastrados neste módulo.
function getLojasUnicas(fornecedores) {
  var set = {};
  (fornecedores || []).forEach(function(f) {
    (f.lojas || []).forEach(function(l) { set[l] = true; });
  });
  return Object.keys(set).sort();
}
```

- [ ] **Step 2: Verificar manualmente**

Abrir o app no navegador, console DevTools, rodar:
```js
calcPontualidade({horaAgendada:'09:00', checkInEm:{toDate:function(){return new Date(new Date().toDateString()+' 09:20');}}})
```
Esperado: `'atrasado'`. Trocar `09:20` por `08:45` → esperado `'antecipado'`. Trocar por `09:05` → esperado `'pontual'`.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: camada de dados do painel de Promotores (status, pontualidade, coleção de visitas)"
```

---

### Task 3: Cadastro de fornecedores — campos novos (contato, periodicidade, dias da semana)

**Files:**
- Modify: `index.html:464-477` (modal `modal-fornecedor`)
- Modify: `app.js` (`abrirModalFornecedor`, `salvarFornecedor`, linhas ~4290-4316)

**Interfaces:**
- Consumes: `fornecedoresCol()` (Task 2).
- Produces: fornecedor com `telefone`, `email`, `periodicidade`, `diasSemana` persistidos — consumido pela Task 4 (agendamento) e Task 7 (drawer).

- [ ] **Step 1: Adicionar campos no modal, em `index.html`**

Substituir o conteúdo do `modal-fornecedor` (linhas 464-477):

```html
      <div class="modal-bg" id="modal-fornecedor" style="display:none">
        <div class="modal-box" style="width:440px">
          <div class="modal-title">Fornecedor</div>
          <input type="hidden" id="forn-id">
          <label>Nome</label>
          <input id="forn-nome" placeholder="Nome do fornecedor">
          <label style="margin-top:12px">Telefone</label>
          <input id="forn-telefone" placeholder="(00) 00000-0000">
          <label style="margin-top:12px">E-mail</label>
          <input id="forn-email" type="email" placeholder="contato@fornecedor.com">
          <label style="margin-top:12px">Lojas atendidas (IDs separados por vírgula)</label>
          <input id="forn-lojas" placeholder="1,2,3">
          <label style="margin-top:12px">Dias da semana esperados</label>
          <div id="forn-dias" style="display:flex;gap:6px;margin-bottom:16px">
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="1" onclick="toggleDiaFornecedor(this)">Seg</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="2" onclick="toggleDiaFornecedor(this)">Ter</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="3" onclick="toggleDiaFornecedor(this)">Qua</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="4" onclick="toggleDiaFornecedor(this)">Qui</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="5" onclick="toggleDiaFornecedor(this)">Sex</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="6" onclick="toggleDiaFornecedor(this)">Sáb</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="0" onclick="toggleDiaFornecedor(this)">Dom</button>
          </div>
          <label>Periodicidade</label>
          <select id="forn-periodicidade" style="margin-bottom:16px">
            <option value="semanal">Semanal</option>
            <option value="diaria">Diária</option>
            <option value="quinzenal">Quinzenal</option>
            <option value="mensal">Mensal</option>
          </select>
          <div class="btn-row">
            <button class="btn btn-p" onclick="salvarFornecedor()">Salvar</button>
            <button class="btn btn-s" onclick="document.getElementById('modal-fornecedor').style.display='none'">Cancelar</button>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Adicionar `toggleDiaFornecedor` e atualizar `abrirModalFornecedor`/`salvarFornecedor` em `app.js`**

Substituir as duas funções (linhas ~4290-4316) por:

```js
function toggleDiaFornecedor(btn) {
  btn.classList.toggle('btn-p');
  btn.classList.toggle('btn-s');
}

function abrirModalFornecedor(id) {
  document.getElementById('forn-id').value = id || '';
  document.getElementById('forn-nome').value = '';
  document.getElementById('forn-telefone').value = '';
  document.getElementById('forn-email').value = '';
  document.getElementById('forn-lojas').value = '';
  document.getElementById('forn-periodicidade').value = 'semanal';
  document.querySelectorAll('#forn-dias .dia-btn').forEach(function(b) {
    b.classList.remove('btn-p'); b.classList.add('btn-s');
  });
  document.getElementById('modal-fornecedor').style.display = 'flex';
  if (id) {
    fornecedoresCol().doc(id).get().then(function(doc) {
      var f = doc.data();
      document.getElementById('forn-nome').value = f.nome || '';
      document.getElementById('forn-telefone').value = f.telefone || '';
      document.getElementById('forn-email').value = f.email || '';
      document.getElementById('forn-lojas').value = (f.lojas || []).join(',');
      document.getElementById('forn-periodicidade').value = f.periodicidade || 'semanal';
      (f.diasSemana || []).forEach(function(dia) {
        var btn = document.querySelector('#forn-dias .dia-btn[data-dia="' + dia + '"]');
        if (btn) { btn.classList.remove('btn-s'); btn.classList.add('btn-p'); }
      });
    });
  }
}

function salvarFornecedor() {
  var id = document.getElementById('forn-id').value;
  var nome = document.getElementById('forn-nome').value.trim();
  var lojas = document.getElementById('forn-lojas').value.split(',').map(function(s){return s.trim();}).filter(Boolean);
  if (!nome || !lojas.length) { showToast('Preencha nome e ao menos uma loja.'); return; }
  var diasSemana = Array.prototype.slice.call(document.querySelectorAll('#forn-dias .dia-btn.btn-p'))
    .map(function(b) { return parseInt(b.getAttribute('data-dia'), 10); });
  var dados = {
    nome: nome,
    telefone: document.getElementById('forn-telefone').value.trim() || null,
    email: document.getElementById('forn-email').value.trim() || null,
    lojas: lojas,
    diasSemana: diasSemana,
    periodicidade: document.getElementById('forn-periodicidade').value,
    ativo: true
  };
  var op = id ? fornecedoresCol().doc(id).update(dados) : fornecedoresCol().add(dados);
  op.then(function() {
    document.getElementById('modal-fornecedor').style.display = 'none';
    showToast('Fornecedor salvo.');
    if (typeof renderPromotoresPainel === 'function') renderPromotoresPainel();
  });
}
```

`renderFornecedores()` (a listagem simples de v1) sai de uso a partir da Task 4, que substitui a tela inteira — não precisa remover ainda nesta task, só parar de ser a única forma de ver fornecedores.

- [ ] **Step 3: Verificar manualmente**

Chamar `nav('promotores')` manualmente no console (a navegação de verdade só é ligada na Task 10). Abrir "+ Novo Fornecedor", preencher nome, telefone, email, lojas "1,2", marcar Seg/Qua/Sex, periodicidade "Semanal", salvar. Confirmar no Firestore Console que o documento tem todos os campos, incluindo `diasSemana:[1,3,5]`. Editar o mesmo fornecedor, confirmar que os dias marcados aparecem certos ao reabrir o modal.

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "feat: campos de contato, periodicidade e dias da semana no cadastro de fornecedores"
```

---

### Task 4: Painel principal — KPIs, busca, filtros e tabela de visitas

**Files:**
- Modify: `index.html:445-462` (substitui o `panel-promotores` de duas abas)
- Modify: `app.js` (substitui `switchPromotoresTab`, `renderFornecedores` como tela principal — linhas ~4259-4289 — por `renderPromotoresPainel` e afins)

**Interfaces:**
- Consumes: `visitasCol()`, `STATUS_VISITA`, `labelStatusVisita()`, `calcPontualidade()` (Task 2); `fornecedoresCol()` (existente).
- Produces: `renderPromotoresPainel()`, `S.promotoresState` (`{visitas:[], fornecedores:[], filtro:'todos', busca:''}`), `aplicarFiltroPromotores(filtro, btn)`, `buscarPromotores(valor)` — consumidos pelas Tasks 5-8, que injetam conteúdo nos containers `#promotores-agendamento-btn`, `#promotores-fornecedores-lista`, `#promotores-rankings`, `#promotores-qr-grid` criados aqui.

- [ ] **Step 1: Substituir o painel em `index.html`**

```html
      <div id="panel-promotores" class="panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
          <div><div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:18px;font-weight:700">Gestão de Promotores</div><div style="font-size:13px;color:var(--t3);margin-top:2px">Fornecedores, agenda e visitas por loja</div></div>
          <div id="promotores-agendamento-btn" style="display:flex;gap:8px"></div>
        </div>

        <div id="promotores-kpis"></div>
        <div id="promotores-cumprimento" style="margin:14px 0"></div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
          <input id="promotores-busca" placeholder="Buscar por fornecedor, promotor ou loja..." style="flex:1;min-width:220px;padding:10px 12px;border:1px solid var(--gray2);border-radius:10px;font-size:13px" oninput="buscarPromotores(this.value)">
          <button class="btn btn-s btn-sm" onclick="abrirAgendaSemanal()">📅 Agenda Semanal</button>
        </div>

        <div class="tabs" id="promotores-filtros">
          <div class="tab on" data-filtro="todos" onclick="aplicarFiltroPromotores('todos',this)">Todos</div>
          <div class="tab" data-filtro="hoje" onclick="aplicarFiltroPromotores('hoje',this)">Hoje</div>
          <div class="tab" data-filtro="agendada" onclick="aplicarFiltroPromotores('agendada',this)">Agendados</div>
          <div class="tab" data-filtro="na_loja" onclick="aplicarFiltroPromotores('na_loja',this)">Na Loja</div>
          <div class="tab" data-filtro="realizada" onclick="aplicarFiltroPromotores('realizada',this)">Realizados</div>
          <div class="tab" data-filtro="nao_compareceu" onclick="aplicarFiltroPromotores('nao_compareceu',this)">Não Compareceram</div>
          <div class="tab" data-filtro="fim_de_semana" onclick="aplicarFiltroPromotores('fim_de_semana',this)">Fim de Semana</div>
          <div class="tab" data-filtro="proximos7" onclick="aplicarFiltroPromotores('proximos7',this)">Próximos 7 dias</div>
        </div>

        <div id="promotores-tabela"></div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-top:24px" id="promotores-rankings"></div>

        <div style="margin-top:24px">
          <div style="font-weight:700;font-size:14px;margin-bottom:10px">Fornecedores cadastrados</div>
          <button class="btn btn-p btn-sm" style="margin-bottom:12px" onclick="abrirModalFornecedor()">+ Novo Fornecedor</button>
          <div id="promotores-fornecedores-lista"></div>
        </div>

        <div style="margin-top:24px">
          <div style="font-weight:700;font-size:14px;margin-bottom:10px">QR codes por loja</div>
          <div id="promotores-qr-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px"></div>
        </div>
      </div>

      <div class="modal-bg" id="modal-qr" style="display:none">
        <div class="modal-box" style="width:340px;text-align:center">
          <div class="modal-title">QR Code da loja</div>
          <div id="qr-container" style="margin:16px 0"></div>
          <button class="btn btn-s" style="width:100%" onclick="document.getElementById('modal-qr').style.display='none'">Fechar</button>
        </div>
      </div>
```

(o modal `modal-fornecedor` da Task 3 continua logo abaixo, sem mudança.)

- [ ] **Step 2: Substituir `switchPromotoresTab`/`renderFornecedores` por `renderPromotoresPainel` e o motor de filtro/busca, em `app.js`**

Remover `switchPromotoresTab` e `renderFornecedores` (linhas ~4259-4289) e colocar no lugar:

```js
// ── Painel Promotores ──
var S_PROM = {visitas: [], fornecedores: [], filtro: 'todos', busca: ''};

function renderPromotoresPainel() {
  Promise.all([
    visitasCol().get(),
    fornecedoresCol().get()
  ]).then(function(results) {
    S_PROM.visitas = results[0].docs.map(function(d) { return Object.assign({id: d.id}, d.data()); });
    S_PROM.fornecedores = results[1].docs.map(function(d) { return Object.assign({id: d.id}, d.data()); });
    renderKpisPromotores();
    renderTabelaVisitas();
    renderFornecedoresLista();
    renderQrGridLojas();
    if (typeof renderRankingsPromotores === 'function') renderRankingsPromotores();
  }).catch(function(e) {
    document.getElementById('promotores-tabela').innerHTML = '<div class="empty">Erro ao carregar: ' + e.message + '</div>';
  });
}

function renderFornecedoresLista() {
  var wrap = document.getElementById('promotores-fornecedores-lista');
  if (!S_PROM.fornecedores.length) { wrap.innerHTML = '<div class="empty">Nenhum fornecedor cadastrado ainda.</div>'; return; }
  wrap.innerHTML = S_PROM.fornecedores.map(function(f) {
    return '<div class="card" style="display:flex;align-items:center;justify-content:space-between;padding:14px;margin-bottom:8px">'
      + '<div><strong>' + f.nome + '</strong><div style="font-size:12px;color:var(--t3)">Lojas: ' + (f.lojas||[]).join(', ') + (f.telefone ? ' · ' + f.telefone : '') + '</div></div>'
      + '<div style="display:flex;gap:6px">'
      + '<button class="btn btn-s btn-sm" onclick="abrirDrawerFornecedor(\'' + f.id + '\')">Ver</button>'
      + '<button class="btn btn-s btn-sm" onclick="abrirModalFornecedor(\'' + f.id + '\')">Editar</button>'
      + '<button class="btn btn-d btn-sm" onclick="excluirFornecedor(\'' + f.id + '\')">Excluir</button>'
      + '</div></div>';
  }).join('');
}

function excluirFornecedor(id) {
  if (!confirm('Excluir este fornecedor?')) return;
  fornecedoresCol().doc(id).delete().then(renderPromotoresPainel);
}

function renderKpisPromotores() {
  var hoje = getLocalDate();
  var visitasHoje = S_PROM.visitas.filter(function(v) { return v.dataAgendada === hoje; });
  var previstas = visitasHoje.length;
  var realizadas = visitasHoje.filter(function(v) { return v.status === 'realizada'; }).length;
  var naLoja = visitasHoje.filter(function(v) { return v.status === 'na_loja'; }).length;
  var naoCompareceram = visitasHoje.filter(function(v) { return v.status === 'nao_compareceu'; }).length;
  var pct = previstas ? Math.round((realizadas / previstas) * 100) : 0;

  document.getElementById('promotores-kpis').innerHTML =
    '<style>#promotores-kpis .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}'
    + '#promotores-kpis .kpi{background:#f8f9fa;border-radius:8px;padding:12px 14px;border-left:4px solid #FFC600}'
    + '#promotores-kpis .k-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-bottom:4px}'
    + '#promotores-kpis .k-val{font-size:22px;font-weight:800}</style>'
    + '<div class="kpis">'
    + '<div class="kpi"><div class="k-lbl">Visitas Previstas Hoje</div><div class="k-val">' + previstas + '</div></div>'
    + '<div class="kpi"><div class="k-lbl">Check-ins Realizados</div><div class="k-val">' + realizadas + '</div></div>'
    + '<div class="kpi"><div class="k-lbl">Em Loja Agora</div><div class="k-val">' + naLoja + '</div></div>'
    + '<div class="kpi" style="border-left-color:' + (naoCompareceram > 0 ? '#e74c3c' : '#FFC600') + '"><div class="k-lbl">Não Compareceram</div><div class="k-val" style="color:' + (naoCompareceram > 0 ? '#e74c3c' : 'inherit') + '">' + naoCompareceram + '</div></div>'
    + '</div>';

  document.getElementById('promotores-cumprimento').innerHTML =
    '<div style="font-size:12px;color:var(--t3);margin-bottom:4px">Cumprimento da Agenda (hoje): ' + pct + '%</div>'
    + '<div style="background:var(--gray);border-radius:8px;height:8px;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:' + (pct >= 80 ? '#2d9e62' : pct >= 50 ? '#e67e22' : '#e74c3c') + '"></div></div>';
}

function aplicarFiltroPromotores(filtro, btn) {
  S_PROM.filtro = filtro;
  document.querySelectorAll('#promotores-filtros .tab').forEach(function(t) { t.classList.remove('on'); });
  if (btn) btn.classList.add('on');
  renderTabelaVisitas();
}

function buscarPromotores(valor) {
  S_PROM.busca = (valor || '').toLowerCase().trim();
  renderTabelaVisitas();
}

function _visitasFiltradas() {
  var hoje = getLocalDate();
  var em7dias = new Date(); em7dias.setDate(em7dias.getDate() + 7);
  var em7diasStr = em7dias.toISOString().slice(0, 10);

  return S_PROM.visitas.filter(function(v) {
    if (S_PROM.filtro === 'hoje' && v.dataAgendada !== hoje) return false;
    if (S_PROM.filtro === 'proximos7' && !(v.dataAgendada >= hoje && v.dataAgendada <= em7diasStr)) return false;
    if (['agendada','na_loja','realizada','nao_compareceu','fim_de_semana'].indexOf(S_PROM.filtro) >= 0 && v.status !== S_PROM.filtro) return false;
    if (S_PROM.busca) {
      var alvo = ((v.fornecedorNome||'') + ' ' + (v.promotorNome||'') + ' ' + (v.lojaNome||'')).toLowerCase();
      if (alvo.indexOf(S_PROM.busca) === -1) return false;
    }
    return true;
  }).sort(function(a, b) { return (b.dataAgendada||'') < (a.dataAgendada||'') ? -1 : 1; });
}

function renderTabelaVisitas() {
  var wrap = document.getElementById('promotores-tabela');
  var visitas = _visitasFiltradas();
  if (!visitas.length) { wrap.innerHTML = '<div class="empty">Nenhuma visita encontrada.</div>'; return; }

  var pontualidadeLabel = {antecipado: 'Antecipado', pontual: 'Pontual', atrasado: 'Atrasado'};

  wrap.innerHTML = '<table class="tbl"><thead><tr><th>Data</th><th>Fornecedor</th><th>Promotor</th><th>Loja</th><th>Programado</th><th>Entrada</th><th>Saída</th><th>Status</th></tr></thead><tbody>'
    + visitas.map(function(v) {
      var st = STATUS_VISITA[v.status] || {label: v.status, cls: 'st-info'};
      var pont = calcPontualidade(v);
      var entrada = v.checkInEm ? (v.checkInEm.toDate ? v.checkInEm.toDate() : new Date(v.checkInEm)).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '-';
      var saida = v.checkOutEm ? (v.checkOutEm.toDate ? v.checkOutEm.toDate() : new Date(v.checkOutEm)).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : (v.status === 'na_loja' ? '<span class="st st-warn">Em aberto</span>' : '-');
      return '<tr><td>' + (v.dataAgendada || '-') + '</td><td>' + (v.fornecedorNome||'-') + '</td><td>' + (v.promotorNome||'-') + '</td><td>' + (v.lojaNome||'-') + '</td>'
        + '<td>' + (v.horaAgendada || '-') + '</td>'
        + '<td>' + entrada + (pont ? ' <span class="st ' + (pont==='atrasado'?'st-err':pont==='antecipado'?'st-info':'st-ok') + '">' + pontualidadeLabel[pont] + '</span>' : '') + '</td>'
        + '<td>' + saida + '</td>'
        + '<td><span class="st ' + st.cls + '">' + st.label + '</span></td></tr>';
    }).join('')
    + '</tbody></table>';
}
```

- [ ] **Step 3: Verificar manualmente**

Chamar `renderPromotoresPainel()` no console (navegação de verdade só é ligada na Task 10). Confirmar que aparecem: linha de KPIs zerados (sem visitas ainda), barra de cumprimento 0%, filtros, busca, lista de fornecedores (herdada da Task 3), tabela vazia com "Nenhuma visita encontrada". Criar manualmente um documento de teste em `promotor_visitas` pelo Firestore Console (`status:'realizada'`, `dataAgendada` de hoje, `fornecedorNome`, `promotorNome`, `lojaNome`, `checkInEm`/`checkOutEm` como timestamps), rodar `renderPromotoresPainel()` de novo — confirmar que aparece na tabela e nos KPIs.

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "feat: painel principal de Promotores (KPIs, busca, filtros, tabela)"
```

---

### Task 5: Agendamento de visitas (avulso e recorrente)

**Files:**
- Modify: `index.html` (novo modal `modal-agendamento`, depois do `modal-fornecedor`)
- Modify: `app.js` (novas funções `abrirModalAgendamento`, `toggleDiaAgendamento`, `salvarAgendamento`)

**Interfaces:**
- Consumes: `visitasCol()` (Task 2), `S_PROM.fornecedores` (Task 4), `renderPromotoresPainel()` (Task 4).
- Produces: botão real dentro de `#promotores-agendamento-btn` (container criado na Task 4).

- [ ] **Step 1: Adicionar o modal em `index.html`, depois do `modal-fornecedor`**

```html
      <div class="modal-bg" id="modal-agendamento" style="display:none">
        <div class="modal-box" style="width:460px">
          <div class="modal-title">Novo Agendamento</div>
          <label>Fornecedor</label>
          <select id="ag-fornecedor"></select>
          <label style="margin-top:12px">Nome do promotor</label>
          <input id="ag-promotor-nome" placeholder="Nome completo">
          <label style="margin-top:12px">Telefone do promotor</label>
          <input id="ag-promotor-telefone" placeholder="(00) 00000-0000">
          <label style="margin-top:12px">Loja</label>
          <input id="ag-loja" placeholder="ID/nome da loja">
          <div style="display:flex;gap:10px">
            <div style="flex:1"><label style="margin-top:12px">Data inicial</label><input id="ag-data-inicial" type="date"></div>
            <div style="flex:1"><label style="margin-top:12px">Hora</label><input id="ag-hora" type="time"></div>
          </div>
          <label style="margin-top:12px">Recorrência</label>
          <div id="ag-dias" style="display:flex;gap:6px;margin-bottom:12px">
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="1" onclick="toggleDiaAgendamento(this)">Seg</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="2" onclick="toggleDiaAgendamento(this)">Ter</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="3" onclick="toggleDiaAgendamento(this)">Qua</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="4" onclick="toggleDiaAgendamento(this)">Qui</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="5" onclick="toggleDiaAgendamento(this)">Sex</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="6" onclick="toggleDiaAgendamento(this)">Sáb</button>
            <button type="button" class="btn btn-s btn-sm dia-btn" data-dia="0" onclick="toggleDiaAgendamento(this)">Dom</button>
          </div>
          <label>Periodicidade</label>
          <select id="ag-periodicidade">
            <option value="">Avulso (só a data inicial)</option>
            <option value="diaria">Diária</option>
            <option value="semanal">Semanal</option>
            <option value="quinzenal">Quinzenal</option>
            <option value="mensal">Mensal</option>
          </select>
          <label style="margin-top:12px">Data final (obrigatório se recorrente)</label>
          <input id="ag-data-final" type="date" style="margin-bottom:16px">
          <div class="btn-row">
            <button class="btn btn-p" onclick="salvarAgendamento()">Salvar</button>
            <button class="btn btn-s" onclick="document.getElementById('modal-agendamento').style.display='none'">Cancelar</button>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Adicionar as funções em `app.js`, logo depois de `renderTabelaVisitas`**

```js
function abrirModalAgendamento() {
  var sel = document.getElementById('ag-fornecedor');
  sel.innerHTML = '<option value="">Selecione...</option>' + S_PROM.fornecedores.map(function(f) {
    return '<option value="' + f.id + '" data-nome="' + f.nome + '">' + f.nome + '</option>';
  }).join('');
  document.getElementById('ag-promotor-nome').value = '';
  document.getElementById('ag-promotor-telefone').value = '';
  document.getElementById('ag-loja').value = '';
  document.getElementById('ag-data-inicial').value = getLocalDate();
  document.getElementById('ag-hora').value = '';
  document.getElementById('ag-periodicidade').value = '';
  document.getElementById('ag-data-final').value = '';
  document.querySelectorAll('#ag-dias .dia-btn').forEach(function(b) { b.classList.remove('btn-p'); b.classList.add('btn-s'); });
  document.getElementById('modal-agendamento').style.display = 'flex';
}

function toggleDiaAgendamento(btn) {
  btn.classList.toggle('btn-p');
  btn.classList.toggle('btn-s');
}

// Gera as datas de ocorrência entre dataInicial e dataFinal conforme a
// periodicidade. Sem periodicidade = uma ocorrência só (avulso).
// Teto de 60 ocorrências pra nunca gerar uma escrita em massa por engano.
function _gerarDatasAgendamento(dataInicial, dataFinal, periodicidade, diasSemana) {
  if (!periodicidade) return [dataInicial];
  var datas = [];
  var cursor = new Date(dataInicial + 'T00:00:00');
  var fim = new Date((dataFinal || dataInicial) + 'T00:00:00');
  var semanaInicial = Math.floor(cursor.getTime() / (7 * 86400000));
  while (cursor <= fim && datas.length < 60) {
    var diaSemana = cursor.getDay();
    var passaFiltroDia = periodicidade === 'diaria' || periodicidade === 'mensal' || !diasSemana.length || diasSemana.indexOf(diaSemana) >= 0;
    if (periodicidade === 'quinzenal') {
      var semanaAtual = Math.floor(cursor.getTime() / (7 * 86400000));
      passaFiltroDia = passaFiltroDia && ((semanaAtual - semanaInicial) % 2 === 0);
    }
    if (periodicidade === 'mensal') {
      passaFiltroDia = cursor.getDate() === new Date(dataInicial + 'T00:00:00').getDate();
    }
    if (passaFiltroDia) datas.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return datas;
}

function salvarAgendamento() {
  var fornecedorSel = document.getElementById('ag-fornecedor');
  var fornecedorId = fornecedorSel.value;
  var fornecedorNome = fornecedorSel.options[fornecedorSel.selectedIndex] ? fornecedorSel.options[fornecedorSel.selectedIndex].getAttribute('data-nome') : '';
  var promotorNome = document.getElementById('ag-promotor-nome').value.trim();
  var lojaId = document.getElementById('ag-loja').value.trim();
  var dataInicial = document.getElementById('ag-data-inicial').value;
  var periodicidade = document.getElementById('ag-periodicidade').value;
  var dataFinal = document.getElementById('ag-data-final').value;

  if (!fornecedorId || !promotorNome || !lojaId || !dataInicial) { showToast('Preencha fornecedor, promotor, loja e data inicial.'); return; }
  if (periodicidade && !dataFinal) { showToast('Informe a data final da recorrência.'); return; }

  var diasSemana = Array.prototype.slice.call(document.querySelectorAll('#ag-dias .dia-btn.btn-p'))
    .map(function(b) { return parseInt(b.getAttribute('data-dia'), 10); });
  var datas = _gerarDatasAgendamento(dataInicial, dataFinal, periodicidade, diasSemana);
  if (!datas.length) { showToast('Nenhuma data gerada — confira os dias da semana e o período.'); return; }

  var batch = db.batch();
  var col = visitasCol();
  datas.forEach(function(data) {
    var ref = col.doc();
    batch.set(ref, {
      fornecedorId: fornecedorId,
      fornecedorNome: fornecedorNome,
      lojaId: lojaId,
      lojaNome: lojaId,
      promotorNome: promotorNome,
      promotorTelefone: document.getElementById('ag-promotor-telefone').value.trim() || null,
      dataAgendada: data,
      horaAgendada: document.getElementById('ag-hora').value || null,
      status: 'agendada',
      sessionUid: null,
      checkInEm: null,
      checkInGeo: null,
      checkOutEm: null,
      checkOutGeo: null
    });
  });
  batch.commit().then(function() {
    document.getElementById('modal-agendamento').style.display = 'none';
    showToast(datas.length + ' visita(s) agendada(s).');
    renderPromotoresPainel();
  }).catch(function(e) { showToast('Erro ao agendar: ' + e.message); });
}
```

- [ ] **Step 3: Ligar o botão no container criado pela Task 4**

No `renderPromotoresPainel()` (Task 4), adicionar logo no início da função (antes do `Promise.all`):

```js
  document.getElementById('promotores-agendamento-btn').innerHTML =
    '<button class="btn btn-p btn-sm" onclick="abrirModalAgendamento()">+ Novo Agendamento</button>';
```

- [ ] **Step 4: Verificar manualmente**

Com pelo menos um fornecedor cadastrado (Task 3), clicar "+ Novo Agendamento". Testar avulso: preencher tudo, periodicidade "Avulso", salvar — confirmar 1 documento novo em `promotor_visitas` com `status:'agendada'`. Testar recorrente: periodicidade "Semanal", marcar Seg/Qua, data inicial e final cobrindo 2 semanas — confirmar 4 documentos gerados (2 semanas × 2 dias), todos com `status:'agendada'`. Confirmar que a tabela do painel mostra as novas visitas.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js
git commit -m "feat: agendamento de visitas avulso e recorrente"
```

---

### Task 6: Agenda semanal (modal)

**Files:**
- Modify: `index.html` (novo modal `modal-agenda-semanal`)
- Modify: `app.js` (`abrirAgendaSemanal`, `renderAgendaSemanal`)

**Interfaces:**
- Consumes: `S_PROM.visitas` (Task 4).

- [ ] **Step 1: Adicionar o modal em `index.html`, depois do `modal-agendamento`**

```html
      <div class="modal-bg" id="modal-agenda-semanal" style="display:none">
        <div class="modal-box" style="width:900px;max-width:95vw">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div class="modal-title" style="margin:0">Agenda Semanal</div>
            <div style="display:flex;gap:6px;align-items:center">
              <button class="btn btn-s btn-sm" onclick="renderAgendaSemanal(-1)">◀</button>
              <button class="btn btn-s btn-sm" onclick="renderAgendaSemanal(0,true)">Hoje</button>
              <button class="btn btn-s btn-sm" onclick="renderAgendaSemanal(1)">▶</button>
            </div>
          </div>
          <div id="agenda-semanal-grid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;max-height:60vh;overflow-y:auto"></div>
          <div class="btn-row" style="margin-top:16px"><button class="btn btn-s" style="width:100%" onclick="document.getElementById('modal-agenda-semanal').style.display='none'">Fechar</button></div>
        </div>
      </div>
```

- [ ] **Step 2: Adicionar as funções em `app.js`, depois de `salvarAgendamento`**

```js
var _agendaSemanaOffset = 0;

function abrirAgendaSemanal() {
  _agendaSemanaOffset = 0;
  document.getElementById('modal-agenda-semanal').style.display = 'flex';
  renderAgendaSemanal(0, true);
}

function renderAgendaSemanal(delta, resetar) {
  _agendaSemanaOffset = resetar ? 0 : _agendaSemanaOffset + delta;
  var hoje = new Date();
  var diaSemanaHoje = hoje.getDay();
  var segundaBase = new Date(hoje);
  segundaBase.setDate(hoje.getDate() - ((diaSemanaHoje + 6) % 7) + (_agendaSemanaOffset * 7));

  var nomesDia = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  var hojeStr = getLocalDate();
  var grid = document.getElementById('agenda-semanal-grid');

  var colunas = [];
  for (var i = 0; i < 7; i++) {
    var dia = new Date(segundaBase);
    dia.setDate(segundaBase.getDate() + i);
    var diaStr = dia.toISOString().slice(0, 10);
    var isHoje = diaStr === hojeStr;
    var isFimSemana = dia.getDay() === 0 || dia.getDay() === 6;
    var visitasDoDia = S_PROM.visitas.filter(function(v) { return v.dataAgendada === diaStr; })
      .sort(function(a, b) { return (a.horaAgendada||'') < (b.horaAgendada||'') ? -1 : 1; });

    var cards = visitasDoDia.map(function(v) {
      var st = STATUS_VISITA[v.status] || {label: v.status, cls: 'st-info'};
      return '<div class="card" style="padding:8px;margin-bottom:6px;font-size:11px">'
        + '<div style="font-weight:700">' + (v.horaAgendada || '--:--') + ' · ' + (v.fornecedorNome||'-') + '</div>'
        + '<div style="color:var(--t3)">' + (v.promotorNome||'-') + ' · ' + (v.lojaNome||'-') + '</div>'
        + '<span class="st ' + st.cls + '" style="margin-top:4px;display:inline-block">' + st.label + '</span></div>';
    }).join('') || '<div style="font-size:11px;color:var(--t3)">Sem visitas</div>';

    colunas.push(
      '<div style="background:' + (isHoje ? '#fff8e1' : isFimSemana ? '#fafafa' : 'transparent') + ';border-radius:8px;padding:8px;border:1px solid var(--gray2)">'
      + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px">' + nomesDia[dia.getDay()] + ' ' + dia.getDate() + '/' + (dia.getMonth()+1) + '</div>'
      + cards + '</div>'
    );
  }
  grid.innerHTML = colunas.join('');
}
```

- [ ] **Step 3: Verificar manualmente**

Com visitas já agendadas (Task 5) em datas variadas, clicar "📅 Agenda Semanal". Confirmar 7 colunas, coluna de hoje destacada, visitas aparecendo no dia certo. Clicar ◀/▶, confirmar que a semana muda. Clicar "Hoje", confirmar que volta pra semana atual.

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "feat: modal de agenda semanal do painel de Promotores"
```

---

### Task 7: Drawer de fornecedor e rankings

**Files:**
- Modify: `index.html` (novo `div#drawer-fornecedor`, fora dos `.panel` mas dentro de `#app`)
- Modify: `app.js` (`abrirDrawerFornecedor`, `fecharDrawerFornecedor`, `renderRankingsPromotores`)

**Interfaces:**
- Consumes: `S_PROM.fornecedores`, `S_PROM.visitas` (Task 4).
- Produces: preenche `#promotores-rankings` (container da Task 4).

- [ ] **Step 1: Adicionar o drawer em `index.html`, próximo aos outros modais de Promotores**

```html
      <div id="drawer-fornecedor-bg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:900" onclick="fecharDrawerFornecedor()"></div>
      <div id="drawer-fornecedor" style="display:none;position:fixed;top:0;right:0;bottom:0;width:360px;max-width:90vw;background:#fff;z-index:901;box-shadow:-4px 0 20px rgba(0,0,0,.15);padding:22px;overflow-y:auto">
        <button class="btn btn-s btn-sm" style="margin-bottom:16px" onclick="fecharDrawerFornecedor()">← Fechar</button>
        <div id="drawer-fornecedor-conteudo"></div>
      </div>
```

- [ ] **Step 2: Adicionar as funções em `app.js`, depois de `renderAgendaSemanal`**

```js
function abrirDrawerFornecedor(id) {
  var f = S_PROM.fornecedores.filter(function(x) { return x.id === id; })[0];
  if (!f) return;
  var visitasDoFornecedor = S_PROM.visitas.filter(function(v) { return v.fornecedorId === id; })
    .sort(function(a, b) { return (b.dataAgendada||'') < (a.dataAgendada||'') ? -1 : 1; })
    .slice(0, 6);

  var nomesDia = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  var diasTexto = (f.diasSemana || []).map(function(d) { return nomesDia[d]; }).join(', ') || '-';

  var historico = visitasDoFornecedor.map(function(v) {
    var duracao = '-';
    if (v.checkInEm && v.checkOutEm) {
      var ini = v.checkInEm.toDate ? v.checkInEm.toDate() : new Date(v.checkInEm);
      var fim = v.checkOutEm.toDate ? v.checkOutEm.toDate() : new Date(v.checkOutEm);
      duracao = Math.round((fim - ini) / 60000) + ' min';
    }
    return '<div style="padding:8px 0;border-bottom:1px solid var(--gray2);font-size:12px">'
      + '<div style="font-weight:700">' + (v.dataAgendada||'-') + ' · ' + labelStatusVisita(v.status) + '</div>'
      + '<div style="color:var(--t3)">' + (v.lojaNome||'-') + ' · ' + (v.promotorNome||'-') + ' · Duração: ' + duracao + '</div></div>';
  }).join('') || '<div class="empty">Sem visitas registradas ainda.</div>';

  document.getElementById('drawer-fornecedor-conteudo').innerHTML =
    '<div style="font-family:\'Plus Jakarta Sans\',sans-serif;font-size:18px;font-weight:700;margin-bottom:4px">' + f.nome + '</div>'
    + '<div style="font-size:12px;color:var(--t3);margin-bottom:16px">' + (f.telefone||'sem telefone') + (f.email ? ' · ' + f.email : '') + '</div>'
    + '<div style="background:#f8f9fa;border-radius:10px;padding:12px;margin-bottom:16px;font-size:12px">'
    + '<div><strong>Lojas:</strong> ' + (f.lojas||[]).join(', ') + '</div>'
    + '<div><strong>Dias esperados:</strong> ' + diasTexto + '</div>'
    + '<div><strong>Periodicidade:</strong> ' + (f.periodicidade || '-') + '</div></div>'
    + '<div style="font-weight:700;font-size:13px;margin-bottom:8px">Últimas visitas</div>'
    + historico;

  document.getElementById('drawer-fornecedor-bg').style.display = 'block';
  document.getElementById('drawer-fornecedor').style.display = 'block';
}

function fecharDrawerFornecedor() {
  document.getElementById('drawer-fornecedor-bg').style.display = 'none';
  document.getElementById('drawer-fornecedor').style.display = 'none';
}

function renderRankingsPromotores() {
  var realizadas = S_PROM.visitas.filter(function(v) { return v.status === 'realizada'; });

  // Pontualidade por promotor
  var porPromotor = {};
  realizadas.forEach(function(v) {
    var p = calcPontualidade(v);
    if (!p) return;
    var chave = v.promotorNome || '-';
    if (!porPromotor[chave]) porPromotor[chave] = {total: 0, pontual: 0};
    porPromotor[chave].total++;
    if (p === 'pontual' || p === 'antecipado') porPromotor[chave].pontual++;
  });
  var rankPromotor = Object.keys(porPromotor).map(function(nome) {
    return {nome: nome, pct: Math.round((porPromotor[nome].pontual / porPromotor[nome].total) * 100)};
  }).sort(function(a, b) { return b.pct - a.pct; }).slice(0, 5);

  // Tempo médio em loja
  var temposPorPromotor = {};
  realizadas.forEach(function(v) {
    if (!v.checkInEm || !v.checkOutEm) return;
    var ini = v.checkInEm.toDate ? v.checkInEm.toDate() : new Date(v.checkInEm);
    var fim = v.checkOutEm.toDate ? v.checkOutEm.toDate() : new Date(v.checkOutEm);
    var min = (fim - ini) / 60000;
    var chave = v.promotorNome || '-';
    if (!temposPorPromotor[chave]) temposPorPromotor[chave] = [];
    temposPorPromotor[chave].push(min);
  });
  var rankTempo = Object.keys(temposPorPromotor).map(function(nome) {
    var lista = temposPorPromotor[nome];
    var media = lista.reduce(function(a, b) { return a + b; }, 0) / lista.length;
    return {nome: nome, media: Math.round(media)};
  }).sort(function(a, b) { return b.media - a.media; }).slice(0, 5);

  // Cumprimento por fornecedor
  var porFornecedor = {};
  S_PROM.visitas.forEach(function(v) {
    var chave = v.fornecedorNome || '-';
    if (!porFornecedor[chave]) porFornecedor[chave] = {total: 0, realizadas: 0};
    porFornecedor[chave].total++;
    if (v.status === 'realizada') porFornecedor[chave].realizadas++;
  });
  var rankFornecedor = Object.keys(porFornecedor).map(function(nome) {
    return {nome: nome, pct: Math.round((porFornecedor[nome].realizadas / porFornecedor[nome].total) * 100)};
  }).sort(function(a, b) { return b.pct - a.pct; }).slice(0, 5);

  function bloco(titulo, itens, sufixo) {
    var linhas = itens.map(function(it, i) {
      var valor = sufixo === '%' ? it.pct + '%' : it.media + ' min';
      return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--gray2);font-size:12px">'
        + '<span>' + (i+1) + '. ' + it.nome + '</span><strong>' + valor + '</strong></div>';
    }).join('') || '<div class="empty" style="font-size:12px">Sem dados ainda.</div>';
    return '<div class="card" style="padding:14px"><div style="font-weight:700;font-size:13px;margin-bottom:8px">' + titulo + '</div>' + linhas + '</div>';
  }

  document.getElementById('promotores-rankings').innerHTML =
    bloco('Ranking de Pontualidade', rankPromotor, '%')
    + bloco('Tempo Médio em Loja', rankTempo, 'min')
    + bloco('Cumprimento por Fornecedor', rankFornecedor, '%');
}
```

- [ ] **Step 3: Verificar manualmente**

Com fornecedores e visitas de teste (algumas `realizada` com `checkInEm`/`checkOutEm` preenchidos), rodar `renderPromotoresPainel()`. Confirmar que os 3 blocos de ranking aparecem com dados. Clicar "Ver" num fornecedor da lista, confirmar que o drawer abre pela direita com contato, lojas, dias, periodicidade e até 6 últimas visitas. Clicar fora do drawer (no fundo escuro), confirmar que fecha.

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "feat: drawer de fornecedor e rankings de pontualidade/cumprimento"
```

---

### Task 8: Grade de QR codes por loja

**Files:**
- Modify: `app.js` (`renderQrGridLojas`, reaproveita `abrirQrFornecedor` renomeada)

**Interfaces:**
- Consumes: `getLojasUnicas()` (Task 2), `qrcode-generator.min.js` (já carregado em `index.html`), container `#promotores-qr-grid` (Task 4), modal `#modal-qr` (Task 4).
- Produces: URL do modo convidado, consumida pela Task 9.

- [ ] **Step 1: Substituir `abrirQrFornecedor` por `renderQrGridLojas`/`abrirQrLoja`, em `app.js`**

Localizar `abrirQrFornecedor` (função antiga que gerava QR por fornecedor) e substituir por:

```js
function renderQrGridLojas() {
  var lojas = getLojasUnicas(S_PROM.fornecedores);
  var wrap = document.getElementById('promotores-qr-grid');
  if (!lojas.length) { wrap.innerHTML = '<div class="empty">Cadastre um fornecedor com loja pra gerar QR codes.</div>'; return; }
  wrap.innerHTML = lojas.map(function(lojaId) {
    return '<div class="card" style="padding:14px;text-align:center">'
      + '<div style="font-size:12px;font-weight:700;margin-bottom:8px">Loja ' + lojaId + '</div>'
      + '<button class="btn btn-s btn-sm" style="width:100%" onclick="abrirQrLoja(\'' + lojaId + '\')">Ver / Imprimir</button></div>';
  }).join('');
}

function abrirQrLoja(lojaId) {
  var url = location.origin + location.pathname + '?checkin=1&c=' + S.clienteConfig.id + '&l=' + lojaId;
  var qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  document.getElementById('qr-container').innerHTML = qr.createSvgTag(5) + '<div style="font-size:11px;color:var(--t3);margin-top:8px;word-break:break-all">' + url + '</div>';
  document.getElementById('modal-qr').style.display = 'flex';
}
```

- [ ] **Step 2: Verificar manualmente**

Com fornecedores cadastrados em lojas "1" e "2" (Task 3), rodar `renderPromotoresPainel()`. Confirmar que a grade de QR mostra 2 cards ("Loja 1", "Loja 2"), sem duplicar mesmo se mais de um fornecedor atender a mesma loja. Clicar "Ver / Imprimir" num deles, confirmar que abre um QR code válido apontando pra `<origem>/?checkin=1&c=<clienteId>&l=1` (escanear com o celular pra conferir o link, mesmo que a página ainda não trate `checkin=1` — isso é da Task 9).

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: grade de QR codes por loja (aponta pro futuro modo convidado)"
```

---

### Task 9: Check-in como convidado embutido no PWA

**Files:**
- Modify: `index.html` (novo container `#checkin-guest-overlay`)
- Modify: `app.js` (nova IIFE de detecção + funções `_getGuestAuth`, `_iniciarCheckinConvidado` e afins, logo depois do bloco "Verificação de modo anônimo / privado", linha ~24)
- Delete: `public/checkin.html`

**Interfaces:**
- Consumes: `location.search` (parâmetros `checkin`, `c`, `l`), `db` (Firestore da app principal — leitura de fornecedores/loja não precisa de instância separada, só a escrita/autenticação do convidado usa a secundária).
- Produces: nenhuma interface nova pra outras tasks — é o fim da cadeia (consome a URL gerada na Task 8).

Este modo roda numa **instância Firebase secundária** (mesmo padrão de `_getSecondaryAuth()`, já usado em `migrarFirebaseAuth`) pra nunca interferir com uma sessão real já logada no mesmo navegador (ex.: tablet da loja com admin logado, promotor abre o link de check-in no mesmo aparelho).

- [ ] **Step 1: Adicionar o container do overlay em `index.html`, logo no início do `<body>` (antes de `loginScreen`)**

```html
<div id="checkin-guest-overlay" style="display:none"></div>
```

- [ ] **Step 2: Adicionar a detecção + fluxo completo em `app.js`, logo depois do bloco de "Verificação de modo anônimo / privado" (depois da linha ~103, onde termina aquela IIFE)**

```js
// ── Check-in de promotor como convidado (QR das lojas) ─────────────────────
(function() {
  var params = new URLSearchParams(location.search);
  if (params.get('checkin') !== '1') return;

  var CLIENTE_ID = params.get('c') || '';
  var LOJA_ID = params.get('l') || '';
  var overlay = document.getElementById('checkin-guest-overlay');
  overlay.style.cssText = 'display:flex;position:fixed;inset:0;z-index:999999;background:#F5F6F8;align-items:center;justify-content:center;padding:20px;font-family:\'Segoe UI\',sans-serif';
  overlay.innerHTML = '<div class="card" id="cg-card" style="background:#fff;border-radius:16px;padding:28px 24px;max-width:400px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.08)">'
    + '<div id="cg-titulo" style="font-size:20px;font-weight:800;margin-bottom:4px">Carregando...</div>'
    + '<div id="cg-sub" style="font-size:13px;color:#6b7280;margin-bottom:20px"></div>'
    + '<div id="cg-erro" style="display:none;font-size:13px;padding:12px;border-radius:10px;margin-bottom:16px;background:#fee2e2;color:#991b1b"></div>'
    + '</div>';

  function cgErro(msg) {
    var el = document.getElementById('cg-erro');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function getGuestAuth() {
    try { return firebase.app('promotorCheckin').auth(); }
    catch(e) { return firebase.initializeApp(_fbAuthConfig, 'promotorCheckin').auth(); }
  }

  if (!CLIENTE_ID || !LOJA_ID) { cgErro('Link inválido — faltam parâmetros na URL.'); return; }

  var guestAuth = getGuestAuth();
  var guestUid = null;
  var fornecedoresDaLoja = [];
  var visitaAbertaId = null;
  var visitaAgendadaId = null;

  guestAuth.signInAnonymously().then(function(cred) {
    guestUid = cred.user.uid;
    return db.collection('clientes').doc(CLIENTE_ID).get();
  }).then(function(doc) {
    var nome = doc.exists ? (doc.data().nome || CLIENTE_ID) : CLIENTE_ID;
    document.getElementById('cg-titulo').textContent = nome;
    document.getElementById('cg-sub').textContent = 'Loja: ' + LOJA_ID;
    return db.collection('clientes').doc(CLIENTE_ID).collection('fornecedores')
      .where('lojas', 'array-contains', LOJA_ID).where('ativo', '==', true).get();
  }).then(function(snap) {
    fornecedoresDaLoja = snap.docs.map(function(d) { return Object.assign({id: d.id}, d.data()); });
    return verificarVisita();
  }).catch(function(e) { cgErro('Erro ao iniciar: ' + e.message); });

  function verificarVisita() {
    var col = db.collection('clientes').doc(CLIENTE_ID).collection('promotor_visitas');
    return col.where('sessionUid', '==', guestUid).where('checkOutEm', '==', null).limit(1).get()
      .then(function(snap) {
        if (!snap.empty) {
          visitaAbertaId = snap.docs[0].id;
          renderCheckout(snap.docs[0].data());
          return;
        }
        var hoje = getLocalDate();
        return col.where('lojaId', '==', LOJA_ID).where('status', '==', 'agendada').where('dataAgendada', '==', hoje).get();
      }).then(function(snapAgendadas) {
        if (visitaAbertaId) return;
        if (snapAgendadas && !snapAgendadas.empty) {
          visitaAgendadaId = snapAgendadas.docs[0].id;
        }
        renderCheckin();
      });
  }

  function renderCheckin() {
    var card = document.getElementById('cg-card');
    var opcoes = fornecedoresDaLoja.map(function(f) { return '<option value="' + f.id + '">' + f.nome + '</option>'; }).join('');
    if (!opcoes) {
      card.innerHTML += '<div style="font-size:13px;padding:12px;border-radius:10px;background:#fee2e2;color:#991b1b">Nenhum fornecedor cadastrado pra essa loja ainda. Fale com o administrador.</div>';
      return;
    }
    card.innerHTML +=
      '<label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;text-transform:uppercase">Fornecedor</label>'
      + '<select id="cg-fornecedor" style="width:100%;padding:12px;border:1px solid #d1d5db;border-radius:10px;font-size:15px;margin-bottom:16px"><option value="">Selecione...</option>' + opcoes + '</select>'
      + '<label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;text-transform:uppercase">Seu nome</label>'
      + '<input id="cg-nome" placeholder="Nome completo" style="width:100%;padding:12px;border:1px solid #d1d5db;border-radius:10px;font-size:15px;margin-bottom:16px">'
      + '<button id="cg-btn" style="width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;background:#FFC600;color:#111">Registrar entrada</button>';
    document.getElementById('cg-btn').onclick = fazerCheckin;
  }

  function fazerCheckin() {
    var fornecedorId = document.getElementById('cg-fornecedor').value;
    var nome = document.getElementById('cg-nome').value.trim();
    if (!fornecedorId) { cgErro('Selecione o fornecedor.'); return; }
    if (!nome) { cgErro('Informe seu nome.'); return; }
    var fornecedor = fornecedoresDaLoja.filter(function(f) { return f.id === fornecedorId; })[0];
    var btn = document.getElementById('cg-btn');
    btn.disabled = true; btn.textContent = 'Registrando...';

    function gravar(geo) {
      var col = db.collection('clientes').doc(CLIENTE_ID).collection('promotor_visitas');
      var dados = {
        checkInEm: firebase.firestore.FieldValue.serverTimestamp(),
        checkInGeo: geo,
        sessionUid: guestUid,
        status: 'na_loja'
      };
      var op;
      if (visitaAgendadaId) {
        op = col.doc(visitaAgendadaId).update(dados);
      } else {
        op = col.add(Object.assign({
          fornecedorId: fornecedorId,
          fornecedorNome: fornecedor.nome,
          lojaId: LOJA_ID,
          lojaNome: LOJA_ID,
          promotorNome: nome,
          promotorTelefone: null,
          dataAgendada: getLocalDate(),
          horaAgendada: null,
          checkOutEm: null,
          checkOutGeo: null
        }, dados));
      }
      op.then(function(ref) {
        visitaAbertaId = visitaAgendadaId || (ref && ref.id);
        verificarVisita();
      }).catch(function(e) {
        btn.disabled = false; btn.textContent = 'Registrar entrada';
        cgErro('Erro ao registrar: ' + e.message);
      });
    }

    if (!navigator.geolocation) { gravar(null); return; }
    navigator.geolocation.getCurrentPosition(
      function(pos) { gravar({lat: pos.coords.latitude, lng: pos.coords.longitude}); },
      function() { gravar(null); },
      {timeout: 5000}
    );
  }

  function renderCheckout(visita) {
    var card = document.getElementById('cg-card');
    var hora = visita.checkInEm && visita.checkInEm.toDate ? visita.checkInEm.toDate().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : '';
    card.innerHTML +=
      '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;margin-bottom:16px"><b style="display:block;font-size:16px;margin-bottom:4px">Você está em: ' + visita.lojaNome + '</b>Fornecedor: ' + visita.fornecedorNome + '<br>Entrada às ' + hora + '</div>'
      + '<button id="cg-btn-out" style="width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;background:#FFC600;color:#111">Registrar saída</button>';
    document.getElementById('cg-btn-out').onclick = fazerCheckout;
  }

  function fazerCheckout() {
    var btn = document.getElementById('cg-btn-out');
    btn.disabled = true; btn.textContent = 'Registrando...';
    function gravar(geo) {
      db.collection('clientes').doc(CLIENTE_ID).collection('promotor_visitas').doc(visitaAbertaId).update({
        checkOutEm: firebase.firestore.FieldValue.serverTimestamp(),
        checkOutGeo: geo,
        status: 'realizada'
      }).then(function() {
        document.getElementById('cg-card').innerHTML = '<div style="font-size:20px;font-weight:800;margin-bottom:4px">✅ Saída registrada</div><div style="font-size:13px;color:#6b7280">Obrigado! Você já pode fechar essa página.</div>';
      }).catch(function(e) {
        btn.disabled = false; btn.textContent = 'Registrar saída';
        cgErro('Erro ao registrar: ' + e.message);
      });
    }
    if (!navigator.geolocation) { gravar(null); return; }
    navigator.geolocation.getCurrentPosition(
      function(pos) { gravar({lat: pos.coords.latitude, lng: pos.coords.longitude}); },
      function() { gravar(null); },
      {timeout: 5000}
    );
  }
})();
```

`_fbAuthConfig` já existe no arquivo (usado por `_getSecondaryAuth`, linha ~6560) — não precisa redeclarar.

- [ ] **Step 3: Remover `public/checkin.html`**

```bash
git rm public/checkin.html
```

- [ ] **Step 4: Verificar manualmente**

Com um fornecedor cadastrado na loja "1" (Task 3), abrir `index.html?checkin=1&c=fluxocerto&l=1` numa aba anônima do navegador (simula um celular sem sessão). Confirmar: overlay cobre a tela inteira, título vira o nome do cliente, aparece o formulário de check-in. Selecionar fornecedor, digitar nome, clicar "Registrar entrada" — navegador deve pedir localização. Confirmar no Firestore Console que um documento novo apareceu em `promotor_visitas` com `status:'na_loja'`, `sessionUid` preenchido. **Sem fechar a aba**, recarregar a mesma URL — deve pular direto pra tela de check-out. Clicar "Registrar saída", confirmar `status:'realizada'` e `checkOutEm` preenchido no Firestore.

Testar o caminho de visita agendada: criar manualmente uma visita com `status:'agendada'`, `lojaId:'1'`, `dataAgendada` de hoje pelo Firestore Console, depois abrir o mesmo link de check-in numa aba nova (sessão anônima diferente) — confirmar que o check-in **atualiza esse documento existente** (mesmo `id`) em vez de criar um novo.

Testar isolamento de sessão: logar como admin normalmente numa aba, abrir `?checkin=1&c=...&l=...` **na mesma aba** (trocando a URL) — confirmar que a sessão do admin continua intacta (reabrir a URL sem `?checkin=1` deve manter o admin logado, sem pedir login de novo).

- [ ] **Step 5: Commit**

```bash
git add index.html app.js
git commit -m "feat: check-in de promotor como convidado embutido no PWA, remove checkin.html"
```

---

### Task 10: Ativar o módulo — capa, sidebar, roteamento e BUILD

**Files:**
- Modify: `app.js:999` (`CAPA_MODULOS`, entrada `promotores`)
- Modify: `app.js:1703` (`setupRole`)
- Modify: `app.js` (função `nav()`, bloco `if (page==='central')`, linha ~1836)
- Modify: `app.js` (linhas 9552, 9748, 9805 — três ocorrências de `MODS_LABEL`)
- Modify: `app.js:2`, `sw.js` (`CACHE_NAME` e lista de arquivos), `index.html` (`app.js?v=`, `style.css?v=`), `version.json`

**Interfaces:**
- Consumes: `renderPromotoresPainel()` (Task 4).

- [ ] **Step 1: Atualizar a entrada `promotores` em `CAPA_MODULOS`**

Trocar (linha 999):
```js
  { id:'promotores', label:'Promotores', desenvolvido:false,
    icone:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
```
por:
```js
  { id:'promotores', label:'Promotores', desenvolvido:true, moduloChave:'promotores',
    roleOk: function(){ return S.role==='admin' || S.role==='supervisor'; },
    page: function(){ return 'promotores'; },
    icone:'<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
```

- [ ] **Step 2: Ligar a visibilidade do item de sidebar em `setupRole`**

Trocar (linha 1703):
```js
  show('nav-embreve-promotores', mostrarEmBreve);
```
por:
```js
  show('nav-promotores', (isAdmin || isSup) && _moduloAtivo('promotores'));
```

(`isAdmin`/`isSup` já existem como variáveis locais em `setupRole` — mesmo padrão usado por `nav-central` algumas linhas acima; conferir o nome exato das variáveis lendo o entorno de `setupRole` antes de aplicar, caso tenham sido renomeadas desde a Task 8 do plano v1.)

- [ ] **Step 3: Adicionar `promotores` no roteamento de `nav()`**

Logo depois do bloco `if (page==='central') { ... }` (linha ~1836), adicionar:
```js
  if (page === 'promotores') {
    renderPromotoresPainel();
  }
```

- [ ] **Step 4: Adicionar `promotores:'Promotores'` nas três ocorrências de `MODS_LABEL`**

Linhas 9552, 9748, 9805 — em cada uma, adicionar `,promotores:'Promotores'` ao final do objeto literal (antes do `}`).

- [ ] **Step 5: Bump de BUILD nos 4 lugares**

```js
// app.js linha 2
var BUILD = '346';
```
```js
// sw.js — CACHE_NAME e lista de arquivos versionados
var CACHE_NAME = 'cahu360-v346';
// (e as entradas './app.js?v=346', './style.css?v=346' na lista de arquivos do SW)
```
```html
<!-- index.html -->
<script src="app.js?v=346" defer></script>
<link rel="stylesheet" href="style.css?v=346"/>
```
```json
{"build":"346"}
```

- [ ] **Step 6: Verificar manualmente — fluxo completo**

Logar como admin no tenant `fluxocerto`. Confirmar que o card "Promotores" na capa mobile aparece vivo (não mais "Em breve") e o item "Promotores" aparece no sidebar desktop. Clicar nele, confirmar que abre o painel completo (KPIs, filtros, tabela, fornecedores, QR, rankings). Repetir o fluxo de ponta a ponta: cadastrar fornecedor → agendar visita → escanear/abrir o QR da loja numa aba anônima → check-in → check-out → voltar pro painel logado e confirmar que a visita aparece como "Realizada" com pontualidade calculada.

Logar como Gerência ou Coletor, confirmar que o card/sidebar de Promotores não aparece (fora do `roleOk`).

Testar em cliente Bar do Cachorro (ou outro tenant de teste) que **não** tenha `modulos.promotores` habilitado no `clienteConfig` — confirmar que o card aparece com cadeado (upsell), não vivo.

- [ ] **Step 7: Commit**

```bash
git add app.js sw.js index.html version.json
git commit -m "feat: ativa o módulo Promotores v2 na capa e sidebar, bump de BUILD"
```

---

## Self-review notes

- Cobertura da spec (`2026-09-10-modulo-promotores-v2-design.md`): seção 3 (modelo de dados) → Tasks 1-2; seção 4 (check-in convidado) → Task 9 (com refinamento: instância Firebase secundária em vez de reusar a principal, decidido durante o plano pra não arriscar a sessão logada real — não estava explícito na spec, mas segue a mesma intenção de isolamento dela); seção 5 (painel completo: KPIs, filtros, tabela, agendamento, agenda semanal, drawer, rankings, QR) → Tasks 4-8; seção 6 (acesso) → Task 10; seção 7 (herança do v1) → `firestore.rules`/`qrcode-generator.min.js` mantidos e estendidos (Task 1, Task 8), `checkin.html` removido (Task 9), CRUD de fornecedores estendido (Task 3), abas simples substituídas (Task 4).
- Placeholder scan: nenhum "TBD"/"TODO" — todos os steps têm código completo e comandos de verificação com resultado esperado explícito.
- Consistência de nomes: `visitasCol()`, `STATUS_VISITA`, `labelStatusVisita()`, `calcPontualidade()`, `getLojasUnicas()` (Task 2) usados sem variação de nome em todas as tasks seguintes; `S_PROM` é o único estado compartilhado do painel, populado só em `renderPromotoresPainel()` (Task 4) e lido por Tasks 5-8.
- Risco não coberto por task própria (aceito, registrado na spec): `sessionUid` preso ao navegador quebra o check-out se o promotor trocar de aparelho no meio da visita — mitigação é o Admin fechar manualmente pela tabela, já possível via Update #3 das regras (Task 1), mas não foi criado um botão dedicado "Fechar manualmente" na tabela — avaliar se vira necessidade real depois do uso em produção antes de adicionar.
