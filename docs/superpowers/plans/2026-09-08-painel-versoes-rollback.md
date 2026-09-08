# Painel de Clientes — Histórico de Versões e Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No Painel de Clientes (app.js), dar ao Tiago um jeito de ver as últimas 3 versões publicadas em cada cliente, ler o que mudou em cada uma, e reverter pra uma delas com um clique.

**Architecture:** Não cria nenhum armazenamento novo de versões — o histórico de commits dos repos do GitHub já é o histórico de deploys (cada deploy vira 1 commit `Auto-deploy ...` no repo do cliente). A leitura é feita direto do navegador via API do GitHub (mesmo padrão de autenticação com token já usado em `deployCliente`/`_pollWorkflow`). O rollback em si roda numa GitHub Action nova (`rollback.yml`), disparada via `repository_dispatch`, que faz checkout de um commit antigo do próprio repo do cliente e publica um commit novo por cima — nunca reescreve/força histórico.

**Tech Stack:** JavaScript vanilla (sem framework), Firebase Firestore (Web SDK v8, API antiga `firebase.firestore()`/`db.collection()`), GitHub REST API (`api.github.com` + `raw.githubusercontent.com`), GitHub Actions (`repository_dispatch`).

## Global Constraints

- Repo: `fc360oficial/fluxocerto360` (clonado localmente em `/c/tmp/fc360-explore` nesta sessão — em outra sessão, clonar de novo com `git clone https://github.com/fc360oficial/fluxocerto360.git`).
- Todo o código novo de front-end vai dentro de `app.js` (arquivo único, ~10600 linhas) — o projeto não usa módulos/bundler, é convenção deliberada, não introduzir arquivo novo de JS.
- Toda vez que `app.js` for modificado, subir `var BUILD` (linha 2) em `+1` no mesmo commit — convenção já usada em 100% do histórico recente do arquivo (confirmado com `git log -L 2,2:app.js`). BUILD atual no momento deste plano: `345`. Cada task abaixo que mexe em `app.js` já diz pra qual número subir.
- Projeto não tem framework de testes automatizado (`package.json` não tem `jest`/`mocha`/`vitest`, sem pasta `tests/`). Onde a lógica é pura (sem `document`/`fetch`/Firebase), o teste é um script Node standalone descartável. Onde depende de DOM/rede real, o teste é manual no navegador — mesmo padrão que a seção "Teste manual" do spec já assume.
- Estilo de código existente: `var` (não `let`/`const`), funções `function(){}` (não arrow functions), HTML montado por concatenação de string (não template literals na maioria do arquivo — mas `+'...'+` é o padrão dominante, seguir isso), `Promise.all(arr.map(function(x){...}))` pra chamadas paralelas (já usado 16x no arquivo), modais no padrão `position:fixed;inset:0;background:rgba(0,0,0,.5)` com `onclick="if(event.target===this)this.remove()"` pra fechar clicando fora.
- Nunca embutir o token do GitHub (`config/superadmin.githubToken`) em atributo `onclick=""` renderizado no HTML (fica visível no DOM) — sempre buscar via closure/fetch novo dentro da função que precisa dele, como o código existente já faz em `deployCliente`.
- Push para o repo já funciona sem configuração extra nesta máquina (testado: commit da spec já foi pushado com sucesso pro `main` de `fc360oficial/fluxocerto360`).

---

### Task 1: GitHub Action de rollback + setup nos repos existentes

**Files:**
- Create: `.github/workflows/rollback.yml` (neste repo base)
- Nenhum arquivo de `app.js` é tocado nesta task.

**Interfaces:**
- Produces: um workflow que aceita `repository_dispatch` tipo `rollback` com `client_payload: { sha: "<commit sha do próprio repo do cliente>" }`, e ao terminar deixa a `main` do repo do cliente com os arquivos daquele `sha` (exceto `client.js` e `.github/`), publicado por um commit novo. As tasks 5 depende deste workflow existir tanto no repo base quanto no(s) repo(s) de cliente.

- [ ] **Step 1: Criar o workflow no repo base**

Criar `.github/workflows/rollback.yml`:

