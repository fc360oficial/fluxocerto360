# Painel de Clientes — Histórico de Versões e Rollback — Design

**Status: pendente, NÃO implementado ainda.** Brainstorm feito com o Tiago em 2026-09-08, a partir de uma pergunta dele olhando o Painel de Clientes ("não deveria ter um botão de voltar versão anterior?"). Design aprovado por ele em texto; falta implementar.

**Contexto técnico ao salvar este spec (2026-09-08, BUILD 345):**

- Este repo (`fc360oficial/fluxocerto360`, branch `main`) é o **repo base**. Cada cliente (hoje: `fluxocerto` = o próprio base, e `economico`) tem um **repo GitHub próprio**, publicado via GitHub Pages direto da branch `main` (`fc360oficial.github.io/<repo>/`).
- `.github/workflows/deploy.yml` (neste repo) — Action que roda `repository_dispatch` tipo `deploy` **no repo do cliente**: faz `git fetch base main` (aponta pra este repo base), `git checkout base/main -- .`, restaura `client.js` (identidade do tenant, backup/restore ao redor do checkout) e a própria `.github/` do cliente (não vem do base), e commita `"Auto-deploy DD/MM/YYYY HH:MM"` na `main` do cliente. GitHub Pages serve direto dali.
- `deployCliente()` (app.js ~10102) — dispara o `dispatches` via GitHub API usando o token salvo em `config/superadmin.githubToken` (Firestore), depois chama `_pollWorkflow()` (~10037) que faz polling em `GET /repos/{org}/{repo}/actions/runs` até o run terminar, atualizando o botão e o Firestore (`clientes/{id}.ultimoDeploy` e `.buildDeploy`).
- `_atualizarVersaoClientes()` (app.js ~9678) — hoje só mostra a versão **atual/ao vivo** de cada cliente, buscando `version.json` publicado (`fc360oficial.github.io/<repo>/version.json?t=...`) e comparando com o build do base. Não existe nenhum histórico guardado — nem em Firestore nem em UI.
- `var BUILD = '345'` (app.js linha 2) — sobe quase sempre **+1 por commit** que mexe em `app.js`, e a mensagem do commit já é uma nota de mudança legível (confirmado com `git log -L 2,2:app.js`, ex: `fix: leva pra tela de reconexao quando o Lote falha por impressora desconectada`). Ou seja, **as notas de atualização já existem** no histórico de commits do repo base — não tem changelog separado hoje, e não precisa criar um do zero.
- Padrão de modal já estabelecido no arquivo (ex: `verTokensCliente()` ~9989) — modal `position:fixed;inset:0`, fecha clicando fora, mesmo estilo de card branco arredondado. O design abaixo segue esse mesmo padrão visual, não inventa um novo.
- Card do cliente `fluxocerto` (o próprio base) não tem botão de Deploy nem Desativar (ver render em `_renderClientesLista()` ~9614). Rollback também não se aplica a ele — é só pros clientes "de verdade".

**Fora de escopo explícito (decidido com o Tiago):**
- Nota manual digitada no momento do deploy — não precisa, a mensagem de commit do base já serve como nota.
- Rollback do repo base em si — só dos repos de cliente.
- Histórico "infinito" ou paginado — só as últimas 3 versões publicadas naquele cliente, como ele pediu.
- Distinguir visualmente "atrasado por rollback proposital" vs "esqueceram de dar deploy" no badge ATUALIZADO/DESATUALIZADO — mantém o badge atual como está; não foi pedido.

---

## Objetivo

No card de cada cliente (exceto o `fluxocerto`/base), adicionar:

1. Um botão **"🕓 Versões"** que abre um modal com as **últimas 3 versões publicadas naquele cliente**.
2. Ao clicar em uma versão da lista, expandir e mostrar a **nota de atualização** (o que mudou) daquela versão.
3. Em cada versão que não seja a atualmente publicada, um botão **"↩️ Reverter"** que republica os arquivos daquele ponto do histórico no repo do cliente.

## Arquitetura

Não é criado nenhum armazenamento novo de versões — o histórico de commits dos repos já É o histórico de deploys (cada deploy é 1 commit `Auto-deploy ...` no repo do cliente). O que muda:

1. **Leitura do histórico** — via GitHub API, direto do navegador (mesmo padrão que já existe pra `_pollWorkflow`), sem passar por Firestore.
2. **Nova Action** `.github/workflows/rollback.yml`, mesmo padrão do `deploy.yml`, mas fazendo checkout de um commit antigo do próprio repo do cliente (não do base) e criando um commit novo pra cima — nunca reescreve/força histórico.

```
[Modal "Versões"] --GET commits (client repo)--> GitHub API
       |
       +--(usuário clica numa versão)--> monta notas (busca commits do BASE
       |                                   entre o build anterior e esse)
       |
       +--(usuário clica "Reverter")--> repository_dispatch "rollback"
                                          --> rollback.yml no repo do cliente
                                          --> checkout do commit antigo, exceto
                                              client.js e .github/
                                          --> commit "Rollback para build vXXX"
                                          --> push (Pages republica sozinho)
```

## Componentes novos (tudo em `app.js`, seguindo o padrão monolítico existente — sem criar arquivo novo de código)

### 1. Botão "🕓 Versões" no card do cliente
Ao lado do botão "📋 Tokens" em `_renderClientesLista()`. Não aparece no card `fluxocerto` (mesma condição que já esconde Deploy/Desativar pra ele).

