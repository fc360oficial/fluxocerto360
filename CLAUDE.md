# Fluxo Certo 360 — regras do repositório

## Versão (BUILD) — nunca editar na mão

O número de BUILD vive em 4 lugares que precisam ser iguais: `app.js` (`var BUILD`),
`version.json`, `index.html` (`app.js?v=`) e `sw.js` (`CACHE_NAME` e `./app.js?v=`).
O Painel de Clientes lê o `version.json`; o app mostra o `var BUILD`. Se divergirem,
o painel diz uma versão e o app outra (aconteceu nos BUILDs 419 e 420).

- Para subir a versão: `node scripts/bump-build.js` (ou `node scripts/bump-build.js 430`).
  Ele altera os 4 arquivos juntos e confere no final.
- Toda alteração em `app.js` sobe o BUILD em +1 no mesmo commit (convenção do projeto).
- `node scripts/check-build.js` só confere. Roda no GitHub Actions do base
  (`check-build.yml`) e dentro do deploy de cada cliente (`deploy.yml`), que falha
  antes de publicar se o base estiver inconsistente.
- Em cada clone, ative o hook uma vez: `git config core.hooksPath .githooks`
  (bloqueia commit com BUILD desalinhado).

## Deploy para clientes

Cada cliente (ex.: `fc360-economico`) recebe cópia do base via workflow
`.github/workflows/deploy.yml` (repository_dispatch `deploy`), mantendo só o
`client.js` e a pasta `.github/` dele. O `deploy.yml` deste repo é o modelo
para novos clientes; se mudar aqui, replique nos repos dos clientes.
