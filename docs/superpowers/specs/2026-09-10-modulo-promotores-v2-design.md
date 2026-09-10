# Módulo Promotores v2 (design)

**Data:** 2026-09-10
**Contexto:** Fase 2 do roadmap FC360 ([[2026-08-05-fase1-capa-modulos-apk-design]]) migra Promotores e Pesquisa Concorrentes do Fluxo Radar (React/Vite + Supabase, `C:\Users\tiago\OneDrive\Documentos\fluxo radar`) para dentro do FC360 (vanilla JS + Firebase, `C:\Users\tiago\OneDrive\Documentos\claude_code_`). Este documento cobre só **Promotores**; Pesquisa Concorrentes fica para spec própria.

**Substitui o design v1** ([[2026-08-10-fase2-promotores-design]]). O v1 foi implementado quase por inteiro (Tasks 1-7 do plano de 2026-08-10: `firestore.rules`, `qrcode-generator.min.js`, `public/checkin.html`, CRUD de fornecedores e histórico de visitas em `app.js`) mas nunca chegou à Task 8 (ativar o card na capa) — o módulo ficou pronto por baixo e nunca foi ligado. Decisão do Tiago em 2026-09-10: em vez de só terminar a Task 8 do v1 (escopo simples: CRUD + histórico + check-in via página pública), fazer a réplica completa do que existe hoje no Radar (KPIs, filtros, rankings, agenda semanal, drawer de fornecedor) e trocar o check-in público por um modo convidado dentro do próprio PWA.

## 1. Objetivo

Controlar visitas de promotores/repositores (funcionários de fornecedores, não usuários do FC360) às lojas — agendamento recorrente, check-in/check-out por QR code sem exigir login do promotor, e painel de acompanhamento (KPIs, cumprimento de agenda, rankings) para Admin/Supervisor.

## 2. Escopo v2

**Dentro:**
- Cadastro de fornecedores (nome, telefone, email, lojas atendidas, dias da semana esperados, periodicidade).
- Agendamento de visitas (recorrente por dias da semana, ou avulso) — diferente do v1, a visita pode existir antes do check-in acontecer.
- Check-in/check-out do promotor via QR, **como convidado dentro do PWA** (não mais página separada `checkin.html`).
- Painel "Gestão de Promotores": KPIs do dia, barra de cumprimento de agenda, busca, filtros rápidos (Todos/Hoje/Agendados/Na Loja/Realizados/Não Compareceram/Fim de Semana/Próximos 7 dias), tabela de visitas com badge de pontualidade, modal de agenda semanal, drawer de fornecedor (contato + histórico), rankings (pontualidade por promotor, tempo médio em loja, cumprimento por fornecedor/loja).
- Geração de QR code por loja (grade dentro do painel, com opção de imprimir/baixar).

**Fora (v3 ou não decidido):**
- Notificação automática de atraso/ausência (dado já existe via status `nao_compareceu`, alerta proativo fica pra depois).
- Edição de visita já com check-out feito.
- Multi-idioma / suporte a promotor sem celular com câmera (QR é o único fluxo de entrada v2).

## 3. Modelo de dados (Firestore)

Continua no padrão `clientes/{clienteId}/...` (mesma decisão da Fase 1), estendendo as duas coleções já criadas no v1 em vez de recriá-las:

```
clientes/{clienteId}/
  fornecedores/{fornecedorId}
    nome: string
    telefone: string | null       // novo no v2
    email: string | null          // novo no v2
    ativo: boolean
    lojas: string[]                // ids das lojas atendidas
    diasSemana: number[]           // 0-6, dias esperados de visita
    periodicidade: string          // 'diaria' | 'semanal' | 'quinzenal' | 'mensal' — novo no v2

  promotor_visitas/{visitaId}
    fornecedorId: string
    fornecedorNome: string          // cópia, evita join na leitura do convidado
    lojaId: string
    lojaNome: string
    promotorNome: string            // digitado no check-in ou no agendamento
    promotorTelefone: string | null // novo no v2
    dataAgendada: string | null     // YYYY-MM-DD — novo no v2, existe antes do check-in
    horaAgendada: string | null     // HH:MM — novo no v2
    status: string                  // 'agendada'|'na_loja'|'realizada'|'nao_compareceu'|'fim_de_semana' — substitui o binário implícito do v1
    sessionUid: string | null       // uid anônimo de quem fez o check-in (null se ainda não chegou)
    checkInEm: timestamp | null
    checkInGeo: {lat: number, lng: number} | null
    checkOutEm: timestamp | null
    checkOutGeo: {lat: number, lng: number} | null
```

Diferença chave em relação ao v1: a visita pode nascer **agendada** (criada pelo Admin/Supervisor, `status:'agendada'`, sem `sessionUid`/check-in ainda) ou nascer **direto do check-in** (promotor sem agendamento prévio escaneia o QR — mesmo comportamento do v1, cria a visita na hora). O painel trata as duas origens igual a partir do momento em que existe o documento.

## 4. Check-in como convidado dentro do PWA

Troca o `public/checkin.html` (arquivo separado) por um modo de entrada dentro do `index.html`/`app.js` já existentes:

