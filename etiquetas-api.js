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
    const dadosUsuario = snap.docs[0].data();
    req.clienteId = dadosUsuario.clienteId;
    req.userLoja = dadosUsuario.loja || '';
    if (req.clienteId !== 'economico') {
      return res.status(403).json({ error: 'Módulo não habilitado para este cliente' });
    }
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido: ' + e.message });
  }
}

// Mapeamento loja (campo `loja` do usuário no Firestore, texto livre) ->
// número da loja nas tabelas de estoque do ERP (central.estoquen1..6).
// Confirmado com o Tiago (2026-08-25): não existe tabela no ERP que faça
// essa ligação (central.loja está desatualizada, só "LOJA 1"/"LOJA 2" de
// 2018) — o mapeamento é fixo aqui.
const LOJA_NUMERO = {
  cahu: 1, muribeca: 2, ponte: 3, atacarejo: 4, 'porta larga': 5, 'jardim jordao': 6
};
var DIACRITICOS_RE = new RegExp('[̀-ͯ]', 'g');
function _normalizarLoja(nome) {
  return (nome || '').normalize('NFD').replace(DIACRITICOS_RE, '')
    .trim().toLowerCase();
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
    // Estoque real por loja: confirmado (2026-08-25) que supermercado.itens
    // não tem estoque populado (coluna existe mas é 0 em 100% dos itens
    // ativos) — o dado real mora em central.estoquen1..6 (uma tabela por
    // loja), ligado por CodigoBarra (nInterno NÃO bate entre os dois
    // schemas, confirmado por teste direto). Loja resolvida via LOJA_NUMERO
    // a partir do campo `loja` do usuário logado (req.userLoja). Tentativa
    // isolada — se o usuário não tiver loja mapeada, ou a consulta falhar,
    // segue sem travar a consulta de preço/nome (frontend já trata
    // produto.estoque ausente com "—", app.js:5822).
    var numeroLoja = LOJA_NUMERO[_normalizarLoja(req.userLoja)];
    if (numeroLoja) {
      try {
        var [estRows] = await conn.query(
          'SELECT Qtd FROM central.estoquen' + numeroLoja + ' WHERE CodigoBarra = ? LIMIT 1',
          [req.params.codigoBarras]
        );
        if (estRows.length && estRows[0].Qtd != null) produto.estoque = Number(estRows[0].Qtd);
      } catch (eEst) {
        console.error('[etiquetas-api] erro ao consultar estoque da loja ' + numeroLoja + ':', eEst.code || eEst.message);
      }
    }
    res.json(produto);
  } catch (e) {
    console.error('[etiquetas-api] erro MySQL:', e.code || e.message);
    res.status(503).json({ error: 'Erro ao consultar o ERP' });
  } finally {
    if (conn) await conn.end().catch(function(){});
  }
});

// Busca por nome ou código (substring), com filtro opcional por Mercadológico
// 1/2 (Departamento/Setor) — usada pela tela de Etiquetas em Lote pra montar
// o lote com produtos reais em vez do catálogo mockado (ETC_MOCK_PRODUTOS no
// app.js, mantido só pra Avulsa/Consulta enriquecerem marca/estoque-anterior
// quando o código bate com os 6 itens de exemplo).
// Confirmado (2026-08-25): só CodGrupo/CodGrupoSub têm dado real ligado a
// produto em supermercado.itens (join com central.grupo/gruposub). Marca e
// um hipotético 3º nível (central.grupomarca/marca, codsetor/central.setor)
// foram testados e estão 100% vazios nos itens ativos — não implementados.
// Com filtro(s) preenchido(s), o termo de busca vira opcional (permite
// "navegar" por Mercadológico sem digitar nada).
app.get('/produtos/buscar', verificarToken, async function(req, res) {
  var termo = (req.query.q || '').trim();
  var codGrupo = req.query.codGrupo ? Number(req.query.codGrupo) : null;
  var codGrupoSub = req.query.codGrupoSub ? Number(req.query.codGrupoSub) : null;
  if ((!termo || termo.length < 2) && !codGrupo && !codGrupoSub) return res.json([]);
  var conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    var condicoes = ['CodDesativado = 0'];
    var params = [];
    if (termo && termo.length >= 2) {
      condicoes.push('(Descricao LIKE ? OR CodigoBarra LIKE ?)');
      var like = '%' + termo + '%';
      params.push(like, like);
    }
    if (codGrupo) { condicoes.push('CodGrupo = ?'); params.push(codGrupo); }
    if (codGrupoSub) { condicoes.push('CodGrupoSub = ?'); params.push(codGrupoSub); }
    var [rows] = await conn.query(
      'SELECT CodigoBarra, Descricao, preco, unvenda FROM supermercado.itens ' +
      'WHERE ' + condicoes.join(' AND ') + ' ORDER BY Descricao LIMIT 60',
      params
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

// Mercadológico 1 (Departamento) — lista completa, pra popular o filtro da
// tela de Montar Lote. Pouco mais de 40 grupos, não precisa paginar.
app.get('/mercadologico/grupos', verificarToken, async function(req, res) {
  var conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    var [rows] = await conn.query('SELECT CodGrupo, Descricao FROM central.grupo WHERE CodDesativado = 0 ORDER BY Descricao');
    res.json(rows.map(function(r) { return { codGrupo: r.CodGrupo, descricao: r.Descricao }; }));
  } catch (e) {
    console.error('[etiquetas-api] erro MySQL (grupos):', e.code || e.message);
    res.status(503).json({ error: 'Erro ao consultar o ERP' });
  } finally {
    if (conn) await conn.end().catch(function(){});
  }
});

// Mercadológico 2 (Setor) — filtrado por Departamento quando ?codGrupo= é
// passado (uso normal: operador escolhe Departamento primeiro).
app.get('/mercadologico/subgrupos', verificarToken, async function(req, res) {
  var codGrupo = req.query.codGrupo ? Number(req.query.codGrupo) : null;
  var conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    var sql = 'SELECT CodSubGrupo, Descricao FROM central.gruposub WHERE CodDesativado = 0';
    var params = [];
    if (codGrupo) { sql += ' AND CodGrupo = ?'; params.push(codGrupo); }
    sql += ' ORDER BY Descricao';
    var [rows] = await conn.query(sql, params);
    res.json(rows.map(function(r) { return { codGrupoSub: r.CodSubGrupo, descricao: r.Descricao }; }));
  } catch (e) {
    console.error('[etiquetas-api] erro MySQL (subgrupos):', e.code || e.message);
    res.status(503).json({ error: 'Erro ao consultar o ERP' });
  } finally {
    if (conn) await conn.end().catch(function(){});
  }
});

const PORT = process.env.PORT || 3011;
app.listen(PORT, () => console.log('etiquetas-api rodando na porta ' + PORT));

module.exports = { app, verificarToken };
