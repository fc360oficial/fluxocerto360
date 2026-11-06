// FC360 API — cliente do app (checklist no Postgres do .254).
// Browser: window.FC360Api. Node: module.exports (testes). Sem dependência de Firebase/DOM:
// tudo que varia (fetch, storage, token, relógio) entra por configurar().
//
// Fila offline: o que não consegue ir pro servidor na hora fica em
// storage['fc360_fila'] (array) e é reenviado em ordem — sem delete cego, sem
// travar nada: item com erro 4xx (corpo inválido) sai da fila com aviso; erro de
// rede/5xx/401 fica e tenta de novo mais tarde.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FC360Api = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FILA_KEY = 'fc360_fila';
  var cfg = { baseUrl: '', obterToken: null, fetch: null, storage: null, agora: function () { return Date.now(); }, log: function () {} };
  var memoria = null;          // cópia da fila em memória (storage pode falhar por cota)
  var drenando = null;         // Promise em andamento
  var ouvintes = [];           // callbacks chamados após cada drenagem com {enviados:[ids por tipo]}

  function configurar(o) {
    Object.keys(o || {}).forEach(function (k) { cfg[k] = o[k]; });
    if (!cfg.fetch && typeof fetch === 'function') cfg.fetch = fetch.bind(typeof self !== 'undefined' ? self : this);
    if (!cfg.storage && typeof localStorage !== 'undefined') cfg.storage = localStorage;
    memoria = null;
  }

  function ErroApi(status, mensagem, offline) {
    this.name = 'ErroApi'; this.status = status; this.message = mensagem; this.offline = !!offline;
  }
  ErroApi.prototype = Object.create(Error.prototype);

  // chamar('POST', '/sync', corpo) → JSON. Lança ErroApi {status, message, offline}.
  function chamar(metodo, rota, corpo) {
    var tokenP = cfg.obterToken ? Promise.resolve().then(cfg.obterToken) : Promise.resolve('');
    return tokenP.then(function (token) {
      var init = { method: metodo, headers: {}, cache: 'no-store' };
      if (token) init.headers.Authorization = 'Bearer ' + token;
      if (corpo !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(corpo); }
      return cfg.fetch(cfg.baseUrl + rota, init).then(function (resp) {
        return resp.text().then(function (txt) {
          var json = null;
          try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }
          if (!resp.ok) throw new ErroApi(resp.status, (json && json.error) || ('HTTP ' + resp.status), false);
          return json;
        });
      }, function (e) {
        throw new ErroApi(0, 'sem conexão com o servidor: ' + (e && e.message ? e.message : e), true);
      });
    }, function (e) {
      // sem token (usuário deslogado / Firebase ainda carregando): trata como transitório
      throw new ErroApi(0, 'sem token: ' + (e && e.message ? e.message : e), true);
    });
  }

  // ── fila ──────────────────────────────────────────────────────────────────
  function lerFila() {
    if (memoria) return memoria;
    var lista = [];
    try { lista = JSON.parse((cfg.storage && cfg.storage.getItem(FILA_KEY)) || '[]'); } catch (e) { lista = []; }
    if (!Array.isArray(lista)) lista = [];
    memoria = lista;
    return memoria;
  }
  function gravarFila(lista) {
    memoria = lista;
    try { if (cfg.storage) cfg.storage.setItem(FILA_KEY, JSON.stringify(lista)); return true; }
    catch (e) { cfg.log('fila: não coube no storage (' + (e && e.message) + '); segue só em memória'); return false; }
  }

  // Resumo de um corpo de /sync pra dedupe: checkstate e foto repetidos substituem o anterior.
  function chaveDe(corpo) {
    if (!corpo) return null;
    if (corpo.checkstates && corpo.checkstates.length === 1 && !corpo.resultados && !corpo.fotos) return 'cs:' + corpo.checkstates[0].id;
    if (corpo.fotos && corpo.fotos.length === 1 && !corpo.resultados && !corpo.checkstates) return 'foto:' + corpo.fotos[0].id;
    if (corpo.patches && corpo.patches.length === 1 && !corpo.resultados) return 'patch:' + corpo.patches[0].id;
    return null;
  }

  function adicionar(corpo, chave) {
    var lista = lerFila().slice();
    chave = chave || chaveDe(corpo);
    if (chave) lista = lista.filter(function (it) { return it.chave !== chave; });
    var item = { id: 'q_' + cfg.agora() + '_' + Math.random().toString(36).slice(2, 7), chave: chave, corpo: corpo, criadoEm: cfg.agora(), tentativas: 0 };
    lista.push(item);
    gravarFila(lista);
    return item.id;
  }

  function pendentes() { return lerFila().length; }

  // ids de resultados que ainda estão na fila (pra tela saber que "está enviando")
  function resultadosNaFila() {
    var ids = [];
    lerFila().forEach(function (it) { (it.corpo && it.corpo.resultados || []).forEach(function (r) { if (r && r.id) ids.push(r.id); }); });
    return ids;
  }

  // Envia a fila em ordem. Para no primeiro erro transitório (rede/5xx/401/408/429).
  // Devolve {enviados: [{id, chave, resposta}], descartados: [{id, chave, motivo}], restantes: n}.
  function drenar() {
    // Já tem uma passagem rodando: espera ela acabar e, se sobrou item (ex.: entrou
    // depois que ela já tinha conferido a fila), roda outra — senão quem chamou
    // enviarOuEnfileirar() receberia "enviado" com o item ainda parado na fila.
    if (drenando) return drenando.then(function (r) { return pendentes() > 0 ? drenar() : r; });
    drenando = (function () {
      var enviados = [], descartados = [];
      function passo() {
        var lista = lerFila();
        if (!lista.length) return Promise.resolve();
        var it = lista[0];
        return chamar('POST', '/sync', it.corpo).then(function (resp) {
          enviados.push({ id: it.id, chave: it.chave, resposta: resp });
          gravarFila(lerFila().filter(function (x) { return x.id !== it.id; }));
          return passo();
        }, function (e) {
          var transitorio = e.offline || e.status === 0 || e.status >= 500 || e.status === 401 || e.status === 408 || e.status === 429;
          if (transitorio) {
            var l2 = lerFila().slice();
            if (l2[0] && l2[0].id === it.id) { l2[0] = Object.assign({}, l2[0], { tentativas: (l2[0].tentativas || 0) + 1, ultimoErro: e.message, ultimaTentativa: cfg.agora() }); gravarFila(l2); }
            return; // para aqui; tenta de novo na próxima drenagem
          }
          descartados.push({ id: it.id, chave: it.chave, motivo: e.message, status: e.status });
          cfg.log('fila: item descartado (' + e.status + ' ' + e.message + ')');
          gravarFila(lerFila().filter(function (x) { return x.id !== it.id; }));
          return passo();
        });
      }
      return passo().then(function () {
        var r = { enviados: enviados, descartados: descartados, restantes: pendentes() };
        if (enviados.length || descartados.length) ouvintes.forEach(function (f) { try { f(r); } catch (e) { cfg.log('ouvinte da fila: ' + e.message); } });
        return r;
      });
    })().then(function (r) { drenando = null; return r; }, function (e) { drenando = null; throw e; });
    return drenando;
  }

  // Tenta mandar agora; se não der (rede/5xx/401), guarda na fila. Resolve 'enviado' ou 'enfileirado'.
  // Nunca rejeita por falta de rede — só por corpo inválido (4xx), que não adianta enfileirar.
  function enviarOuEnfileirar(corpo, chave) {
    // Se já tem coisa na fila, respeita a ordem: entra atrás e tenta drenar.
    if (pendentes() > 0) {
      adicionar(corpo, chave);
      return drenar().then(function () { return pendentes() === 0 ? 'enviado' : 'enfileirado'; }, function () { return 'enfileirado'; });
    }
    return chamar('POST', '/sync', corpo).then(function () { return 'enviado'; }, function (e) {
      var transitorio = e.offline || e.status === 0 || e.status >= 500 || e.status === 401 || e.status === 408 || e.status === 429;
      if (!transitorio) throw e;
      adicionar(corpo, chave);
      return 'enfileirado';
    });
  }

  function aoDrenar(f) { ouvintes.push(f); }

  // Browser: reenvia quando a internet volta, quando o app volta pra frente e a cada intervalo.
  var _timer = null;
  function iniciarAutomatico(intervaloMs) {
    if (typeof window === 'undefined') return;
    var tentar = function () { if (pendentes() > 0) drenar().catch(function () {}); };
    window.addEventListener('online', tentar);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') tentar(); });
    if (_timer) clearInterval(_timer);
    _timer = setInterval(tentar, intervaloMs || 30000);
    tentar();
  }

  return { configurar: configurar, chamar: chamar, ErroApi: ErroApi,
    fila: { adicionar: adicionar, drenar: drenar, pendentes: pendentes, resultadosNaFila: resultadosNaFila, aoDrenar: aoDrenar, iniciarAutomatico: iniciarAutomatico, _ler: lerFila, FILA_KEY: FILA_KEY },
    enviarOuEnfileirar: enviarOuEnfileirar, _chaveDe: chaveDe };
});
