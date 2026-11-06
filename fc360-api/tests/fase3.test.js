// Fase 3: coleções genéricas (/col, ops em /sync) + login próprio (/auth). Precisa de FC360_TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { migrar } = require('../lib/db');
const { createApp } = require('../lib/app');
const { criarAuth } = require('../lib/auth');
const documentos = require('../lib/documentos');

const URL_DB = process.env.FC360_TEST_DATABASE_URL;

test('documentos: sentinelas, merge e caminhos com ponto (puro)', () => {
  const agora = '2026-11-06T03:00:00.000Z';
  assert.deepEqual(documentos.resolver({ a: 1, t: { __serverTimestamp: true }, x: { __delete: true } }, undefined, agora), { a: 1, t: { __ts: agora } });
  assert.deepEqual(documentos.resolver({ l: { __arrayUnion: [2, 3] } }, { l: [1, 2] }, agora), { l: [1, 2, 3] });
  assert.deepEqual(documentos.mesclar({ a: { b: 1, c: 2 }, k: 'x' }, { a: { c: 3 }, k: { __delete: true } }, agora), { a: { b: 1, c: 3 } });
  assert.deepEqual(documentos.atualizar({ push: { p1: 'a', p2: 'b' }, n: 1 }, { 'push.p1': { __delete: true }, 'push.p3': 'c', n: 2 }, agora), { push: { p2: 'b', p3: 'c' }, n: 2 });
  assert.deepEqual(documentos.atualizar({}, { 'coletoresReg.k': { coletorId: 'c1', registradoEm: { __serverTimestamp: true } } }, agora), { coletoresReg: { k: { coletorId: 'c1', registradoEm: { __ts: agora } } } });
});

