// Importa o histórico do Firestore pro Postgres — roda 1x no .254 antes de virar a chave do app.
//   node tools/backfill-firestore.js [--dias-fotos=2] [--so-contar]
//
// O que traz: resultados (todos), resultados_fotos (todas), fotos avulsas e checkstates só
// dos últimos N dias (são do checklist em andamento; o resto é lixo). Idempotente: grava com
// o mesmo gravarSync da API (upsert por id), pode rodar de novo. Leituras do Firestore:
// 1 por documento, uma vez (≈ 4 mil hoje) — longe da cota de 50 mil.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { criarPool, migrar } = require('../lib/db');
const { gravarSync, dataValida } = require('../lib/gravar');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const DIAS_FOTOS = Number(args['dias-fotos'] || 2);
const SO_CONTAR = !!args['so-contar'];
const FOTOS_RAIZ = process.env.FOTOS_DIR || path.join(__dirname, '..', 'data', 'fotos');

initializeApp({ credential: cert(require(path.resolve(__dirname, '..', process.env.GOOGLE_APPLICATION_CREDENTIALS))) });
const fs = getFirestore();

function diasAtras(n) { const d = new Date(Date.now() - 3 * 3600 * 1000 - n * 86400000); return d.toISOString().slice(0, 10); }
function usuarioFake(clienteId) { return { id: 'backfill', clienteId, loja: '', nome: 'backfill' }; }

async function lote(colecao, filtro, cb) {
  // pagina de 200 em 200 por id (sem índice composto) pra não segurar 2 mil docs com base64 na memória
  let ultimo = null, total = 0;
  for (;;) {
    let q = fs.collection(colecao).orderBy('__name__').limit(200);
    if (filtro) q = filtro(q);
    if (ultimo) q = q.startAfter(ultimo);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) { await cb(Object.assign({ id: d.id }, d.data())); total++; }
    ultimo = snap.docs[snap.docs.length - 1];
    if (snap.size < 200) break;
  }
  return total;
}

(async () => {
  const pool = criarPool(process.env.DATABASE_URL);
  await migrar(pool);
  const desdeFotos = diasAtras(DIAS_FOTOS);
  const stats = { resultados: 0, resultados_fotos: 0, fotos: 0, checkstates: 0, rejeitados: [] };
  const porCliente = {};
  const t0 = Date.now();

  async function gravar(clienteId, corpo) {
    porCliente[clienteId] = (porCliente[clienteId] || 0) + 1;
    if (SO_CONTAR) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await gravarSync(client, usuarioFake(clienteId), corpo, 'backfill', FOTOS_RAIZ, { semLog: true });
      await client.query('COMMIT');
      stats.rejeitados.push(...out.rejeitados);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  stats.resultados = await lote('resultados', null, async d => {
    const clienteId = d.clienteId || 'economico';
    if (!dataValida(d.dateISO)) {
      // doc antigo sem dateISO: deriva de dataHora 'dd/mm/aaaa ...'
      const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(d.dataHora || '');
      d.dateISO = m ? `${m[3]}-${m[2]}-${m[1]}` : '2026-01-01';
    }
    await gravar(clienteId, { resultados: [d] });
  });
  console.log(`resultados: ${stats.resultados}`);

  stats.resultados_fotos = await lote('resultados_fotos', null, async d => {
    await gravar(d.clienteId || 'economico', { resultados_fotos: [d] });
  });
  console.log(`resultados_fotos: ${stats.resultados_fotos}`);

  stats.fotos = await lote('fotos', q => q.where('date', '>=', desdeFotos), async d => {
    await gravar(d.clienteId || 'economico', { fotos: [d] });
  });
  console.log(`fotos (desde ${desdeFotos}): ${stats.fotos}`);

  stats.checkstates = await lote('checkstates', q => q.where('date', '>=', desdeFotos), async d => {
    await gravar(d.clienteId || 'economico', { checkstates: [d] });
  });
  console.log(`checkstates (desde ${desdeFotos}): ${stats.checkstates}`);

  console.log('por cliente:', porCliente);
  if (stats.rejeitados.length) console.log('rejeitados:', stats.rejeitados.length, JSON.stringify(stats.rejeitados.slice(0, 10)));
  const { rows } = await pool.query("SELECT (SELECT count(*) FROM resultado) AS resultados, (SELECT count(*) FROM foto) AS fotos, (SELECT count(*) FROM checkstate) AS checkstates");
  console.log('no Postgres agora:', rows[0], `· ${Math.round((Date.now() - t0) / 1000)}s`);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('backfill falhou:', e); process.exit(1); });
