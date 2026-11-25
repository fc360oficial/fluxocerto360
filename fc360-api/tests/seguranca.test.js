// Segurança (25/11/2026): quem pode trocar senha/cadastro de quem, limite de tentativas de login,
// campo sensível fora dos filtros. A parte com banco precisa de FC360_TEST_DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { migrar } = require('../lib/db');
const { createApp } = require('../lib/app');
const { criarAuth } = require('../lib/auth');
const documentos = require('../lib/documentos');
const regras = require('../lib/regras-usuario');
const { criarLimiteLogin } = require('../lib/limite');

const URL_DB = process.env.FC360_TEST_DATABASE_URL;
const MIN = 60 * 1000;

test('regras: ninguém além do superadmin gere superadmin; admin gere o próprio cliente; gerência/supervisor só quem está abaixo', () => {
  const sup = { id: 's', perfil: 'superadmin', clienteId: '' };
  const adm = { id: 'a', perfil: 'admin', clienteId: 'economico' };
  const ger = { id: 'g', perfil: 'gerencia', clienteId: 'economico' };
  const svr = { id: 'v', perfil: 'supervisor', clienteId: 'economico' };
  const op = { id: 'o', perfil: 'operator', clienteId: 'economico' };
  const docSuper = { perfil: 'superadmin' };                       // como está em produção: sem clienteId
  const docAntigo = { perfil: 'operator' };                        // anterior ao multi-cliente = Econômico
  const docOutro = { perfil: 'operator', clienteId: 'fluxocerto' };

  for (const quem of [adm, ger, svr, op]) assert.equal(regras.podeGerir(quem, docSuper), false, quem.perfil + ' não gere superadmin');
  assert.equal(regras.podeGerir(sup, docSuper), true);
  assert.equal(regras.podeGerir(adm, { perfil: 'admin', clienteId: 'economico' }), true);
  assert.equal(regras.podeGerir(adm, docAntigo), true);
  assert.equal(regras.podeGerir(adm, docOutro), false, 'outro cliente');
  assert.equal(regras.podeGerir(ger, { perfil: 'admin', clienteId: 'economico' }), false);
  assert.equal(regras.podeGerir(ger, { perfil: 'gerencia', clienteId: 'economico' }), false, 'gerência não gere outra gerência');
  assert.equal(regras.podeGerir(ger, { perfil: 'supervisor', clienteId: 'economico' }), false);
  assert.equal(regras.podeGerir(svr, { perfil: 'gerencia', clienteId: 'economico' }), false);
  assert.equal(regras.podeGerir(ger, { perfil: 'prevencao', clienteId: 'economico' }), true);
  assert.equal(regras.podeGerir(svr, docAntigo), true);
  assert.equal(regras.podeGerir(op, docAntigo), false);
  assert.equal(regras.podeGerir({ id: 'x', perfil: 'admin', clienteId: '' }, docAntigo), false, 'sem cliente não gere ninguém');

  assert.equal(regras.podeAtribuir(adm, 'superadmin'), false);
  assert.equal(regras.podeAtribuir(adm, 'admin'), true);
  assert.equal(regras.podeAtribuir(ger, 'admin'), false);
  assert.equal(regras.podeAtribuir(ger, 'gerencia'), false);
  assert.equal(regras.podeAtribuir(ger, 'operator'), true);
  assert.equal(regras.podeAtribuir(op, 'operator'), false);
  assert.equal(regras.podeAtribuir(sup, 'superadmin'), true);
});

test('limite de login: 10 erros na conta+IP bloqueiam 15 min; acertar zera; conta atacada de vários IPs fecha em 30', () => {
  const l = criarLimiteLogin();
  let t = 1000000;
  for (let i = 0; i < 9; i++) assert.equal(l.falha('Ana@X.com', '1.1.1.1', t += 1000), false);
  assert.equal(l.bloqueado('ana@x.com', '1.1.1.1', t), 0);
  assert.equal(l.falha('ana@x.com', '1.1.1.1', t += 1000), true);
  assert.equal(l.bloqueado('ANA@x.com ', '1.1.1.1', t + 1), 15 * MIN - 1);
  assert.equal(l.bloqueado('ana@x.com', '2.2.2.2', t + 1), 0, 'outro IP segue');
  assert.equal(l.bloqueado('bia@x.com', '1.1.1.1', t + 1), 0, 'outra conta segue');
  assert.equal(l.bloqueado('ana@x.com', '1.1.1.1', t + 15 * MIN), 0);
  assert.equal(l.aviso(15 * MIN), 'Muitas tentativas de login. Aguarde 15 min e tente de novo.');

  const m = criarLimiteLogin();
  for (let i = 0; i < 9; i++) m.falha('ana@x.com', '1.1.1.1', 1000 + i);
  m.sucesso('ana@x.com', '1.1.1.1');
  for (let i = 0; i < 9; i++) assert.equal(m.falha('ana@x.com', '1.1.1.1', 2000 + i), false);

  const n = criarLimiteLogin();
  let disparou = false;
  for (let i = 0; i < 30; i++) disparou = n.falha('ana@x.com', '9.9.9.' + i, 3000 + i);
  assert.equal(disparou, true);
  assert.ok(n.bloqueado('ana@x.com', '8.8.8.8', 4000) > 0, 'conta fechada pra qualquer IP');
});

