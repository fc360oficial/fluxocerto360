// FC360 API — checklist no Postgres do .254 (substitui as coleções resultados,
// resultados_fotos, fotos e checkstates do Firestore).
//
// createApp recebe tudo injetado (pool, pasta das fotos, função de autenticação)
// pra rodar igual em produção e nos testes. Toda consulta filtra por cliente_id
// do usuário autenticado — nunca pelo clienteId que vier no corpo.
'use strict';
const express = require('express');
const cors = require('cors');
const path = require('path');
const fotosDisco = require('./fotos-disco');
const ResultadosCore = require('./resultados-core');

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE_JSON = '30mb';

function dataValida(s) { return typeof s === 'string' && DATA_RE.test(s); }
function str(v, max) { return (v === undefined || v === null) ? '' : String(v).slice(0, max || 200); }
function hojeIso() {
  // Data local do Brasil (as lojas mandam dateISO; isto é só fallback).
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function createApp(opts) {
  const { pool, fotosRaiz, autenticar } = opts;
  const build = opts.build || 'dev';
  const origens = opts.origens || ['https://fc360oficial.github.io'];
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(cors({
    origin: origens,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600
  }));
  app.use(express.json({ limit: LIMITE_JSON }));

  app.get('/health', async (req, res) => {
    let db = 'ok';
    try { await pool.query('SELECT 1'); } catch (e) { db = 'erro: ' + e.message; }
    res.json({ ok: db === 'ok', build, db, agora: new Date().toISOString() });
  });

  // ── autenticação ──────────────────────────────────────────────────────────
  app.use(async (req, res, next) => {
    try {
      const u = await autenticar(req);
      if (!u || !u.clienteId) return res.status(401).json({ error: 'Não autenticado' });
      req.usuario = { id: str(u.id, 120), email: str(u.email, 200), clienteId: str(u.clienteId, 60),
        loja: str(u.loja, 120), nome: str(u.nome, 200), perfil: str(u.perfil, 40) };
      next();
    } catch (e) {
      res.status(401).json({ error: 'Token inválido: ' + e.message });
    }
  });

  function ipDe(req) { return str(req.ip || '', 60); }

  // ── gravação (tudo numa transação) ────────────────────────────────────────
  async function gravarSync(client, usuario, corpo, ip) {
    const out = { resultados: [], resultados_fotos: [], fotos: [], checkstates: [], rejeitados: [] };
    const cliente = usuario.clienteId;
    const log = (tipo, refId, bytes) => client.query(
      'INSERT INTO envio_log (cliente_id, user_id, loja, tipo, ref_id, bytes, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [cliente, usuario.id, usuario.loja, tipo, str(refId, 200), bytes | 0, ip]);

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
      const dateIso = dataValida(doc.dateISO) ? doc.dateISO : hojeIso();
      doc.dateISO = dateIso;
      await client.query(
        `INSERT INTO resultado (id, cliente_id, loja, operador, user_id, checklist_id, checklist_nome, date_iso, data_hora, pct, resetado, manual, dados)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET loja=EXCLUDED.loja, operador=EXCLUDED.operador, checklist_id=EXCLUDED.checklist_id,
           checklist_nome=EXCLUDED.checklist_nome, date_iso=EXCLUDED.date_iso, data_hora=EXCLUDED.data_hora, pct=EXCLUDED.pct,
           resetado=EXCLUDED.resetado, manual=EXCLUDED.manual, dados=EXCLUDED.dados, atualizado_em=now()`,
        [str(doc.id, 200), cliente, str(doc.loja || usuario.loja, 120), str(doc.operador || usuario.nome, 200),
          str(doc.userId || usuario.id, 120), str(doc.checklistId, 200), str(doc.checklistNome || doc.label, 300), dateIso,
          str(doc.dataHora, 40), Number.isFinite(+doc.pct) ? Math.round(+doc.pct) : null, !!doc.resetado, !!doc.manual,
          JSON.stringify(doc)]);
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
    return out;
  }

  async function sync(req, res) {
    const corpo = req.body && typeof req.body === 'object' ? req.body : {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await gravarSync(client, req.usuario, corpo, ipDe(req));
      await client.query('COMMIT');
      res.json(Object.assign({ ok: true }, out));
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* já caiu */ }
      res.status(500).json({ error: 'Falha ao gravar: ' + e.message });
    } finally {
      client.release();
    }
  }

  app.post('/sync', sync);
  app.post('/resultados', (req, res) => { req.body = { resultados: [req.body] }; return sync(req, res); });

  // ── leitura ───────────────────────────────────────────────────────────────
  app.get('/resultados', async (req, res) => {
    const desde = dataValida(req.query.desde) ? req.query.desde : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const ate = dataValida(req.query.ate) ? req.query.ate : '9999-12-31';
    const params = [req.usuario.clienteId, desde, ate];
    let where = 'cliente_id=$1 AND date_iso >= $2 AND date_iso <= $3';
    if (req.query.loja) { params.push(str(req.query.loja, 120)); where += ' AND loja=$' + params.length; }
    const { rows } = await pool.query(`SELECT dados, recebido_em FROM resultado WHERE ${where} ORDER BY date_iso, recebido_em`, params);
    res.json(rows.map(r => Object.assign({}, r.dados, { _recebidoEm: r.recebido_em })));
  });

  app.get('/resultados/:id', async (req, res) => {
    const { rows } = await pool.query('SELECT dados, recebido_em FROM resultado WHERE cliente_id=$1 AND id=$2', [req.usuario.clienteId, str(req.params.id, 200)]);
    if (!rows.length) return res.status(404).json({ error: 'Resultado não encontrado' });
    const fotos = await pool.query('SELECT id, meta, mime, bytes FROM foto WHERE cliente_id=$1 AND resultado_id=$2 ORDER BY id', [req.usuario.clienteId, str(req.params.id, 200)]);
    res.json(Object.assign({}, rows[0].dados, { _recebidoEm: rows[0].recebido_em,
      _fotos: fotos.rows.map(f => ({ id: f.id, slot: f.meta && f.meta.slot, mime: f.mime, bytes: f.bytes, url: '/fotos/' + encodeURIComponent(f.id) + '/arquivo' })) }));
  });

  app.get('/envios', async (req, res) => {
    const date = dataValida(req.query.date) ? req.query.date : hojeIso();
    const { rows } = await pool.query(
      `SELECT id, loja, operador, checklist_id, checklist_nome, pct, data_hora, resetado, manual, recebido_em
       FROM resultado WHERE cliente_id=$1 AND date_iso=$2 ORDER BY recebido_em`, [req.usuario.clienteId, date]);
    res.json(rows.map(r => ({ id: r.id, loja: r.loja, operador: r.operador, checklistId: r.checklist_id, checklistNome: r.checklist_nome,
      pct: r.pct, dataHora: r.data_hora, resetado: r.resetado, manual: r.manual, recebidoEm: r.recebido_em })));
  });

  function fotoJson(f, comBase64, buf) {
    const o = { id: f.id, colecao: f.colecao, loja: f.loja, userId: f.user_id, date: f.date_iso, resultadoId: f.resultado_id,
      mime: f.mime, bytes: f.bytes, recebidoEm: f.recebido_em, url: '/fotos/' + encodeURIComponent(f.id) + '/arquivo' };
    Object.assign(o, f.meta || {});
    if (comBase64 && buf) o.base64 = fotosDisco.comoDataUri(f.mime, buf);
    return o;
  }

  app.get('/fotos', async (req, res) => {
    const params = [req.usuario.clienteId];
    let where = 'cliente_id=$1';
    if (dataValida(req.query.date)) { params.push(req.query.date); where += ' AND date_iso=$' + params.length; }
    if (req.query.userId) { params.push(str(req.query.userId, 120)); where += ' AND user_id=$' + params.length; }
    if (req.query.colecao) { params.push(str(req.query.colecao, 40)); where += ' AND colecao=$' + params.length; }
    if (req.query.resultadoId) { params.push(str(req.query.resultadoId, 200)); where += ' AND resultado_id=$' + params.length; }
    if (params.length === 1) { params.push(hojeIso()); where += ' AND date_iso=$2'; }
    const { rows } = await pool.query(`SELECT id, colecao, loja, user_id, to_char(date_iso,'YYYY-MM-DD') AS date_iso, resultado_id, meta, mime, bytes, recebido_em FROM foto WHERE ${where} ORDER BY recebido_em`, params);
    res.json(rows.map(f => fotoJson(f, false)));
  });

  async function buscarFoto(req) {
    const { rows } = await pool.query(`SELECT id, colecao, loja, user_id, to_char(date_iso,'YYYY-MM-DD') AS date_iso, resultado_id, meta, arquivo, mime, bytes, recebido_em FROM foto WHERE cliente_id=$1 AND id=$2`, [req.usuario.clienteId, str(req.params.id, 200)]);
    return rows[0] || null;
  }

  app.get('/fotos/:id', async (req, res) => {
    const f = await buscarFoto(req);
    if (!f) return res.status(404).json({ error: 'Foto não encontrada' });
    const buf = fotosDisco.ler(fotosRaiz, f.arquivo);
    if (!buf) return res.status(410).json({ error: 'Arquivo da foto não está mais no disco' });
    res.json(fotoJson(f, true, buf));
  });

  app.get('/fotos/:id/arquivo', async (req, res) => {
    const f = await buscarFoto(req);
    if (!f) return res.status(404).json({ error: 'Foto não encontrada' });
    const buf = fotosDisco.ler(fotosRaiz, f.arquivo);
    if (!buf) return res.status(410).json({ error: 'Arquivo da foto não está mais no disco' });
    res.set('Content-Type', f.mime);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  });

  app.get('/checkstates/:id', async (req, res) => {
    const { rows } = await pool.query('SELECT id, user_id, to_char(date_iso,\'YYYY-MM-DD\') AS date_iso, state, atualizado_em FROM checkstate WHERE cliente_id=$1 AND id=$2', [req.usuario.clienteId, str(req.params.id, 200)]);
    if (!rows.length) return res.status(404).json({ error: 'Estado não encontrado' });
    const r = rows[0];
    res.json({ id: r.id, userId: r.user_id, date: r.date_iso, state: r.state, atualizadoEm: r.atualizado_em });
  });

  app.put('/checkstates/:id', (req, res) => {
    const cs = Object.assign({}, req.body || {}, { id: req.params.id });
    req.body = { checkstates: [cs] };
    return sync(req, res);
  });

  // 404 em JSON (o app lê sempre JSON) e erro genérico sem vazar stack.
  app.use((req, res) => res.status(404).json({ error: 'Rota não existe: ' + req.method + ' ' + req.path }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.type === 'entity.too.large' ? 413 : (err.status || 500);
    res.status(status).json({ error: status === 413 ? 'Envio grande demais (limite ' + LIMITE_JSON + ')' : (err.message || 'erro') });
  });

  return app;
}

module.exports = { createApp, hojeIso };