### 2. `abrirModalVersoes(clienteId)`
- Busca `repos[clienteId]` (já carregado em `_atualizarVersaoClientes`, ou busca de novo `config/repos`).
- `GET /repos/{org}/{repoDoCliente}/commits?sha=main&per_page=5` (token do `config/superadmin`) — pega os commits mais recentes.
- Filtra só os commits `Auto-deploy ...` (ou `Rollback para build ...`, que também conta como uma versão publicada) — ignora ruído.
- Pega os **3 primeiros** dessa lista filtrada.
- Pra cada um, busca o build publicado naquele commit: `GET https://raw.githubusercontent.com/{org}/{repoDoCliente}/{sha}/version.json` (sem token — é conteúdo público, mesmo domínio que já é usado sem auth pro `version.json` ao vivo).
- Renderiza modal (mesmo padrão visual de `verTokensCliente`) com 3 linhas: data/hora do commit (formatada pt-BR), `vXXX`, e um botão "Ver o que mudou" que expande a nota (carregada sob demanda, só quando clicado — ver função 3). A linha cujo build bate com o build ao vivo atual (já calculado em `_atualizarVersaoClientes`) fica marcada como "🟢 Publicada agora" e não mostra botão Reverter.

### 3. `_buscarNotasVersao(buildAnterior, buildAtual)`
- Só roda quando o usuário expande uma versão (evita gastar chamadas de API à toa).
- `GET /repos/{org}/fluxocerto360/commits?path=app.js&per_page=50` no **repo base** (não no do cliente).
- Percorre os commits (mais novo → mais velho); pra cada um, `GET /repos/{org}/fluxocerto360/commits/{sha}` pra pegar o patch de `app.js` e extrair a linha `var BUILD = 'X'` antes/depois.
- Acumula as mensagens de commit cujo build resultante cai no intervalo `(buildAnterior, buildAtual]`.
- Se não achar nenhuma transição de build nesse intervalo dentro dos 50 commits (ex.: cliente muito atrasado), mostra fallback: *"Notas não disponíveis pra esse intervalo — [ver histórico completo no GitHub](link)"*.
- Cache simples em memória (`_notasVersaoCache = {}`) pra não refazer a busca se o usuário reabrir o modal na mesma sessão.

### 4. `reverterVersaoCliente(clienteId, sha, build)`
- `confirm()`: *"Reverter '<nome do cliente>' pra versão de <data/hora> (build vXXX)? Isso publica um commit novo revertendo os arquivos — nada é apagado do histórico."*
- Mesmo fluxo de `deployCliente`: `POST /repos/{org}/{repoDoCliente}/dispatches` com `event_type: 'rollback'` e `client_payload: {sha: sha}`.
- Reaproveita `_pollWorkflow` pra acompanhar o Action e mostrar toast de sucesso/erro.
- Ao terminar com sucesso: fecha o modal, chama `_atualizarVersaoClientes()` de novo (o card já atualiza sozinho, vai aparecer `⚠️ DESATUALIZADO` se o base tiver builds mais novos — comportamento correto, o card não sabe distinguir "atrasado por rollback" de "esqueceram de atualizar", e ficou definido que não precisa distinguir).

### 5. `.github/workflows/rollback.yml` (novo arquivo, neste repo base)
Mesma estrutura do `deploy.yml`, mudando o gatilho e a origem do checkout:

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
        run: git checkout ${{ github.event.client_payload.sha }} -- . ':!.github'
      - name: Restore client identity and push
        run: |
          cp /tmp/client_backup.js client.js
          git add -A
          git config user.email "deploy@fluxocerto.com"
          git config user.name "FC360 Auto Deploy"
          git diff --staged --quiet || git commit -m "Rollback para build anterior ($(date '+%d/%m/%Y %H:%M'))"
          git push origin HEAD:main
```

## Rollout (passo manual, uma vez só)

`deploy.yml` já mostra que a `.github/` de cada cliente **não** é sincronizada a partir do base (é preservada de propósito). Isso significa que `rollback.yml` também não chega sozinho nos clientes já existentes só por estar no base. Passo único necessário:

1. Adicionar `rollback.yml` neste repo base (fica valendo pra clientes **novos**, se a criação deles copiar a `.github/` do base — checar como o repo de cliente é criado hoje, provavelmente via "Use this template" do GitHub).
2. Subir manualmente o mesmo `rollback.yml` no(s) repo(s) de cliente que já existem hoje (só `economico`, já que `fluxocerto` é o base) — um `git push` avulso, não precisa de ferramenta nova pra isso dado que são só 1-2 repos.

## Tratamento de erro

- Repo do cliente não configurado / API do GitHub fora do ar / rate limit → mesma UX de erro que `_atualizarVersaoClientes` já usa hoje (mostra "—" / "SEM RESPOSTA", não quebra o resto do painel).
- `rollback.yml` ainda não existe no repo do cliente (esqueceram do passo de rollout) → o `dispatch` volta 404/422 do GitHub; mostrar toast `"❌ Esse cliente ainda não tem o workflow de rollback — rode o setup manual primeiro."` em vez de deixar o polling travar esperando um Action que nunca vai rodar.
- Busca de notas não encontra a transição de build → fallback com link pro histórico do GitHub (ver item 3 acima), nunca deixa a UI em branco/quebrada.

## Teste manual (não tem suite de testes automatizada neste projeto)

1. Abrir o Painel de Clientes, clicar em "🕓 Versões" no card do `economico` → confirmar que aparecem as últimas 3 versões publicadas de verdade (comparar com o histórico de commits do repo `fc360-economico` no GitHub).
2. Expandir uma versão → conferir que as notas batem com os commits reais do base naquele intervalo de build.
3. Fazer um rollback de teste pra a versão anterior → confirmar que o Action roda, o `version.json` ao vivo do cliente volta pro build antigo, e o `client.js` **não** muda (login/identidade do tenant continua funcionando).
4. Depois do teste, dar Deploy normal de novo pra deixar o cliente atualizado.
