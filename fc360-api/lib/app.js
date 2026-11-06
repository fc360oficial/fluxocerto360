// FC360 API — checklist no Postgres do .254 (substitui as coleções resultados,
// resultados_fotos, fotos e checkstates do Firestore).
//
// createApp recebe tudo injetado (pool, pasta das fotos, função de autenticação)
// pra rodar igual em produção e nos testes. Toda consulta filtra por cliente_id
// do usuário autenticado — nunca pelo clienteId que vier no corpo.
'use strict';
const express = require('express');
const cors = require('cors');
const fotosDisco = require('./fotos-disco');
const documentos = require('./documentos');
const { gravarSync, hojeIso, dataValida, str } = require('./gravar');

const LIMITE_JSON = '30mb';

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
  // O app consulta as mesmas URLs o tempo todo (/resultados?desde=..., /envios?date=...):
  // nada de cache HTTP, senão o navegador devolve a resposta velha e o "ao vivo" morre.
  // (/fotos/:id/arquivo sobrescreve com cache privado, imagem não muda.)
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/health', async (req, res) => {
    let db = 'ok';
    try { await pool.query('SELECT 1'); } catch (e) { db = 'erro: ' + e.message; }
    res.json({ ok: db === 'ok', build, db, agora: new Date().toISOString() });
  });

  // ── login próprio (fase 3) — pública ──────────────────────────────────────
  const auth = opts.auth || null;
  app.post('/auth/login', async (req, res) => {
    if (!auth) return res.status(501).json({ error: 'login próprio não configurado' });
    try {
      const r = await auth.login(req.body && req.body.email, req.body && req.body.senha);
      await pool.query('INSERT INTO envio_log (cliente_id, user_id, loja, tipo, ref_id, bytes, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [r.usuario.clienteId || '', r.usuario.id, r.usuario.loja || '', 'login', r.usuario.email || '', 0, str(req.ip, 60)]).catch(() => {});
      res.json(r);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── autenticação ──────────────────────────────────────────────────────────
  app.use(async (req, res, next) => {
    try {
      const u = await autenticar(req);
      // superadmin não tem tenant; todo mundo mais precisa de um
      if (!u || (!u.clienteId && u.perfil !== 'superadmin')) return res.status(401).json({ error: 'Não autenticado' });
      req.usuario = { id: str(u.id, 120), email: str(u.email, 200), clienteId: str(u.clienteId, 60),
        loja: str(u.loja, 120), nome: str(u.nome, 200), perfil: str(u.perfil, 40), imp: !!u.imp };
      next();
    } catch (e) {
      res.status(e.status === 403 ? 403 : 401).json({ error: 'Token inválido: ' + e.message });
    }
  });

  app.get('/auth/me', async (req, res) => {
    if (req.usuario.imp || req.usuario.perfil === 'superadmin' && !auth) return res.json(req.usuario);
    const u = auth ? await auth.usuarioPorId(req.usuario.id) : null;
    if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(documentos.limparSensiveis('usuarios', u));
  });

  const gestor = p => ['admin', 'gerencia', 'supervisor', 'superadmin'].includes(p);

  // admin cria usuário (documento + senha). superadmin pode criar pra qualquer cliente.
  app.post('/auth/usuarios', async (req, res) => {
    if (!auth) return res.status(501).json({ error: 'login próprio não configurado' });
    if (!gestor(req.usuario.perfil)) return res.status(403).json({ error: 'Sem permissão' });
    const dados = req.body && req.body.usuario && typeof req.body.usuario === 'object' ? Object.assign({}, req.body.usuario) : null;
    const senha = req.body && req.body.senha;
    if (!dados || !dados.email || !senha || String(senha).length < 4) return res.status(400).json({ error: 'usuario (com email) e senha (mín. 4) são obrigatórios' });
    dados.email = String(dados.email).trim().toLowerCase();
    if (req.usuario.perfil !== 'superadmin') dados.clienteId = req.usuario.clienteId;
    if (!dados.clienteId) return res.status(400).json({ error: 'clienteId obrigatório' });
    if (dados.perfil === 'superadmin' && req.usuario.perfil !== 'superadmin') return res.status(403).json({ error: 'Sem permissão' });
    const id = str(dados.id || ('id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)), 120);
    dados.id = id;
    delete dados.senha; delete dados._fbNewPass;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const dup = await client.query("SELECT id FROM documento WHERE colecao='usuarios' AND lower(dados->>'email')=$1 AND id<>$2", [dados.email, id]);
      if (dup.rows.length) { await client.query('ROLLBACK'); client.release(); return res.status(409).json({ error: 'Já existe usuário com esse e-mail' }); }
      await client.query(`INSERT INTO documento (colecao, id, cliente_id, dados) VALUES ('usuarios',$1,$2,$3)
        ON CONFLICT (colecao, id) DO UPDATE SET dados = EXCLUDED.dados, cliente_id = EXCLUDED.cliente_id, atualizado_em = now()`, [id, dados.clienteId, JSON.stringify(dados)]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); client.release(); return res.status(500).json({ error: e.message }); }
    client.release();
    await auth.definirSenha(id, dados.email, senha, 'bcrypt');
    auth.esquecer(id);
    res.json({ ok: true, id });
  });

  // troca de senha: a própria, ou de alguém do mesmo cliente se for gestor
  app.post('/auth/senha', async (req, res) => {
    if (!auth) return res.status(501).json({ error: 'login próprio não configurado' });
    const alvoId = str(req.body && req.body.usuarioId || req.usuario.id, 120);
    const senha = req.body && req.body.senha;
    if (!senha || String(senha).length < 4) return res.status(400).json({ error: 'senha (mín. 4) obrigatória' });
    const alvo = await auth.usuarioPorId(alvoId);
    if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado' });
    const mesmoCliente = (alvo.clienteId || 'economico') === req.usuario.clienteId;
    if (!(alvoId === req.usuario.id || req.usuario.perfil === 'superadmin' || (gestor(req.usuario.perfil) && mesmoCliente))) return res.status(403).json({ error: 'Sem permissão' });
    await auth.definirSenha(alvoId, alvo.email, senha, 'bcrypt');
    await pool.query("UPDATE documento SET dados = dados - 'senha' - '_fbNewPass', atualizado_em = now() WHERE colecao='usuarios' AND id=$1", [alvoId]);
    auth.esquecer(alvoId);
    res.json({ ok: true });
  });

  // superadmin entra como um cliente (token descreve o usuário sintético)
  app.post('/auth/impersonar', async (req, res) => {
    if (!auth) return res.status(501).json({ error: 'login próprio não configurado' });
    if (req.usuario.perfil !== 'superadmin') return res.status(403).json({ error: 'Sem permissão' });
    const clienteId = str(req.body && req.body.clienteId, 60);
    if (!clienteId) return res.status(400).json({ error: 'clienteId obrigatório' });
    const token = auth.emitir({ id: 'superadmin', email: req.usuario.email, nome: 'Super Admin', perfil: 'admin', clienteId, loja: '' }, { imp: true });
    res.json({ token });
  });

  // ── coleções genéricas (fase 3) ───────────────────────────────────────────
  function lerJson(v) { if (v === undefined || v === '') return undefined; try { return JSON.parse(v); } catch { throw new Error('parâmetro inválido: ' + String(v).slice(0, 60)); } }
  app.get('/col/:nome', async (req, res) => {
    const nome = str(req.params.nome, 160);
    if (/[^a-zA-Z0-9_\/-]/.test(nome)) return res.status(400).json({ error: 'coleção inválida' });
    try {
      const q = { where: lerJson(req.query.where), orderBy: lerJson(req.query.orderBy), limit: req.query.limit,
        ids: req.query.ids ? String(req.query.ids).split(',').filter(Boolean) : undefined };
      // 'resultados' mora na tabela própria (fase 2); aqui só o que o "zerar dados" do admin precisa
      if (nome === 'resultados') {
        const lim = Math.min(Math.max(parseInt(q.limit, 10) || 400, 1), 2000);
        if (req.query.count === '1') { const c = await pool.query('SELECT count(*)::int AS n FROM resultado WHERE cliente_id=$1', [req.usuario.clienteId]); return res.json({ count: c.rows[0].n }); }
        const r = await pool.query('SELECT id, dados FROM resultado WHERE cliente_id=$1 ORDER BY date_iso LIMIT ' + lim, [req.usuario.clienteId]);
        return res.json(r.rows.map(x => Object.assign({ id: x.id }, x.dados)));
      }
      if (req.query.count === '1') {
        const c = documentos.montarConsulta(req.usuario, nome, q);
        if (!c) return res.json({ count: 0 });
        const r = await pool.query('SELECT count(*)::int AS n FROM (' + c.sql.replace(/ LIMIT \d+$/, '') + ') t', c.params);
        return res.json({ count: r.rows[0].n });
      }
      res.json(await documentos.consultar(pool, req.usuario, nome, q));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/col/:nome/:id', async (req, res) => {
    const nome = str(req.params.nome, 160);
    if (/[^a-zA-Z0-9_\/-]/.test(nome)) return res.status(400).json({ error: 'coleção inválida' });
    const d = await documentos.buscar(pool, req.usuario, nome, str(req.params.id, 200));
    if (!d) return res.status(404).json({ error: 'Documento não encontrado' });
    res.json(d);
  });

  async function sync(req, res) {
    const corpo = req.body && typeof req.body === 'object' ? req.body : {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await gravarSync(client, req.usuario, corpo, req.ip || '', fotosRaiz);
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

  function fotoJson(f, comBase64) {
    const o = { id: f.id, colecao: f.colecao, loja: f.loja, userId: f.user_id, date: f.date_iso, resultadoId: f.resultado_id,
      mime: f.mime, bytes: f.bytes, recebidoEm: f.recebido_em, url: '/fotos/' + encodeURIComponent(f.id) + '/arquivo' };
    Object.assign(o, f.meta || {});
    if (comBase64) {
      const buf = fotosDisco.ler(fotosRaiz, f.arquivo);
      o.base64 = buf ? fotosDisco.comoDataUri(f.mime, buf) : null;
    }
    return o;
  }

  const SELECT_FOTO = `SELECT id, colecao, loja, user_id, to_char(date_iso,'YYYY-MM-DD') AS date_iso, resultado_id, meta, arquivo, mime, bytes, recebido_em FROM foto`;

  // ?comBase64=1 devolve a imagem junto (data URI) — pra restaurar as fotos do dia do
  // operador e pra abrir o detalhe de um envio (poucas fotos, já filtradas por dia/resultado).
  app.get('/fotos', async (req, res) => {
    const params = [req.usuario.clienteId];
    let where = 'cliente_id=$1';
    if (dataValida(req.query.date)) { params.push(req.query.date); where += ' AND date_iso=$' + params.length; }
    if (req.query.userId) { params.push(str(req.query.userId, 120)); where += ' AND user_id=$' + params.length; }
    if (req.query.colecao) { params.push(str(req.query.colecao, 40)); where += ' AND colecao=$' + params.length; }
    if (req.query.resultadoId) { params.push(str(req.query.resultadoId, 200)); where += ' AND resultado_id=$' + params.length; }
    if (params.length === 1) { params.push(hojeIso()); where += ' AND date_iso=$2'; }
    const { rows } = await pool.query(`${SELECT_FOTO} WHERE ${where} ORDER BY recebido_em`, params);
    res.json(rows.map(f => fotoJson(f, req.query.comBase64 === '1')));
  });

  async function buscarFoto(req) {
    const { rows } = await pool.query(`${SELECT_FOTO} WHERE cliente_id=$1 AND id=$2`, [req.usuario.clienteId, str(req.params.id, 200)]);
    return rows[0] || null;
  }

  app.get('/fotos/:id', async (req, res) => {
    const f = await buscarFoto(req);
    if (!f) return res.status(404).json({ error: 'Foto não encontrada' });
    const o = fotoJson(f, true);
    if (!o.base64) return res.status(410).json({ error: 'Arquivo da foto não está mais no disco' });
    res.json(o);
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
