// etiquetas-api.js — serviço isolado, processo separado de server.js.
// Só faz SELECT no MySQL do ERP (nunca INSERT/UPDATE/DELETE).
require('dotenv').config({ path: '.env.etiquetas-api' });
const express = require('express');
const cors = require('cors');
// firebase-admin ^14 usa a API modular (sem o namespace admin.auth()/
// admin.firestore()/admin.credential.cert() das versões antigas).
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const mysql = require('mysql2/promise');

initializeApp({
  credential: cert(require(process.env.GOOGLE_APPLICATION_CREDENTIALS))
});
const firestore = getFirestore();

const app = express();

// O FC360 PWA é servido do GitHub Pages (fc360oficial.github.io), origem
// diferente desta API — o browser manda preflight OPTIONS em toda chamada
// autenticada (header Authorization), e sem CORS o Express responde 404,
// quebrando o fetch() no app. ALLOWED_ORIGIN deve ser configurado por
// deploy com a(s) origem(ns) real(is) do FC360 em produção — NUNCA usar
// origin:'*' aqui porque o endpoint é autenticado. Aceita uma lista
// separada por vírgula para suportar múltiplas origens (ex.: produção +
// homologação).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://fc360oficial.github.io')
  .split(',').map(function(o) { return o.trim(); }).filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET'],
  allowedHeaders: ['Authorization', 'Content-Type']
}));

// Verifica o Firebase ID token do operador já logado no FC360, e resolve
// o clienteId do usuário consultando a mesma coleção `usuarios` que o
// app.js usa (finalizarLogin, app.js:1285) — não existe custom claim de
// clienteId no token ainda, então a busca é por e-mail, igual ao app.
// v1 deste módulo é escopo único-tenant (Econômico) — ver spec §9: extrai
// clienteId do usuário para evitar expor consulta de preço do ERP sem
// controle. Por isso não há fallback silencioso para 'economico': um
// clienteId ausente/desconhecido é rejeitado, não tratado como Econômico.
async function verificarToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    const decoded = await getAuth().verifyIdToken(token);
    const snap = await firestore.collection('usuarios')
      .where('email', '==', (decoded.email || '').toLowerCase())
      .limit(1).get();
    if (snap.empty) return res.status(403).json({ error: 'Usuário não encontrado' });
    req.clienteId = snap.docs[0].data().clienteId;
    if (req.clienteId !== 'economico') {
      return res.status(403).json({ error: 'Módulo não habilitado para este cliente' });
    }
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido: ' + e.message });
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

const dbConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectTimeout: 15000
};

// Tabela confirmada via investigação de schema (supermercado.itens, chave
// nInterno) — é a que tem preço real e atualizado; central.itens existe
// mas está com 100% dos preços zerados (base legada), não usar.
app.get('/produto/:codigoBarras', verificarToken, async function(req, res) {
  var conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    var [rows] = await conn.query(
      'SELECT CodigoBarra, Descricao, preco, unvenda FROM supermercado.itens WHERE CodigoBarra = ? AND CodDesativado = 0 LIMIT 1',
      [req.params.codigoBarras]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    var produto = {
      codigoBarras: rows[0].CodigoBarra,
      nome: rows[0].Descricao,
      preco: Number(rows[0].preco),
      unidade: rows[0].unvenda
    };
    // Estoque: coluna NÃO confirmada em supermercado.itens (só existe
    // comprovada na base legada central.itens/estoquen1-6, que tem preço
    // zerado e por isso não é usada pra mais nada aqui). Tentativa isolada
    // do resto da resposta — se a coluna não existir, loga e segue sem
    // travar a consulta de preço/nome, que já é comprovada em produção.
    try {
      var [estRows] = await conn.query(
        'SELECT Estoque FROM supermercado.itens WHERE CodigoBarra = ? LIMIT 1',
        [req.params.codigoBarras]
      );
      if (estRows.length && estRows[0].Estoque != null) produto.estoque = Number(estRows[0].Estoque);
    } catch (eEst) {
      console.error('[etiquetas-api] coluna de estoque indisponível em supermercado.itens (esperado até confirmar ao vivo):', eEst.code || eEst.message);
    }
    res.json(produto);
  } catch (e) {
    console.error('[etiquetas-api] erro MySQL:', e.code || e.message);
    res.status(503).json({ error: 'Erro ao consultar o ERP' });
  } finally {
    if (conn) await conn.end().catch(function(){});
  }
});

// Busca por nome ou código (substring) — usada pela tela de Etiquetas em
// Lote pra montar o lote com produtos reais em vez do catálogo mockado
// (ETC_MOCK_PRODUTOS no app.js, mantido só pra Avulsa/Consulta enriquecerem
// marca/estoque-anterior quando o código bate com os 6 itens de exemplo).
// Sem filtro de Departamento/Setor/Marca — sem coluna confirmada pra isso.
app.get('/produtos/buscar', verificarToken, async function(req, res) {
  var termo = (req.query.q || '').trim();
  if (!termo || termo.length < 2) return res.json([]);
  var conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    var like = '%' + termo + '%';
    var [rows] = await conn.query(
      'SELECT CodigoBarra, Descricao, preco, unvenda FROM supermercado.itens ' +
      'WHERE CodDesativado = 0 AND (Descricao LIKE ? OR CodigoBarra LIKE ?) ' +
      'ORDER BY Descricao LIMIT 30',
      [like, like]
    );
    res.json(rows.map(function(r) {
      return { codigoBarras: r.CodigoBarra, nome: r.Descricao, preco: Number(r.preco), unidade: r.unvenda };
    }));
  } catch (e) {
    console.error('[etiquetas-api] erro MySQL (busca):', e.code || e.message);
    res.status(503).json({ error: 'Erro ao consultar o ERP' });
  } finally {
    if (conn) await conn.end().catch(function(){});
  }
});

const PORT = process.env.PORT || 3011;
app.listen(PORT, () => console.log('etiquetas-api rodando na porta ' + PORT));

module.exports = { app, verificarToken };
