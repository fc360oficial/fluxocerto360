// lib/resultados-core.js — lógica pura dos resultados de checklist (roda em Node e no browser).
// Browser: window.ResultadosCore. Node: module.exports. Sem dependência de Firebase/DOM.
//
// Contexto (spec docs/superpowers/specs/2026-09-23-checklist-envio-confiavel-design.md):
// cada envio gravava 14 fotos + assinatura em base64 dentro do próprio doc de
// `resultados` (250 a 660 KB), e todo login baixava a coleção inteira (165 MB).
// Aqui fica o que separa foto de resultado, enxuga docs antigos pro cache,
// calcula a janela de carga e hidrata as fotos de volta pra tela.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResultadosCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLECAO_FOTOS = 'resultados_fotos';

  function ehBase64(v) {
    return typeof v === 'string' && v.indexOf('data:') === 0;
  }

  function copiaItem(item) {
    var c = {};
    for (var k in item) if (Object.prototype.hasOwnProperty.call(item, k)) c[k] = item[k];
    return c;
  }

  function copiaRes(res) {
    var c = {};
    for (var k in res) if (Object.prototype.hasOwnProperty.call(res, k)) c[k] = res[k];
    c.itens = (res.itens || []).map(copiaItem);
    return c;
  }

  // Separa as imagens do resultado. Devolve:
  //   doc   — resultado pronto pra gravar em `resultados` (refs no lugar do base64)
  //   fotos — [{id, data}] pra gravar em `resultados_fotos`, um por imagem
  // Nunca deixa campo undefined no doc (Firestore rejeita).
  function separarFotos(res) {
    var doc = copiaRes(res);
    var fotos = [];
    var meta = { resultadoId: res.id, clienteId: res.clienteId || '', loja: res.loja || '', dateISO: res.dateISO || '' };
    function add(slot, data) {
      var id = res.id + '_' + slot;
      fotos.push({ id: id, data: { resultadoId: meta.resultadoId, clienteId: meta.clienteId, loja: meta.loja, dateISO: meta.dateISO, slot: slot, data: data } });
      return id;
    }
    doc.itens.forEach(function (item, idx) {
      if (ehBase64(item.fotoAntes)) item.fotoAntesRef = add(idx + '_antes', item.fotoAntes);
      if (ehBase64(item.fotoDepois)) item.fotoDepoisRef = add(idx + '_depois', item.fotoDepois);
      if (item.fotosMulti && item.fotosMulti.length) {
        var refs = [];
        item.fotosMulti.forEach(function (f, n) { if (ehBase64(f)) refs.push(add(idx + '_m' + n, f)); });
        if (refs.length) item.fotosMultiRef = refs;
      }
      delete item.fotoAntes; delete item.fotoDepois; delete item.fotosMulti;
    });
    if (ehBase64(res.assinatura)) doc.assinaturaRef = add('assinatura', res.assinatura);
    delete doc.assinatura;
    return { doc: doc, fotos: fotos };
  }

  // Doc antigo (base64 embutido) vira versão leve pro cache: sem imagens e com
  // `_semFotos: true`, pra tela saber que precisa reler o doc inteiro ao abrir
  // o detalhe. Doc novo (refs) ou sem foto passa como cópia, sem marca.
  function enxugar(res) {
    var tinha = ehBase64(res.assinatura);
    var doc = copiaRes(res);
    doc.itens.forEach(function (item) {
      if (ehBase64(item.fotoAntes) || ehBase64(item.fotoDepois) || (item.fotosMulti && item.fotosMulti.length)) tinha = true;
      delete item.fotoAntes; delete item.fotoDepois; delete item.fotosMulti;
    });
    delete doc.assinatura;
    if (tinha) doc._semFotos = true;
    return doc;
  }

  // Descarta docs que o Firestore ainda não confirmou no servidor (latency
  // compensation). É o que impede a tela de dizer "já enviado" antes da hora.
  function filtrarConfirmados(docs) {
    return (docs || []).filter(function (d) { return !(d.metadata && d.metadata.hasPendingWrites); });
  }

  function isoLocal(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // 'YYYY-MM-DD' de `dias` atrás, em data local.
  function janelaISO(dias, hoje) {
    var d = new Date(hoje ? hoje.getTime() : Date.now());
    d.setDate(d.getDate() - (dias || 0));
    return isoLocal(d);
  }

  function precisaCarregar(deISO, carregadoDesde) {
    if (!deISO) return false;
    if (!carregadoDesde) return true;
    return deISO < carregadoDesde;
  }

  // tipo: 'antes' | 'depois' | 'multi' | (vazio = qualquer)
  function itemTemFoto(item, tipo) {
    if (!item) return false;
    var antes = !!(item.fotoAntes || item.fotoAntesRef);
    var depois = !!(item.fotoDepois || item.fotoDepoisRef);
    var multi = !!((item.fotosMulti && item.fotosMulti.length) || (item.fotosMultiRef && item.fotosMultiRef.length));
    if (tipo === 'antes') return antes;
    if (tipo === 'depois') return depois;
    if (tipo === 'multi') return multi;
    return antes || depois || multi;
  }

  function contarFotos(item) {
    if (!item) return 0;
    var n = 0;
    if (item.fotoAntes || item.fotoAntesRef) n++;
    if (item.fotoDepois || item.fotoDepoisRef) n++;
    if (item.fotosMulti && item.fotosMulti.length) n += item.fotosMulti.length;
    else if (item.fotosMultiRef && item.fotosMultiRef.length) n += item.fotosMultiRef.length;
    return n;
  }

  // doc com refs + docs de `resultados_fotos` (o data() de cada um) → cópia do
  // doc com base64 preenchido nos campos que a tela já usa. Foto que não veio
  // do servidor fica null (não quebra o render).
  function montarFotosHidratadas(doc, fotosDocs) {
    var porSlot = {};
    (fotosDocs || []).forEach(function (f) { if (f && f.slot) porSlot[f.slot] = f.data || null; });
    var h = copiaRes(doc);
    delete h._semFotos;
    h.itens.forEach(function (item, idx) {
      if (item.fotoAntesRef) item.fotoAntes = porSlot[idx + '_antes'] || null;
      if (item.fotoDepoisRef) item.fotoDepois = porSlot[idx + '_depois'] || null;
      if (item.fotosMultiRef && item.fotosMultiRef.length) {
        item.fotosMulti = item.fotosMultiRef.map(function (ref, n) { return porSlot[idx + '_m' + n] || null; });
      }
    });
    if (doc.assinaturaRef) h.assinatura = porSlot['assinatura'] || null;
    return h;
  }

  // Junta duas listas de resultados por id (novos vencem) e devolve ordenada
  // por dataHora, como o cache sempre foi.
  function mesclarPorId(lista, novos) {
    var mapa = {};
    var ordem = [];
    (lista || []).concat(novos || []).forEach(function (r) {
      if (!r || !r.id) return;
      if (!mapa[r.id]) ordem.push(r.id);
      mapa[r.id] = r;
    });
    var out = ordem.map(function (id) { return mapa[id]; });
    out.sort(function (a, b) { return (a.dataHora || '') < (b.dataHora || '') ? -1 : 1; });
    return out;
  }

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

  return {
    COLECAO_FOTOS: COLECAO_FOTOS,
    separarFotos: separarFotos,
    enxugar: enxugar,
    filtrarConfirmados: filtrarConfirmados,
    janelaISO: janelaISO,
    precisaCarregar: precisaCarregar,
    itemTemFoto: itemTemFoto,
    contarFotos: contarFotos,
    montarFotosHidratadas: montarFotosHidratadas,
    mesclarPorId: mesclarPorId,
    montarResultadoManual: montarResultadoManual
  };
});
