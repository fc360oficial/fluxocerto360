// Testes da API contra um Postgres de verdade. Precisa de FC360_TEST_DATABASE_URL
// (ex.: postgres://postgres@127.0.0.1:54329/postgres); sem isso os testes são pulados.
// Cada execução cria um schema próprio (fc360_test_<ts>) e apaga no fim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { migrar } = require('../lib/db');
const { createApp } = require('../lib/app');

const URL_DB = process.env.FC360_TEST_DATABASE_URL;
const B64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const USUARIOS = {
  cahu: { id: 'u_cahu', email: 'cahu@economico.com', clienteId: 'economico', loja: 'Cahu', nome: 'Prevenção Cahu', perfil: 'prevencao' },
  ponte: { id: 'u_ponte', email: 'ponte@economico.com', clienteId: 'economico', loja: 'Ponte', nome: 'Prevenção Ponte', perfil: 'prevencao' },
  outro: { id: 'u_fluxo', email: 'x@fluxo.com', clienteId: 'fluxocerto', loja: 'Matriz', nome: 'Fluxo', perfil: 'admin' },
};

function resExemplo(extra) {
  return Object.assign({
    id: 'id_1700000000000_abc', checklistId: 'cl_abertura', checklistNome: 'Abertura de Loja', setor: 'Geral',
    operador: 'Prevenção Cahu', perfil: 'prevencao', loja: 'Cahu', clienteId: 'economico',
    dataHora: '05/11/2026 08:12', dateISO: '2026-11-05', feitos: 2, total: 2, pct: 100,
    itens: [
      { t: 'Luzes acesas', feito: true, fotoAntes: null, fotoDepois: B64, fotosMulti: null },
      { t: 'Gôndola limpa', feito: true, fotoAntes: null, fotoDepois: null, fotosMulti: [B64, B64] },
    ],
    assinatura: B64,
  }, extra || {});
}