```yaml
name: Rollback to previous version
on:
  repository_dispatch:
    types: [rollback]
jobs:
  rollback:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fetch-depth: 0
      - name: Backup client identity
        run: cp client.js /tmp/client_backup.js
      - name: Checkout old commit from this repo's own history
        run: |
          git checkout ${{ github.event.client_payload.sha }} -- .
          git checkout HEAD -- .github/
      - name: Restore client identity and push
        run: |
          cp /tmp/client_backup.js client.js
          git add -A
          git config user.email "deploy@fluxocerto.com"
          git config user.name "FC360 Auto Deploy"
          git diff --staged --quiet || git commit -m "Rollback para build anterior ($(date '+%d/%m/%Y %H:%M'))"
          git push origin HEAD:main
```

- [ ] **Step 2: Commitar e subir**

```bash
git add .github/workflows/rollback.yml
git commit -m "feat: Action de rollback pro repo de cliente reverter pra um commit antigo"
git push origin main
```

- [ ] **Step 3: Descobrir o nome real do repo do cliente `economico`**

Este dado vive no Firestore (`config/repos`), não em nenhum arquivo local. No navegador, com o Painel de Clientes já aberto e logado (é a mesma sessão que já usa `db`/Firebase), abrir o Console do DevTools e rodar:

```js
db.collection('config').doc('repos').get().then(function(d){ console.log(d.data()); });
```

Anotar o valor da chave `economico` (ex: pode ser `fc360-economico` — confirmar o valor real antes de seguir, não assumir).

- [ ] **Step 4: Subir o mesmo workflow no repo do cliente `economico`**

Substituir `<repo-do-economico>` pelo nome real encontrado no Step 3:

```bash
cd /c/tmp
git clone https://github.com/fc360oficial/<repo-do-economico>.git fc360-economico-explore
cd fc360-economico-explore
mkdir -p .github/workflows
cp /c/tmp/fc360-explore/.github/workflows/rollback.yml .github/workflows/rollback.yml
git add .github/workflows/rollback.yml
git commit -m "feat: adiciona Action de rollback (mesma do repo base)"
git push origin main
```

- [ ] **Step 5: Verificar**

```bash
curl -s https://api.github.com/repos/fc360oficial/<repo-do-economico>/contents/.github/workflows/rollback.yml | grep '"name"'
```

Esperado: retorna JSON com `"name": "rollback.yml"` (confirma que o arquivo está lá). Se `curl` não estiver disponível, conferir direto em `github.com/fc360oficial/<repo-do-economico>/tree/main/.github/workflows`.

---

### Task 2: Helpers puros — extrair build de um patch e filtrar últimas versões

**Files:**
- Modify: `app.js` (adicionar as duas funções logo antes de `_atualizarVersaoClientes`, que hoje começa por volta da linha 9678 — usar o texto de `function _atualizarVersaoClientes() {` como âncora, não confiar cegamente no número de linha)
- Test: script Node descartável em `C:\Users\tiago\AppData\Local\Temp\claude\C--Users-tiago\180a81b1-47cd-472c-9d17-d98918e6701a\scratchpad\test-helpers-versoes.js` (ou o scratchpad válido da sessão que for executar — não faz parte do repo, é só pra validar a lógica antes de colar em `app.js`)

**Interfaces:**
- Produces: `_extrairBuildDoPatch(patch)` → `{antes: string, depois: string}` ou `null`. `_filtrarUltimasVersoes(commits, limite)` → array de `{sha, mensagem, data}`, no máximo `limite` itens (padrão 3), na mesma ordem que veio em `commits` (GitHub API já devolve mais novo primeiro).
- Consumes: nada de outras tasks. `commits` é o formato cru devolvido por `GET /repos/{org}/{repo}/commits` (cada item tem `.sha`, `.commit.message`, `.commit.author.date`).
- As tasks 3 e 4 dependem dessas duas funções existirem em `app.js` com essa assinatura exata.

- [ ] **Step 1: Escrever as funções + asserts num script Node solto**

Criar `test-helpers-versoes.js` no scratchpad:

