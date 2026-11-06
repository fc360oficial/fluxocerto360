const test = require('node:test');
const assert = require('node:assert/strict');
const FC360Store = require('../lib/fc360-store.js');

// FC360Api falso: guarda as chamadas e responde conforme um "banco" em memória
function apiFake() {
  const banco = {}; // col -> { id: dados }
  const chamadas = [];
  let offline = false;
  const api = {
    banco, chamadas, setOffline: v => { offline = v; },
    chamar: async (metodo, rota) => {
      chamadas.push({ metodo, rota });
      if (offline) { const e = new Error('sem conexão'); e.status = 0; e.offline = true; throw e; }
      const m = /^\/col\/([^/?]+)(?:\/([^?]+))?(?:\?(.*))?$/.exec(rota);
      if (!m) throw Object.assign(new Error('rota?'), { status: 404 });
      const col = decodeURIComponent(m[1]);
      if (m[2]) { const d = (banco[col] || {})[decodeURIComponent(m[2])]; if (!d) throw Object.assign(new Error('nao'), { status: 404 }); return Object.assign({ id: decodeURIComponent(m[2]) }, d); }
      const params = new URLSearchParams(m[3] || '');
      let lista = Object.keys(banco[col] || {}).map(id => Object.assign({ id }, banco[col][id]));
      const where = params.get('where') ? JSON.parse(params.get('where')) : [];
      for (const [campo, op, valor] of where) lista = lista.filter(d => op === '==' ? d[campo] === valor : op === 'in' ? valor.includes(d[campo]) : op === '>=' ? d[campo] >= valor : true);
      if (params.get('limit')) lista = lista.slice(0, Number(params.get('limit')));
      return lista;
    },
    enviarOuEnfileirar: async (corpo) => {
      chamadas.push({ metodo: 'POST', rota: '/sync', corpo });
      if (offline) return 'enfileirado';
      for (const o of corpo.ops) {
        banco[o.col] = banco[o.col] || {};
        if (o.op === 'delete') delete banco[o.col][o.id];
        else if (o.op === 'set' && !o.merge) banco[o.col][o.id] = o.dados;
        else banco[o.col][o.id] = Object.assign({}, banco[o.col][o.id] || {}, o.dados);
      }
      return 'enviado';
    },
    fila: { drenar: async () => ({ enviados: [], restantes: 0 }) },
  };
  return api;
}

function preparar() {
  const api = apiFake();
  const mem = {}; const storage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; }, removeItem: k => { delete mem[k]; }, get length() { return Object.keys(mem).length; }, key: i => Object.keys(mem)[i] };
  FC360Store._limparCache();
  FC360Store.configurar({ api, storage, intervaloListener: 30, agora: () => Date.parse('2026-11-06T03:00:00Z') });
  return { api, storage, db: FC360Store.db };
}

