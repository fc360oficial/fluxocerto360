// lib/inv-bip-core.js — lógica pura do Inventário (roda em Node e no browser).
// Browser: window.InvCore. Node: module.exports. Sem dependência de Firebase/DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Normaliza EAN pra comparação: tira zeros à esquerda. Leitor físico às vezes
  // lê EAN-13 iniciado em 0 como UPC-A de 12 dígitos (mesmo código, sem o zero).
  function normEan(s) {
    s = String(s == null ? '' : s).trim();
    var st = s.replace(/^0+/, '');
    return st || '0';
  }

  // itens: [{c: código interno, e: EAN, d: descrição, u: unidade, q: estoque}]
  function criarCatalogo(itens) {
    var porCodigo = {}, porEan = {}, total = 0;
    (itens || []).forEach(function (it) {
      var c = String(it.c == null ? '' : it.c).trim();
      var e = String(it.e == null ? '' : it.e).trim();
      if (!c && !e) return;
      total++;
      var item = { c: c, e: e, d: it.d || '', u: it.u || '', q: (it.q == null ? null : Number(it.q)), k: (it.k == null ? null : Number(it.k)) };
      if (c && !porCodigo[c]) porCodigo[c] = item;
      if (e) {
        var k = normEan(e);
        if (!porEan[k]) porEan[k] = [];
        porEan[k].push(item);
      }
    });
    return { porCodigo: porCodigo, porEan: porEan, total: total };
  }

  function _fmt(it) { return { codigo: it.c, ean: it.e, desc: it.d, un: it.u, estoque: it.q, custo: (it.k == null ? null : it.k) }; }

  // 1) código interno exato; 2) EAN normalizado; 3) UPC-A de 12 dígitos com 0 na frente.
  // Devolve null, {codigo,ean,desc,un,estoque} ou {multiplos:[...]} se o EAN é de vários produtos.
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

  // Quebra o catálogo em blocos (1 doc Firestore por bloco). Descrição truncada em 120.
  function montarBlocos(itens, tam) {
    tam = tam || 1000;
    var out = [];
    for (var i = 0; i < itens.length; i += tam) {
      out.push(itens.slice(i, i + tam).map(function (it) {
        return { c: it.c || '', e: it.e || '', d: String(it.d || '').slice(0, 120), u: it.u || '', q: (it.q == null ? null : it.q), k: (it.k == null ? null : it.k) };
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

  // Descobre qual coluna é o quê. Com cabeçalho: por nome. Sem: por formato dos dados.
  function mapearColunas(header, linhas) {
    var h = (header || []).map(function (x) { return String(x).toLowerCase(); });
    var idx = function (re) { for (var i = 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; };
    var ean = idx(/ean|gtin|barra/), codigo = idx(/^cod|codigo|código|sku/), desc = idx(/desc|nome|produto/), un = idx(/^un|unid|emb/), estoque = idx(/estoq|saldo|qtd/), custo = idx(/custo/);
    var temHeader = (ean >= 0 || codigo >= 0 || desc >= 0);
    if (!temHeader) {
      var amostra = [header].concat(linhas || []).slice(0, 5);
      var ncol = header.length;
      var score = function (i, re) { var n = 0; amostra.forEach(function (r) { if (re.test(String(r[i] || ''))) n++; }); return n; };
      ean = codigo = desc = un = estoque = custo = -1;
      for (var i = 0; i < ncol; i++) {
        if (ean < 0 && score(i, /^\d{8}$|^\d{12,14}$/) >= amostra.length) { ean = i; continue; }
        if (codigo < 0 && score(i, /^\d{1,7}$/) >= amostra.length) { codigo = i; continue; }
        if (un < 0 && score(i, /^[A-Za-z]{1,6}$/) >= amostra.length) { un = i; continue; }
        if (desc < 0 && score(i, /[A-Za-z]{3,}/) >= amostra.length) { desc = i; continue; }
      }
    }
    return { codigo: codigo, ean: ean, desc: desc, un: un, estoque: estoque, custo: custo, temHeader: temHeader };
  }

  // Leitor Bluetooth (keyboard wedge) digita um código inteiro em poucos ms.
  // Devolve o buffer quando passa de minChars em rajada; humano digitando devagar nunca dispara.
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

  // Resultado do balanço: contado × estoque do sistema por produto, totais e endereços suspeitos.
  // bips: docs de inv_bipagens. resolucoes: {endereco: {rodada}} (auditoria com 2 rodadas).
  function calcularResultado(cat, bips, resolucoes) {
    resolucoes = resolucoes || {};
    var contado = {}, porEnd = {};
    function keyOf(b) {
      if (b.codigo) return 'c:' + b.codigo;
      var it = resolverCodigo(cat, b.ean);
      if (it && !it.multiplos && it.codigo) return 'c:' + it.codigo;
      return 'e:' + normEan(b.ean);
    }
    (bips || []).forEach(function (b) {
      var correcao = (b.modo === 'correcao' || b.endereco === '_CORRECAO');
      if (!correcao) { var r = resolucoes[b.endereco]; if (r && (b.rodada || 1) !== r.rodada) return; }
      var k = keyOf(b), q = Number(b.qty) || 0;
      contado[k] = (contado[k] || 0) + q;
      if (!correcao && b.endereco) { porEnd[b.endereco] = porEnd[b.endereco] || {}; porEnd[b.endereco][k] = (porEnd[b.endereco][k] || 0) + q; }
    });
    function mk(k, it, cont, nc) {
      var sis = (it.q == null ? null : Number(it.q));
      var dif = (sis == null ? null : cont - sis);
      var custo = (it.k == null ? null : Number(it.k));
      return { key: k, codigo: it.c || '', ean: it.e || '', desc: it.d || '', un: it.u || '', sistema: sis, contado: cont, dif: dif, custo: custo, valor: (dif != null && custo != null) ? dif * custo : null, nc: !!nc };
    }
    var linhas = [], vistos = {};
    Object.keys(cat.porCodigo).forEach(function (cod) { var k = 'c:' + cod; vistos[k] = 1; linhas.push(mk(k, cat.porCodigo[cod], contado[k] || 0)); });
    Object.keys(cat.porEan).forEach(function (e) { cat.porEan[e].forEach(function (it) { if (it.c) return; var k = 'e:' + e; if (vistos[k]) return; vistos[k] = 1; linhas.push(mk(k, it, contado[k] || 0)); }); });
    Object.keys(contado).forEach(function (k) { if (vistos[k]) return; vistos[k] = 1; linhas.push(mk(k, { c: k.indexOf('c:') === 0 ? k.slice(2) : '', e: k.indexOf('e:') === 0 ? k.slice(2) : '', d: '(não cadastrado)', u: '', q: null, k: null }, contado[k], true)); });
    var tot = { itens: linhas.length, divergentes: 0, sobraUn: 0, faltaUn: 0, sobraVal: 0, faltaVal: 0, semCusto: 0, naoCadastrados: 0 };
    linhas.forEach(function (l) {
      if (l.nc) tot.naoCadastrados++;
      if (l.dif == null || l.dif === 0) return;
      tot.divergentes++;
      if (l.dif > 0) { tot.sobraUn += l.dif; if (l.valor != null) tot.sobraVal += l.valor; else tot.semCusto++; }
      else { tot.faltaUn += -l.dif; if (l.valor != null) tot.faltaVal += -l.valor; else tot.semCusto++; }
    });
    var byKey = {}; linhas.forEach(function (l) { byKey[l.key] = l; });
    var enderecos = Object.keys(porEnd).map(function (e) {
      var score = 0, un = 0, itens = 0;
      Object.keys(porEnd[e]).forEach(function (k) {
        var l = byKey[k]; if (!l || !l.dif || !l.contado) return;
        var parte = porEnd[e][k] / l.contado;
        un += Math.abs(l.dif) * parte; score += (l.valor != null ? Math.abs(l.valor) : Math.abs(l.dif)) * parte; itens++;
      });
      return { endereco: e, score: score, unidades: un, itensDivergentes: itens };
    }).sort(function (a, b) { return b.score - a.score; });
    var peso = function (l) { return Math.abs(l.valor != null ? l.valor : (l.dif || 0)); };
    linhas.sort(function (a, b) { return peso(b) - peso(a); });
    return { linhas: linhas, totais: tot, enderecos: enderecos };
  }

  return { normEan: normEan, criarCatalogo: criarCatalogo, resolverCodigo: resolverCodigo, montarBlocos: montarBlocos, parseCatalogoTexto: parseCatalogoTexto, mapearColunas: mapearColunas, criarDetectorRajada: criarDetectorRajada, calcularResultado: calcularResultado };
});