```js
function _extrairBuildDoPatch(patch) {
  if (!patch) return null;
  var antes = patch.match(/^-var BUILD = '(\d+)';/m);
  var depois = patch.match(/^\+var BUILD = '(\d+)';/m);
  if (!antes || !depois) return null;
  return { antes: antes[1], depois: depois[1] };
}

function _filtrarUltimasVersoes(commits, limite) {
  var n = limite || 3;
  return (commits || []).filter(function(c) {
    var msg = (c.commit && c.commit.message) || '';
    return msg.indexOf('Auto-deploy') === 0 || msg.indexOf('Rollback para build') === 0;
  }).slice(0, n).map(function(c) {
    return { sha: c.sha, mensagem: c.commit.message, data: c.commit.author.date };
  });
}

// --- asserts ---
function assertEqual(atual, esperado, nome) {
  var a = JSON.stringify(atual), e = JSON.stringify(esperado);
  if (a !== e) { console.error('FALHOU: '+nome+'\n  esperado: '+e+'\n  atual:    '+a); process.exitCode = 1; }
  else console.log('OK: '+nome);
}

var patchComBump = "@@ -1,3 +1,3 @@\n-var BUILD = '344';\n+var BUILD = '345';\n var ETIQUETAS_API_URL = 'x';";
assertEqual(_extrairBuildDoPatch(patchComBump), { antes: '344', depois: '345' }, 'extrai bump normal');
assertEqual(_extrairBuildDoPatch("@@ -1 +1 @@\n-var X = 1;\n+var X = 2;"), null, 'patch sem BUILD retorna null');
assertEqual(_extrairBuildDoPatch(null), null, 'patch vazio retorna null');

var commitsFake = [
  { sha: 'aaa', commit: { message: 'Auto-deploy 08/09/2026 10:00', author: { date: '2026-09-08T13:00:00Z' } } },
  { sha: 'bbb', commit: { message: 'Merge branch x', author: { date: '2026-09-07T10:00:00Z' } } },
  { sha: 'ccc', commit: { message: 'Rollback para build 340 (07/09/2026 09:00)', author: { date: '2026-09-06T09:00:00Z' } } },
  { sha: 'ddd', commit: { message: 'Auto-deploy 05/09/2026 08:00', author: { date: '2026-09-05T08:00:00Z' } } },
  { sha: 'eee', commit: { message: 'Auto-deploy 01/09/2026 08:00', author: { date: '2026-09-01T08:00:00Z' } } }
];
assertEqual(_filtrarUltimasVersoes(commitsFake, 3), [
  { sha: 'aaa', mensagem: 'Auto-deploy 08/09/2026 10:00', data: '2026-09-08T13:00:00Z' },
  { sha: 'ccc', mensagem: 'Rollback para build 340 (07/09/2026 09:00)', data: '2026-09-06T09:00:00Z' },
  { sha: 'ddd', mensagem: 'Auto-deploy 05/09/2026 08:00', data: '2026-09-05T08:00:00Z' }
], 'filtra e limita a 3, ignora commit Merge, aceita Rollback');
assertEqual(_filtrarUltimasVersoes([], 3), [], 'lista vazia retorna vazio');
```

- [ ] **Step 2: Rodar e confirmar que passa**

Run: `node test-helpers-versoes.js`
Expected: 4 linhas `OK: ...`, nenhuma linha `FALHOU`, exit code 0.

- [ ] **Step 3: Colar as duas funções em `app.js`**

Abrir `app.js`, localizar:

```js
function _atualizarVersaoClientes() {
```

Inserir imediatamente **antes** dessa linha (mantendo a função original intacta logo depois):

```js
function _extrairBuildDoPatch(patch) {
  if (!patch) return null;
  var antes = patch.match(/^-var BUILD = '(\d+)';/m);
  var depois = patch.match(/^\+var BUILD = '(\d+)';/m);
  if (!antes || !depois) return null;
  return { antes: antes[1], depois: depois[1] };
}

function _filtrarUltimasVersoes(commits, limite) {
  var n = limite || 3;
  return (commits || []).filter(function(c) {
    var msg = (c.commit && c.commit.message) || '';
    return msg.indexOf('Auto-deploy') === 0 || msg.indexOf('Rollback para build') === 0;
  }).slice(0, n).map(function(c) {
    return { sha: c.sha, mensagem: c.commit.message, data: c.commit.author.date };
  });
}

```

- [ ] **Step 4: Bump de BUILD e commit**

Em `app.js` linha 2, trocar:
```js
var BUILD = '345';
```
por:
```js
var BUILD = '346';
```

```bash
git add app.js
git commit -m "feat: helpers puros pra ler histórico de versões (extrair build de patch, filtrar deploys)"
git push origin main
```

Apagar o script solto do scratchpad (não faz parte do repo, só serviu pra validar antes de colar):
```bash
rm test-helpers-versoes.js
```

---

### Task 3: Botão "Versões" no card + modal com a lista das últimas 3