test('consulta: campo sensível não serve de filtro nem de ordem', () => {
  const u = { id: 'u1', clienteId: 'economico', perfil: 'admin' };
  assert.throws(() => documentos.montarConsulta(u, 'usuarios', { where: [['senha', '==', 'abc']] }), /campo não permitido/);
  assert.throws(() => documentos.montarConsulta(u, 'usuarios', { where: [['senha', '>=', 'a']] }), /campo não permitido/);
  assert.throws(() => documentos.montarConsulta(u, 'usuarios', { orderBy: [['_fbNewPass', 'asc']] }), /campo não permitido/);
  assert.throws(() => documentos.montarConsulta(u, 'usuarios', { orderBy: ['senha_hash'] }), /campo não permitido/);
  assert.ok(documentos.montarConsulta(u, 'usuarios', { where: [['loja', '==', 'Cahu']], orderBy: [['nome', 'asc']] }).sql);
  assert.ok(documentos.montarConsulta(u, 'planos', { where: [['senha', '==', 'x']] }).sql, 'outras coleções não mudam');
});

(URL_DB ? test : test.skip)('segurança na API', async (t) => {
  const schema = 'fc360_seg_' + Date.now();
  const raiz = new Pool({ connectionString: URL_DB, max: 2 });
  await raiz.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, max: 4, options: `-c search_path=${schema}` });
  const fotosRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'fc360-seg-'));
  await migrar(pool);
  const auth = criarAuth({ pool, segredo: 'segredo-de-teste-bem-comprido', firebaseApiKey: '', fetch: async () => ({ ok: false }) });
  const autenticar = async (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? auth.verificar(h.slice(7)) : null; };
  const app = createApp({ pool, fotosRaiz, autenticar, auth, build: 'test' });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (metodo, rota, corpo, token) => {
    const r = await fetch(base + rota, { method: metodo, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: corpo ? JSON.stringify(corpo) : undefined });
    let body = null; try { body = await r.json(); } catch { /* sem corpo json */ }
    return { status: r.status, body };
  };
  t.after(async () => { server.close(); await pool.end(); await raiz.query(`DROP SCHEMA ${schema} CASCADE`); await raiz.end(); fs.rmSync(fotosRaiz, { recursive: true, force: true }); });

  // Como em produção: o documento do superadmin NÃO tem clienteId e está gravado com cliente_id 'economico'.
  const seed = [
    ['u_admin', 'economico', { id: 'u_admin', email: 'admin@e.com', nome: 'Admin', perfil: 'admin', clienteId: 'economico', ativo: true }],
    ['u_ger', 'economico', { id: 'u_ger', email: 'ger@e.com', nome: 'Gerência', perfil: 'gerencia', clienteId: 'economico', ativo: true }],
    ['u_ger2', 'economico', { id: 'u_ger2', email: 'ger2@e.com', nome: 'Gerência 2', perfil: 'gerencia', clienteId: 'economico', ativo: true }],
    ['u_sup', 'economico', { id: 'u_sup', email: 'sup@e.com', nome: 'Supervisor', perfil: 'supervisor', ativo: true }],
    ['u_op', 'economico', { id: 'u_op', email: 'op@e.com', nome: 'Operador', perfil: 'operator', clienteId: 'economico', ativo: true }],
    ['superadmin', 'economico', { id: 'superadmin', email: 'super@fc.com', nome: 'Super', perfil: 'superadmin', ativo: true }],
    ['u_fluxo', 'fluxocerto', { id: 'u_fluxo', email: 'x@fluxo.com', nome: 'Fluxo', perfil: 'admin', clienteId: 'fluxocerto', ativo: true }],
  ];
  for (const [id, cli, d] of seed) {
    await pool.query("INSERT INTO documento (colecao, id, cliente_id, dados) VALUES ('usuarios',$1,$2,$3)", [id, cli, JSON.stringify(d)]);
    await auth.definirSenha(id, d.email, 'senha-' + id, 'bcrypt');
  }
  const entrar = async (id, email) => (await api('POST', '/auth/login', { email, senha: 'senha-' + id })).body.token;
  const tok = { admin: await entrar('u_admin', 'admin@e.com'), ger: await entrar('u_ger', 'ger@e.com'), sup: await entrar('u_sup', 'sup@e.com'), op: await entrar('u_op', 'op@e.com') };
  const perfilDe = async (id) => (await pool.query("SELECT dados FROM documento WHERE colecao='usuarios' AND id=$1", [id])).rows[0];

  await t.test('/auth/senha: gestor não troca a senha do superadmin nem de quem está acima ou ao lado', async () => {
    for (const quem of ['admin', 'ger', 'sup', 'op']) assert.equal((await api('POST', '/auth/senha', { usuarioId: 'superadmin', senha: 'tomei1234' }, tok[quem])).status, 403, quem + ' → superadmin');
    assert.equal((await api('POST', '/auth/login', { email: 'super@fc.com', senha: 'tomei1234' })).status, 401, 'a senha do superadmin não mudou');
    assert.equal((await api('POST', '/auth/login', { email: 'super@fc.com', senha: 'senha-superadmin' })).status, 200);
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_admin', senha: 'x1234567' }, tok.ger)).status, 403, 'gerência → admin');
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_ger2', senha: 'x1234567' }, tok.ger)).status, 403, 'gerência → outra gerência');
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_ger', senha: 'x1234567' }, tok.sup)).status, 403, 'supervisor → gerência');
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_fluxo', senha: 'x1234567' }, tok.admin)).status, 403, 'admin → outro cliente');
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_ger', senha: 'x1234567' }, tok.op)).status, 403, 'operador → gerência');
  });

  await t.test('/auth/senha: o que continua valendo — a própria, admin no próprio cliente, gestor em quem está abaixo', async () => {
    assert.equal((await api('POST', '/auth/senha', { senha: 'minha12345' }, tok.op)).status, 200, 'a própria');
    assert.equal((await api('POST', '/auth/login', { email: 'op@e.com', senha: 'minha12345' })).status, 200);
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_ger2', senha: 'nova12345' }, tok.admin)).status, 200, 'admin → gerência');
    assert.equal((await api('POST', '/auth/login', { email: 'ger2@e.com', senha: 'nova12345' })).status, 200);
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_op', senha: 'dada12345' }, tok.ger)).status, 200, 'gerência → operador');
    assert.equal((await api('POST', '/auth/senha', { usuarioId: 'u_op', senha: 'dada67890' }, tok.sup)).status, 200, 'supervisor (documento antigo, sem clienteId) → operador');
  });

  await t.test('/auth/usuarios: não regrava usuário que a pessoa não pode gerir, nem cria perfil acima do próprio', async () => {
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { id: 'superadmin', email: 'meu@e.com', nome: 'Eu', perfil: 'admin' }, senha: 'tomei1234' }, tok.admin)).status, 403, 'id do superadmin');
    assert.equal((await perfilDe('superadmin')).dados.perfil, 'superadmin');
    assert.equal((await perfilDe('superadmin')).dados.email, 'super@fc.com');
    assert.equal((await api('POST', '/auth/login', { email: 'super@fc.com', senha: 'senha-superadmin' })).status, 200);
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { id: 'u_fluxo', email: 'meu2@e.com', nome: 'Eu', perfil: 'operator' }, senha: 'tomei1234' }, tok.admin)).status, 403, 'id de outro cliente');
    assert.equal((await pool.query("SELECT cliente_id FROM documento WHERE colecao='usuarios' AND id='u_fluxo'")).rows[0].cliente_id, 'fluxocerto');
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { id: 'u_admin', email: 'meu3@e.com', nome: 'Eu', perfil: 'operator' }, senha: 'tomei1234' }, tok.ger)).status, 403, 'gerência regravando o admin');
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { email: 'novoadm@e.com', nome: 'N', perfil: 'admin' }, senha: 'abcd1234' }, tok.ger)).status, 403, 'gerência criando admin');
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { email: 'novosup@e.com', nome: 'N', perfil: 'superadmin' }, senha: 'abcd1234' }, tok.admin)).status, 403, 'admin criando superadmin');
    const r = await api('POST', '/auth/usuarios', { usuario: { id: 'u_novo', email: 'novo@e.com', nome: 'Novo', perfil: 'operator', loja: 'Ponte' }, senha: 'abcd1234' }, tok.ger);
    assert.equal(r.status, 200, 'gerência criando operador');
    assert.equal((await api('POST', '/auth/login', { email: 'novo@e.com', senha: 'abcd1234' })).status, 200);
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { id: 'u_novo', email: 'novo@e.com', nome: 'Novo', perfil: 'operator', loja: 'Ponte' }, senha: 'abcd1234' }, tok.ger)).status, 200, 'repetir o próprio cadastro continua dando certo');
    assert.equal((await api('POST', '/auth/usuarios', { usuario: { email: 'novoger@e.com', nome: 'G', perfil: 'gerencia' }, senha: 'abcd1234' }, tok.admin)).status, 200, 'admin criando gerência');
  });

  await t.test('/sync (coleção usuarios): superadmin intocável; gestor não se promove nem mexe em quem está acima', async () => {
    const ops = async (lista, token) => (await api('POST', '/sync', { ops: lista }, token)).body;
    let r = await ops([{ op: 'update', col: 'usuarios', id: 'superadmin', dados: { email: 'meu@e.com' } }], tok.ger);
    assert.equal(r.rejeitados[0].motivo, 'documento de superadmin');
    r = await ops([{ op: 'update', col: 'usuarios', id: 'superadmin', dados: { perfil: 'operator' } }], tok.admin);
    assert.equal(r.rejeitados[0].motivo, 'documento de superadmin');
    r = await ops([{ op: 'delete', col: 'usuarios', id: 'superadmin' }], tok.admin);
    assert.equal(r.rejeitados[0].motivo, 'documento de superadmin');
    assert.equal((await perfilDe('superadmin')).dados.email, 'super@fc.com');

    r = await ops([{ op: 'update', col: 'usuarios', id: 'u_ger', dados: { perfil: 'admin' } }], tok.ger);
    assert.equal(r.rejeitados[0].motivo, 'perfil não permitido', 'gerência se promovendo');
    r = await ops([{ op: 'update', col: 'usuarios', id: 'u_admin', dados: { email: 'meu@e.com' } }], tok.ger);
    assert.equal(r.rejeitados[0].motivo, 'sem permissão sobre esse usuário');
    r = await ops([{ op: 'delete', col: 'usuarios', id: 'u_admin' }], tok.sup);
    assert.equal(r.rejeitados[0].motivo, 'sem permissão sobre esse usuário');
    r = await ops([{ op: 'update', col: 'usuarios', id: 'u_op', dados: { perfil: 'gerencia' } }], tok.ger);
    assert.equal(r.rejeitados[0].motivo, 'perfil não permitido', 'gerência promovendo operador a gerência');
    assert.equal((await perfilDe('u_ger')).dados.perfil, 'gerencia');
    assert.equal((await perfilDe('u_admin')).dados.email, 'admin@e.com');

    // o que a tela faz de verdade: grava a lista inteira (set) — o que a pessoa pode gerir entra, o resto é recusado em silêncio
    r = await ops([{ op: 'update', col: 'usuarios', id: 'u_op', dados: { nome: 'Operador Novo', loja: 'Cahu' } }], tok.ger);
    assert.deepEqual(r.rejeitados, []);
    const proprio = (await perfilDe('u_ger')).dados;
    r = await ops([{ op: 'set', col: 'usuarios', id: 'u_ger', dados: Object.assign({}, proprio, { telefone: '81999990000' }) }], tok.ger);
    assert.deepEqual(r.rejeitados, [], 'gravar o próprio cadastro com o mesmo perfil');
    r = await ops([{ op: 'set', col: 'usuarios', id: 'u_ger2', dados: { id: 'u_ger2', email: 'ger2@e.com', nome: 'Gerência Dois', perfil: 'supervisor', clienteId: 'economico', ativo: true } }], tok.admin);
    assert.deepEqual(r.rejeitados, [], 'admin edita e muda o perfil de um gestor');
    r = await ops([{ op: 'update', col: 'usuarios', id: 'u_op', dados: { 'push.abc': 'tok' } }], tok.op);
    assert.deepEqual(r.rejeitados, [], 'operador segue registrando o próprio aparelho');
  });

  await t.test('/col/usuarios: filtrar pela senha não é mais aceito', async () => {
    const r = await api('GET', '/col/usuarios?where=' + encodeURIComponent(JSON.stringify([['senha', '==', 'abc']])), null, tok.admin);
    assert.ok(r.status >= 400 && r.status < 500, 'recusado (' + r.status + ')');
    assert.equal((await api('GET', '/col/usuarios?where=' + encodeURIComponent(JSON.stringify([['perfil', '==', 'operator']])), null, tok.admin)).status, 200);
  });

  await t.test('/auth/login: 10 senhas erradas → 429 mesmo com a senha certa; outra conta continua entrando; corpo gigante é recusado', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await api('POST', '/auth/login', { email: 'ger2@e.com', senha: 'errada' + i })).status, 401);
    const barrado = await api('POST', '/auth/login', { email: 'GER2@e.com', senha: 'nova12345' });
    assert.equal(barrado.status, 429);
    assert.match(barrado.body.error, /Muitas tentativas de login\. Aguarde 15 min/);
    assert.equal((await api('POST', '/auth/login', { email: 'admin@e.com', senha: 'senha-u_admin' })).status, 200, 'outra conta, mesmo IP');
    const grande = await api('POST', '/auth/login', { email: 'admin@e.com', senha: 'x'.repeat(60000) });
    assert.equal(grande.status, 413);
  });
});
