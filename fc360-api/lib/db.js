// Pool do Postgres + migrações em sql/NNN_*.sql (aplicadas em ordem, uma vez cada).
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function criarPool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30000 });
}

async function migrar(pool, sqlDir) {
  sqlDir = sqlDir || path.join(__dirname, '..', 'sql');
  const arquivos = fs.readdirSync(sqlDir).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS migracao (versao int PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT versao FROM migracao');
    const feitas = new Set(rows.map(r => r.versao));
    const aplicadas = [];
    for (const f of arquivos) {
      const versao = parseInt(f.slice(0, 3), 10);
      if (feitas.has(versao)) continue;
      const sql = fs.readFileSync(path.join(sqlDir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migracao (versao) VALUES ($1)', [versao]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migração ${f} falhou: ${e.message}`);
      }
      aplicadas.push(f);
    }
    return aplicadas;
  } finally {
    client.release();
  }
}

module.exports = { criarPool, migrar };