**Files:**
- Modify: `app.js`, bloco de botões do card em `_renderClientesLista()` (âncora: linha com `onclick="deployCliente(\''+safeId+'\')">🚀 Deploy</button>`)
- Modify: `app.js`, nova função `abrirModalVersoes` + `_desenharLinhasVersoes` (colar logo depois de `cancelarToken`, âncora: linha `}).catch(function(e){ showToast('Erro: '+e.message); });` seguida de `}` que fecha `cancelarToken`)

**Interfaces:**
- Consumes: `_filtrarUltimasVersoes` (Task 2), `db`/`firebase` (Firestore já inicializado em outro lugar do arquivo), `showToast` (já existe).
- Produces: `abrirModalVersoes(clienteId)` (chamada pelo botão do card) e `_desenharLinhasVersoes(clienteId, org, repoName, versoes, builds, buildAoVivo)`. Os botões "Ver o que mudou" e "↩️ Reverter" dentro das linhas renderizadas por `_desenharLinhasVersoes` chamam `_toggleNotasVersao(sha, build, buildAnterior)` (Task 4) e `reverterVersaoCliente(clienteId, sha, build)` (Task 5) — essas duas ainda não existem depois desta task, então clicar nelas vai dar erro no console até as tasks 4/5 rodarem. Isso é esperado nesta task; o teste manual abaixo só valida a listagem, não os cliques.

- [ ] **Step 1: Adicionar o botão no card**

Em `_renderClientesLista()`, localizar:

```js
        '<button class="btn btn-sm" id="btn-deploy-'+safeId+'" style="background:#2d6a2d;color:#fff;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit" onclick="deployCliente(\''+safeId+'\')">🚀 Deploy</button>' +
        (c.id === 'fluxocerto' ? '' : (inativo
```

Trocar por (adiciona o botão de Versões logo antes do Deploy, escondido pro `fluxocerto` do mesmo jeito que Desativar/Excluir já são):

```js
        (c.id === 'fluxocerto' ? '' : '<button class="btn btn-sm" style="background:#fff;color:var(--t2);border:1.5px solid var(--gray2);padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit" onclick="abrirModalVersoes(\''+safeId+'\')">🕓 Versões</button>') +
        '<button class="btn btn-sm" id="btn-deploy-'+safeId+'" style="background:#2d6a2d;color:#fff;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit" onclick="deployCliente(\''+safeId+'\')">🚀 Deploy</button>' +
        (c.id === 'fluxocerto' ? '' : (inativo
```

- [ ] **Step 2: Adicionar `abrirModalVersoes` e `_desenharLinhasVersoes`**

Localizar o fim de `cancelarToken`:

```js
function cancelarToken(tokenId, clienteId) {
  if (!confirm('Cancelar este token?\n\nO cliente perderá o acesso no próximo login.')) return;
  var ontem = new Date(); ontem.setDate(ontem.getDate()-1);
  var ontemStr = ontem.toISOString().slice(0,10);
  // Atualiza cliente (crítico) e tenta marcar token (pode falhar se já foi excluído)
  db.collection('clientes').doc(clienteId).update({ validade: ontemStr }).then(function() {
    db.collection('tokens').doc(tokenId).update({ cancelado: true, canceladoEm: firebase.firestore.FieldValue.serverTimestamp() }).catch(function(){});
    var m = document.getElementById('modal-tokens'); if (m) m.remove();
    renderPainelClientes();
    showToast('🔒 Acesso revogado.');
  }).catch(function(e){ showToast('Erro: '+e.message); });
}
```

Inserir logo depois (antes do `_pollWorkflow` que vem em seguida):