- QR aponta para `index.html?checkin=1&c={clienteId}&l={lojaId}`.
- `app.js`, antes de rodar a checagem normal de sessão/login (`finalizarLogin`), detecta o parâmetro `checkin=1` na URL e desvia para um fluxo separado: `signInAnonymously()` (transparente, sem UI) e renderização de uma tela mínima — sem sidebar, sem nav, reaproveitando o CSS já carregado (`style.css`) para manter a identidade visual.
- Mesma lógica de dados do v1: verifica se existe visita `agendada` para aquele fornecedor/loja/hoje (se o admin já agendou) e assume ela em vez de criar uma nova; senão, cria a visita na hora, igual ao fluxo antigo. Confirmado o fornecedor, captura GPS (com fallback `null` se negado) e grava `checkInEm`/`status:'na_loja'`.
- Ao reabrir o mesmo link na mesma sessão (mesmo `sessionUid` com visita em aberto), mostra direto a tela de check-out em vez do formulário.
- Security Rules seguem o mesmo modelo do v1 (`firestore.rules` já commitado): `request.auth != null` aceita anônimo, escrita de `promotor_visitas` restrita a quem bate o `sessionUid`; ajuste necessário é permitir `update` de uma visita `agendada` existente (v1 só previa `create`) — regra nova cobre `create` (visita nova) e `update` restrito aos campos de check-in/check-out (nunca deixa o convidado reescrever fornecedor/loja/data agendada).
- `public/checkin.html` é removido depois que o modo convidado embutido estiver validado (mantém funcionando até lá, para não quebrar QR já impressos).

## 5. Painel "Gestão de Promotores" (Admin/Supervisor)

Réplica funcional da tela do Radar, adaptada ao padrão visual do FC360 (não é port de componente React — reimplementação em vanilla JS seguindo os padrões já usados em outras telas do app, ex. `switchCentralTab`):

- **KPIs do dia** (4 cards): visitas previstas hoje, check-ins realizados, em loja agora, não compareceram.
- **Barra de cumprimento de agenda** (realizado / previsto do dia).
- **Busca** por fornecedor, promotor ou loja + **filtros rápidos**: Todos, Hoje, Agendados, Na Loja, Realizados, Não Compareceram, Fim de Semana, Próximos 7 dias.
- **Tabela de visitas**: data, fornecedor, promotor, loja, horário programado, entrada (com badge de pontualidade: antecipado/pontual/atrasado), saída, status.
- **Modal de novo agendamento**: fornecedor, nome/telefone do promotor, loja, data/hora, seletor de dias da semana (recorrência), periodicidade, data final.
- **Agenda semanal** (modal): visão de 7 colunas com navegação de semana, cards compactos por visita.
- **Drawer de fornecedor**: contato, lojas atendidas, dias/periodicidade esperados, últimas 6 visitas com duração.
- **Rankings**: pontualidade por promotor, tempo médio em loja, cumprimento por fornecedor/loja (calculados client-side a partir das visitas carregadas, sem coleção agregada nova).
- **Grade de QR codes por loja**: reaproveita `qrcode-generator.min.js` já vendorizado; cada QR aponta para a URL do modo convidado (seção 4).

## 6. Acesso

- Módulo novo `promotores` em `_moduloAtivo`/`MODS_LABEL`.
- Card na capa mobile e item de sidebar: `roleOk: admin || supervisor` (mesmo padrão de `central`).
- Modo convidado (seção 4) não passa por `roleOk` nem por login — é uma rota separada fora do fluxo de autenticação normal do app.

## 7. O que muda em relação ao já implementado (v1)

| Peça do v1 | Destino no v2 |
|---|---|
| `firestore.rules` (fornecedores/promotor_visitas) | Mantido, com ajuste de `update` para cobrir visita agendada (seção 4) |
| `qrcode-generator.min.js` | Mantido, sem mudança |
| `public/checkin.html` | Removido após validar o modo convidado embutido (seção 4) |
| `renderFornecedores`/CRUD em `app.js` | Estendido com telefone/email/periodicidade, mantém a base |
| Abas simples "Fornecedores"/"Visitas" | Substituídas pelo painel completo (seção 5) |
| `CAPA_MODULOS` entrada `promotores` (`desenvolvido:false`) | Ativada (`desenvolvido:true`, `roleOk`, `moduloChave`) só quando o painel v2 estiver pronto — não antes, para não expor uma tela pela metade |

## 8. Riscos e observações

- GPS pode ser negado pelo navegador do promotor — nunca bloquear o check-in/check-out por isso, só gravar `null`.
- `sessionUid` amarrado ao navegador quebra o check-out se o promotor trocar de celular/navegador no meio da visita — mesma limitação aceita do v1; contorno é o Admin fechar a visita manualmente pela tabela (a incluir como ação na tabela do painel, já que agora existe um painel completo em vez de só histórico).
- Detectar `checkin=1` na URL antes do fluxo normal de login em `app.js` precisa ser feito com cuidado para não quebrar o `finalizarLogin()` existente (checagem anti-vazamento cross-tenant) nem o restore de sessão normal — é código nesse hot path que já teve bugs sérios antes (BUILDs 266-271, 276).
- Rankings client-side (sem coleção agregada) podem ficar lentos se o histórico de visitas crescer muito — aceitável no volume atual (poucas lojas, poucos fornecedores por cliente); revisitar se virar problema real.
- Ao remover `public/checkin.html`, qualquer QR já impresso fica inválido — avisar o Tiago para reimprimir QRs depois do deploy do v2 (só relevante se algum QR do v1 já foi impresso/testado em loja real; a se confirmar no plano).
