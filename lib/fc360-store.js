// FC360 Store — a API do Firestore que o app usa (db.collection().doc().get()/set()/update(),
// where/orderBy/limit, onSnapshot, batch, FieldValue, FieldPath) servida pela FC360 API
// (Postgres do .254, tabela `documento`). Troca-se `var db = firebase.firestore()` por
// `var db = FC360Store.db` e o resto do app continua igual.
//
// Diferenças de propósito:
//   - escrita vai pela fila do FC360Api (sem internet guarda no aparelho e sobe depois);
//     a promise resolve quando o servidor confirma OU quando entrou na fila;
//   - onSnapshot é leitura periódica (5 s) com diff — não existe push do servidor;
//   - leitura sem internet devolve a última resposta guardada daquela consulta (fromCache).
// Browser: window.FC360Store. Node: module.exports (testes).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FC360Store = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var cfg = { api: null, intervaloListener: 5000, storage: null, log: function () {}, agora: function () { return Date.now(); } };
  var memoriaCache = {};
  var CACHE_PREFIXO = 'fc360_qc:';
  var CACHE_MAX = 200 * 1024;

  function configurar(o) {
    Object.keys(o || {}).forEach(function (k) { cfg[k] = o[k]; });
    if (!cfg.storage && typeof localStorage !== 'undefined') cfg.storage = localStorage;
    if (!cfg.api && typeof FC360Api !== 'undefined') cfg.api = FC360Api;
  }
  function api() { if (!cfg.api) throw new Error('FC360Store não configurado'); return cfg.api; }

  // ── valores ───────────────────────────────────────────────────────────────
  function Timestamp(iso) {
    this.__ts = iso;
    var ms = new Date(iso).getTime();
    this.seconds = Math.floor(ms / 1000);
    this.nanoseconds = (ms % 1000) * 1e6;
  }
  Timestamp.prototype.toDate = function () { return new Date(this.__ts); };
  Timestamp.prototype.toMillis = function () { return new Date(this.__ts).getTime(); };
  Timestamp.prototype.toJSON = function () { return { __ts: this.__ts }; };
  Timestamp.prototype.isEqual = function (o) { return !!o && o.__ts === this.__ts; };
  Timestamp.now = function () { return new Timestamp(new Date(cfg.agora()).toISOString()); };
  Timestamp.fromDate = function (d) { return new Timestamp(new Date(d).toISOString()); };

  var FieldValue = {
    serverTimestamp: function () { return { __serverTimestamp: true }; },
    delete: function () { return { __delete: true }; },
    arrayUnion: function () { return { __arrayUnion: Array.prototype.slice.call(arguments) }; }
  };
  function FieldPath() { this._segs = Array.prototype.slice.call(arguments); }
  FieldPath.prototype.toString = function () { return this._segs.join('.'); };

  function ehObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  // Pra enviar: Date → {__ts}, Timestamp → {__ts}, undefined some; sentinelas passam.
  function serializar(v) {
    if (v === undefined) return undefined;
    if (v instanceof Date) return { __ts: v.toISOString() };
    if (v instanceof Timestamp) return { __ts: v.__ts };
    if (Array.isArray(v)) return v.map(function (x) { var s = serializar(x); return s === undefined ? null : s; });
    if (ehObj(v)) {
      if (v.__serverTimestamp || v.__delete || v.__arrayUnion) return v;
      var o = {};
      Object.keys(v).forEach(function (k) { var s = serializar(v[k]); if (s !== undefined) o[k] = s; });
      return o;
    }
    return v;
  }
  // Ao ler: {__ts} → Timestamp (tem toDate()).
  function hidratar(v) {
    if (Array.isArray(v)) return v.map(hidratar);
    if (ehObj(v)) {
      if (typeof v.__ts === 'string' && Object.keys(v).length === 1) return new Timestamp(v.__ts);
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = hidratar(v[k]); });
      return o;
    }
    return v;
  }

  function erro(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function transitorio(e) { return !!(e && (e.offline || e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429)); }

  // ── cache de leitura (última resposta de cada consulta) ───────────────────
  function cacheLer(chave) {
    if (memoriaCache[chave] !== undefined) return memoriaCache[chave];
    try { var s = cfg.storage && cfg.storage.getItem(CACHE_PREFIXO + chave); if (s) { memoriaCache[chave] = JSON.parse(s); return memoriaCache[chave]; } } catch (e) { /* sem cache */ }
    return undefined;
  }
  function cacheGravar(chave, valor) {
    memoriaCache[chave] = valor;
    try { var s = JSON.stringify(valor); if (cfg.storage && s.length <= CACHE_MAX) cfg.storage.setItem(CACHE_PREFIXO + chave, s); } catch (e) { /* cota */ }
  }
  function lerComCache(chave, rota) {
    return api().chamar('GET', rota).then(function (dados) { cacheGravar(chave, dados); return { dados: dados, fromCache: false }; }, function (e) {
      if (e && e.status === 404) return { dados: null, fromCache: false };
      var c = cacheLer(chave);
      if (transitorio(e) && c !== undefined) { cfg.log('sem servidor, usando cache: ' + chave); return { dados: c, fromCache: true }; }
      throw erro(e && e.status === 401 ? 'permission-denied' : 'unavailable', e && e.message);
    });
  }

  function novoId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', s = '';
    for (var i = 0; i < 20; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  }

  // ── snapshots ─────────────────────────────────────────────────────────────
  function DocSnapshot(ref, dados, fromCache) {
    this.ref = ref; this.id = ref.id; this.exists = dados !== null && dados !== undefined;
    this._dados = this.exists ? hidratar(dados) : undefined;
    this.metadata = { hasPendingWrites: false, fromCache: !!fromCache };
  }
  DocSnapshot.prototype.data = function () { if (!this.exists) return undefined; var c = Object.assign({}, this._dados); delete c.id; return c; };
  DocSnapshot.prototype.get = function (campo) { var d = this.data() || {}; return String(campo).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, d); };

  function QuerySnapshot(col, lista, fromCache, anterior) {
    var self = this;
    this.docs = (lista || []).map(function (d) { return new DocSnapshot(col.doc(d.id), d, fromCache); });
    this.size = this.docs.length; this.empty = this.size === 0;
    this.metadata = { hasPendingWrites: false, fromCache: !!fromCache };
    this._mapa = {}; this.docs.forEach(function (d) { self._mapa[d.id] = d; });
    this._anterior = anterior || null;
  }
  QuerySnapshot.prototype.forEach = function (f) { this.docs.forEach(f); };
  QuerySnapshot.prototype.docChanges = function () {
    var self = this, mudancas = [];
    if (!this._anterior) { this.docs.forEach(function (d, i) { mudancas.push({ type: 'added', doc: d, newIndex: i, oldIndex: -1 }); }); return mudancas; }
    this.docs.forEach(function (d, i) {
      var a = self._anterior._mapa[d.id];
      if (!a) mudancas.push({ type: 'added', doc: d, newIndex: i, oldIndex: -1 });
      else if (JSON.stringify(a._dados) !== JSON.stringify(d._dados)) mudancas.push({ type: 'modified', doc: d, newIndex: i, oldIndex: -1 });
    });
    this._anterior.docs.forEach(function (d) { if (!self._mapa[d.id]) mudancas.push({ type: 'removed', doc: d, newIndex: -1, oldIndex: -1 }); });
    return mudancas;
  };

  // ── escrita ───────────────────────────────────────────────────────────────
  function enviarOps(ops) {
    return api().enviarOuEnfileirar({ ops: ops }).then(function (estado) { return estado; }, function (e) {
      throw erro(e && e.status === 401 ? 'permission-denied' : (e && e.status === 404 ? 'not-found' : 'invalid-argument'), e && e.message);
    });
  }
  function opsUpdate(args) {
    // update({a:1,'b.c':2}) ou update(campo, valor, campo2, valor2, ...) ou update(FieldPath, valor)
    var campos = {};
    if (args.length === 1 && ehObj(args[0])) {
      Object.keys(args[0]).forEach(function (k) { campos[k] = args[0][k]; });
    } else {
      for (var i = 0; i + 1 < args.length; i += 2) campos[String(args[i])] = args[i + 1];
    }
    return serializar(campos);
  }

  function DocRef(col, id) { this.parent = col; this.id = id; this.path = col.id + '/' + id; }
  DocRef.prototype.get = function () {
    var self = this;
    return lerComCache('d:' + self.path, '/col/' + encodeURIComponent(self.parent.id) + '/' + encodeURIComponent(self.id))
      .then(function (r) { return new DocSnapshot(self, r.dados, r.fromCache); });
  };
  DocRef.prototype.set = function (dados, opts) {
    return enviarOps([{ op: 'set', col: this.parent.id, id: this.id, dados: serializar(dados || {}), merge: !!(opts && opts.merge) }]).then(function () {});
  };
  DocRef.prototype.update = function () {
    return enviarOps([{ op: 'update', col: this.parent.id, id: this.id, dados: opsUpdate(Array.prototype.slice.call(arguments)) }]).then(function () {});
  };
  DocRef.prototype.delete = function () {
    return enviarOps([{ op: 'delete', col: this.parent.id, id: this.id }]).then(function () {});
  };
  DocRef.prototype.onSnapshot = function (cb, errCb) {
    var self = this, ultimo = null, vivo = true;
    function passo() {
      if (!vivo) return;
      self.get().then(function (snap) {
        var chave = JSON.stringify(snap.exists ? snap._dados : null);
        if (chave !== ultimo) { ultimo = chave; if (vivo) cb(snap); }
      }, function (e) { if (vivo && errCb) errCb(e); });
    }
    passo();
    var t = setInterval(passo, cfg.intervaloListener);
    return function () { vivo = false; clearInterval(t); };
  };
  DocRef.prototype.collection = function (nome) { return new CollectionRef(this.path + '/' + nome); };

  function Query(col, where, orderBy, limite) { this._col = col; this._where = where || []; this._orderBy = orderBy || []; this._limit = limite || null; }
  Query.prototype.where = function (campo, op, valor) { return new Query(this._col, this._where.concat([[String(campo), op, serializar(valor)]]), this._orderBy, this._limit); };
  Query.prototype.orderBy = function (campo, dir) { return new Query(this._col, this._where, this._orderBy.concat([[String(campo), dir || 'asc']]), this._limit); };
  Query.prototype.limit = function (n) { return new Query(this._col, this._where, this._orderBy, n); };
  Query.prototype._rota = function () {
    var p = [];
    if (this._where.length) p.push('where=' + encodeURIComponent(JSON.stringify(this._where)));
    if (this._orderBy.length) p.push('orderBy=' + encodeURIComponent(JSON.stringify(this._orderBy)));
    if (this._limit) p.push('limit=' + this._limit);
    return '/col/' + encodeURIComponent(this._col.id) + (p.length ? '?' + p.join('&') : '');
  };
  Query.prototype.get = function () {
    var self = this, rota = self._rota();
    return lerComCache('q:' + rota, rota).then(function (r) { return new QuerySnapshot(self._col, r.dados || [], r.fromCache); });
  };
  Query.prototype.onSnapshot = function (cb, errCb) {
    var self = this, anterior = null, ultimo = null, vivo = true;
    function passo() {
      if (!vivo) return;
      var rota = self._rota();
      lerComCache('q:' + rota, rota).then(function (r) {
        var chave = JSON.stringify(r.dados || []);
        if (chave === ultimo) return;
        ultimo = chave;
        var snap = new QuerySnapshot(self._col, r.dados || [], r.fromCache, anterior);
        anterior = snap;
        if (vivo) cb(snap);
      }, function (e) { if (vivo && errCb) errCb(e); });
    }
    passo();
    var t = setInterval(passo, cfg.intervaloListener);
    return function () { vivo = false; clearInterval(t); };
  };

  function CollectionRef(nome) { Query.call(this, this, [], [], null); this.id = nome; this.path = nome; }
  CollectionRef.prototype = Object.create(Query.prototype);
  CollectionRef.prototype.constructor = CollectionRef;
  CollectionRef.prototype.doc = function (id) { return new DocRef(this, id || novoId()); };
  CollectionRef.prototype.add = function (dados) { var r = this.doc(); return r.set(dados).then(function () { return r; }); };

  function WriteBatch() { this._ops = []; }
  WriteBatch.prototype.set = function (ref, dados, opts) { this._ops.push({ op: 'set', col: ref.parent.id, id: ref.id, dados: serializar(dados || {}), merge: !!(opts && opts.merge) }); return this; };
  WriteBatch.prototype.update = function (ref) { this._ops.push({ op: 'update', col: ref.parent.id, id: ref.id, dados: opsUpdate(Array.prototype.slice.call(arguments, 1)) }); return this; };
  WriteBatch.prototype.delete = function (ref) { this._ops.push({ op: 'delete', col: ref.parent.id, id: ref.id }); return this; };
  WriteBatch.prototype.commit = function () { if (!this._ops.length) return Promise.resolve(); var ops = this._ops; this._ops = []; return enviarOps(ops).then(function () {}); };

  var db = {
    collection: function (nome) { return new CollectionRef(nome); },
    batch: function () { return new WriteBatch(); },
    enablePersistence: function () { return Promise.resolve(); },
    waitForPendingWrites: function () { return api().fila.drenar().then(function () {}); },
    terminate: function () { return Promise.resolve(); },
    clearPersistence: function () {
      memoriaCache = {};
      try { var s = cfg.storage; if (s) { var apagar = []; for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf(CACHE_PREFIXO) === 0) apagar.push(k); } apagar.forEach(function (k) { s.removeItem(k); }); } } catch (e) { /* ok */ }
      return Promise.resolve();
    }
  };

  return { configurar: configurar, db: db, FieldValue: FieldValue, FieldPath: FieldPath, Timestamp: Timestamp,
    _serializar: serializar, _hidratar: hidratar, _novoId: novoId, _limparCache: function () { memoriaCache = {}; } };
});