```js
function abrirModalVersoes(clienteId) {
  var existing = document.getElementById('modal-versoes'); if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend',
    '<div id="modal-versoes" onclick="if(event.target===this)this.remove()" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px">'+
      '<div style="background:#fff;border-radius:16px;padding:24px;width:100%;max-width:480px;max-height:80vh;overflow-y:auto">'+
        '<div style="font-family:\'Plus Jakarta Sans\',sans-serif;font-size:16px;font-weight:800;margin-bottom:16px">Versões — '+clienteId+'</div>'+
        '<div id="versoes-lista">Carregando...</div>'+
        '<button onclick="document.getElementById(\'modal-versoes\').remove()" style="margin-top:16px;width:100%;padding:10px;background:var(--gray);border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer">Fechar</button>'+
      '</div></div>');

  db.collection('config').doc('superadmin').get({source:'server'}).then(function(doc) {
    var cfg = doc.data();
    var token = cfg.githubToken, org = cfg.githubOrg || 'fc360oficial';
    db.collection('config').doc('repos').get({source:'server'}).then(function(rDoc) {
      var repoName = (rDoc.data()||{})[clienteId];
      var listaEl = document.getElementById('versoes-lista');
      if (!repoName) { if (listaEl) listaEl.innerHTML = 'Repositório não configurado pra esse cliente.'; return; }
      fetch('https://api.github.com/repos/'+org+'/'+repoName+'/commits?sha=main&per_page=10', {
        headers: { Authorization: 'token '+token, Accept: 'application/vnd.github+json' }
      }).then(function(r) {
        if (!r.ok) throw new Error('GitHub '+r.status);
        return r.json();
      }).then(function(commits) {
        var versoes = _filtrarUltimasVersoes(commits, 3);
        if (versoes.length === 0) { if (listaEl) listaEl.innerHTML = 'Nenhuma versão publicada ainda.'; return; }
        return Promise.all(versoes.map(function(v) {
          return fetch('https://raw.githubusercontent.com/'+org+'/'+repoName+'/'+v.sha+'/version.json?t='+Date.now())
            .then(function(r){ return r.json(); })
            .then(function(data){ return data.build; })
            .catch(function(){ return '?'; });
        })).then(function(builds) {
          var verAoVivoEl = document.getElementById('ver-'+clienteId);
          var buildAoVivo = verAoVivoEl ? verAoVivoEl.textContent.replace('v','') : '';
          _desenharLinhasVersoes(clienteId, org, repoName, versoes, builds, buildAoVivo);
        });
      }).catch(function(e) {
        if (listaEl) listaEl.innerHTML = 'Erro ao buscar histórico: '+e.message;
      });
    });
  }).catch(function(e) {
    var listaEl = document.getElementById('versoes-lista');
    if (listaEl) listaEl.innerHTML = 'Erro: '+e.message;
  });
}

function _desenharLinhasVersoes(clienteId, org, repoName, versoes, builds, buildAoVivo) {
  var listaEl = document.getElementById('versoes-lista');
  if (!listaEl) return;
  var rows = versoes.map(function(v, i) {
    var build = builds[i];
    var buildAnterior = (i+1 < versoes.length) ? builds[i+1] : (parseInt(build,10)-1);
    var dataFmt = new Date(v.data).toLocaleString('pt-BR');
    var ehAtual = String(build) === String(buildAoVivo);
    return '<div style="padding:12px 0;border-bottom:1px solid var(--gray2)">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">'+
        '<div>'+
          '<div style="font-family:monospace;font-size:14px;font-weight:700">v'+build+'</div>'+
          '<div style="font-size:11px;color:var(--t2)">'+dataFmt+'</div>'+
        '</div>'+
        (ehAtual
          ? '<span style="font-size:11px;font-weight:700;color:#1a5c34;background:#d1f0e0;padding:3px 8px;border-radius:6px;white-space:nowrap">🟢 Publicada agora</span>'
          : '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
              '<button class="btn btn-sm" style="border:1.5px solid var(--gray2);background:#fff;padding:5px 10px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer" onclick="_toggleNotasVersao(\''+v.sha+'\',\''+build+'\',\''+buildAnterior+'\')">Ver o que mudou</button>'+
              '<button class="btn btn-sm" style="border:none;background:#b7500a;color:#fff;padding:5px 10px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer" onclick="reverterVersaoCliente(\''+clienteId+'\',\''+v.sha+'\',\''+build+'\')">↩️ Reverter</button>'+
            '</div>')+
      '</div>'+
      '<div id="notas-'+v.sha+'" style="display:none;margin-top:10px;padding:10px;background:var(--gray);border-radius:8px;font-size:12px;color:var(--t2);line-height:1.5"></div>'+
    '</div>';
  }).join('');
  listaEl.innerHTML = rows;
}
```

- [ ] **Step 3: Bump de BUILD e commit**

Em `app.js` linha 2, trocar `var BUILD = '346';` por `var BUILD = '347';`.

```bash
git add app.js
git commit -m "feat: botão Versões no card do cliente, modal lista as últimas 3 versões publicadas"
git push origin main
```

- [ ] **Step 4: Teste manual**

1. Abrir o Painel de Clientes no navegador (recarregar a página pra pegar o `app.js` novo, `Ctrl+Shift+R` se necessário).
2. No card "Econômico Supermercado", clicar em "🕓 Versões".
3. Confirmar: aparecem até 3 linhas com data/hora em português e `vXXX`, a mais recente marcada "🟢 Publicada agora" se bater com o badge VERSÃO do card.
4. Conferir manualmente no GitHub (`github.com/fc360oficial/<repo-do-economico>/commits/main`) que as datas/mensagens batem com os commits reais.
5. Ignorar por enquanto os botões "Ver o que mudou" e "↩️ Reverter" (ainda não implementados — clicar neles vai gerar erro no console, é esperado até a Task 4/5).

