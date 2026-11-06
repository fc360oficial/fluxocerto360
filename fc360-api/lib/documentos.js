// Coleções genéricas (fase 3): a tabela `documento` guarda qualquer coleção do app com a
// semântica que o app já usa do Firestore — where/orderBy/limit, set/merge/update/delete,
// caminhos com ponto no update ("push.abc"), serverTimestamp, FieldValue.delete, arrayUnion.
//
// Sentinelas que o cliente (lib/fc360-store.js) manda dentro do JSON:
//   {"__serverTimestamp": true}  → vira {"__ts": "<iso agora>"}
//   {"__delete": true}           → remove o campo
//   {"__arrayUnion": [..]}       → junta ao array existente (sem repetir)
// Timestamp lido: {"__ts": "<iso>"}; o cliente devolve um objeto com toDate().
'use strict';

const OPS_WHERE = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains']);
const LIMITE_MAX = 2000;
const SENSIVEIS = { usuarios: ['senha', 'senha_hash', '_fbNewPass'] };

// ── escopo por coleção ─────────────────────────────────────────────────────────
// Devolve como a consulta é restringida e quem pode escrever. Padrão: tudo do tenant.
function escopo(colecao, u) {
  const sup = u.perfil === 'superadmin';
  const gestor = ['admin', 'gerencia', 'supervisor'].includes(u.perfil);
  if (colecao === 'usuarios') {
    return { clienteId: sup ? null : u.clienteId,
      clienteIdNovo: (id, dados) => sup ? (dados && dados.clienteId) || '' : u.clienteId,
      escrever: (id) => sup || gestor || id === u.id };
  }
  if (colecao === 'clientes') {
    return { clienteId: null, somenteIds: sup ? null : [u.clienteId],
      clienteIdNovo: (id) => id,
      escrever: (id) => sup || (id === u.clienteId && u.perfil === 'admin') };
  }
  if (colecao === 'tokens') {
    // cliente ativa um token pelo código (lê por id) e marca como usado
    return { clienteId: sup ? null : u.clienteId, lerPorIdQualquer: true,
      clienteIdNovo: (id, dados) => (dados && dados.clienteId) || u.clienteId,
      escrever: (id, dados, existente) => sup || (!!existente && gestor) };
  }
  if (colecao === 'config') {
    return { clienteId: null, somente: sup, clienteIdNovo: () => '', escrever: () => sup };
  }
  return { clienteId: u.clienteId, clienteIdNovo: () => u.clienteId, escrever: () => true };
}

function limparSensiveis(colecao, dados) {
  const lista = SENSIVEIS[colecao];
  if (!lista || !dados) return dados;
  const c = Object.assign({}, dados);
  lista.forEach(k => { delete c[k]; });
  return c;
}

// ── consulta ──────────────────────────────────────────────────────────────────
function caminho(campo) { return String(campo).split('.'); }

