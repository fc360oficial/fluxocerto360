// Fase 3: copia as outras coleções do Firestore pra tabela `documento` (idempotente, upsert por id).
//   node tools/backfill-colecoes.js [--so=usuarios,planos] [--pular=inv_bipagens]
// Timestamp do Firestore vira {"__ts": "<iso>"} (o app lê com toDate() pela lib/fc360-store.js).
// Subcoleções do módulo Promotores (clientes/{id}/fornecedores e promotor_visitas) ficam no
// Firestore por enquanto (página pública do promotor usa auth anônimo de lá).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { criarPool, migrar } = require('../lib/db');

const COLECOES = ['usuarios', 'clientes', 'tokens', 'config', 'checklists', 'planos', 'contagens', 'perdas', 'inventarios',
  'inv_inventarios', 'inv_bipagens', 'inv_catalogo', 'inv_catalogo_blocos', 'inv_auditlog',
  'etiquetas_log', 'etiquetas_lote', 'etiquetas_layout', 'fornecedores', 'visitas', 'historico', 'hist'];

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const SO = args.so ? String(args.so).split(',') : null;
const PULAR = args.pular ? String(args.pular).split(',') : [];

initializeApp({ credential: cert(require(path.resolve(__dirname, '..', process.env.GOOGLE_APPLICATION_CREDENTIALS))) });
const fs = getFirestore();

function converter(v) {
  if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
  if (v instanceof Date) return { __ts: v.toISOString() };
  if (Array.isArray(v)) return v.map(converter);
  if (v && typeof v === 'object') {
    if (typeof v.toDate === 'function') return { __ts: v.toDate().toISOString() };
    const o = {};
    for (const k of Object.keys(v)) { const c = converter(v[k]); if (c !== undefined) o[k] = c; }
    return o;
  }
  return v;
}

function clienteDe(colecao, id, dados) {
  if (colecao === 'clientes') return id;
  if (colecao === 'config') return '';
  if (colecao === 'tokens') return dados.clienteId || '';
  return dados.clienteId || 'economico'; // pré multi-tenant = Econômico (mesma regra do app)
}

(async () => {
  const pool = criarPool(process.env.DATABASE_URL);
  await migrar(pool);
  const t0 = Date.now();
  const resumo = {};
  for (const col of COLECOES) {
    if (SO && !SO.includes(col)) continue;
    if (PULAR.includes(col)) continue;
    let total = 0, ultimo = null;
    for (;;) {
      let q = fs.collection(col).orderBy('__name__').limit(300);
      if (ultimo) q = q.startAfter(ultimo);
      const snap = await q.get();
      if (snap.empty) break;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const d of snap.docs) {
          const dados = converter(d.data());
          await client.query(
            `INSERT INTO documento (colecao, id, cliente_id, dados) VALUES ($1,$2,$3,$4)
             ON CONFLICT (colecao, id) DO UPDATE SET dados = EXCLUDED.dados, cliente_id = EXCLUDED.cliente_id, atualizado_em = now()`,
            [col, d.id, clienteDe(col, d.id, dados), JSON.stringify(dados)]);
          total++;
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
      ultimo = snap.docs[snap.docs.length - 1];
      if (snap.size < 300) break;
    }
    resumo[col] = total;
    console.log(col.padEnd(22), total);
  }
  const { rows } = await pool.query('SELECT colecao, count(*)::int AS n FROM documento GROUP BY colecao ORDER BY colecao');
  console.log('no Postgres agora:', rows.map(r => r.colecao + '=' + r.n).join(' '), `· ${Math.round((Date.now() - t0) / 1000)}s`);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('backfill de coleções falhou:', e); process.exit(1); });