---

### Task 4: Notas de atualização (o que mudou em cada versão)

**Files:**
- Modify: `app.js`, novas funções `_toggleNotasVersao`, `_buscarNotasVersao`, `_coletarNotasNoIntervalo` + as duas constantes `BASE_REPO_ORG`/`BASE_REPO_NOME` (colar logo depois de `_desenharLinhasVersoes`, adicionada na Task 3)

**Interfaces:**
- Consumes: `_extrairBuildDoPatch` (Task 2), o atributo `id="notas-<sha>"` já renderizado por `_desenharLinhasVersoes` (Task 3), botão `onclick="_toggleNotasVersao(sha, build, buildAnterior)"` já renderizado na Task 3.
- Produces: `_toggleNotasVersao(sha, build, buildAnterior)`, cache em memória `_notasVersaoCache` (chave = build, valor = HTML já resolvido, evita rebuscar se o usuário fechar/reabrir o modal na mesma sessão).

- [ ] **Step 1: Adicionar as funções**

Colar logo depois do fechamento de `_desenharLinhasVersoes` (`}` final da Task 3):

```js
var BASE_REPO_ORG = 'fc360oficial';
var BASE_REPO_NOME = 'fluxocerto360';
var _notasVersaoCache = {};

function _toggleNotasVersao(sha, build, buildAnterior) {
  var el = document.getElementById('notas-'+sha);
  if (!el) return;
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  if (_notasVersaoCache[build]) { el.innerHTML = _notasVersaoCache[build]; return; }
  el.innerHTML = 'Buscando notas...';
  _buscarNotasVersao(buildAnterior, build).then(function(html) {
    _notasVersaoCache[build] = html;
    el.innerHTML = html;
  });
}

function _buscarNotasVersao(buildAnterior, buildAtual) {
  return db.collection('config').doc('superadmin').get({source:'server'}).then(function(doc) {
    var token = (doc.data()||{}).githubToken;
    var headers = { Authorization: 'token '+token, Accept: 'application/vnd.github+json' };
    return fetch('https://api.github.com/repos/'+BASE_REPO_ORG+'/'+BASE_REPO_NOME+'/commits?path=app.js&per_page=50', { headers: headers })
      .then(function(r) {
        if (!r.ok) throw new Error('GitHub '+r.status);
        return r.json();
      })
      .then(function(commits) {
        return _coletarNotasNoIntervalo(commits, 0, buildAnterior, buildAtual, headers);
      });
  }).then(function(notas) {
    if (notas.length === 0) {
      return 'Notas não disponíveis pra essa versão. <a href="https://github.com/'+BASE_REPO_ORG+'/'+BASE_REPO_NOME+'/commits/main" target="_blank" rel="noopener">Ver histórico completo no GitHub</a>.';
    }
    return '<ul style="margin:0;padding-left:18px">'+notas.map(function(n){ return '<li>'+n+'</li>'; }).join('')+'</ul>';
  }).catch(function(e) {
    return 'Erro ao buscar notas: '+e.message;
  });
}

// Percorre os commits do repo base (mais novo -> mais velho) buscando o patch de
// app.js em cada um, até achar todas as transições de build no intervalo
// (buildAnterior, buildAtual]. Para assim que passar do início do intervalo,
// pra não gastar chamada de API à toa.
function _coletarNotasNoIntervalo(commits, i, buildAnterior, buildAtual, headers) {
  if (i >= commits.length) return Promise.resolve([]);
  var c = commits[i];
  return fetch('https://api.github.com/repos/'+BASE_REPO_ORG+'/'+BASE_REPO_NOME+'/commits/'+c.sha, { headers: headers })
    .then(function(r){ return r.json(); })
    .then(function(detalhe) {
      var arquivo = (detalhe.files||[]).filter(function(f){ return f.filename === 'app.js'; })[0];
      var transicao = arquivo ? _extrairBuildDoPatch(arquivo.patch) : null;
      if (transicao) {
        var depois = parseInt(transicao.depois, 10);
        if (depois <= parseInt(buildAnterior, 10)) return [];
        if (depois <= parseInt(buildAtual, 10)) {
          return _coletarNotasNoIntervalo(commits, i+1, buildAnterior, buildAtual, headers).then(function(resto) {
            return [c.commit.message].concat(resto);
          });
        }
      }
      return _coletarNotasNoIntervalo(commits, i+1, buildAnterior, buildAtual, headers);
    });
}
```