test('documentos: montarConsulta traduz where/orderBy/limit e escopo', () => {
  const u = { id: 'u1', clienteId: 'economico', perfil: 'prevencao' };
  const c = documentos.montarConsulta(u, 'planos', { where: [['status', 'in', ['aberto', 'andamento']], ['prazoFim', '>=', '2026-01-01'], ['loja', '==', 'Cahu'], ['x', '==', null]], orderBy: [['criadoEm', 'desc']], limit: 10 });
  assert.match(c.sql, /colecao = \$1 AND cliente_id = \$2/);
  assert.match(c.sql, /= ANY\(\$4::jsonb\[\]\)/);
  assert.match(c.sql, /dados #>> \$5::text\[\] >= \$6/);
  assert.match(c.sql, /ORDER BY dados #> \$\d+::text\[\] DESC NULLS LAST LIMIT 10$/);
  const sup = documentos.montarConsulta({ id: 's', clienteId: '', perfil: 'superadmin' }, 'clientes', {});
  assert.doesNotMatch(sup.sql, /cliente_id/);
  assert.equal(documentos.montarConsulta(u, 'config', {}), null, 'config só superadmin');
  const cli = documentos.montarConsulta(u, 'clientes', {});
  assert.match(cli.sql, /id = ANY\(\$2::text\[\]\)/);
});

(URL_DB ? test : test.skip)('fase 3 na API', async (t) => {
  const schema = 'fc360_f3_' + Date.now();
  const raiz = new Pool({ connectionString: URL_DB, max: 2 });
  await raiz.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, max: 4, options: `-c search_path=${schema}` });
  const fotosRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'fc360-f3-'));
  await migrar(pool);
  const firebaseChamadas = [];
  const auth = criarAuth({ pool, segredo: 'segredo-de-teste-bem-comprido', firebaseApiKey: 'k', fetch: async (url, init) => { firebaseChamadas.push(JSON.parse(init.body)); const ok = JSON.parse(init.body).password === 'senha-firebase'; return { ok, status: ok ? 200 : 400 }; } });
  const autenticar = async (req) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!tok) return null;
    return auth.verificar(tok);
  };
  const app = createApp({ pool, fotosRaiz, autenticar, auth, build: 'test' });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (metodo, rota, corpo, token) => {
    const r = await fetch(base + rota, { method: metodo, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, body: await r.json() };
  };
  t.after(async () => { server.close(); await pool.end(); await raiz.query(`DROP SCHEMA ${schema} CASCADE`); await raiz.end(); fs.rmSync(fotosRaiz, { recursive: true, force: true }); });

  // usuários como vieram do Firestore (sem credencial local)
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const seed = [
    ['u_admin', { id: 'u_admin', email: 'admin@economico.com', nome: 'Admin', perfil: 'admin', clienteId: 'economico', ativo: true }],
    ['u_cahu', { id: 'u_cahu', email: 'cahu@economico.com', nome: 'Prev Cahu', perfil: 'prevencao', clienteId: 'economico', loja: 'Cahu', ativo: true, senha: sha('legado123') }],
    ['u_fluxo', { id: 'u_fluxo', email: 'x@fluxo.com', nome: 'Fluxo', perfil: 'admin', clienteId: 'fluxocerto', ativo: true }],
    ['superadmin', { id: 'superadmin', email: 'super@fluxocerto.com', nome: 'Super', perfil: 'superadmin', ativo: true }],
    ['u_inativo', { id: 'u_inativo', email: 'ina@economico.com', nome: 'Ina', perfil: 'operator', clienteId: 'economico', ativo: false }],
  ];
  for (const [id, d] of seed) await pool.query("INSERT INTO documento (colecao, id, cliente_id, dados) VALUES ('usuarios',$1,$2,$3)", [id, d.clienteId || '', JSON.stringify(d)]);
  await pool.query("INSERT INTO documento (colecao, id, cliente_id, dados) VALUES ('clientes','economico','economico',$1), ('clientes','fluxocerto','fluxocerto',$2), ('config','repos','',$3)",
    [JSON.stringify({ nome: 'Econômico', validade: '2027-01-01', ativo: true }), JSON.stringify({ nome: 'Fluxo', ativo: true }), JSON.stringify({ economico: 'fc360-economico' })]);

  let tokAdmin, tokCahu, tokFluxo, tokSuper;
  await t.test('login: 1º acesso confere no Firebase e grava bcrypt; 2º acesso não chama o Firebase; legado sha256; inativo; errado', async () => {
    let r = await api('POST', '/auth/login', { email: 'Admin@Economico.com', senha: 'senha-firebase' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.equal(r.body.usuario.senha, undefined);
    tokAdmin = r.body.token;
    assert.equal(firebaseChamadas.length, 1);
    r = await api('POST', '/auth/login', { email: 'admin@economico.com', senha: 'senha-firebase' });
    assert.equal(r.status, 200);
    assert.equal(firebaseChamadas.length, 1, 'segunda vez é bcrypt local');
    const { rows } = await pool.query('SELECT origem FROM credencial WHERE usuario_id=$1', ['u_admin']);
    assert.equal(rows[0].origem, 'firebase');
    r = await api('POST', '/auth/login', { email: 'cahu@economico.com', senha: 'legado123' });
    assert.equal(r.status, 200, 'sha256 legado aceito');
    tokCahu = r.body.token;
    r = await api('POST', '/auth/login', { email: 'ina@economico.com', senha: 'senha-firebase' });
    assert.equal(r.status, 403);
    r = await api('POST', '/auth/login', { email: 'admin@economico.com', senha: 'errada' });
    assert.equal(r.status, 401);
    r = await api('POST', '/auth/login', { email: 'ninguem@x.com', senha: 'senha-firebase' });
    assert.equal(r.status, 401);
    tokFluxo = (await api('POST', '/auth/login', { email: 'x@fluxo.com', senha: 'senha-firebase' })).body.token;
    tokSuper = (await api('POST', '/auth/login', { email: 'super@fluxocerto.com', senha: 'senha-firebase' })).body.token;
    assert.ok(tokFluxo && tokSuper);
  });

  await t.test('/auth/me devolve o documento sem senha; token inválido → 401', async () => {
    const r = await api('GET', '/auth/me', null, tokCahu);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'u_cahu');
    assert.equal(r.body.senha, undefined);
    assert.equal((await api('GET', '/auth/me', null, 'xyz')).status, 401);
  });

  await t.test('ops via /sync: set, merge, update com ponto, serverTimestamp, delete; escopo por cliente', async () => {
    let r = await api('POST', '/sync', { ops: [
      { op: 'set', col: 'planos', id: 'p1', dados: { desc: 'Repor gôndola', status: 'aberto', loja: 'Cahu', criadoEm: { __serverTimestamp: true } } },
      { op: 'set', col: 'planos', id: 'p1', dados: { responsavel: 'João' }, merge: true },
      { op: 'update', col: 'usuarios', id: 'u_cahu', dados: { 'push.p1': { endpoint: 'e1' }, 'dispositivo.modo': 'app' } },
      { op: 'update', col: 'planos', id: 'nao_existe', dados: { x: 1 } },
      { op: 'set', col: 'config', id: 'repos', dados: { hack: true } },
    ] }, tokCahu);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ops.length, 3);
    assert.equal(r.body.rejeitados.length, 2);
    const p = await api('GET', '/col/planos/p1', null, tokCahu);
    assert.equal(p.body.desc, 'Repor gôndola');
    assert.equal(p.body.responsavel, 'João');
    assert.match(p.body.criadoEm.__ts, /^2026-/);
    const u = await api('GET', '/col/usuarios/u_cahu', null, tokCahu);
    assert.deepEqual(u.body.push, { p1: { endpoint: 'e1' } });
    assert.equal(u.body.dispositivo.modo, 'app');
    assert.equal(u.body.senha, undefined, 'hash legado nunca sai');
    // outro cliente não vê nem altera
    assert.equal((await api('GET', '/col/planos/p1', null, tokFluxo)).status, 404);
    r = await api('POST', '/sync', { ops: [{ op: 'update', col: 'planos', id: 'p1', dados: { status: 'resolvido' } }] }, tokFluxo);
    assert.equal(r.body.rejeitados[0].motivo, 'documento de outro cliente');
    // quem não é gestor não muda o próprio cadastro (perfil, loja...), só aparelho/push; gestor não vira superadmin
    r = await api('POST', '/sync', { ops: [
      { op: 'update', col: 'usuarios', id: 'u_cahu', dados: { perfil: 'admin' } },
      { op: 'set', col: 'usuarios', id: 'u_cahu', dados: { nome: 'x', perfil: 'admin' } },
      { op: 'update', col: 'usuarios', id: 'u_cahu', dados: { 'push.p9': { endpoint: 'e9' }, 'dispositivo.modo': 'app' } },
    ] }, tokCahu);
    assert.deepEqual(r.body.ops.map(x => x.op), ['update']);
    assert.equal(r.body.rejeitados.length, 2);
    assert.equal((await api('GET', '/col/usuarios/u_cahu', null, tokCahu)).body.perfil, 'prevencao');
    r = await api('POST', '/sync', { ops: [{ op: 'update', col: 'usuarios', id: 'u_cahu', dados: { perfil: 'superadmin' } }, { op: 'update', col: 'usuarios', id: 'u_cahu', dados: { loja: 'Ponte' } }] }, tokAdmin);
    assert.deepEqual(r.body.ops.length, 1);
    assert.equal((await api('GET', '/col/usuarios/u_cahu', null, tokAdmin)).body.loja, 'Ponte');
    // FieldValue.delete em caminho com ponto
    r = await api('POST', '/sync', { ops: [{ op: 'update', col: 'usuarios', id: 'u_cahu', dados: { 'push.p1': { __delete: true } } }] }, tokCahu);
    assert.equal((await api('GET', '/col/usuarios/u_cahu', null, tokCahu)).body.push.p1, undefined);
    // delete
    r = await api('POST', '/sync', { ops: [{ op: 'delete', col: 'planos', id: 'p1' }] }, tokCahu);
    assert.equal((await api('GET', '/col/planos/p1', null, tokCahu)).status, 404);
  });

  await t.test('GET /col com where (==, in, >=, null), orderBy, limit, ids', async () => {
    const ops = [];
    for (let i = 1; i <= 5; i++) ops.push({ op: 'set', col: 'planos', id: 'q' + i, dados: { status: i % 2 ? 'aberto' : 'resolvido', prazoFim: '2026-11-0' + i, n: i, loja: i < 3 ? 'Cahu' : 'Ponte', checkOutEm: i === 1 ? null : 'x' } });
    await api('POST', '/sync', { ops }, tokCahu);
    await api('POST', '/sync', { ops: [{ op: 'set', col: 'planos', id: 'fx', dados: { status: 'aberto' } }] }, tokFluxo);
    const q = (w, extra) => api('GET', '/col/planos?where=' + encodeURIComponent(JSON.stringify(w)) + (extra || ''), null, tokCahu);
    assert.deepEqual((await q([['status', '==', 'aberto']])).body.map(d => d.id).sort(), ['q1', 'q3', 'q5']);
    assert.deepEqual((await q([['status', 'in', ['aberto', 'resolvido']], ['loja', '==', 'Ponte']])).body.map(d => d.id).sort(), ['q3', 'q4', 'q5']);
    assert.deepEqual((await q([['prazoFim', '>=', '2026-11-04']])).body.map(d => d.id).sort(), ['q4', 'q5']);
    assert.deepEqual((await q([['n', '>', 3]])).body.map(d => d.id).sort(), ['q4', 'q5']);
    assert.deepEqual((await q([['checkOutEm', '==', null]])).body.map(d => d.id), ['q1']);
    const ord = await q([], '&orderBy=' + encodeURIComponent(JSON.stringify([['n', 'desc']])) + '&limit=2');
    assert.deepEqual(ord.body.map(d => d.id), ['q5', 'q4']);
    const ids = await api('GET', '/col/planos?ids=q1,q2,fx', null, tokCahu);
    assert.deepEqual(ids.body.map(d => d.id).sort(), ['q1', 'q2'], 'fx é de outro cliente');
    assert.equal((await api('GET', '/col/planos?where=%5B%5B%22a%22%2C%22like%22%2C1%5D%5D', null, tokCahu)).status, 400);
  });

  await t.test('escopo: usuarios por cliente (superadmin vê tudo), clientes só o próprio, config só superadmin, tokens por id', async () => {
    const meus = await api('GET', '/col/usuarios', null, tokAdmin);
    assert.deepEqual(meus.body.map(u => u.id).sort(), ['u_admin', 'u_cahu', 'u_inativo']);
    const todos = await api('GET', '/col/usuarios', null, tokSuper);
    assert.equal(todos.body.length, 5);
    const cli = await api('GET', '/col/clientes', null, tokAdmin);
    assert.deepEqual(cli.body.map(c => c.id), ['economico']);
    assert.equal((await api('GET', '/col/clientes/fluxocerto', null, tokAdmin)).status, 404);
    assert.equal((await api('GET', '/col/clientes/fluxocerto', null, tokSuper)).status, 200);
    assert.deepEqual((await api('GET', '/col/config', null, tokAdmin)).body, []);
    assert.equal((await api('GET', '/col/config/repos', null, tokSuper)).body.economico, 'fc360-economico');
    // admin do cliente renova a própria licença; não mexe na de outro
    let r = await api('POST', '/sync', { ops: [{ op: 'update', col: 'clientes', id: 'economico', dados: { validade: '2027-06-01' } }, { op: 'update', col: 'clientes', id: 'fluxocerto', dados: { validade: '2099-01-01' } }] }, tokAdmin);
    assert.equal(r.body.ops.length, 1);
    assert.equal(r.body.rejeitados.length, 1);
    // prevenção não cria usuário nem edita cliente
    r = await api('POST', '/sync', { ops: [{ op: 'set', col: 'usuarios', id: 'novo', dados: { email: 'n@x.com', clienteId: 'economico' } }, { op: 'update', col: 'clientes', id: 'economico', dados: { validade: '2099-01-01' } }] }, tokCahu);
    assert.equal(r.body.ops.length, 0);
    // tokens: superadmin cria pra um cliente; o admin desse cliente lê por id e marca usado
    r = await api('POST', '/sync', { ops: [{ op: 'set', col: 'tokens', id: 'ABCD-1234', dados: { clienteId: 'economico', dias: 30, usado: false } }] }, tokSuper);
    assert.equal(r.body.ops.length, 1);
    assert.equal((await api('GET', '/col/tokens/ABCD-1234', null, tokAdmin)).body.dias, 30);
    r = await api('POST', '/sync', { ops: [{ op: 'update', col: 'tokens', id: 'ABCD-1234', dados: { usado: true, ativadoEm: { __serverTimestamp: true } } }] }, tokAdmin);
    assert.equal(r.body.ops.length, 1);
  });

  await t.test('admin cria usuário com senha e troca senha; o usuário entra com a senha nova', async () => {
    let r = await api('POST', '/auth/usuarios', { usuario: { email: 'Novo@Economico.com', nome: 'Novo', perfil: 'operator', loja: 'Ponte', clienteId: 'fluxocerto' }, senha: 'abcd1234' }, tokAdmin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.id;
    const doc = await api('GET', '/col/usuarios/' + id, null, tokAdmin);
    assert.equal(doc.body.clienteId, 'economico', 'admin não escolhe o cliente');
    assert.equal(doc.body.email, 'novo@economico.com');
    assert.equal((await api('POST', '/auth/login', { email: 'novo@economico.com', senha: 'abcd1234' })).status, 200);
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { email: 'novo@economico.com' }, senha: 'x1234' }, tokAdmin)).status, 409);
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { email: 'z@z.com' }, senha: 'x1234' }, tokCahu)).status, 403);
    r = await api('POST', '/auth/senha', { usuarioId: id, senha: 'nova9999' }, tokAdmin);
    assert.equal(r.status, 200);
    assert.equal((await api('POST', '/auth/login', { email: 'novo@economico.com', senha: 'abcd1234' })).status, 401);
    assert.equal((await api('POST', '/auth/login', { email: 'novo@economico.com', senha: 'nova9999' })).status, 200);
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_fluxo', senha: 'hack1234' }, tokAdmin)).status, 403, 'gestor não troca senha de outro cliente');
    assert.equal((await api('POST', '/auth/senha', { senha: 'minha1234' }, tokCahu)).status, 200, 'a própria sempre pode');
  });

  await t.test('superadmin impersona um cliente e opera como admin dele', async () => {
    let r = await api('POST', '/auth/impersonar', { clienteId: 'fluxocerto' }, tokSuper);
    assert.equal(r.status, 200);
    const tokImp = r.body.token;
    assert.equal((await api('POST', '/auth/impersonar', { clienteId: 'x' }, tokAdmin)).status, 403);
    const planos = await api('GET', '/col/planos', null, tokImp);
    assert.deepEqual(planos.body.map(p => p.id), ['fx']);
    const me = await api('GET', '/auth/me', null, tokImp);
    assert.equal(me.body.clienteId, 'fluxocerto');
    assert.equal(me.body.perfil, 'admin');
  });
});