test('serializar/hidratar: Date e Timestamp viram {__ts}; sentinelas passam; undefined some; {__ts} volta com toDate()', () => {
  const s = FC360Store._serializar({ a: new Date('2026-01-02T03:04:05.000Z'), b: FC360Store.FieldValue.serverTimestamp(), c: undefined, d: [1, undefined], e: { f: FC360Store.FieldValue.delete() } });
  assert.deepEqual(s, { a: { __ts: '2026-01-02T03:04:05.000Z' }, b: { __serverTimestamp: true }, d: [1, null], e: { f: { __delete: true } } });
  const h = FC360Store._hidratar({ criadoEm: { __ts: '2026-01-02T03:04:05.000Z' }, lista: [{ __ts: '2026-01-01T00:00:00.000Z' }], n: 1 });
  assert.equal(h.criadoEm.toDate().toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(h.criadoEm.toMillis(), Date.parse('2026-01-02T03:04:05.000Z'));
  assert.equal(h.lista[0].toDate().getUTCFullYear(), 2026);
  assert.equal(h.n, 1);
  assert.equal(JSON.stringify({ t: h.criadoEm }), '{"t":{"__ts":"2026-01-02T03:04:05.000Z"}}', 'reenviar um Timestamp lido mantém o formato');
});

test('doc: set/get/update/delete, exists, data() sem id, caminhos com ponto e FieldPath', async () => {
  const { api, db } = preparar();
  const ref = db.collection('planos').doc('p1');
  await ref.set({ desc: 'x', status: 'aberto', criadoEm: FC360Store.FieldValue.serverTimestamp() });
  assert.deepEqual(api.chamadas[0].corpo.ops[0], { op: 'set', col: 'planos', id: 'p1', dados: { desc: 'x', status: 'aberto', criadoEm: { __serverTimestamp: true } }, merge: false });
  let snap = await ref.get();
  assert.equal(snap.exists, true);
  assert.equal(snap.id, 'p1');
  assert.deepEqual(snap.data(), { id: 'p1', desc: 'x', status: 'aberto', criadoEm: { __serverTimestamp: true } }, 'data() mantém o id dentro do doc');
  await ref.update({ status: 'resolvido', 'meta.por': 'eu' });
  await ref.update(new FC360Store.FieldPath('fila', 'A1'), FC360Store.FieldValue.delete());
  await ref.update('push.k1', { endpoint: 'e' });
  const ops = api.chamadas.filter(c => c.rota === '/sync').map(c => c.corpo.ops[0]);
  assert.deepEqual(ops[1].dados, { status: 'resolvido', 'meta.por': 'eu' });
  assert.deepEqual(ops[2].dados, { 'fila.A1': { __delete: true } });
  assert.deepEqual(ops[3].dados, { 'push.k1': { endpoint: 'e' } });
  await ref.delete();
  snap = await ref.get();
  assert.equal(snap.exists, false);
  assert.equal(snap.data(), undefined);
  await ref.set({ a: 1 }, { merge: true });
  assert.equal(api.chamadas[api.chamadas.length - 1].corpo.ops[0].merge, true);
});

test('query: where/orderBy/limit viram a URL certa; snapshot tem docs/empty/size/forEach e doc.ref', async () => {
  const { api, db } = preparar();
  api.banco.tokens = { t1: { clienteId: 'economico', usado: false }, t2: { clienteId: 'economico', usado: true }, t3: { clienteId: 'fluxo', usado: false } };
  const snap = await db.collection('tokens').where('clienteId', '==', 'economico').where('usado', '==', false).orderBy('criadoEm', 'desc').limit(20).get();
  const rota = api.chamadas[0].rota;
  assert.match(rota, /^\/col\/tokens\?where=/);
  assert.deepEqual(JSON.parse(decodeURIComponent(rota.split('where=')[1].split('&')[0])), [['clienteId', '==', 'economico'], ['usado', '==', false]]);
  assert.match(rota, /orderBy=%5B%5B%22criadoEm%22%2C%22desc%22%5D%5D/);
  assert.match(rota, /limit=20$/);
  assert.equal(snap.size, 1);
  assert.equal(snap.empty, false);
  assert.equal(snap.docs[0].id, 't1');
  assert.equal(snap.docs[0].data().usado, false);
  let n = 0; snap.forEach(() => n++); assert.equal(n, 1);
  await snap.docs[0].ref.update({ usado: true });
  assert.equal(api.banco.tokens.t1.usado, true);
  const vazio = await db.collection('tokens').where('clienteId', '==', 'ninguem').get();
  assert.equal(vazio.empty, true);
  assert.equal((await db.collection('planos').where('status', 'in', ['aberto', 'andamento']).get()).size, 0);
});

test('batch: set/update/delete numa só chamada; commit vazio não chama nada', async () => {
  const { api, db } = preparar();
  const b = db.batch();
  b.set(db.collection('a').doc('1'), { x: 1 });
  b.update(db.collection('a').doc('2'), { y: FC360Store.FieldValue.serverTimestamp() });
  b.delete(db.collection('b').doc('3'));
  await b.commit();
  assert.equal(api.chamadas.length, 1);
  assert.deepEqual(api.chamadas[0].corpo.ops.map(o => o.op), ['set', 'update', 'delete']);
  await db.batch().commit();
  assert.equal(api.chamadas.length, 1);
});

test('offline: leitura devolve a última resposta guardada (fromCache); escrita resolve como enfileirada', async () => {
  const { api, db } = preparar();
  api.banco.checklists = { c1: { nome: 'Abertura' } };
  const antes = await db.collection('checklists').get();
  assert.equal(antes.metadata.fromCache, false);
  api.setOffline(true);
  const depois = await db.collection('checklists').get();
  assert.equal(depois.metadata.fromCache, true);
  assert.equal(depois.docs[0].data().nome, 'Abertura');
  const doc = await db.collection('checklists').doc('c1').get().catch(e => e);
  assert.equal(doc.code, 'unavailable', 'doc nunca lido antes não tem cache');
  await db.collection('planos').doc('novo').set({ a: 1 }); // não rejeita
  api.setOffline(false);
});

test('onSnapshot: chama no 1º resultado e só quando muda; docChanges; unsubscribe para', async () => {
  const { api, db } = preparar();
  api.banco.inv_bipagens = { b1: { invId: 'i1', qty: 1 } };
  const vistos = [];
  const unsub = db.collection('inv_bipagens').where('invId', '==', 'i1').onSnapshot(s => vistos.push(s));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(vistos.length, 1);
  assert.deepEqual(vistos[0].docChanges().map(c => c.type), ['added']);
  await new Promise(r => setTimeout(r, 70));
  assert.equal(vistos.length, 1, 'sem mudança, sem chamada');
  api.banco.inv_bipagens.b2 = { invId: 'i1', qty: 2 };
  api.banco.inv_bipagens.b1.qty = 5;
  await new Promise(r => setTimeout(r, 70));
  assert.equal(vistos.length, 2);
  assert.deepEqual(vistos[1].docChanges().map(c => c.type + ':' + c.doc.id).sort(), ['added:b2', 'modified:b1']);
  unsub();
  api.banco.inv_bipagens.b3 = { invId: 'i1' };
  await new Promise(r => setTimeout(r, 70));
  assert.equal(vistos.length, 2);
  // listener de documento
  const vistosDoc = [];
  const unsub2 = db.collection('inv_inventarios').doc('i1').onSnapshot(s => vistosDoc.push(s.exists));
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(vistosDoc, [false]);
  api.banco.inv_inventarios = { i1: { nome: 'Balanço' } };
  await new Promise(r => setTimeout(r, 70));
  assert.deepEqual(vistosDoc, [false, true]);
  unsub2();
});

test('db.collection().doc() sem id gera id de 20 chars; add() grava e devolve a ref', async () => {
  const { api, db } = preparar();
  const r = db.collection('x').doc();
  assert.equal(r.id.length, 20);
  const r2 = await db.collection('x').add({ a: 1 });
  assert.equal(api.banco.x[r2.id].a, 1);
});