- [ ] **Step 2: Bump de BUILD e commit**

Em `app.js` linha 2, trocar `var BUILD = '347';` por `var BUILD = '348';`.

```bash
git add app.js
git commit -m "feat: nota de atualização por versão, derivada dos commits do repo base"
git push origin main
```

- [ ] **Step 3: Teste manual**

1. Recarregar o Painel de Clientes (hard refresh).
2. Abrir "🕓 Versões" no card do Econômico, clicar em "Ver o que mudou" numa versão que não seja a atual.
3. Confirmar que aparece uma lista de mensagens de commit (não "Buscando notas..." travado, nem "Erro").
4. Comparar com `git log --oneline -L 2,2:app.js` no repo base (ou a lista de commits no GitHub) pro intervalo de build esperado — as mensagens devem bater.
5. Clicar de novo pra fechar (recolher), clicar de novo pra abrir — deve reaparecer instantâneo (veio do `_notasVersaoCache`, sem nova chamada de rede — conferir na aba Network do DevTools que não disparou fetch de novo).

---

### Task 5: Botão Reverter (rollback de verdade)

**Files:**
- Modify: `app.js:10037` — assinatura de `_pollWorkflow` (adicionar parâmetro `buildAlvo`)
- Modify: `app.js:10131` (aprox., dentro de `deployCliente`) — call site de `_pollWorkflow`
- Modify: `app.js` — nova função `reverterVersaoCliente` (colar depois de `_coletarNotasNoIntervalo`, da Task 4)

**Interfaces:**
- Consumes: `_pollWorkflow` (modificada nesta task), `showToast`, `renderPainelClientes` — todas já existentes. Botão `onclick="reverterVersaoCliente(clienteId, sha, build)"` já renderizado na Task 3.
- Produces: `reverterVersaoCliente(clienteId, sha, build)`. `_pollWorkflow` passa a gravar o build correto (o que foi de fato publicado) em `clientes/{id}.buildDeploy`, em vez de sempre gravar o `BUILD` global — corrige uma inconsistência que já existia (esse campo nunca é lido em nenhum outro lugar do código hoje, mas ficava errado depois de qualquer coisa que não fosse "publicar exatamente o build atual do base", como é o caso do rollback).

- [ ] **Step 1: Corrigir `_pollWorkflow` pra aceitar o build alvo explicitamente**

Localizar:

```js
function _pollWorkflow(org, repoName, token, since, btn, clienteId, silencioso, callback) {
```

Trocar por:

```js
function _pollWorkflow(org, repoName, token, since, btn, clienteId, silencioso, buildAlvo, callback) {
```

Localizar (dentro da mesma função, no bloco de sucesso):

```js
          db.collection('clientes').doc(clienteId).update({ ultimoDeploy: firebase.firestore.FieldValue.serverTimestamp(), buildDeploy: BUILD }).catch(function(){});
```

Trocar por:

```js
          db.collection('clientes').doc(clienteId).update({ ultimoDeploy: firebase.firestore.FieldValue.serverTimestamp(), buildDeploy: buildAlvo }).catch(function(){});
```

- [ ] **Step 2: Atualizar o único call site existente (`deployCliente`)**

Localizar dentro de `deployCliente`:

```js
          _pollWorkflow(org, repoName, token, dispatchTime, btn, clienteId, silencioso, callback);
```

Trocar por:

```js
          _pollWorkflow(org, repoName, token, dispatchTime, btn, clienteId, silencioso, BUILD, callback);
```

- [ ] **Step 3: Adicionar `reverterVersaoCliente`**

Colar depois de `_coletarNotasNoIntervalo` (Task 4):