(URL_DB ? test : test.skip)('FC360 API', async (t) => {
  const schema = 'fc360_test_' + Date.now();
  const raiz = new Pool({ connectionString: URL_DB, max: 2 });
  await raiz.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: URL_DB, max: 4, options: `-c search_path=${schema}` });
  const fotosRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'fc360-fotos-'));
  let usuarioAtual = USUARIOS.cahu;
  let falharAuth = false;
  const app = createApp({ pool, fotosRaiz, build: 'test', autenticar: async (req) => {
    if (falharAuth) throw new Error('token expirado');
    return req.headers.authorization === 'Bearer ok' ? usuarioAtual : null;
  } });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (metodo, rota, corpo, semToken) => {
    const r = await fetch(base + rota, { method: metodo, headers: Object.assign({ 'Content-Type': 'application/json' }, semToken ? {} : { Authorization: 'Bearer ok' }), body: corpo ? JSON.stringify(corpo) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
  };

  t.after(async () => {
    server.close();
    await pool.end();
    await raiz.query(`DROP SCHEMA ${schema} CASCADE`);
    await raiz.end();
    fs.rmSync(fotosRaiz, { recursive: true, force: true });
  });

  await t.test('migra o schema e roda de novo sem reaplicar', async () => {
    const a = await migrar(pool);
    assert.deepEqual(a, ['001_inicial.sql']);
    const b = await migrar(pool);
    assert.deepEqual(b, []);
  });

  await t.test('health não exige token', async () => {
    const r = await api('GET', '/health', null, true);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.db, 'ok');
  });

  await t.test('sem token → 401; token inválido → 401', async () => {
    assert.equal((await api('POST', '/sync', { resultados: [] }, true)).status, 401);
    falharAuth = true;
    const r = await api('GET', '/resultados');
    falharAuth = false;
    assert.equal(r.status, 401);
    assert.match(r.body.error, /expirado/);
  });

  await t.test('envio de resultado com fotos: separa, grava em disco, devolve refs', async () => {
    const r = await api('POST', '/sync', { resultados: [resExemplo()] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.resultados, ['id_1700000000000_abc']);
    assert.equal(r.body.resultados_fotos.length, 4); // depois + 2 multi + assinatura
    assert.deepEqual(r.body.rejeitados, []);
    const arquivos = fs.readdirSync(path.join(fotosRaiz, 'economico', '2026-11-05'));
    assert.equal(arquivos.length, 4);

    const d = await api('GET', '/resultados/id_1700000000000_abc');
    assert.equal(d.status, 200);
    assert.equal(d.body.itens[0].fotoDepoisRef, 'id_1700000000000_abc_0_depois');
    assert.equal(d.body.itens[0].fotoDepois, undefined, 'base64 não fica no doc');
    assert.equal(d.body.assinaturaRef, 'id_1700000000000_abc_assinatura');
    assert.equal(d.body._fotos.length, 4);
  });

  await t.test('reenvio do mesmo id é idempotente (1 linha, dados atualizados)', async () => {
    const r = await api('POST', '/sync', { resultados: [resExemplo({ pct: 50, assinatura: null, itens: [{ t: 'x', feito: false }] })] });
    assert.equal(r.status, 200);
    const { rows } = await pool.query('SELECT count(*)::int AS n, max(pct) AS pct FROM resultado');
    assert.equal(rows[0].n, 1);
    assert.equal(rows[0].pct, 50);
  });

  await t.test('clienteId do corpo é ignorado: vale o do usuário autenticado', async () => {
    const r = await api('POST', '/sync', { resultados: [resExemplo({ id: 'id_x', clienteId: 'fluxocerto' })] });
    assert.equal(r.status, 200);
    const { rows } = await pool.query("SELECT cliente_id, dados->>'clienteId' AS c FROM resultado WHERE id='id_x'");
    assert.equal(rows[0].cliente_id, 'economico');
    assert.equal(rows[0].c, 'economico');
  });

  await t.test('GET /resultados filtra por janela, loja e tenant', async () => {
    await api('POST', '/sync', { resultados: [resExemplo({ id: 'id_velho', dateISO: '2026-09-01', loja: 'Ponte' })] });
    const tudo = await api('GET', '/resultados?desde=2026-01-01');
    assert.equal(tudo.body.length, 3);
    const janela = await api('GET', '/resultados?desde=2026-11-01');
    assert.deepEqual(janela.body.map(r => r.id).sort(), ['id_1700000000000_abc', 'id_x']);
    const ponte = await api('GET', '/resultados?desde=2026-01-01&loja=Ponte');
    assert.deepEqual(ponte.body.map(r => r.id), ['id_velho']);
    usuarioAtual = USUARIOS.outro;
    const outro = await api('GET', '/resultados?desde=2026-01-01');
    usuarioAtual = USUARIOS.cahu;
    assert.deepEqual(outro.body, [], 'outro tenant não vê nada');
    const detalheOutro = await (async () => { usuarioAtual = USUARIOS.outro; const r = await api('GET', '/resultados/id_x'); usuarioAtual = USUARIOS.cahu; return r; })();
    assert.equal(detalheOutro.status, 404);
  });

  await t.test('GET /envios resume o dia', async () => {
    const r = await api('GET', '/envios?date=2026-11-05');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(e => e.id).sort(), ['id_1700000000000_abc', 'id_x']);
    assert.equal(r.body[0].checklistNome, 'Abertura de Loja');
  });

  await t.test('foto avulsa do checklist (coleção fotos): grava, lista sem base64, devolve com base64 e arquivo', async () => {
    const doc = { id: 'u_cahu_2026-11-05_cl_abertura_depois_0', userId: 'u_cahu', date: '2026-11-05', clId: 'cl_abertura', tipo: 'depois', idx: 0, base64: B64, loja: 'Cahu', operador: 'Prevenção Cahu' };
    const r = await api('POST', '/sync', { fotos: [doc] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.fotos, [doc.id]);

    const lista = await api('GET', '/fotos?date=2026-11-05&userId=u_cahu&colecao=fotos');
    assert.equal(lista.body.length, 1);
    assert.equal(lista.body[0].base64, undefined);
    assert.equal(lista.body[0].clId, 'cl_abertura');
    assert.equal(lista.body[0].tipo, 'depois');
    assert.equal(lista.body[0].idx, 0);

    const uma = await api('GET', '/fotos/' + doc.id);
    assert.equal(uma.body.base64, B64);

    const arq = await api('GET', '/fotos/' + doc.id + '/arquivo');
    assert.equal(arq.status, 200);
    assert.equal(arq.headers.get('content-type'), 'image/jpeg');
    assert.ok(arq.body.byteLength > 50);

    usuarioAtual = USUARIOS.outro;
    const alheia = await api('GET', '/fotos/' + doc.id);
    usuarioAtual = USUARIOS.cahu;
    assert.equal(alheia.status, 404);
  });

  await t.test('foto com conteúdo inválido é rejeitada sem derrubar o resto', async () => {
    const r = await api('POST', '/sync', { fotos: [{ id: 'ruim', date: '2026-11-05', base64: 'isso não é imagem' }, { id: 'boa', date: '2026-11-05', base64: B64 }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fotos, ['boa']);
    assert.equal(r.body.rejeitados.length, 1);
    assert.equal(r.body.rejeitados[0].id, 'ruim');
  });

  await t.test('checkstates: PUT/GET, state como string JSON ou objeto', async () => {
    const put = await api('PUT', '/checkstates/u_cahu_2026-11-05', { userId: 'u_cahu', date: '2026-11-05', state: JSON.stringify({ 'cl_abertura_Luzes acesas': true }) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const get = await api('GET', '/checkstates/u_cahu_2026-11-05');
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.state, { 'cl_abertura_Luzes acesas': true });
    const put2 = await api('PUT', '/checkstates/u_cahu_2026-11-05', { date: '2026-11-05', state: { a: 1 } });
    assert.equal(put2.status, 200);
    assert.deepEqual((await api('GET', '/checkstates/u_cahu_2026-11-05')).body.state, { a: 1 });
    assert.equal((await api('GET', '/checkstates/nao_existe')).status, 404);
  });

  await t.test('sync em lote grava tudo numa transação e registra no envio_log', async () => {
    const r = await api('POST', '/sync', {
      resultados: [resExemplo({ id: 'id_lote', assinatura: null, itens: [{ t: 'a', feito: true }] })],
      fotos: [{ id: 'f_lote', date: '2026-11-05', base64: B64 }],
      checkstates: [{ id: 'u_cahu_2026-11-06', date: '2026-11-06', state: {} }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.resultados.length + r.body.fotos.length + r.body.checkstates.length, 3);
    const { rows } = await pool.query('SELECT tipo, count(*)::int AS n FROM envio_log GROUP BY tipo ORDER BY tipo');
    const porTipo = Object.fromEntries(rows.map(x => [x.tipo, x.n]));
    assert.ok(porTipo.resultados >= 4);
    assert.ok(porTipo.fotos >= 3);
    assert.ok(porTipo.checkstates >= 3);
    assert.ok(porTipo.resultados_fotos >= 4);
  });

  await t.test('patches: mescla campos no doc (resetado/substituidoPor), recalcula colunas, só do próprio tenant', async () => {
    const r = await api('POST', '/sync', { patches: [
      { id: 'id_lote', campos: { resetado: true, substituidoPor: 'id_x', pct: 40, clienteId: 'fluxocerto' } },
      { id: 'nao_existe', campos: { resetado: true } },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.patches, ['id_lote']);
    assert.equal(r.body.rejeitados.length, 1);
    const { rows } = await pool.query("SELECT resetado, pct, cliente_id, dados->>'substituidoPor' AS sub, dados->>'checklistNome' AS nome FROM resultado WHERE id='id_lote'");
    assert.equal(rows[0].resetado, true);
    assert.equal(rows[0].pct, 40);
    assert.equal(rows[0].sub, 'id_x');
    assert.equal(rows[0].cliente_id, 'economico', 'clienteId do patch é ignorado');
    assert.equal(rows[0].nome, 'Abertura de Loja', 'campos não citados ficam como estavam');
    usuarioAtual = USUARIOS.outro;
    const alheio = await api('POST', '/sync', { patches: [{ id: 'id_lote', campos: { resetado: false } }] });
    usuarioAtual = USUARIOS.cahu;
    assert.equal(alheio.body.rejeitados[0].motivo, 'resultado não encontrado');
    const r2 = await api('PUT', '/checkstates/x_y', { state: {} });
    assert.equal(r2.status, 200);
  });

  await t.test('GET /fotos?comBase64=1 devolve a imagem junto; por resultadoId serve pra hidratar o detalhe', async () => {
    const lista = await api('GET', '/fotos?resultadoId=id_1700000000000_abc&comBase64=1');
    assert.equal(lista.status, 200);
    assert.equal(lista.body.length, 4);
    assert.ok(lista.body.every(f => typeof f.base64 === 'string' && f.base64.startsWith('data:image/jpeg;base64,')));
    assert.deepEqual(lista.body.map(f => f.slot).sort(), ['0_depois', '1_m0', '1_m1', 'assinatura']);
    const sem = await api('GET', '/fotos?resultadoId=id_1700000000000_abc');
    assert.ok(sem.body.every(f => f.base64 === undefined));
  });

  await t.test('rota inexistente responde JSON 404', async () => {
    const r = await api('GET', '/nada');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /não existe/);
  });
});
