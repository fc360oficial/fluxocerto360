const test = require('node:test');
const assert = require('node:assert/strict');
const FC360Api = require('../lib/fc360-api-client.js');

function storageFake(limiteBytes) {
  const m = {};
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { if (limiteBytes && String(v).length > limiteBytes) { const e = new Error('QuotaExceededError'); throw e; } m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    _m: m,
  };
}

// servidor falso: lista de respostas por chamada; cada entrada é {status, body} ou 'offline'
function fetchFake(roteiro) {
  const chamadas = [];
  const f = async (url, init) => {
    chamadas.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const r = roteiro.length ? roteiro.shift() : { status: 200, body: { ok: true } };
    if (r === 'offline') throw new TypeError('Failed to fetch');
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  f.chamadas = chamadas;
  return f;
}

function preparar(roteiro, opts) {
  const storage = storageFake(opts && opts.limite);
  const fetch = fetchFake(roteiro || []);
  const logs = [];
  FC360Api.configurar({ baseUrl: 'https://x/fc360-api', obterToken: async () => 'tok', fetch, storage, agora: () => 1000, log: m => logs.push(m) });
  return { storage, fetch, logs };
}

test('chamar: manda token, JSON e devolve o corpo; erro HTTP vira ErroApi com a mensagem do servidor', async () => {
  const { fetch } = preparar([{ status: 200, body: { ok: true, resultados: ['a'] } }, { status: 401, body: { error: 'Token inválido' } }, 'offline']);
  const r = await FC360Api.chamar('POST', '/sync', { resultados: [{ id: 'a' }] });
  assert.deepEqual(r, { ok: true, resultados: ['a'] });
  assert.equal(fetch.chamadas[0].url, 'https://x/fc360-api/sync');
  assert.equal(fetch.chamadas[0].auth, 'Bearer tok');
  assert.deepEqual(fetch.chamadas[0].body, { resultados: [{ id: 'a' }] });
  await assert.rejects(FC360Api.chamar('GET', '/resultados'), e => e.status === 401 && /Token inválido/.test(e.message) && !e.offline);
  await assert.rejects(FC360Api.chamar('GET', '/resultados'), e => e.status === 0 && e.offline);
});

test('enviarOuEnfileirar: online → enviado sem tocar na fila', async () => {
  const { storage } = preparar([{ status: 200, body: { ok: true } }]);
  assert.equal(await FC360Api.enviarOuEnfileirar({ resultados: [{ id: 'r1' }] }), 'enviado');
  assert.equal(FC360Api.fila.pendentes(), 0);
  assert.equal(storage.getItem('fc360_fila'), null);
});

test('enviarOuEnfileirar: sem rede → enfileirado e persistido; drenar() depois entrega em ordem', async () => {
  const { storage, fetch } = preparar(['offline', { status: 503, body: { error: 'fora' } }, 'offline', { status: 200, body: { ok: true, resultados: ['r1'] } }, { status: 200, body: { ok: true, checkstates: ['cs'] } }]);
  assert.equal(await FC360Api.enviarOuEnfileirar({ resultados: [{ id: 'r1' }] }), 'enfileirado');
  assert.equal(await FC360Api.enviarOuEnfileirar({ checkstates: [{ id: 'cs', state: {} }] }), 'enfileirado'); // já tinha fila: entra atrás, tenta drenar (503) e fica
  assert.equal(FC360Api.fila.pendentes(), 2);
  assert.deepEqual(FC360Api.fila.resultadosNaFila(), ['r1']);
  const persistido = JSON.parse(storage.getItem('fc360_fila'));
  assert.equal(persistido.length, 2);
  assert.equal(persistido[0].tentativas, 1, 'a tentativa com 503 ficou registrada');

  let r = await FC360Api.fila.drenar(); // 'offline' → para, nada enviado
  assert.equal(r.enviados.length, 0);
  assert.equal(r.restantes, 2);
  r = await FC360Api.fila.drenar();     // 200, 200
  assert.equal(r.enviados.length, 2);
  assert.equal(r.restantes, 0);
  assert.deepEqual(fetch.chamadas.slice(-2).map(c => Object.keys(c.body)[0]), ['resultados', 'checkstates'], 'ordem preservada');
  assert.equal(JSON.parse(storage.getItem('fc360_fila')).length, 0);
});

test('fila: erro 4xx (corpo inválido) descarta o item e segue; 401 e 429 ficam', async () => {
  const { logs } = preparar(['offline', 'offline', { status: 400, body: { error: 'inválido' } }, { status: 429, body: { error: 'calma' } }]);
  await FC360Api.enviarOuEnfileirar({ fotos: [{ id: 'f1', base64: 'x' }] });
  await FC360Api.enviarOuEnfileirar({ fotos: [{ id: 'f2', base64: 'y' }] });
  const r = await FC360Api.fila.drenar();
  assert.equal(r.descartados.length, 1);
  assert.equal(r.descartados[0].status, 400);
  assert.equal(r.restantes, 1, 'f2 ficou (429 é transitório)');
  assert.match(logs[0], /descartado/);
});

test('fila: checkstate e foto repetidos substituem o anterior (dedupe por chave); resultado nunca é deduplicado', async () => {
  preparar(['offline', 'offline', 'offline', 'offline', 'offline']);
  await FC360Api.enviarOuEnfileirar({ checkstates: [{ id: 'u_d', state: { a: 1 } }] });
  await FC360Api.enviarOuEnfileirar({ checkstates: [{ id: 'u_d', state: { a: 2 } }] });
  await FC360Api.enviarOuEnfileirar({ fotos: [{ id: 'f', base64: 'v1' }] });
  await FC360Api.enviarOuEnfileirar({ fotos: [{ id: 'f', base64: 'v2' }] });
  await FC360Api.enviarOuEnfileirar({ resultados: [{ id: 'r' }] });
  const fila = FC360Api.fila._ler();
  assert.equal(fila.length, 3);
  assert.deepEqual(fila[0].corpo.checkstates[0].state, { a: 2 });
  assert.equal(fila[1].corpo.fotos[0].base64, 'v2');
  assert.equal(FC360Api._chaveDe({ resultados: [{ id: 'r' }] }), null);
  assert.equal(FC360Api._chaveDe({ patches: [{ id: 'r', campos: { resetado: true } }] }), 'patch:r');
});

test('fila: storage sem espaço não perde o item (fica em memória) e avisa no log', async () => {
  const { logs } = preparar(['offline'], { limite: 50 });
  await FC360Api.enviarOuEnfileirar({ fotos: [{ id: 'grande', base64: 'x'.repeat(500) }] });
  assert.equal(FC360Api.fila.pendentes(), 1);
  assert.match(logs[0], /não coube/);
});

test('ouvintes da fila recebem o resultado de cada drenagem com envios', async () => {
  preparar(['offline', { status: 200, body: { ok: true, resultados: ['r9'] } }]);
  const vistos = [];
  FC360Api.fila.aoDrenar(r => vistos.push(r));
  await FC360Api.enviarOuEnfileirar({ resultados: [{ id: 'r9' }] });
  await FC360Api.fila.drenar();
  assert.equal(vistos.length, 1);
  assert.deepEqual(vistos[0].enviados[0].resposta.resultados, ['r9']);
});

test('drenar() concorrente reaproveita a mesma passagem', async () => {
  preparar(['offline', { status: 200, body: { ok: true } }]);
  await FC360Api.enviarOuEnfileirar({ resultados: [{ id: 'r' }] });
  const [a, b] = await Promise.all([FC360Api.fila.drenar(), FC360Api.fila.drenar()]);
  assert.equal(a, b);
  assert.equal(a.enviados.length, 1);
});