```js
function reverterVersaoCliente(clienteId, sha, build) {
  if (!confirm('Reverter "'+clienteId+'" pra build v'+build+'?\n\nIsso publica um commit novo revertendo os arquivos — nada é apagado do histórico.')) return;
  db.collection('config').doc('superadmin').get({source:'server'}).then(function(doc) {
    var cfg = doc.data();
    var token = cfg.githubToken, org = cfg.githubOrg || 'fc360oficial';
    db.collection('config').doc('repos').get({source:'server'}).then(function(rDoc) {
      var repoName = (rDoc.data()||{})[clienteId];
      if (!repoName) { showToast('❌ Repositório não configurado para: '+clienteId); return; }
      var dispatchTime = Date.now();
      fetch('https://api.github.com/repos/'+org+'/'+repoName+'/dispatches', {
        method: 'POST',
        headers: { Authorization: 'token '+token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'rollback', client_payload: { sha: sha } })
      }).then(function(res) {
        if (res.status === 204) {
          showToast('⏳ Revertendo pra v'+build+'...');
          var m = document.getElementById('modal-versoes'); if (m) m.remove();
          _pollWorkflow(org, repoName, token, dispatchTime, null, clienteId, false, build, function(ok) {
            if (ok) renderPainelClientes();
          });
        } else if (res.status === 404 || res.status === 422) {
          showToast('❌ Esse cliente ainda não tem o workflow de rollback — rode o setup manual primeiro (ver docs/superpowers/specs/2026-09-08-painel-versoes-rollback-design.md).');
        } else {
          showToast('❌ Erro GitHub ('+clienteId+'): '+res.status);
        }
      }).catch(function(e) { showToast('❌ Erro: '+e.message); });
    });
  }).catch(function(e) { showToast('❌ Erro Firestore: '+e.message); });
}
```

- [ ] **Step 4: Bump de BUILD e commit**

Em `app.js` linha 2, trocar `var BUILD = '348';` por `var BUILD = '349';`.

```bash
git add app.js
git commit -m "feat: botão Reverter dispara rollback via Action, corrige buildDeploy gravado no Firestore"
git push origin main
```

- [ ] **Step 5: Teste manual — CUIDADO, isso publica de verdade no cliente `economico` (repo real, Pages real)**

**Antes de rodar este teste, confirmar com o Tiago que pode mexer no cliente `economico` agora** (é o cliente de produção real do CAHU) — idealmente fora do horário de pico da loja.

1. Confirmar que a Task 1 (setup do `rollback.yml` no repo do `economico`) já rodou — sem isso o teste vai falhar com o toast de "workflow de rollback" faltando.
2. No Painel de Clientes, abrir "🕓 Versões" no card do Econômico, escolher a versão **anterior** à atual, clicar "↩️ Reverter", confirmar o `confirm()`.
3. Acompanhar o toast (`⏳ Revertendo...` → `✅ Deploy concluído` reaproveitado de `_pollWorkflow`).
4. Conferir `https://fc360oficial.github.io/<repo-do-economico>/version.json` (com `?t=`+timestamp pra furar cache) — deve mostrar o build anterior.
5. Conferir que o login do cliente ainda funciona (abrir a URL do cliente, logar) — confirma que `client.js` não foi mexido pelo rollback.
6. **Reverter o teste**: voltar pro card e clicar em "🚀 Deploy" normal, pra deixar o cliente de novo no build atual do base (mesmo passo final que o próprio spec já previa).

---

## Self-Review

**Cobertura do spec:** os 3 pontos do "Objetivo" do spec (botão Versões, expandir nota, botão Reverter) estão cobertos nas Tasks 3, 4 e 5 respectivamente. O "Rollout" do spec virou a Task 1. O "Tratamento de erro" do spec está refletido nos `.catch`/branches de status HTTP em `abrirModalVersoes`, `_buscarNotasVersao` e `reverterVersaoCliente`. O "Teste manual" do spec foi incorporado no Step final de cada task, na task correspondente.

**Placeholders:** nenhum "TBD"/"implementar depois" — todo código é completo e colável. O único dado não cravado de antemão é o nome real do repo GitHub do cliente `economico` (Task 1, Step 3) — isso é informação que só existe no Firestore de produção, não dá pra adivinhar; o plano dá o comando exato pra descobrir, não deixa em aberto.

**Consistência de tipos/assinaturas:** `_pollWorkflow` ganha o parâmetro `buildAlvo` na Task 5 — os dois lugares que chamam a função (o call site já existente em `deployCliente`, Task 5 Step 2, e o novo em `reverterVersaoCliente`, Task 5 Step 3) foram atualizados juntos, na mesma task, pra não ficar um call site desatualizado. `_toggleNotasVersao(sha, build, buildAnterior)` (Task 4) usa exatamente os 3 argumentos que o botão já renderiza na Task 3. `_buscarNotasVersao(buildAnterior, buildAtual)` bate com a assinatura descrita no spec original.
