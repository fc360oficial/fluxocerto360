// Gravação de um corpo de /sync dentro de uma transação já aberta (client do pg).
// Separado do app pra ser reaproveitado pelo importador do histórico do Firestore
// (tools/backfill-firestore.js), que grava exatamente do mesmo jeito.
//
// corpo = { resultados[], resultados_fotos[], fotos[], checkstates[], patches[] }
// usuario = { id, clienteId, loja, nome }  — cliente_id vem SEMPRE daqui.
'use strict';
const fotosDisco = require('./fotos-disco');
const ResultadosCore = require('./resultados-core');
const documentos = require('./documentos');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
function dataValida(s) { return typeof s === 'string' && DATA_RE.test(s); }
function str(v, max) { return (v === undefined || v === null) ? '' : String(v).slice(0, max || 200); }
function hojeIso() {
  // Data local do Brasil (as lojas mandam dateISO; isto é só fallback).
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function colunasDe(doc, usuario) {
  return [
    str(doc.loja || usuario.loja, 120), str(doc.operador || usuario.nome, 200), str(doc.userId || usuario.id, 120),
    str(doc.checklistId, 200), str(doc.checklistNome || doc.label, 300), doc.dateISO, str(doc.dataHora, 40),
    Number.isFinite(+doc.pct) ? Math.round(+doc.pct) : null, !!doc.resetado, !!doc.manual,
  ];
}

async function gravarSync(client, usuario, corpo, ip, fotosRaiz, opts) {
  opts = opts || {};
  const out = { resultados: [], resultados_fotos: [], fotos: [], checkstates: [], patches: [], rejeitados: [] };
  const cliente = usuario.clienteId;
  const log = opts.semLog ? async () => {} : (tipo, refId, bytes) => client.query(
    'INSERT INTO envio_log (cliente_id, user_id, loja, tipo, ref_id, bytes, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [cliente, usuario.id, usuario.loja, tipo, str(refId, 200), bytes | 0, str(ip, 60)]);

  async function gravarFoto(colecao, item, extra) {
    const id = str(item && item.id, 200);
    const dataUri = item && (item.data || item.base64);
    if (!id) { out.rejeitados.push({ tipo: colecao, id: '', motivo: 'sem id' }); return null; }
    const dateIso = dataValida(item.dateISO) ? item.dateISO : (dataValida(item.date) ? item.date : null);
    const salvo = fotosDisco.salvar(fotosRaiz, { clienteId: cliente, dateIso: dateIso || 'sem-data', id, dataUri });
    if (!salvo) { out.rejeitados.push({ tipo: colecao, id, motivo: 'imagem inválida (esperado data:image/...;base64,...)' }); return null; }
    const meta = Object.assign({}, extra || {});
    await client.query(
      `INSERT INTO foto (id, colecao, cliente_id, loja, user_id, date_iso, resultado_id, meta, arquivo, mime, bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET loja=EXCLUDED.loja, user_id=EXCLUDED.user_id, date_iso=EXCLUDED.date_iso,
         resultado_id=EXCLUDED.resultado_id, meta=EXCLUDED.meta, arquivo=EXCLUDED.arquivo, mime=EXCLUDED.mime,
         bytes=EXCLUDED.bytes, recebido_em=now()`,
      [id, colecao, cliente, str(item.loja || usuario.loja, 120), str(item.userId || usuario.id, 120), dateIso,
        item.resultadoId ? str(item.resultadoId, 200) : null, JSON.stringify(meta), salvo.arquivo, salvo.mime, salvo.bytes]);
    await log(colecao, id, salvo.bytes);
    return id;
  }

  // resultados: aceita o doc já separado (refs) ou com base64 dentro (separa aqui)
  for (const bruto of corpo.resultados || []) {
    if (!bruto || !bruto.id) { out.rejeitados.push({ tipo: 'resultados', id: '', motivo: 'sem id' }); continue; }
    const sep = ResultadosCore.separarFotos(Object.assign({}, bruto, { clienteId: cliente }));
    const doc = sep.doc;
    doc.dateISO = dataValida(doc.dateISO) ? doc.dateISO : hojeIso();
    const cols = colunasDe(doc, usuario);
    await client.query(
      `INSERT INTO resultado (id, cliente_id, loja, operador, user_id, checklist_id, checklist_nome, date_iso, data_hora, pct, resetado, manual, dados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET loja=EXCLUDED.loja, operador=EXCLUDED.operador, user_id=EXCLUDED.user_id, checklist_id=EXCLUDED.checklist_id,
         checklist_nome=EXCLUDED.checklist_nome, date_iso=EXCLUDED.date_iso, data_hora=EXCLUDED.data_hora, pct=EXCLUDED.pct,
         resetado=EXCLUDED.resetado, manual=EXCLUDED.manual, dados=EXCLUDED.dados, atualizado_em=now()`,
      [str(doc.id, 200), cliente].concat(cols, [JSON.stringify(doc)]));
    await log('resultados', doc.id, JSON.stringify(doc).length);
    out.resultados.push(doc.id);
    for (const f of sep.fotos) {
      const id = await gravarFoto('resultados_fotos', Object.assign({ id: f.id }, f.data), { slot: f.data.slot });
      if (id) out.resultados_fotos.push(id);
    }
  }
  for (const f of corpo.resultados_fotos || []) {
    const id = await gravarFoto('resultados_fotos', f, { slot: str(f && f.slot, 60) });
    if (id) out.resultados_fotos.push(id);
  }
  for (const f of corpo.fotos || []) {
    const id = await gravarFoto('fotos', f, { clId: str(f && f.clId, 120), tipo: str(f && f.tipo, 60), idx: f && f.idx, operador: str(f && f.operador, 200) });
    if (id) out.fotos.push(id);
  }
  for (const cs of corpo.checkstates || []) {
    const id = str(cs && cs.id, 200);
    if (!id) { out.rejeitados.push({ tipo: 'checkstates', id: '', motivo: 'sem id' }); continue; }
    const dateIso = dataValida(cs.date) ? cs.date : (dataValida(cs.localDate) ? cs.localDate : hojeIso());
    let state = cs.state;
    if (typeof state === 'string') { try { state = JSON.parse(state); } catch { out.rejeitados.push({ tipo: 'checkstates', id, motivo: 'state não é JSON' }); continue; } }
    if (!state || typeof state !== 'object') state = {};
    await client.query(
      `INSERT INTO checkstate (id, cliente_id, user_id, date_iso, state) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, date_iso=EXCLUDED.date_iso, state=EXCLUDED.state, atualizado_em=now()`,
      [id, cliente, str(cs.userId || usuario.id, 120), dateIso, JSON.stringify(state)]);
    await log('checkstates', id, JSON.stringify(state).length);
    out.checkstates.push(id);
  }
  // patches: campos mesclados no doc (resetado, substituidoPor, pct, itens...). Só do próprio tenant.
  for (const p of corpo.patches || []) {
    const id = str(p && p.id, 200);
    const campos = p && p.campos && typeof p.campos === 'object' ? p.campos : null;
    if (!id || !campos) { out.rejeitados.push({ tipo: 'patches', id, motivo: 'precisa de id e campos' }); continue; }
    delete campos.id; delete campos.clienteId;
    const { rows } = await client.query('SELECT dados FROM resultado WHERE cliente_id=$1 AND id=$2 FOR UPDATE', [cliente, id]);
    if (!rows.length) { out.rejeitados.push({ tipo: 'patches', id, motivo: 'resultado não encontrado' }); continue; }
    const doc = Object.assign({}, rows[0].dados, campos);
    doc.dateISO = dataValida(doc.dateISO) ? doc.dateISO : hojeIso();
    const cols = colunasDe(doc, usuario);
    await client.query(
      `UPDATE resultado SET loja=$3, operador=$4, user_id=$5, checklist_id=$6, checklist_nome=$7, date_iso=$8, data_hora=$9, pct=$10,
         resetado=$11, manual=$12, dados=$13, atualizado_em=now() WHERE cliente_id=$1 AND id=$2`,
      [cliente, id].concat(cols, [JSON.stringify(doc)]));
    await log('patches', id, JSON.stringify(campos).length);
    out.patches.push(id);
  }
  // ops: coleções genéricas (fase 3) — set/update/delete em `documento`, ver lib/documentos.js
  if (Array.isArray(corpo.ops) && corpo.ops.length) {
    const r = await documentos.aplicarOps(client, usuario, corpo.ops);
    out.ops = r.feitos;
    r.rejeitados.forEach(x => out.rejeitados.push(Object.assign({ tipo: 'ops' }, x)));
    await log('ops', r.feitos.map(f => f.col + '/' + f.id).join(',').slice(0, 200), JSON.stringify(corpo.ops).length);
  }
  return out;
}

module.exports = { gravarSync, hojeIso, dataValida, str };