function montarConsulta(usuario, colecao, q) {
  const esc = escopo(colecao, usuario);
  if (esc.somente === false) return null;
  const params = [colecao];
  const cond = ['colecao = $1'];
  if (esc.clienteId !== null && esc.clienteId !== undefined) { params.push(esc.clienteId); cond.push('cliente_id = $' + params.length); }
  if (esc.somenteIds) { params.push(esc.somenteIds); cond.push('id = ANY($' + params.length + '::text[])'); }
  if (q.ids && q.ids.length) { params.push(q.ids.slice(0, 500)); cond.push('id = ANY($' + params.length + '::text[])'); }
  for (const w of q.where || []) {
    if (!Array.isArray(w) || w.length !== 3) throw new Error('where inválido');
    const [campo, op, valor] = w;
    if (!OPS_WHERE.has(op)) throw new Error('operador inválido: ' + op);
    params.push(caminho(campo));
    const p = '$' + params.length + '::text[]';
    if (op === '==') {
      if (valor === null || valor === undefined) { cond.push(`(dados #> ${p} IS NULL OR dados #> ${p} = 'null'::jsonb)`); continue; }
      params.push(JSON.stringify(valor)); cond.push(`dados #> ${p} = $${params.length}::jsonb`);
    } else if (op === '!=') {
      params.push(JSON.stringify(valor)); cond.push(`dados #> ${p} IS DISTINCT FROM $${params.length}::jsonb`);
    } else if (op === 'in') {
      if (!Array.isArray(valor)) throw new Error("'in' precisa de lista");
      params.push(valor.map(v => JSON.stringify(v))); cond.push(`dados #> ${p} = ANY($${params.length}::jsonb[])`);
    } else if (op === 'array-contains') {
      params.push(JSON.stringify([valor])); cond.push(`dados #> ${p} @> $${params.length}::jsonb`);
    } else {
      if (typeof valor === 'number') { params.push(valor); cond.push(`(jsonb_typeof(dados #> ${p}) = 'number' AND (dados #>> ${p})::numeric ${op} $${params.length})`); }
      else { params.push(String(valor)); cond.push(`dados #>> ${p} ${op} $${params.length}`); }
    }
  }
  let ordem = '';
  if (q.orderBy && q.orderBy.length) {
    ordem = ' ORDER BY ' + q.orderBy.map(o => {
      const [campo, dir] = Array.isArray(o) ? o : [o, 'asc'];
      params.push(caminho(campo));
      return `dados #> $${params.length}::text[] ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
    }).join(', ');
  } else ordem = ' ORDER BY criado_em';
  const limite = Math.min(Math.max(parseInt(q.limit, 10) || LIMITE_MAX, 1), LIMITE_MAX);
  return { sql: `SELECT id, dados FROM documento WHERE ${cond.join(' AND ')}${ordem} LIMIT ${limite}`, params };
}

async function consultar(pool, usuario, colecao, q) {
  const c = montarConsulta(usuario, colecao, q || {});
  if (!c) return [];
  const { rows } = await pool.query(c.sql, c.params);
  return rows.map(r => Object.assign({ id: r.id }, limparSensiveis(colecao, r.dados)));
}

async function buscar(pool, usuario, colecao, id) {
  const esc = escopo(colecao, usuario);
  if (esc.somente === false) return null;
  const { rows } = await pool.query('SELECT id, cliente_id, dados FROM documento WHERE colecao=$1 AND id=$2', [colecao, id]);
  if (!rows.length) return null;
  const r = rows[0];
  if (esc.lerPorIdQualquer) return Object.assign({ id: r.id }, limparSensiveis(colecao, r.dados));
  if (esc.clienteId !== null && esc.clienteId !== undefined && r.cliente_id !== esc.clienteId) return null;
  if (esc.somenteIds && !esc.somenteIds.includes(id)) return null;
  return Object.assign({ id: r.id }, limparSensiveis(colecao, r.dados));
}

// ── escrita ───────────────────────────────────────────────────────────────────
function ehObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Resolve sentinelas num valor novo (set sem merge). `atual` é o valor que já existia no mesmo caminho.
function resolver(valor, atual, agora) {
  if (ehObj(valor)) {
    if (valor.__serverTimestamp === true) return { __ts: agora };
    if (valor.__delete === true) return undefined;
    if (Array.isArray(valor.__arrayUnion)) {
      const base = Array.isArray(atual) ? atual.slice() : [];
      for (const it of valor.__arrayUnion) { if (!base.some(b => JSON.stringify(b) === JSON.stringify(it))) base.push(it); }
      return base;
    }
    const out = {};
    for (const k of Object.keys(valor)) {
      const r = resolver(valor[k], ehObj(atual) ? atual[k] : undefined, agora);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return valor;
}

// merge profundo (set com {merge:true}): objetos se juntam, o resto substitui
function mesclar(atual, novo, agora) {
  const out = ehObj(atual) ? Object.assign({}, atual) : {};
  for (const k of Object.keys(novo)) {
    const v = novo[k];
    if (ehObj(v) && !v.__serverTimestamp && !v.__delete && !v.__arrayUnion) out[k] = mesclar(out[k], v, agora);
    else {
      const r = resolver(v, out[k], agora);
      if (r === undefined) delete out[k]; else out[k] = r;
    }
  }
  return out;
}

// update: cada chave pode ser "a.b.c"
function atualizar(atual, campos, agora) {
  const out = ehObj(atual) ? JSON.parse(JSON.stringify(atual)) : {};
  for (const chave of Object.keys(campos)) {
    const partes = chave.split('.');
    let alvo = out;
    for (let i = 0; i < partes.length - 1; i++) {
      if (!ehObj(alvo[partes[i]])) alvo[partes[i]] = {};
      alvo = alvo[partes[i]];
    }
    const ult = partes[partes.length - 1];
    const v = campos[chave];
    if (ehObj(v) && !v.__serverTimestamp && !v.__delete && !v.__arrayUnion) { alvo[ult] = mesclar(undefined, v, agora); continue; }
    const r = resolver(v, alvo[ult], agora);
    if (r === undefined) delete alvo[ult]; else alvo[ult] = r;
  }
  return out;
}

// ops = [{op:'set'|'update'|'delete', col, id, dados, merge}] dentro de uma transação aberta.
async function aplicarOps(client, usuario, ops) {
  const feitos = [], rejeitados = [];
  const agora = new Date().toISOString();
  for (const o of ops || []) {
    const col = String(o && o.col || '').slice(0, 80);
    const id = String(o && o.id || '').slice(0, 200);
    if (!col || !id || !['set', 'update', 'delete'].includes(o.op)) { rejeitados.push({ col, id, motivo: 'op inválida' }); continue; }
    if (/[^a-zA-Z0-9_\/-]/.test(col)) { rejeitados.push({ col, id, motivo: 'coleção inválida' }); continue; }
    if (col === 'resultados') { // tabela própria (fase 2): só exclusão, pro "zerar dados" do admin
      if (o.op !== 'delete' || !['admin', 'superadmin'].includes(usuario.perfil)) { rejeitados.push({ col, id, motivo: 'resultados: só exclusão por admin' }); continue; }
      await client.query('DELETE FROM foto WHERE cliente_id=$1 AND resultado_id=$2', [usuario.clienteId, id]);
      await client.query('DELETE FROM resultado WHERE cliente_id=$1 AND id=$2', [usuario.clienteId, id]);
      feitos.push({ col, id, op: 'delete' }); continue;
    }
    const esc = escopo(col, usuario);
    const { rows } = await client.query('SELECT cliente_id, dados FROM documento WHERE colecao=$1 AND id=$2 FOR UPDATE', [col, id]);
    const existente = rows[0] || null;
    if (existente && esc.clienteId !== null && esc.clienteId !== undefined && existente.cliente_id !== esc.clienteId && usuario.perfil !== 'superadmin') {
      rejeitados.push({ col, id, motivo: 'documento de outro cliente' }); continue;
    }
    if (existente && esc.somenteIds && !esc.somenteIds.includes(id)) { rejeitados.push({ col, id, motivo: 'sem acesso' }); continue; }
    if (!esc.escrever(id, o.dados, existente)) { rejeitados.push({ col, id, motivo: 'sem permissão' }); continue; }
    if (col === 'usuarios' && usuario.perfil !== 'superadmin') {
      // quem não é gestor só mexe no próprio aparelho/push; ninguém vira superadmin nem troca de cliente por aqui
      const gestor = ['admin', 'gerencia', 'supervisor'].includes(usuario.perfil);
      const chaves = Object.keys(ehObj(o.dados) ? o.dados : {}).map(k => k.split('.')[0]);
      const PROPRIOS = ['dispositivo', 'push', 'ultimoAcesso', 'ultimoLogin', 'fotoPerfil', 'telefone'];
      if (!gestor && (o.op !== 'update' || chaves.some(k => !PROPRIOS.includes(k)))) { rejeitados.push({ col, id, motivo: 'só gestor altera cadastro de usuário' }); continue; }
      const d = ehObj(o.dados) ? o.dados : {};
      if (d.perfil === 'superadmin' || (d.clienteId && d.clienteId !== usuario.clienteId)) { rejeitados.push({ col, id, motivo: 'perfil/cliente não permitido' }); continue; }
    }
    if (o.op === 'delete') {
      await client.query('DELETE FROM documento WHERE colecao=$1 AND id=$2', [col, id]);
      feitos.push({ col, id, op: 'delete' }); continue;
    }
    const dados = ehObj(o.dados) ? o.dados : {};
    let novo;
    if (o.op === 'set' && !o.merge) novo = resolver(dados, existente ? existente.dados : undefined, agora);
    else if (o.op === 'set') novo = mesclar(existente ? existente.dados : {}, dados, agora);
    else {
      if (!existente) { rejeitados.push({ col, id, motivo: 'update em documento que não existe' }); continue; }
      novo = atualizar(existente.dados, dados, agora);
    }
    const clienteId = existente ? existente.cliente_id : String(esc.clienteIdNovo(id, novo) || '');
    await client.query(
      `INSERT INTO documento (colecao, id, cliente_id, dados) VALUES ($1,$2,$3,$4)
       ON CONFLICT (colecao, id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now()`,
      [col, id, clienteId, JSON.stringify(novo)]);
    feitos.push({ col, id, op: o.op });
  }
  return { feitos, rejeitados };
}

module.exports = { escopo, montarConsulta, consultar, buscar, aplicarOps, resolver, mesclar, atualizar, limparSensiveis };
